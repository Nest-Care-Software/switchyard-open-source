import type {
  AllocationControlLedger,
  AllocationIdentity,
  AllocationRecord,
  AttemptCleanupState,
  TerminalEvidence,
  TerminalWorkloadConclusion,
} from "@switchyard/core";
import {
  AllocationLedgerError,
  allocationNeedsReconciliation,
  azureRunnerLabelForAllocation,
  FATAL_AZURE_ABORT_CLASSIFICATIONS,
  RECONCILER_HEARTBEAT_INTERVAL_SECONDS,
  type ReconcilerHeartbeatStore,
  UNASSIGNED_ABANDONMENT_MINUTES,
} from "@switchyard/core";

export const RECONCILER_SCAN_PAGE_SIZE = 50;
export const RECONCILER_MAX_SCAN_PAGES = 20;
export const RECONCILER_MAX_SCAN_ALLOCATIONS =
  RECONCILER_SCAN_PAGE_SIZE * RECONCILER_MAX_SCAN_PAGES;
export const GITHUB_JOB_PAGE_SIZE = 50;
export const GITHUB_MAX_JOB_PAGES = 20;
export const GITHUB_MAX_JOBS = GITHUB_JOB_PAGE_SIZE * GITHUB_MAX_JOB_PAGES;
export const GITHUB_OBSERVATION_TIMEOUT_MILLISECONDS = 10_000;
export const RECONCILER_CADENCE_SECONDS = RECONCILER_HEARTBEAT_INTERVAL_SECONDS;
export const AZURE_CLEANUP_MAX_STEPS_PER_CYCLE = 4;
export const FINAL_SAFETY_SWEEP_MAX_PASSES = 2;
export const VISIBILITY_PER_CALL_TIMEOUT_MILLISECONDS = 100;
export const VISIBILITY_TOTAL_TIMEOUT_MILLISECONDS = 1_000;

export type GitHubTerminalConclusion = Exclude<TerminalWorkloadConclusion, "never_started">;

export interface GitHubRunObservation {
  readonly concludedAt: string | null;
  readonly conclusion: GitHubTerminalConclusion | null;
  readonly repositoryId: string;
  readonly runAttempt: number;
  readonly runId: string;
  readonly state: "active" | "terminal";
}

export interface GitHubJobObservation {
  readonly concludedAt: string | null;
  readonly conclusion: GitHubTerminalConclusion | null;
  readonly githubJobId: string;
  /** The GitHub API display name. The immutable workflow verifier owns jobKey. */
  readonly jobName: string;
  readonly runnerLabels: readonly string[];
  readonly startedAt: string | null;
  readonly state: "in_progress" | "queued" | "terminal";
}

export interface GitHubJobObservationPage {
  readonly continuationToken: string | null;
  readonly jobs: readonly GitHubJobObservation[];
  readonly repositoryId: string;
  readonly runAttempt: number;
  readonly runId: string;
}

export interface GitHubWorkloadObservationPort {
  getRun(identity: AllocationIdentity, options: { readonly signal: AbortSignal }): Promise<unknown>;
  listJobs(input: {
    readonly continuationToken?: string;
    readonly identity: AllocationIdentity;
    readonly pageSize: number;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
}

export interface AzureReconciliationPort {
  reconcile(input: {
    readonly allocation_id: string;
    readonly ordinal: 1;
    readonly provider: "azure";
  }): Promise<unknown>;
  reconcileAssignedCleanup(input: { readonly allocationId: string }): Promise<unknown>;
}

/** Best-effort visibility only. Implementations own durable retry and alert state. */
export interface LifecycleVisibilityPort {
  reconcile(allocationId: string, options: { readonly signal: AbortSignal }): Promise<void>;
}

export interface ReconcilerIncidentPort {
  raise(input: {
    readonly allocationId: string | null;
    readonly classification:
      | "allocation-reconciliation-failed"
      | "authoritative-scan-incomplete"
      | "github-observation-invalid";
  }): Promise<void>;
}

export interface ReconcilerCycleResult {
  readonly completeScan: boolean;
  readonly heartbeatRecorded: boolean;
  readonly lifecycleFailures: number;
  readonly processedAllocations: number;
  readonly visibilityFailures: number;
}

interface CompleteGitHubObservation {
  readonly jobs: readonly GitHubJobObservation[];
  readonly run: GitHubRunObservation;
}

interface ExactJobResult {
  readonly ambiguous: boolean;
  readonly job: GitHubJobObservation | null;
}

interface FinalSafetySweepResult {
  readonly heartbeatAt: string | null;
  readonly lifecycleFailures: number;
}

type ValidatedAzureWorkerResult =
  | { readonly allocationId: string; readonly outcome: "ignored"; readonly reason: string }
  | { readonly allocationId: string; readonly outcome: "progress"; readonly stage: string }
  | {
      readonly allocationId: string;
      readonly cleanupPending: boolean;
      readonly code: string;
      readonly outcome: "incident";
    }
  | {
      readonly allocationId: string;
      readonly classification: string;
      readonly outcome: "unavailable";
    }
  | {
      readonly allocationId: string;
      readonly outcome: "ready";
      readonly runnerLabel: string;
    };

const AZURE_PROGRESS_STAGES = new Set([
  "base-deployment-fenced",
  "bootstrap-pending",
  "bootstrap-ready",
  "cleanup-pending",
  "cleanup-started",
  "deployment-observed-concurrently",
  "generation-added",
  "generation-exists",
  "management-plane-unavailable",
  "no-vm-created",
  "provider-operation-in-flight",
  "provider-resources-deleted",
  "resource-deletion-pending",
  "resources-deleted",
  "run-command-delete-fenced",
  "run-command-delete-pending",
  "run-command-deleted",
  "runner-pending",
  "runner-registration-fenced",
  "schedule-accepted",
  "schedule-fenced",
  "schedule-intent-recorded",
  "schedule-refresh-fenced",
  "schedule-requested",
  "vm-created",
  "zone-1-pending",
  "zone-1-planned",
  "zone-2-pending",
  "zone-2-planned",
  "zone-3-pending",
  "zone-3-planned",
  "zone-already-advanced",
]);
const AZURE_INCIDENT_CODES = new Set([
  "authoritative-state-invalid",
  "cleanup-failed",
  "unknown-external-failure",
  ...FATAL_AZURE_ABORT_CLASSIFICATIONS,
]);
const AZURE_UNAVAILABLE_CLASSIFICATIONS = new Set([
  "management-plane-provisioning",
  "readiness-timeout",
  "zones-exhausted",
]);
const AZURE_IGNORED_REASONS = new Set([
  "allocation-cleanup-not-started",
  "attempt-ended",
  "no-held-attempt",
  "not-assigned-azure",
]);
const AZURE_CLEANUP_IMMEDIATE_STAGES = new Set([
  "cleanup-pending",
  "cleanup-started",
  "provider-resources-deleted",
  "runner-registration-fenced",
]);
const AZURE_CLEANUP_WAIT_STAGES = new Set([
  "provider-operation-in-flight",
  "resource-deletion-pending",
]);

export class AllocationReconciler {
  readonly #azure: AzureReconciliationPort;
  readonly #github: GitHubWorkloadObservationPort;
  readonly #heartbeat: ReconcilerHeartbeatStore;
  readonly #incidents: ReconcilerIncidentPort;
  readonly #ledger: AllocationControlLedger;
  readonly #now: () => Date;
  readonly #visibility: LifecycleVisibilityPort;
  readonly #visibilityPerCallTimeoutMilliseconds: number;
  readonly #visibilityTotalTimeoutMilliseconds: number;

  constructor(options: {
    readonly azure: AzureReconciliationPort;
    readonly github: GitHubWorkloadObservationPort;
    readonly heartbeat: ReconcilerHeartbeatStore;
    readonly incidents: ReconcilerIncidentPort;
    readonly ledger: AllocationControlLedger;
    readonly now?: () => Date;
    readonly visibility: LifecycleVisibilityPort;
    readonly visibilityPerCallTimeoutMilliseconds?: number;
    readonly visibilityTotalTimeoutMilliseconds?: number;
  }) {
    this.#azure = options.azure;
    this.#github = options.github;
    this.#heartbeat = options.heartbeat;
    this.#incidents = options.incidents;
    this.#ledger = options.ledger;
    this.#now = options.now ?? (() => new Date());
    this.#visibility = options.visibility;
    this.#visibilityPerCallTimeoutMilliseconds = positiveTimeout(
      options.visibilityPerCallTimeoutMilliseconds ?? VISIBILITY_PER_CALL_TIMEOUT_MILLISECONDS,
    );
    this.#visibilityTotalTimeoutMilliseconds = positiveTimeout(
      options.visibilityTotalTimeoutMilliseconds ?? VISIBILITY_TOTAL_TIMEOUT_MILLISECONDS,
    );
  }

