import type { AllocationIdentity } from "./allocation-identity.js";
import { parseCapabilityProfile, type CapabilityProfile } from "./capabilities.js";
import {
  ContractValidationError,
  requireExactKeys,
  requireNonEmptyString,
  requireRecord,
} from "./validation.js";

export const PROVIDER_NAMES = ["azure", "blacksmith"] as const;

export type ProviderName = (typeof PROVIDER_NAMES)[number];
export type RunnerKind = "ephemeral" | "managed-label";

export interface EphemeralRunner {
  readonly kind: "ephemeral";
  readonly labelScope: "unique-allocation";
  readonly runnerLabel: string;
}

export interface ManagedLabelAuthorisation {
  readonly profile: CapabilityProfile;
  readonly timeoutMinutes: number;
  readonly workflowJobMappingPointer: string;
}

export interface ManagedLabelRunner {
  readonly authorisation: ManagedLabelAuthorisation;
  readonly kind: "managed-label";
  readonly labelScope: "shared";
  readonly runnerLabel: string;
}

export interface ApprovedManagedLabelMappingEvidence {
  /** Produced by the future GitHub adapter only after a central allowlist lookup succeeds. */
  readonly kind: "central-allowlist-match";
  readonly profile: CapabilityProfile;
  readonly runnerLabel: string;
  readonly timeoutMinutes: number;
  readonly workflowJobMappingPointer: string;
}

export const MANAGED_LABEL_CORRELATION_FAILURE_REASONS = [
  "expected-job-missing",
  "different-job",
  "ambiguous-job",
] as const;

export type ManagedLabelCorrelationFailureReason =
  (typeof MANAGED_LABEL_CORRELATION_FAILURE_REASONS)[number];

export type ManagedLabelJobCorrelation =
  | { readonly state: "awaiting-correlation" }
  | {
      readonly persistedGitHubJobId: string;
      readonly state: "correlated";
    }
  | {
      readonly reason: ManagedLabelCorrelationFailureReason;
      readonly state: "correlation-failed";
    };

export type ProviderRunner = EphemeralRunner | ManagedLabelRunner;
export type ProviderUnavailableReason = "capacity-unavailable" | "provisioning-unavailable";

interface FailureDetails {
  readonly code: string;
  readonly message: string;
}

export interface ProviderUnavailableFailure extends FailureDetails {
  readonly classification: "provider-unavailable";
  readonly unavailableReason: ProviderUnavailableReason;
}

export interface InvalidConfigurationFailure extends FailureDetails {
  readonly classification: "invalid-configuration";
}

export interface SecurityFailure extends FailureDetails {
  readonly classification: "security-failure";
}

export interface ControllerUnavailableFailure extends FailureDetails {
  readonly classification: "controller-unavailable";
}

export interface UnexpectedInternalFailure extends FailureDetails {
  readonly classification: "unexpected-internal-error";
}

export type AllocationFailure =
  | ProviderUnavailableFailure
  | InvalidConfigurationFailure
  | SecurityFailure
  | ControllerUnavailableFailure
  | UnexpectedInternalFailure;

export type AllocationFailureClassification = AllocationFailure["classification"];

export interface AzureAllocationSuccess {
  readonly outcome: "allocated";
  readonly provider: "azure";
  readonly runner: EphemeralRunner;
}

export interface BlacksmithAllocationSuccess {
  readonly outcome: "allocated";
  readonly provider: "blacksmith";
  readonly runner: ManagedLabelRunner;
}

export type ProviderAllocationSuccess = AzureAllocationSuccess | BlacksmithAllocationSuccess;

export interface ProviderAllocationFailure<P extends ProviderName = ProviderName> {
  readonly failure: AllocationFailure;
  readonly outcome: "failed";
  readonly provider: P;
}

export type AzureProviderAttemptResult =
  | AzureAllocationSuccess
  | ProviderAllocationFailure<"azure">;
export type BlacksmithProviderAttemptResult =
  | BlacksmithAllocationSuccess
  | ProviderAllocationFailure<"blacksmith">;
export type ProviderAttemptResult = AzureProviderAttemptResult | BlacksmithProviderAttemptResult;
export type ProviderAttemptResultFor<P extends ProviderName> = Extract<
  ProviderAttemptResult,
  { readonly provider: P }
>;

interface ProviderAllocationRequestBase {
  readonly allocationId: string;
  readonly identity: AllocationIdentity;
  readonly profile: CapabilityProfile;
}

export interface AzureProviderAllocationRequest extends ProviderAllocationRequestBase {
  readonly ordinal: 1;
  readonly provider: "azure";
}

export interface BlacksmithProviderAllocationRequest extends ProviderAllocationRequestBase {
  readonly approvedManagedLabel: ApprovedManagedLabelMappingEvidence;
  readonly ordinal: 2;
  readonly provider: "blacksmith";
}

