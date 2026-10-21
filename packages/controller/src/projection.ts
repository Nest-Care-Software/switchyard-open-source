import {
  decideAllocationPolicy,
  type AllocationFailure,
  type AllocationRecord,
  type AllocationStop,
  type ApprovedManagedLabelMappingEvidence,
  type BlacksmithProviderAllocationRequest,
  type ControllerHealthSnapshot,
  type ProviderAttempt,
  type ProviderAttemptResult,
  type RunnerAssignment,
  type VerifiedWorkloadTrust,
} from "@switchyard/core";

export type ControllerAllocationProjection =
  | { readonly action: "await-check-run" }
  | { readonly action: "dispatch-azure" }
  | {
      readonly action: "repair-azure-assignment";
      readonly generationNumber: 1;
      readonly requiresFreshOnlineIdleCheck: true;
      readonly runnerRegistrationId: string;
    }
  | { readonly action: "complete-blacksmith-attempt" }
  | { readonly action: "assign-blacksmith"; readonly request: BlacksmithProviderAllocationRequest }
  | { readonly action: "reserve-azure" }
  | { readonly action: "reserve-blacksmith"; readonly request: BlacksmithProviderAllocationRequest }
  | { readonly action: "return-assignment"; readonly assignment: RunnerAssignment }
  | { readonly action: "stop-allocation"; readonly reason: AllocationStop["reason"] }
  | { readonly action: "runner-unavailable" }
  | { readonly action: "fail"; readonly failure: AllocationFailure };

/**
 * The sole translation from authoritative ordered-attempt state into allocator
 * policy. The orchestration service switches only on this result.
 */
export function projectAllocationControllerState(input: {
  readonly allocation: AllocationRecord;
  readonly controllerHealth: ControllerHealthSnapshot;
  readonly now: Date;
}): ControllerAllocationProjection {
  const { allocation } = input;
  if (
    allocation.lifecycleState === "ended" ||
    allocation.lifecycleState === "cleanup_pending" ||
    allocation.abandonment !== null ||
    allocation.stop !== null
  ) {
    return { action: "runner-unavailable" };
  }
  if (allocation.checkRunCreation.delivery.lifecycle.phase === "not-created") {
    return { action: "await-check-run" };
  }

  const shapeFailure = validateOrderedShape(allocation.attempts);
  if (shapeFailure !== null) return shapeFailure;

  const current = allocation.attempts.at(-1);
  if (allocation.runnerAssignment === null && allocation.stop === null && current !== undefined) {
    if (current.outcome === "pending") {
      return current.provider === "azure"
        ? { action: "dispatch-azure" }
        : { action: "complete-blacksmith-attempt" };
    }
    if (current.outcome === "succeeded") {
      if (current.provider === "azure") {
        const generation = current.physicalGenerations[0];
        if (
          current.physicalGenerations.length !== 1 ||
          generation?.generationNumber !== 1 ||
          generation.state !== "ready" ||
          generation.runnerRegistrationId === null ||
          generation.runnerReadiness === null
        ) {
          return invalidState("successful Azure attempt lacks repairable generation-one state");
        }
        return {
          action: "repair-azure-assignment",
          generationNumber: 1,
          requiresFreshOnlineIdleCheck: true,
          runnerRegistrationId: generation.runnerRegistrationId,
        };
      }
      return { action: "assign-blacksmith", request: blacksmithRequest(allocation) };
    }
  }

  let attempts: readonly ProviderAttemptResult[];
  try {
    attempts = projectAttempts(allocation);
  } catch {
    return invalidState("durable attempt outcomes cannot be projected into policy");
  }
  const decision = decideAllocationPolicy({
    approvedManagedLabelMappings: [managedLabelEvidence(allocation.acceptance.trust)],
    attempts,
    backupChoice: allocation.acceptance.request.backupChoice,
    controllerHealth: input.controllerHealth,
    now: input.now,
    profile: allocation.acceptance.request.profile,
  });

  switch (decision.action) {
    case "attempt-provider":
      if (allocation.stop !== null) return invalidState("stopped allocation requests a provider");
      if (decision.provider === "azure") return { action: "reserve-azure" };
      return { action: "reserve-blacksmith", request: blacksmithRequest(allocation) };
    case "use-runner": {
      const assignment = allocation.runnerAssignment;
      if (
        assignment === null ||
        assignment.provider !== decision.allocation.provider ||
        assignment.runnerLabel !== decision.allocation.runner.runnerLabel
      ) {
        return invalidState("policy runner disagrees with the immutable assignment");
      }
      return { action: "return-assignment", assignment };
    }
    case "stop": {
      if (decision.failure.classification !== "provider-unavailable") {
        return { action: "fail", failure: decision.failure };
      }
      const reason: AllocationStop["reason"] =
        decision.source === "azure" ? "save-money" : "all-providers-unavailable";
      return { action: "stop-allocation", reason };
    }
  }
}