  /**
   * Run one bounded repair cycle. A production timer calls this every minute.
   * A heartbeat proves only a complete safety scan, never merely timer entry.
   */
  async runCycle(): Promise<ReconcilerCycleResult> {
    let completeScan = true;
    let continuationToken: string | undefined;
    let lifecycleFailures = 0;
    let pages = 0;
    let processedAllocations = 0;
    let visibilityFailures = 0;
    const seenAllocations = new Set<string>();
    const seenTokens = new Set<string>();
    const visibilityAllocations: string[] = [];
    const safetyDecisionStartedAt = new Map<string, string>();

    while (true) {
      if (pages >= RECONCILER_MAX_SCAN_PAGES) {
        completeScan = false;
        break;
      }
      let page: Awaited<ReturnType<AllocationControlLedger["listOpenAllocations"]>>;
      try {
        page = await this.#ledger.listOpenAllocations({
          ...(continuationToken === undefined ? {} : { continuationToken }),
          pageSize: RECONCILER_SCAN_PAGE_SIZE,
        });
      } catch {
        completeScan = false;
        lifecycleFailures += 1;
        break;
      }
      pages += 1;
      if (page.allocations.length > RECONCILER_SCAN_PAGE_SIZE) {
        completeScan = false;
        lifecycleFailures += 1;
        break;
      }
      for (const allocation of page.allocations) {
        if (seenAllocations.has(allocation.allocationId)) {
          completeScan = false;
          lifecycleFailures += 1;
          continue;
        }
        seenAllocations.add(allocation.allocationId);
        processedAllocations += 1;
        visibilityAllocations.push(allocation.allocationId);
        if (processedAllocations > RECONCILER_MAX_SCAN_ALLOCATIONS) {
          completeScan = false;
          continue;
        }
        safetyDecisionStartedAt.set(allocation.allocationId, requiredNow(this.#now));
        try {
          await this.#reconcileWithRetry(allocation.allocationId);
        } catch {
          lifecycleFailures += 1;
          await this.#raise(allocation.allocationId, "allocation-reconciliation-failed");
        }
      }
      const next = page.continuationToken;
      if (next === null) break;
      if (
        typeof next !== "string" ||
        next.length < 1 ||
        next.length > 4096 ||
        seenTokens.has(next)
      ) {
        completeScan = false;
        lifecycleFailures += 1;
        break;
      }
      seenTokens.add(next);
      continuationToken = next;
    }

    if (!completeScan) await this.#raise(null, "authoritative-scan-incomplete");
    const sweep = await this.#runFinalSafetySweep(safetyDecisionStartedAt);
    lifecycleFailures += sweep.lifecycleFailures;
    const heartbeatRecorded = completeScan && lifecycleFailures === 0 && sweep.heartbeatAt !== null;
    if (heartbeatRecorded) {
      await this.#heartbeat.recordReconcilerHeartbeat({ lastSucceededAt: sweep.heartbeatAt });
    }
    visibilityFailures = await this.#runVisibility(visibilityAllocations);
    return {
      completeScan,
      heartbeatRecorded,
      lifecycleFailures,
      processedAllocations,
      visibilityFailures,
    };
  }

