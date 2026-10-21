import { parseBackupChoice } from "./backup-choice.js";
import { parseCapabilityProfile, type CapabilityProfile } from "./capabilities.js";
import { evaluateControllerReadiness } from "./controller-health.js";
import {
  parseApprovedManagedLabelMappingEvidenceList,
  parseProviderAttemptResult,
  type AllocationFailure,
  type ApprovedManagedLabelMappingEvidence,
  type BlacksmithAllocationSuccess,
  type ProviderAllocationSuccess,
  type ProviderAttemptResult,
  type ProviderName,
} from "./provider.js";

export const PROVIDER_ORDER = ["azure", "blacksmith"] as const satisfies readonly ProviderName[];

export interface AllocationPolicyInput {
  readonly approvedManagedLabelMappings: unknown;
  readonly attempts: readonly unknown[];
  readonly backupChoice: unknown;
  readonly controllerHealth: unknown;
  readonly now: Date;
  readonly profile: unknown;
}

export type AllocationPolicyDecision =
  | { readonly action: "attempt-provider"; readonly provider: ProviderName }
  | { readonly action: "use-runner"; readonly allocation: ProviderAllocationSuccess }
  | {
      readonly action: "stop";
      readonly failure: AllocationFailure;
      readonly source: "controller" | ProviderName;
    };

export function decideAllocationPolicy(input: AllocationPolicyInput): AllocationPolicyDecision {
  const controllerReadiness = evaluateControllerReadiness(input.controllerHealth, input.now);
  if (!controllerReadiness.ready) {
    return {
      action: "stop",
      source: "controller",
      failure: controllerReadiness.failure,
    };
  }

  let backupChoice: ReturnType<typeof parseBackupChoice>;
  try {
    backupChoice = parseBackupChoice(input.backupChoice, "allocationPolicy.backupChoice");
  } catch (error) {
    return invalidConfiguration("invalid-backup-choice", validationMessage(error));
  }

  let profile: CapabilityProfile;
  try {
    profile = parseCapabilityProfile(input.profile, "allocationPolicy.profile");
  } catch (error) {
    return invalidConfiguration("invalid-profile", validationMessage(error));
  }

  if (!Array.isArray(input.attempts)) {
    return malformedTransport("controller", "provider attempts must be an array");
  }
  if (input.attempts.length > PROVIDER_ORDER.length) {
    return invalidHistory("blacksmith", "more providers were attempted than V1 permits");
  }

  const attempts: ProviderAttemptResult[] = [];
  for (const [index, value] of input.attempts.entries()) {
    try {
      attempts.push(parseProviderAttemptResult(value));
    } catch (error) {
      return malformedTransport(PROVIDER_ORDER[index] ?? "blacksmith", validationMessage(error));
    }
  }

  if (attempts.length === 0) {
    return { action: "attempt-provider", provider: "azure" };
  }

  for (const [index, attempt] of attempts.entries()) {
    const expectedProvider = PROVIDER_ORDER[index];
    if (expectedProvider === undefined || attempt.provider !== expectedProvider) {
      return invalidHistory(
        expectedProvider ?? "blacksmith",
        `provider attempt ${index + 1} did not follow the V1 provider order`,
      );
    }
  }

  const azureAttempt = attempts[0];
  if (azureAttempt === undefined || azureAttempt.provider !== "azure") {
    return invalidHistory("azure", "the Azure attempt is missing");
  }

  if (azureAttempt.outcome === "allocated") {
    if (attempts.length > 1) {
      return invalidHistory(
        "blacksmith",
        "Blacksmith was attempted after Azure allocated a runner",
      );
    }
    return { action: "use-runner", allocation: azureAttempt };
  }

  if (azureAttempt.failure.classification !== "provider-unavailable") {
    if (attempts.length > 1) {
      return invalidHistory(
        "blacksmith",
        "Blacksmith was attempted after a non-fallback Azure failure",
      );
    }
    return stopForFailure(azureAttempt);
  }

  if (backupChoice === "Save money") {
    if (attempts.length > 1) {
      return invalidHistory(
        "blacksmith",
        "Blacksmith was attempted when the caller chose Save money",
      );
    }
    return stopForFailure(azureAttempt);
  }

  const evidenceResult = validateManagedLabelEvidence(input.approvedManagedLabelMappings, profile);
  if (!evidenceResult.valid) {
    return evidenceResult.decision;
  }

  const blacksmithAttempt = attempts[1];
  if (blacksmithAttempt === undefined) {
    return { action: "attempt-provider", provider: "blacksmith" };
  }
  if (blacksmithAttempt.provider !== "blacksmith") {
    return invalidHistory("blacksmith", "the Blacksmith attempt is malformed");
  }

  if (blacksmithAttempt.outcome === "allocated") {
    return validateManagedLabelSelection(blacksmithAttempt, evidenceResult.evidence, profile);
  }

  return stopForFailure(blacksmithAttempt);
}