export function managedLabelEvidence(
  trust: VerifiedWorkloadTrust,
): ApprovedManagedLabelMappingEvidence {
  return {
    kind: "central-allowlist-match",
    profile: trust.workload.profile,
    runnerLabel: trust.workload.blacksmithRunnerLabel,
    timeoutMinutes: trust.workload.timeoutMinutes,
    workflowJobMappingPointer: trust.mappingPointer,
  };
}

function blacksmithRequest(allocation: AllocationRecord): BlacksmithProviderAllocationRequest {
  return {
    allocationId: allocation.allocationId,
    approvedManagedLabel: managedLabelEvidence(allocation.acceptance.trust),
    identity: allocation.identity,
    ordinal: 2,
    profile: allocation.acceptance.request.profile,
    provider: "blacksmith",
  };
}

function projectAttempts(allocation: AllocationRecord): readonly ProviderAttemptResult[] {
  return allocation.attempts.map((attempt) => {
    if (attempt.outcome === "unavailable") {
      return {
        failure: {
          classification: "provider-unavailable",
          code: attempt.unavailable?.classification ?? "provider-unavailable-evidence-missing",
          message: "provider capacity or provisioning is unavailable",
          unavailableReason:
            attempt.unavailable?.classification === "concurrency-limit" ||
            attempt.unavailable?.classification === "daily-allowance"
              ? "capacity-unavailable"
              : "provisioning-unavailable",
        },
        outcome: "failed",
        provider: attempt.provider,
      } satisfies ProviderAttemptResult;
    }

    const assignment = allocation.runnerAssignment;
    if (attempt.outcome !== "succeeded" || assignment?.attemptOrdinal !== attempt.ordinal) {
      throw new TypeError("pending or unassigned successful attempts cannot enter policy");
    }
    if (attempt.provider === "azure" && assignment.provider === "azure") {
      return {
        outcome: "allocated",
        provider: "azure",
        runner: {
          kind: "ephemeral",
          labelScope: "unique-allocation",
          runnerLabel: assignment.runnerLabel,
        },
      } satisfies ProviderAttemptResult;
    }
    if (attempt.provider === "blacksmith" && assignment.provider === "blacksmith") {
      return {
        outcome: "allocated",
        provider: "blacksmith",
        runner: {
          authorisation: {
            profile: allocation.acceptance.request.profile,
            timeoutMinutes: allocation.acceptance.trust.workload.timeoutMinutes,
            workflowJobMappingPointer: allocation.acceptance.trust.mappingPointer,
          },
          kind: "managed-label",
          labelScope: "shared",
          runnerLabel: assignment.runnerLabel,
        },
      } satisfies ProviderAttemptResult;
    }
    throw new TypeError("successful provider attempt disagrees with assignment");
  });
}

function validateOrderedShape(
  attempts: readonly ProviderAttempt[],
): Extract<ControllerAllocationProjection, { readonly action: "fail" }> | null {
  if (
    attempts.length > 2 ||
    (attempts[0] !== undefined &&
      (attempts[0].ordinal !== 1 || attempts[0].provider !== "azure")) ||
    (attempts[1] !== undefined &&
      (attempts[1].ordinal !== 2 || attempts[1].provider !== "blacksmith"))
  ) {
    return invalidState("provider attempts do not follow the exhaustive V1 order");
  }
  return null;
}

function invalidState(
  message: string,
): Extract<ControllerAllocationProjection, { readonly action: "fail" }> {
  return {
    action: "fail",
    failure: {
      classification: "unexpected-internal-error",
      code: "invalid-controller-projection-state",
      message,
    },
  };
}