  async #reconcileWithRetry(allocationId: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.#reconcileAllocation(allocationId);
        return;
      } catch (error) {
        if (
          !(error instanceof AllocationLedgerError) ||
          error.code !== "optimistic-concurrency-conflict" ||
          attempt === 2
        ) {
          throw error;
        }
      }
    }
  }

  async #reconcileAllocation(allocationId: string): Promise<void> {
    let allocation = await this.#requiredAllocation(allocationId);
    if (!allocationNeedsReconciliation(allocation)) return;
    if (allocation.lifecycleState === "ended") return;

    if (allocation.runnerAssignment === null) {
      await this.#reconcileUnassigned(allocation);
      return;
    }

    const initialAssignment = allocation.runnerAssignment;
    const initialAttempt = allocation.attempts[initialAssignment.attemptOrdinal - 1];
    let observation: CompleteGitHubObservation;
    try {
      observation = await this.#observeGitHub(allocation);
    } catch (error) {
      const failureAt = requiredNow(this.#now);
      if (
        initialAssignment.provider === "azure" &&
        initialAttempt?.provider === "azure" &&
        initialAttempt.deadlines !== null &&
        (allocation.lifecycleState === "cleanup_pending" ||
          failureAt >= initialAttempt.deadlines.latestSafeStart)
      ) {
        const cleanup = await this.#beginOrRefreshAllocationCleanup(
          allocation.allocationId,
          null,
          failureAt,
        );
        await this.#driveAssignedAzureCleanup(cleanup.allocationId);
        await this.#reflectAzureCleanup(cleanup.allocationId, null, requiredNow(this.#now));
      }
      throw error;
    }
    allocation = await this.#requiredAllocation(allocationId);
    const exactJob = exactMappedJob(allocation, observation.jobs);
    allocation = await this.#persistBindingResult(
      allocation,
      exactJob,
      observation.run,
      requiredNow(this.#now),
    );
    const terminalEvidence = terminalEvidenceFor(allocation, exactJob.job, observation.run);
    const assignment = allocation.runnerAssignment;
    if (assignment === null) throw new TypeError("assigned allocation lost its runner binding");

    const boundJobMissing = allocation.workloadBinding.state === "bound" && exactJob.job === null;
    const bindingIncident =
      allocation.workloadBinding.state === "binding-failed" ||
      exactJob.ambiguous ||
      boundJobMissing;
    if (assignment.provider === "blacksmith") {
      if (terminalEvidence !== null) {
        await this.#settleManagedAssignment(
          allocation.allocationId,
          terminalEvidence,
          requiredNow(this.#now),
        );
      }
      if (bindingIncident) throw new TypeError("managed workload binding failed");
      return;
    }

    const attempt = allocation.attempts[0];
    if (attempt?.provider !== "azure" || attempt.deadlines === null) {
      throw new TypeError("assigned Azure allocation lacks its immutable attempt deadline");
    }
    const jobStartedSafely =
      exactJob.job?.startedAt !== null &&
      exactJob.job?.startedAt !== undefined &&
      exactJob.job.startedAt <= attempt.deadlines.latestSafeStart;
    const decisionAt = requiredNow(this.#now);
    const cleanupDue =
      bindingIncident ||
      terminalEvidence !== null ||
      decisionAt >= attempt.deadlines.absoluteExpiry ||
      (!jobStartedSafely && decisionAt >= attempt.deadlines.latestSafeStart);
    if (!cleanupDue && allocation.lifecycleState !== "cleanup_pending") return;

    allocation = await this.#beginOrRefreshAllocationCleanup(
      allocation.allocationId,
      terminalEvidence,
      decisionAt,
    );
    await this.#driveAssignedAzureCleanup(allocation.allocationId);
    await this.#reflectAzureCleanup(
      allocation.allocationId,
      terminalEvidence,
      requiredNow(this.#now),
    );
    if (bindingIncident) throw new TypeError("Azure workload binding failed");
  }

  async #reconcileUnassigned(allocation: AllocationRecord): Promise<void> {
    const latest = allocation.attempts.at(-1);
    if (latest?.provider === "blacksmith" && latest.reservation.state === "held") {
      await this.#repairBlacksmithAssignment(allocation.allocationId, requiredNow(this.#now));
      const repaired = await this.#requiredAllocation(allocation.allocationId);
      const observation = await this.#observeGitHub(repaired);
      const exactJob = exactMappedJob(repaired, observation.jobs);
      const bound = await this.#persistBindingResult(
        repaired,
        exactJob,
        observation.run,
        requiredNow(this.#now),
      );
      const terminal = terminalEvidenceFor(bound, exactJob.job, observation.run);
      if (terminal !== null)
        await this.#settleManagedAssignment(bound.allocationId, terminal, requiredNow(this.#now));
      if (bound.workloadBinding.state === "binding-failed") {
        throw new TypeError("managed workload binding failed");
      }
      return;
    }

    if (latest?.provider === "azure" && latest.reservation.state === "held") {
      let observationFailure: unknown;
      try {
        const observation = await this.#observeGitHub(allocation);
        const decisionAt = requiredNow(this.#now);
        if (observation.run.state === "terminal") {
          await this.#beginUnassignedAzureAbort(
            allocation.allocationId,
            "workload-terminal-before-assignment",
            decisionAt,
          );
        }
      } catch (error) {
        observationFailure = error;
        const failureAt = requiredNow(this.#now);
        if (latest.deadlines !== null && failureAt >= latest.deadlines.absoluteExpiry) {
          await this.#beginUnassignedAzureAbort(
            allocation.allocationId,
            "allocation-expired-before-assignment",
            failureAt,
          );
        } else if (latest.deadlines !== null && failureAt >= latest.deadlines.latestSafeStart) {
          await this.#beginUnassignedAzureAbort(
            allocation.allocationId,
            "workload-start-unverified-at-cutoff",
            failureAt,
          );
        }
      }
      const current = await this.#requiredAllocation(allocation.allocationId);
      const currentAttempt = current.attempts[0];
      const cleanupAlreadyStarted =
        currentAttempt?.provider === "azure" &&
        (currentAttempt.fatalAbortIntent !== null ||
          currentAttempt.physicalGenerations.some(
            (generation) =>
              generation.state === "fenced" ||
              generation.state === "cleanup_pending" ||
              generation.state === "settled",
          ));
      if (observationFailure === undefined || cleanupAlreadyStarted) {
        if (cleanupAlreadyStarted) {
          await this.#driveUnassignedAzureCleanup(allocation.allocationId);
        } else {
          await this.#reconcileAzureProvisioning(allocation.allocationId);
        }
      }
      if (observationFailure !== undefined) throw observationFailure;
      return;
    }

    if (isDeterministicPolicyStop(allocation)) {
      const decisionAt = requiredNow(this.#now);
      const current = await this.#requiredAllocation(allocation.allocationId);
      await this.#ledger.stopAllocation({
        allocationId: current.allocationId,
        expectedRevision: current.revision,
        reason:
          current.acceptance.request.backupChoice === "Save money"
            ? "save-money"
            : "all-providers-unavailable",
        stoppedAt: monotonicTime(decisionAt, current.updatedAt),
      });
      return;
    }

    const abandonmentAt = new Date(
      Date.parse(allocation.createdAt) + UNASSIGNED_ABANDONMENT_MINUTES * 60_000,
    ).toISOString();
    const decisionAt = requiredNow(this.#now);
    if (decisionAt >= abandonmentAt && hasNoHeldOrUnsettledProviderWork(allocation)) {
      const current = await this.#requiredAllocation(allocation.allocationId);
      await this.#ledger.abandonUnassignedAllocation({
        abandonedAt: monotonicTime(decisionAt, current.updatedAt),
        allocationId: current.allocationId,
        expectedRevision: current.revision,
        reason: "controller-progress-timeout",
      });
    }
  }

  async #repairBlacksmithAssignment(allocationId: string, cycleAt: string): Promise<void> {
    let current = await this.#requiredAllocation(allocationId);
    let attempt = current.attempts[1];
    if (
      attempt?.provider !== "blacksmith" ||
      attempt.reservation.state !== "held" ||
      (attempt.outcome !== "pending" && attempt.outcome !== "succeeded")
    ) {
      throw new TypeError("held Blacksmith repair state is invalid");
    }
    if (attempt.outcome === "pending") {
      current = await this.#ledger.markProviderAttemptSucceeded({
        allocationId,
        expectedAllocationRevision: current.revision,
        expectedAttemptRevision: attempt.revision,
        ordinal: 2,
        succeededAt: monotonicTime(cycleAt, current.updatedAt, attempt.updatedAt),
      });
    }
    if (current.runnerAssignment === null) {
      current = await this.#requiredAllocation(allocationId);
      attempt = current.attempts[1];
      if (attempt?.provider !== "blacksmith" || attempt.outcome !== "succeeded") {
        throw new TypeError("Blacksmith assignment repair lost its successful attempt");
      }
      await this.#ledger.assignRunner({
        allocationId,
        assignment: {
          assignedAt: monotonicTime(cycleAt, current.updatedAt, attempt.updatedAt),
          attemptOrdinal: 2,
          provider: "blacksmith",
          runnerLabel: current.acceptance.trust.workload.blacksmithRunnerLabel,
        },
        expectedAllocationRevision: current.revision,
      });
    }
  }

  async #beginUnassignedAzureAbort(
    allocationId: string,
    classification:
      | "allocation-expired-before-assignment"
      | "workload-start-unverified-at-cutoff"
      | "workload-terminal-before-assignment",
    cycleAt: string,
  ): Promise<void> {
    const current = await this.#requiredAllocation(allocationId);
    const attempt = current.attempts[0];
    if (
      current.runnerAssignment !== null ||
      attempt?.provider !== "azure" ||
      attempt.reservation.state !== "held"
    ) {
      return;
    }
    if (attempt.fatalAbortIntent !== null) return;
    await this.#ledger.beginFatalAzureAbort({
      allocationId,
      classification,
      expectedAllocationRevision: current.revision,
      expectedAttemptRevision: attempt.revision,
      ordinal: 1,
      recordedAt: monotonicTime(cycleAt, current.updatedAt, attempt.updatedAt),
    });
  }

  async #persistBindingResult(
    allocation: AllocationRecord,
    exact: ExactJobResult,
    run: GitHubRunObservation,
    cycleAt: string,
  ): Promise<AllocationRecord> {
    if (
      allocation.workloadBinding.state === "bound" ||
      allocation.workloadBinding.state === "binding-failed"
    ) {
      return allocation;
    }
    if (exact.ambiguous) {
      return this.#updateBinding(
        allocation,
        { reason: "ambiguous-job", state: "binding-failed" },
        cycleAt,
      );
    }
    if (exact.job !== null) {
      return this.#updateBinding(
        allocation,
        { githubJobId: exact.job.githubJobId, state: "bound" },
        cycleAt,
      );
    }
    if (run.state === "terminal" && allocation.runnerAssignment?.provider === "blacksmith") {
      return this.#updateBinding(
        allocation,
        { reason: "expected-job-missing", state: "binding-failed" },
        cycleAt,
      );
    }
    return allocation;
  }

  async #updateBinding(
    allocation: AllocationRecord,
    workloadBinding: AllocationRecord["workloadBinding"],
    cycleAt: string,
  ): Promise<AllocationRecord> {
    const current = await this.#requiredAllocation(allocation.allocationId);
    if (
      current.workloadBinding.state === "bound" ||
      current.workloadBinding.state === "binding-failed"
    ) {
      return current;
    }
    return this.#ledger.updateAllocationState({
      allocationId: current.allocationId,
      expectedRevision: current.revision,
      patch: { workloadBinding },
      updatedAt: monotonicTime(cycleAt, current.updatedAt),
    });
  }

  async #settleManagedAssignment(
    allocationId: string,
    evidence: TerminalEvidence,
    cycleAt: string,
  ): Promise<void> {
    let current = await this.#requiredAllocation(allocationId);
    const attempt = current.attempts[1];
    if (
      current.runnerAssignment?.provider !== "blacksmith" ||
      attempt?.provider !== "blacksmith" ||
      attempt.reservation.state !== "held"
    ) {
      return;
    }
    if (current.cleanup.phase !== "settled") {
      const settledAt = monotonicTime(cycleAt, current.updatedAt, evidence.concludedAt);
      current = await this.#ledger.updateAllocationState({
        allocationId,
        expectedRevision: current.revision,
        patch: {
          cleanup: {
            phase: "settled",
            providerResourcesSettled: true,
            runnerRegistrationSettled: true,
            settledAt,
            terminalEvidence: evidence,
          },
          lifecycleState: "cleanup_pending",
        },
        updatedAt: settledAt,
      });
    }
    const latestAttempt = current.attempts[1];
    if (latestAttempt?.provider !== "blacksmith" || latestAttempt.reservation.state !== "held")
      return;
    const settledAt = monotonicTime(cycleAt, current.updatedAt, latestAttempt.updatedAt);
    await this.#ledger.settleFinalProviderAttempt({
      allocationId,
      cleanup: settledAttemptCleanup(settledAt),
      expectedAllocationRevision: current.revision,
      expectedAttemptRevision: latestAttempt.revision,
      finalCostUsdCents: latestAttempt.reservation.reservedCostUsdCents,
      ordinal: 2,
      settledAt,
    });
  }

  async #beginOrRefreshAllocationCleanup(
    allocationId: string,
    evidence: TerminalEvidence | null,
    cycleAt: string,
  ): Promise<AllocationRecord> {
    const current = await this.#requiredAllocation(allocationId);
    if (current.lifecycleState === "ended") return current;
    const terminalEvidence = current.cleanup.terminalEvidence ?? evidence;
    if (
      current.lifecycleState === "cleanup_pending" &&
      terminalEvidence === current.cleanup.terminalEvidence
    ) {
      return current;
    }
    return this.#ledger.updateAllocationState({
      allocationId,
      expectedRevision: current.revision,
      patch: {
        cleanup: {
          ...current.cleanup,
          phase: "pending",
          terminalEvidence,
        },
        lifecycleState: "cleanup_pending",
      },
      updatedAt: monotonicTime(cycleAt, current.updatedAt, terminalEvidence?.concludedAt),
    });
  }

  async #reflectAzureCleanup(
    allocationId: string,
    evidence: TerminalEvidence | null,
    cycleAt: string,
  ): Promise<void> {
    let current = await this.#requiredAllocation(allocationId);
    const attempt = current.attempts[0];
    const generation = attempt?.physicalGenerations[0];
    if (attempt?.provider !== "azure" || generation === undefined) {
      throw new TypeError("assigned Azure cleanup lost generation state");
    }
    const providerResourcesSettled = generation.cleanup.providerResourcesSettled;
    const runnerRegistrationSettled = generation.cleanup.runnerRegistrationSettled;
    const terminalEvidence = current.cleanup.terminalEvidence ?? evidence;
    const allSettled =
      generation.cleanup.phase === "settled" &&
      providerResourcesSettled &&
      runnerRegistrationSettled &&
      terminalEvidence !== null;
    if (
      current.cleanup.providerResourcesSettled !== providerResourcesSettled ||
      current.cleanup.runnerRegistrationSettled !== runnerRegistrationSettled ||
      (current.cleanup.terminalEvidence === null && terminalEvidence !== null) ||
      (allSettled && current.cleanup.phase !== "settled")
    ) {
      const updatedAt = monotonicTime(
        cycleAt,
        current.updatedAt,
        generation.updatedAt,
        terminalEvidence?.concludedAt,
      );
      current = await this.#ledger.updateAllocationState({
        allocationId,
        expectedRevision: current.revision,
        patch: {
          cleanup: {
            phase: allSettled ? "settled" : "pending",
            providerResourcesSettled,
            runnerRegistrationSettled,
            settledAt: allSettled ? updatedAt : null,
            terminalEvidence,
          },
          lifecycleState: "cleanup_pending",
        },
        updatedAt,
      });
    }
    const latestAttempt = current.attempts[0];
    if (
      current.cleanup.phase !== "settled" ||
      latestAttempt?.provider !== "azure" ||
      latestAttempt.reservation.state !== "held"
    ) {
      return;
    }
    const settledAt = monotonicTime(cycleAt, current.updatedAt, latestAttempt.updatedAt);
    await this.#ledger.settleFinalProviderAttempt({
      allocationId,
      cleanup: settledAttemptCleanup(settledAt),
      expectedAllocationRevision: current.revision,
      expectedAttemptRevision: latestAttempt.revision,
      finalCostUsdCents: latestAttempt.reservation.reservedCostUsdCents,
      ordinal: 1,
      settledAt,
    });
  }

  async #observeGitHub(allocation: AllocationRecord): Promise<CompleteGitHubObservation> {
    const signal = AbortSignal.timeout(GITHUB_OBSERVATION_TIMEOUT_MILLISECONDS);
    const runValue = await this.#github.getRun(allocation.identity, { signal });
    const run = validateRunObservation(runValue, allocation.identity, requiredNow(this.#now));
    const jobs: GitHubJobObservation[] = [];
    const seenIds = new Set<string>();
    const seenTokens = new Set<string>();
    let continuationToken: string | undefined;
    for (let pageNumber = 0; pageNumber < GITHUB_MAX_JOB_PAGES; pageNumber += 1) {
      const page = validateJobPage(
        await this.#github.listJobs({
          ...(continuationToken === undefined ? {} : { continuationToken }),
          identity: allocation.identity,
          pageSize: GITHUB_JOB_PAGE_SIZE,
          signal,
        }),
        allocation.identity,
        requiredNow(this.#now),
      );
      if (page.jobs.length > GITHUB_JOB_PAGE_SIZE)
        throw new TypeError("GitHub job page is oversized");
      for (const job of page.jobs) {
        if (seenIds.has(job.githubJobId)) throw new TypeError("GitHub job ID appears twice");
        seenIds.add(job.githubJobId);
        jobs.push(job);
        if (jobs.length > GITHUB_MAX_JOBS) throw new TypeError("GitHub job scan bound exceeded");
      }
      if (page.continuationToken === null) return { jobs, run };
      if (seenTokens.has(page.continuationToken))
        throw new TypeError("GitHub pagination repeated a token");
      seenTokens.add(page.continuationToken);
      continuationToken = page.continuationToken;
    }
    throw new TypeError("GitHub job page bound exceeded");
  }

  async #reconcileAzureProvisioning(allocationId: string): Promise<void> {
    const result = parseAzureWorkerResult(
      await this.#azure.reconcile({ allocation_id: allocationId, ordinal: 1, provider: "azure" }),
      allocationId,
    );
    if (result.outcome === "incident" || result.outcome === "ignored") {
      throw new TypeError(`Azure worker returned ${result.outcome} during provisioning`);
    }
    if (
      result.outcome === "progress" &&
      (AZURE_CLEANUP_IMMEDIATE_STAGES.has(result.stage) || result.stage === "resources-deleted")
    ) {
      await this.#driveUnassignedAzureCleanup(allocationId, result);
    }
  }

  async #driveAssignedAzureCleanup(allocationId: string): Promise<void> {
    const seenImmediateStages = new Set<string>();
    for (let step = 0; step < AZURE_CLEANUP_MAX_STEPS_PER_CYCLE; step += 1) {
      const result = parseAzureWorkerResult(
        await this.#azure.reconcileAssignedCleanup({ allocationId }),
        allocationId,
      );
      if (result.outcome === "incident") {
        throw new TypeError(`Azure cleanup incident: ${result.code}`);
      }
      if (result.outcome !== "progress") {
        throw new TypeError(`unexpected assigned Azure cleanup result: ${result.outcome}`);
      }
      if (result.stage === "resources-deleted") return;
      if (AZURE_CLEANUP_WAIT_STAGES.has(result.stage)) return;
      if (!AZURE_CLEANUP_IMMEDIATE_STAGES.has(result.stage)) {
        throw new TypeError(`unexpected assigned Azure cleanup stage: ${result.stage}`);
      }
      if (seenImmediateStages.has(result.stage)) {
        throw new TypeError(`Azure cleanup made no durable progress at ${result.stage}`);
      }
      seenImmediateStages.add(result.stage);
    }
    throw new TypeError("Azure cleanup exceeded its per-cycle progress bound");
  }

  async #driveUnassignedAzureCleanup(
    allocationId: string,
    initialResult?: ValidatedAzureWorkerResult,
  ): Promise<void> {
    const seenImmediateStages = new Set<string>();
    for (let step = 0; step < AZURE_CLEANUP_MAX_STEPS_PER_CYCLE; step += 1) {
      const result =
        step === 0 && initialResult !== undefined
          ? initialResult
          : parseAzureWorkerResult(
              await this.#azure.reconcile({
                allocation_id: allocationId,
                ordinal: 1,
                provider: "azure",
              }),
              allocationId,
            );
      if (result.outcome === "incident") {
        throw new TypeError(`Azure cleanup incident: ${result.code}`);
      }
      if (result.outcome === "unavailable") return;
      if (result.outcome !== "progress") {
        throw new TypeError(`unexpected unassigned Azure cleanup result: ${result.outcome}`);
      }
      if (AZURE_CLEANUP_WAIT_STAGES.has(result.stage)) return;
      if (
        result.stage !== "resources-deleted" &&
        !AZURE_CLEANUP_IMMEDIATE_STAGES.has(result.stage)
      ) {
        throw new TypeError(`unexpected unassigned Azure cleanup stage: ${result.stage}`);
      }
      if (seenImmediateStages.has(result.stage)) {
        throw new TypeError(`Azure cleanup made no durable progress at ${result.stage}`);
      }
      seenImmediateStages.add(result.stage);
    }
    throw new TypeError("Azure cleanup exceeded its per-cycle progress bound");
  }

  async #runVisibility(allocationIds: readonly string[]): Promise<number> {
    const deadline = Date.now() + this.#visibilityTotalTimeoutMilliseconds;
    let failures = 0;
    for (const allocationId of allocationIds) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        failures += 1;
        continue;
      }
      const timeoutMilliseconds = Math.min(remaining, this.#visibilityPerCallTimeoutMilliseconds);
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let operation: Promise<void>;
      try {
        operation = this.#visibility.reconcile(allocationId, { signal: controller.signal });
      } catch {
        failures += 1;
        continue;
      }
      operation.catch(() => undefined);
      const timedOut = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("visibility reconciliation timed out"));
        }, timeoutMilliseconds);
      });
      try {
        await Promise.race([operation, timedOut]);
      } catch {
        failures += 1;
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    }
    return failures;
  }

  async #runFinalSafetySweep(
    safetyDecisionStartedAt: Map<string, string>,
  ): Promise<FinalSafetySweepResult> {
    let lifecycleFailures = 0;
    const knownDeadlines = new Map<string, readonly string[]>();
    for (let pass = 0; pass < FINAL_SAFETY_SWEEP_MAX_PASSES; pass += 1) {
      for (const [allocationId, lastDecisionAt] of safetyDecisionStartedAt) {
        let allocation: AllocationRecord;
        try {
          allocation = await this.#requiredAllocation(allocationId);
        } catch {
          lifecycleFailures += 1;
          await this.#raise(allocationId, "allocation-reconciliation-failed");
          continue;
        }
        const checkedAt = requiredNow(this.#now);
        const deadlines = applicableSafetyDeadlines(allocation);
        knownDeadlines.set(allocationId, deadlines);
        if (!hasDeadlineCrossing(deadlines, lastDecisionAt, checkedAt)) continue;
        safetyDecisionStartedAt.set(allocationId, requiredNow(this.#now));
        try {
          await this.#reconcileWithRetry(allocationId);
        } catch {
          lifecycleFailures += 1;
          await this.#raise(allocationId, "allocation-reconciliation-failed");
        }
      }

      const heartbeatAt = requiredNow(this.#now);
      const pending = [...knownDeadlines].filter(([allocationId, deadlines]) => {
        const lastDecisionAt = safetyDecisionStartedAt.get(allocationId);
        return (
          lastDecisionAt !== undefined &&
          hasDeadlineCrossing(deadlines, lastDecisionAt, heartbeatAt)
        );
      });
      if (pending.length === 0) return { heartbeatAt, lifecycleFailures };
      if (pass + 1 < FINAL_SAFETY_SWEEP_MAX_PASSES) continue;
      for (const [allocationId] of pending) {
        lifecycleFailures += 1;
        await this.#raise(allocationId, "allocation-reconciliation-failed");
      }
    }
    return { heartbeatAt: null, lifecycleFailures };
  }

  async #requiredAllocation(allocationId: string): Promise<AllocationRecord> {
    const allocation = await this.#ledger.getAllocation(allocationId);
    if (allocation === undefined) throw new TypeError("enumerated allocation disappeared");
    return allocation;
  }

  async #raise(
    allocationId: string | null,
    classification: Parameters<ReconcilerIncidentPort["raise"]>[0]["classification"],
  ): Promise<void> {
    try {
      await this.#incidents.raise({ allocationId, classification });
    } catch {
      // Alert delivery never replaces the original safety result.
    }
  }
}

function exactMappedJob(
  allocation: AllocationRecord,
  jobs: readonly GitHubJobObservation[],
): ExactJobResult {
  const expectedName = allocation.acceptance.trust.workload.jobName;
  const expectedLabel = allocation.runnerAssignment?.runnerLabel;
  if (expectedLabel === undefined) return { ambiguous: false, job: null };
  const nameMatches = jobs.filter((job) => job.jobName === expectedName);
  const labelConsumers = jobs.filter((job) => hasLabel(job.runnerLabels, expectedLabel));
  if (nameMatches.length > 1 || labelConsumers.length > 1) return { ambiguous: true, job: null };
  const matched = nameMatches[0];
  if (matched === undefined) {
    return { ambiguous: labelConsumers.length !== 0, job: null };
  }
  if (!hasLabel(matched.runnerLabels, expectedLabel)) return { ambiguous: true, job: null };
  const durable = allocation.workloadBinding;
  if (durable.state === "bound" && durable.githubJobId !== matched.githubJobId) {
    return { ambiguous: true, job: null };
  }
  return { ambiguous: false, job: matched };
}

function terminalEvidenceFor(
  allocation: AllocationRecord,
  job: GitHubJobObservation | null,
  run: GitHubRunObservation,
): TerminalEvidence | null {
  if (
    job?.state === "terminal" &&
    job.conclusion !== null &&
    job.concludedAt !== null &&
    allocation.workloadBinding.state === "bound" &&
    allocation.workloadBinding.githubJobId === job.githubJobId
  ) {
    return {
      concludedAt: job.concludedAt,
      conclusion: job.conclusion,
      githubJobId: job.githubJobId,
      source: "github-job",
    };
  }
  if (run.state === "terminal" && run.conclusion !== null && run.concludedAt !== null) {
    return {
      concludedAt: run.concludedAt,
      conclusion: run.conclusion,
      repositoryId: allocation.identity.repository_id,
      runAttempt: allocation.identity.run_attempt,
      runId: allocation.identity.run_id,
      source: "github-workflow-run",
    };
  }
  return null;
}

function validateRunObservation(
  value: unknown,
  identity: AllocationIdentity,
  observedAt: string,
): GitHubRunObservation {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      "repositoryId",
      "runId",
      "runAttempt",
      "state",
      "conclusion",
      "concludedAt",
    ])
  ) {
    throw new TypeError("GitHub run observation shape is invalid");
  }
  if (
    value.repositoryId !== identity.repository_id ||
    value.runId !== identity.run_id ||
    value.runAttempt !== identity.run_attempt ||
    (value.state !== "active" && value.state !== "terminal")
  ) {
    throw new TypeError("GitHub run observation identity or state is invalid");
  }
  const conclusion = terminalConclusion(value.conclusion, value.state, "run");
  const concludedAt = terminalTimestamp(value.concludedAt, value.state, "run", observedAt);
  return {
    concludedAt,
    conclusion,
    repositoryId: value.repositoryId,
    runAttempt: value.runAttempt,
    runId: value.runId,
    state: value.state,
  };
}