function validateManagedLabelSelection(
  allocation: BlacksmithAllocationSuccess,
  evidence: readonly ApprovedManagedLabelMappingEvidence[],
  requestedProfile: CapabilityProfile,
): AllocationPolicyDecision {
  const authorisation = allocation.runner.authorisation;
  const approved = evidence.some(
    (entry) =>
      entry.workflowJobMappingPointer === authorisation.workflowJobMappingPointer &&
      entry.profile === requestedProfile &&
      authorisation.profile === requestedProfile &&
      entry.runnerLabel === allocation.runner.runnerLabel &&
      entry.timeoutMinutes === authorisation.timeoutMinutes,
  );
  if (!approved) {
    return missingManagedLabelApproval();
  }

  return { action: "use-runner", allocation };
}

type ManagedLabelEvidenceResult =
  | { readonly evidence: readonly ApprovedManagedLabelMappingEvidence[]; readonly valid: true }
  | { readonly decision: AllocationPolicyDecision; readonly valid: false };

function validateManagedLabelEvidence(
  evidenceValue: unknown,
  requestedProfile: CapabilityProfile,
): ManagedLabelEvidenceResult {
  let evidence: readonly ApprovedManagedLabelMappingEvidence[];
  try {
    evidence = parseApprovedManagedLabelMappingEvidenceList(evidenceValue);
  } catch (error) {
    return {
      valid: false,
      decision: malformedTransport("blacksmith", validationMessage(error)),
    };
  }

  const profileEvidence = evidence.filter((entry) => entry.profile === requestedProfile);
  if (profileEvidence.length === 0) {
    return { valid: false, decision: missingManagedLabelApproval() };
  }

  return { valid: true, evidence: profileEvidence };
}

function missingManagedLabelApproval(): AllocationPolicyDecision {
  return {
    action: "stop",
    source: "blacksmith",
    failure: {
      classification: "security-failure",
      code: "managed-label-mapping-not-approved",
      message: "the managed runner label is not backed by central allowlist evidence",
    },
  };
}

function stopForFailure(
  result: Extract<ProviderAttemptResult, { readonly outcome: "failed" }>,
): AllocationPolicyDecision {
  return {
    action: "stop",
    source: result.provider,
    failure: result.failure,
  };
}

function invalidHistory(provider: ProviderName, message: string): AllocationPolicyDecision {
  return {
    action: "stop",
    source: provider,
    failure: {
      classification: "unexpected-internal-error",
      code: "invalid-policy-history",
      message,
    },
  };
}

function malformedTransport(
  source: "controller" | ProviderName,
  message: string,
): AllocationPolicyDecision {
  return {
    action: "stop",
    source,
    failure: {
      classification: "unexpected-internal-error",
      code: "malformed-runtime-contract",
      message,
    },
  };
}

function invalidConfiguration(code: string, message: string): AllocationPolicyDecision {
  return {
    action: "stop",
    source: "controller",
    failure: {
      classification: "invalid-configuration",
      code,
      message,
    },
  };
}

function validationMessage(error: unknown): string {
  return error instanceof Error ? error.message : "runtime data is malformed";
}