export type ProviderAllocationRequest =
  | AzureProviderAllocationRequest
  | BlacksmithProviderAllocationRequest;

export type ProviderAllocationRequestFor<P extends ProviderName> = Extract<
  ProviderAllocationRequest,
  { readonly provider: P }
>;

export type RunnerKindForProvider<P extends ProviderName> = P extends "azure"
  ? "ephemeral"
  : "managed-label";

export interface ProviderAdapter<P extends ProviderName> {
  readonly name: P;
  readonly runnerKind: RunnerKindForProvider<P>;

  allocate(request: ProviderAllocationRequestFor<P>): Promise<ProviderAttemptResultFor<P>>;
}

const MANAGED_LABEL_AUTHORISATION_KEYS = [
  "workflowJobMappingPointer",
  "profile",
  "timeoutMinutes",
] as const;
const APPROVED_MAPPING_EVIDENCE_KEYS = [
  "kind",
  "workflowJobMappingPointer",
  "profile",
  "runnerLabel",
  "timeoutMinutes",
] as const;

export function parseManagedLabelAuthorisation(value: unknown): ManagedLabelAuthorisation {
  const record = requireRecord(value, "managedLabelAuthorisation");
  requireExactKeys(record, MANAGED_LABEL_AUTHORISATION_KEYS, "managedLabelAuthorisation");

  const workflowJobMappingPointer = requireNonEmptyString(
    record.workflowJobMappingPointer,
    "managedLabelAuthorisation.workflowJobMappingPointer",
  );
  const profile = parseCapabilityProfile(record.profile, "managedLabelAuthorisation.profile");
  const timeoutMinutes = requirePositiveSafeInteger(
    record.timeoutMinutes,
    "managedLabelAuthorisation.timeoutMinutes",
  );

  return { workflowJobMappingPointer, profile, timeoutMinutes };
}

export function parseApprovedManagedLabelMappingEvidence(
  value: unknown,
): ApprovedManagedLabelMappingEvidence {
  const record = requireRecord(value, "approvedManagedLabelMappingEvidence");
  requireExactKeys(record, APPROVED_MAPPING_EVIDENCE_KEYS, "approvedManagedLabelMappingEvidence");
  requireLiteral(
    record.kind,
    "central-allowlist-match",
    "approvedManagedLabelMappingEvidence.kind",
  );

  return {
    kind: "central-allowlist-match",
    workflowJobMappingPointer: requireNonEmptyString(
      record.workflowJobMappingPointer,
      "approvedManagedLabelMappingEvidence.workflowJobMappingPointer",
    ),
    runnerLabel: requireNonEmptyString(
      record.runnerLabel,
      "approvedManagedLabelMappingEvidence.runnerLabel",
    ),
    profile: parseCapabilityProfile(record.profile, "approvedManagedLabelMappingEvidence.profile"),
    timeoutMinutes: requirePositiveSafeInteger(
      record.timeoutMinutes,
      "approvedManagedLabelMappingEvidence.timeoutMinutes",
    ),
  };
}

export function parseApprovedManagedLabelMappingEvidenceList(
  value: unknown,
): readonly ApprovedManagedLabelMappingEvidence[] {
  if (!Array.isArray(value)) {
    throw new ContractValidationError(
      "approvedManagedLabelMappings",
      "must be an array of central allowlist matches",
    );
  }

  return value.map((entry) => parseApprovedManagedLabelMappingEvidence(entry));
}

export function parseManagedLabelJobCorrelation(value: unknown): ManagedLabelJobCorrelation {
  const record = requireRecord(value, "managedLabelJobCorrelation");

  if (record.state === "awaiting-correlation") {
    requireExactKeys(record, ["state"], "managedLabelJobCorrelation");
    return { state: "awaiting-correlation" };
  }

  if (record.state === "correlated") {
    requireExactKeys(record, ["state", "persistedGitHubJobId"], "managedLabelJobCorrelation");
    return {
      state: "correlated",
      persistedGitHubJobId: requirePositiveDecimalString(
        record.persistedGitHubJobId,
        "managedLabelJobCorrelation.persistedGitHubJobId",
      ),
    };
  }

  if (record.state === "correlation-failed") {
    requireExactKeys(record, ["state", "reason"], "managedLabelJobCorrelation");
    if (!isManagedLabelCorrelationFailureReason(record.reason)) {
      throw new ContractValidationError(
        "managedLabelJobCorrelation.reason",
        "is not a recognised correlation failure reason",
      );
    }
    return { state: "correlation-failed", reason: record.reason };
  }

  throw new ContractValidationError(
    "managedLabelJobCorrelation.state",
    "is not a recognised correlation state",
  );
}