function validateJobPage(
  value: unknown,
  identity: AllocationIdentity,
  observedAt: string,
): GitHubJobObservationPage {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["repositoryId", "runId", "runAttempt", "jobs", "continuationToken"]) ||
    !Array.isArray(value.jobs)
  ) {
    throw new TypeError("GitHub job page shape is invalid");
  }
  if (
    value.repositoryId !== identity.repository_id ||
    value.runId !== identity.run_id ||
    value.runAttempt !== identity.run_attempt
  ) {
    throw new TypeError("GitHub job page identity is invalid");
  }
  if (
    value.continuationToken !== null &&
    (typeof value.continuationToken !== "string" ||
      value.continuationToken.length < 1 ||
      value.continuationToken.length > 4096)
  ) {
    throw new TypeError("GitHub job continuation token is invalid");
  }
  return {
    continuationToken: value.continuationToken,
    jobs: value.jobs.map((job) => validateJobObservation(job, observedAt)),
    repositoryId: value.repositoryId,
    runAttempt: value.runAttempt,
    runId: value.runId,
  };
}

function validateJobObservation(value: unknown, observedAt: string): GitHubJobObservation {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      "githubJobId",
      "jobName",
      "runnerLabels",
      "state",
      "conclusion",
      "concludedAt",
      "startedAt",
    ]) ||
    !Array.isArray(value.runnerLabels)
  ) {
    throw new TypeError("GitHub job observation shape is invalid");
  }
  if (
    !isPositiveDecimal(value.githubJobId) ||
    typeof value.jobName !== "string" ||
    value.jobName.length < 1 ||
    value.jobName.length > 256 ||
    value.runnerLabels.some(
      (label) => typeof label !== "string" || label.length < 1 || label.length > 256,
    ) ||
    (value.state !== "queued" && value.state !== "in_progress" && value.state !== "terminal")
  ) {
    throw new TypeError("GitHub job observation values are invalid");
  }
  const conclusion = terminalConclusion(value.conclusion, value.state, "job");
  const concludedAt = terminalTimestamp(value.concludedAt, value.state, "job", observedAt);
  const startedAt = startedTimestamp(value.startedAt, value.state, observedAt);
  if (concludedAt !== null && startedAt !== null && concludedAt < startedAt) {
    throw new TypeError("GitHub job concluded before it started");
  }
  return {
    concludedAt,
    conclusion,
    githubJobId: value.githubJobId,
    jobName: value.jobName,
    runnerLabels: [...value.runnerLabels],
    startedAt,
    state: value.state,
  };
}

