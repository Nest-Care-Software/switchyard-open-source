import {
  AllocationLedgerError,
  type AllocationControlLedger,
  type AllocationIdentity,
  type AllocationRecord,
  type BackupChoice,
  type CapabilityProfile,
  type VerifiedWorkloadTrust,
  type WorkloadBindingState,
} from "@switchyard/core";

export interface TrustedManagedJobExpectation {
  readonly backupChoice: BackupChoice;
  readonly jobKey: string;
  readonly jobName: string;
  readonly mappingPointer: string;
  readonly profile: CapabilityProfile;
  readonly runnerLabel: string;
  readonly timeoutMinutes: number;
}

export interface ManagedJobObservation {
  readonly githubJobId: string;
  readonly jobName: string;
  readonly runnerLabels: readonly string[];
}

export interface ManagedRunObservation {
  readonly jobs: readonly ManagedJobObservation[];
  readonly repositoryId: string;
  readonly runAttempt: number;
  readonly runId: string;
  readonly state: "active" | "terminal";
}

export interface BlacksmithJobObservationPort {
  observe(input: {
    readonly expected: TrustedManagedJobExpectation;
    readonly identity: AllocationIdentity;
  }): Promise<ManagedRunObservation>;
}

export type BlacksmithCorrelationResult =
  | { readonly outcome: "awaiting" }
  | { readonly githubJobId: string; readonly outcome: "bound" }
  | {
      readonly incidentRequired: true;
      readonly outcome: "binding-failed";
      readonly reason: "expected-job-missing" | "different-job" | "ambiguous-job";
    };

export class BlacksmithCorrelationError extends Error {
  readonly code: "allocation-conflict" | "controller-unavailable" | "not-applicable";

  constructor(code: BlacksmithCorrelationError["code"]) {
    super("Managed runner correlation could not be completed");
    this.name = "BlacksmithCorrelationError";
    this.code = code;
  }
}

/** Per-allocation managed-label reconciliation only. It never settles or falls back. */
export class BlacksmithManagedCorrelationEngine {
  readonly #ledger: AllocationControlLedger;
  readonly #now: () => Date;
  readonly #observations: BlacksmithJobObservationPort;

  constructor(options: {
    readonly ledger: AllocationControlLedger;
    readonly now?: () => Date;
    readonly observations: BlacksmithJobObservationPort;
  }) {
    this.#ledger = options.ledger;
    this.#now = options.now ?? (() => new Date());
    this.#observations = options.observations;
  }

  async reconcileAllocation(allocationId: string): Promise<BlacksmithCorrelationResult> {
    let allocation: AllocationRecord | undefined;
    try {
      allocation = await this.#ledger.getAllocation(allocationId);
    } catch {
      throw new BlacksmithCorrelationError("controller-unavailable");
    }
    if (
      allocation === undefined ||
      allocation.runnerAssignment?.provider !== "blacksmith" ||
      allocation.runnerAssignment.attemptOrdinal !== 2
    ) {
      throw new BlacksmithCorrelationError("not-applicable");
    }
    if (allocation.workloadBinding.state === "bound") {
      return { githubJobId: allocation.workloadBinding.githubJobId, outcome: "bound" };
    }
    if (allocation.workloadBinding.state === "binding-failed") {
      return {
        incidentRequired: true,
        outcome: "binding-failed",
        reason: allocation.workloadBinding.reason,
      };
    }
    if (allocation.workloadBinding.state !== "awaiting-correlation") {
      throw new BlacksmithCorrelationError("not-applicable");
    }

    const expected = expectationFromTrust(allocation.acceptance.trust);
    let observed: ManagedRunObservation;
    try {
      observed = validateObservation(
        await this.#observations.observe({ expected, identity: allocation.identity }),
        allocation.identity,
      );
    } catch (error) {
      if (error instanceof BlacksmithCorrelationError) throw error;
      throw new BlacksmithCorrelationError("controller-unavailable");
    }
    const result = correlate(expected, observed);
    if (result.outcome === "awaiting") return result;

    const workloadBinding: WorkloadBindingState =
      result.outcome === "bound"
        ? { githubJobId: result.githubJobId, state: "bound" }
        : { reason: result.reason, state: "binding-failed" };
    try {
      const updated = await this.#ledger.updateAllocationState({
        allocationId,
        expectedRevision: allocation.revision,
        patch: { workloadBinding },
        updatedAt: requiredNow(this.#now),
      });
      if (updated.workloadBinding.state === "bound") {
        return { githubJobId: updated.workloadBinding.githubJobId, outcome: "bound" };
      }
      if (updated.workloadBinding.state === "binding-failed") {
        return {
          incidentRequired: true,
          outcome: "binding-failed",
          reason: updated.workloadBinding.reason,
        };
      }
      throw new BlacksmithCorrelationError("controller-unavailable");
    } catch (error) {
      if (
        error instanceof AllocationLedgerError &&
        error.code === "optimistic-concurrency-conflict"
      ) {
        const reloaded = await this.#ledger.getAllocation(allocationId);
        if (reloaded?.workloadBinding.state === "bound") {
          return { githubJobId: reloaded.workloadBinding.githubJobId, outcome: "bound" };
        }
        if (reloaded?.workloadBinding.state === "binding-failed") {
          return {
            incidentRequired: true,
            outcome: "binding-failed",
            reason: reloaded.workloadBinding.reason,
          };
        }
        throw new BlacksmithCorrelationError("allocation-conflict");
      }
      if (error instanceof BlacksmithCorrelationError) throw error;
      throw new BlacksmithCorrelationError("controller-unavailable");
    }
  }
}