export function parseProviderAttemptResult(value: unknown): ProviderAttemptResult {
  const record = requireRecord(value, "providerAttemptResult");
  const outcome = record.outcome;

  if (outcome === "allocated") {
    requireExactKeys(record, ["outcome", "provider", "runner"], "providerAttemptResult");
    const provider = parseProviderName(record.provider);

    if (provider === "azure") {
      return {
        outcome,
        provider,
        runner: parseEphemeralRunner(record.runner),
      };
    }

    return {
      outcome,
      provider,
      runner: parseManagedLabelRunner(record.runner),
    };
  }

  if (outcome === "failed") {
    requireExactKeys(record, ["outcome", "provider", "failure"], "providerAttemptResult");
    const provider = parseProviderName(record.provider);
    const failure = parseAllocationFailure(record.failure);

    if (provider === "azure") {
      return { outcome, provider, failure };
    }
    return { outcome, provider, failure };
  }

  throw new ContractValidationError(
    "providerAttemptResult.outcome",
    "must be 'allocated' or 'failed'",
  );
}

function parseProviderName(value: unknown): ProviderName {
  if (value !== "azure" && value !== "blacksmith") {
    throw new ContractValidationError(
      "providerAttemptResult.provider",
      "must be 'azure' or 'blacksmith'",
    );
  }

  return value;
}

function parseEphemeralRunner(value: unknown): EphemeralRunner {
  const record = requireRecord(value, "providerAttemptResult.runner");
  requireExactKeys(record, ["kind", "labelScope", "runnerLabel"], "providerAttemptResult.runner");
  requireLiteral(record.kind, "ephemeral", "providerAttemptResult.runner.kind");
  requireLiteral(record.labelScope, "unique-allocation", "providerAttemptResult.runner.labelScope");

  return {
    kind: "ephemeral",
    labelScope: "unique-allocation",
    runnerLabel: requireNonEmptyString(
      record.runnerLabel,
      "providerAttemptResult.runner.runnerLabel",
    ),
  };
}

function parseManagedLabelRunner(value: unknown): ManagedLabelRunner {
  const record = requireRecord(value, "providerAttemptResult.runner");
  requireExactKeys(
    record,
    ["kind", "labelScope", "runnerLabel", "authorisation"],
    "providerAttemptResult.runner",
  );
  requireLiteral(record.kind, "managed-label", "providerAttemptResult.runner.kind");
  requireLiteral(record.labelScope, "shared", "providerAttemptResult.runner.labelScope");

  return {
    kind: "managed-label",
    labelScope: "shared",
    runnerLabel: requireNonEmptyString(
      record.runnerLabel,
      "providerAttemptResult.runner.runnerLabel",
    ),
    authorisation: parseManagedLabelAuthorisation(record.authorisation),
  };
}

function parseAllocationFailure(value: unknown): AllocationFailure {
  const record = requireRecord(value, "providerAttemptResult.failure");
  const classification = record.classification;
  const code = requireNonEmptyString(record.code, "providerAttemptResult.failure.code");
  const message = requireNonEmptyString(record.message, "providerAttemptResult.failure.message");

  if (classification === "provider-unavailable") {
    requireExactKeys(
      record,
      ["classification", "code", "message", "unavailableReason"],
      "providerAttemptResult.failure",
    );
    const unavailableReason = record.unavailableReason;
    if (
      unavailableReason !== "capacity-unavailable" &&
      unavailableReason !== "provisioning-unavailable"
    ) {
      throw new ContractValidationError(
        "providerAttemptResult.failure.unavailableReason",
        "must be 'capacity-unavailable' or 'provisioning-unavailable'",
      );
    }

    return { classification, code, message, unavailableReason };
  }

  requireExactKeys(record, ["classification", "code", "message"], "providerAttemptResult.failure");
  if (
    classification !== "invalid-configuration" &&
    classification !== "security-failure" &&
    classification !== "controller-unavailable" &&
    classification !== "unexpected-internal-error"
  ) {
    throw new ContractValidationError(
      "providerAttemptResult.failure.classification",
      "is not a recognised failure classification",
    );
  }

  return { classification, code, message };
}

function requirePositiveDecimalString(value: unknown, path: string): string {
  const identifier = requireNonEmptyString(value, path);
  if (!/^[1-9]\d*$/.test(identifier)) {
    throw new ContractValidationError(path, "must be a positive decimal string");
  }

  return identifier;
}

function requirePositiveSafeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new ContractValidationError(path, "must be a positive safe integer");
  }

  return value;
}

function isManagedLabelCorrelationFailureReason(
  value: unknown,
): value is ManagedLabelCorrelationFailureReason {
  return MANAGED_LABEL_CORRELATION_FAILURE_REASONS.some((reason) => reason === value);
}

function requireLiteral<T extends string>(value: unknown, expected: T, path: string): T {
  if (value !== expected) {
    throw new ContractValidationError(path, `must be '${expected}'`);
  }

  return expected;
}