function terminalConclusion(
  value: unknown,
  state: string,
  kind: string,
): GitHubTerminalConclusion | null {
  if (state !== "terminal") {
    if (value !== null) throw new TypeError(`active GitHub ${kind} has a conclusion`);
    return null;
  }
  if (typeof value !== "string" || value.length < 1 || value.length > 64) {
    throw new TypeError(`terminal GitHub ${kind} conclusion is invalid`);
  }
  if (
    value === "succeeded" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "timed_out"
  ) {
    return value;
  }
  return "failed";
}

function startedTimestamp(
  value: unknown,
  state: GitHubJobObservation["state"],
  observedAt: string,
): string | null {
  if (state === "queued") {
    if (value !== null) throw new TypeError("queued GitHub job has a start timestamp");
    return null;
  }
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value ||
    value > observedAt
  ) {
    throw new TypeError("started GitHub job timestamp is invalid");
  }
  return value;
}

function terminalTimestamp(
  value: unknown,
  state: string,
  kind: string,
  observedAt: string,
): string | null {
  if (state !== "terminal") {
    if (value !== null) throw new TypeError(`active GitHub ${kind} has a terminal timestamp`);
    return null;
  }
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value ||
    value > observedAt
  ) {
    throw new TypeError(`terminal GitHub ${kind} timestamp is invalid`);
  }
  return value;
}