export function expectationFromTrust(trust: VerifiedWorkloadTrust): TrustedManagedJobExpectation {
  return {
    backupChoice: trust.workload.backupChoice,
    jobKey: trust.workload.jobKey,
    jobName: trust.workload.jobName,
    mappingPointer: trust.mappingPointer,
    profile: trust.workload.profile,
    runnerLabel: trust.workload.blacksmithRunnerLabel,
    timeoutMinutes: trust.workload.timeoutMinutes,
  };
}

function correlate(
  expected: TrustedManagedJobExpectation,
  observation: ManagedRunObservation,
): BlacksmithCorrelationResult {
  const exact = observation.jobs.filter((job) => job.jobName === expected.jobName);
  const labelConsumers = observation.jobs.filter((job) =>
    hasRunnerLabel(job.runnerLabels, expected.runnerLabel),
  );
  if (exact.length > 1 || labelConsumers.length > 1) {
    return bindingFailed("ambiguous-job");
  }
  const matched = exact[0];
  if (matched !== undefined) {
    if (!hasRunnerLabel(matched.runnerLabels, expected.runnerLabel)) {
      return bindingFailed("different-job");
    }
    return { githubJobId: matched.githubJobId, outcome: "bound" };
  }
  const relatedDifferentJob = observation.jobs.some(
    (job) =>
      job.jobName === expected.jobName || hasRunnerLabel(job.runnerLabels, expected.runnerLabel),
  );
  if (relatedDifferentJob) return bindingFailed("different-job");
  if (observation.state === "terminal") return bindingFailed("expected-job-missing");
  return { outcome: "awaiting" };
}

function hasRunnerLabel(labels: readonly string[], expected: string): boolean {
  const canonicalExpected = expected.toLowerCase();
  return labels.some((label) => label.toLowerCase() === canonicalExpected);
}

function bindingFailed(
  reason: Extract<BlacksmithCorrelationResult, { outcome: "binding-failed" }>["reason"],
): BlacksmithCorrelationResult {
  return { incidentRequired: true, outcome: "binding-failed", reason };
}

function validateObservation(
  value: ManagedRunObservation,
  identity: AllocationIdentity,
): ManagedRunObservation {
  if (
    typeof value !== "object" ||
    value === null ||
    value.repositoryId !== identity.repository_id ||
    value.runId !== identity.run_id ||
    value.runAttempt !== identity.run_attempt ||
    (value.state !== "active" && value.state !== "terminal") ||
    !Array.isArray(value.jobs)
  ) {
    throw new BlacksmithCorrelationError("controller-unavailable");
  }
  const seenIds = new Set<string>();
  for (const job of value.jobs) {
    if (
      typeof job !== "object" ||
      job === null ||
      !/^[1-9]\d*$/.test(job.githubJobId) ||
      typeof job.jobName !== "string" ||
      job.jobName.length < 1 ||
      !Array.isArray(job.runnerLabels) ||
      job.runnerLabels.some((label: unknown) => typeof label !== "string" || label.length < 1) ||
      seenIds.has(job.githubJobId)
    ) {
      throw new BlacksmithCorrelationError("controller-unavailable");
    }
    seenIds.add(job.githubJobId);
  }
  return value;
}

function requiredNow(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
    throw new BlacksmithCorrelationError("controller-unavailable");
  }
  return value.toISOString();
}