function isDeterministicPolicyStop(allocation: AllocationRecord): boolean {
  if (allocation.runnerAssignment !== null || allocation.attempts.length === 0) return false;
  if (
    allocation.attempts.some(
      (attempt) => attempt.outcome !== "unavailable" || attempt.reservation.state === "held",
    )
  )
    return false;
  return (
    (allocation.acceptance.request.backupChoice === "Save money" &&
      allocation.attempts.length === 1) ||
    (allocation.acceptance.request.backupChoice === "Keep going" &&
      allocation.attempts.length === 2)
  );
}

function hasNoHeldOrUnsettledProviderWork(allocation: AllocationRecord): boolean {
  return (
    allocation.runnerAssignment === null &&
    allocation.attempts.every(
      (attempt) =>
        attempt.outcome === "unavailable" &&
        attempt.reservation.state !== "held" &&
        attempt.cleanup.phase === "settled" &&
        attempt.cleanup.providerResourcesSettled &&
        attempt.cleanup.runnerRegistrationSettled,
    )
  );
}

function applicableSafetyDeadlines(allocation: AllocationRecord): readonly string[] {
  if (allocation.lifecycleState === "ended") return [];
  const deadlines = allocation.attempts.flatMap((attempt) =>
    attempt.provider === "azure" &&
    attempt.reservation.state === "held" &&
    attempt.deadlines !== null
      ? [attempt.deadlines.latestSafeStart, attempt.deadlines.absoluteExpiry]
      : [],
  );
  if (allocation.runnerAssignment === null && hasNoHeldOrUnsettledProviderWork(allocation)) {
    deadlines.push(
      new Date(
        Date.parse(allocation.createdAt) + UNASSIGNED_ABANDONMENT_MINUTES * 60_000,
      ).toISOString(),
    );
  }
  return deadlines;
}

function hasDeadlineCrossing(
  deadlines: readonly string[],
  lastDecisionAt: string,
  checkedAt: string,
): boolean {
  return deadlines.some((deadline) => deadline > lastDecisionAt && deadline <= checkedAt);
}

function settledAttemptCleanup(settledAt: string): AttemptCleanupState {
  return {
    phase: "settled",
    providerResourcesSettled: true,
    runnerRegistrationSettled: true,
    settledAt,
  };
}

function hasLabel(labels: readonly string[], expected: string): boolean {
  const canonical = expected.toLowerCase();
  return labels.some((label) => label.toLowerCase() === canonical);
}

function monotonicTime(
  primary: string,
  ...lowerBounds: readonly (string | null | undefined)[]
): string {
  return lowerBounds.reduce<string>(
    (latest, value) => (value !== null && value !== undefined && value > latest ? value : latest),
    primary,
  );
}

function requiredNow(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf()))
    throw new TypeError("reconciler clock is invalid");
  return value.toISOString();
}

function parseAzureWorkerResult(
  value: unknown,
  expectedAllocationId: string,
): ValidatedAzureWorkerResult {
  if (!isPlainRecord(value) || value.allocationId !== expectedAllocationId) {
    throw new TypeError("Azure worker result identity is invalid");
  }
  switch (value.outcome) {
    case "ignored":
      if (
        !hasExactKeys(value, ["allocationId", "outcome", "reason"]) ||
        typeof value.reason !== "string" ||
        !AZURE_IGNORED_REASONS.has(value.reason)
      ) {
        throw new TypeError("Azure ignored result is invalid");
      }
      return {
        allocationId: expectedAllocationId,
        outcome: "ignored",
        reason: value.reason,
      };
    case "progress":
      if (
        !hasExactKeys(value, ["allocationId", "outcome", "stage"]) ||
        typeof value.stage !== "string" ||
        !AZURE_PROGRESS_STAGES.has(value.stage)
      ) {
        throw new TypeError("Azure progress result is invalid");
      }
      return {
        allocationId: expectedAllocationId,
        outcome: "progress",
        stage: value.stage,
      };
    case "incident":
      if (
        !hasExactKeys(value, ["allocationId", "code", "cleanupPending", "outcome"]) ||
        typeof value.code !== "string" ||
        !AZURE_INCIDENT_CODES.has(value.code) ||
        typeof value.cleanupPending !== "boolean"
      ) {
        throw new TypeError("Azure incident result is invalid");
      }
      return {
        allocationId: expectedAllocationId,
        cleanupPending: value.cleanupPending,
        code: value.code,
        outcome: "incident",
      };
    case "unavailable":
      if (
        !hasExactKeys(value, ["allocationId", "classification", "outcome"]) ||
        typeof value.classification !== "string" ||
        !AZURE_UNAVAILABLE_CLASSIFICATIONS.has(value.classification)
      ) {
        throw new TypeError("Azure unavailable result is invalid");
      }
      return {
        allocationId: expectedAllocationId,
        classification: value.classification,
        outcome: "unavailable",
      };
    case "ready":
      if (
        !hasExactKeys(value, ["allocationId", "outcome", "runnerLabel"]) ||
        value.runnerLabel !== azureRunnerLabelForAllocation(expectedAllocationId)
      ) {
        throw new TypeError("Azure ready result is invalid");
      }
      return {
        allocationId: expectedAllocationId,
        outcome: "ready",
        runnerLabel: value.runnerLabel,
      };
    default:
      throw new TypeError("Azure worker result outcome is invalid");
  }
}

function positiveTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
    throw new TypeError("visibility timeout is invalid");
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isPositiveDecimal(value: unknown): value is string {
  return typeof value === "string" && /^[1-9]\d*$/.test(value);
}
