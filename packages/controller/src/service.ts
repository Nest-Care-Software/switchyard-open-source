import {
  AllocationLedgerError,
  evaluateControllerReadiness,
  type AllocationControlLedger,
  type AllocationFailure,
  type AllocationRecord,
  type AzureAttemptDeadlines,
  type CheckRunCreationStore,
  type ControllerHealthSnapshot,
  type ReconcilerHeartbeatStore,
  type VerifiedWorkloadTrust,
} from "@switchyard/core";

import {
  projectAllocationControllerState,
  type ControllerAllocationProjection,
} from "./projection.js";
import {
  ProofVerificationError,
  type AllocationRequestSecurityVerifier,
  type VerifiedAllocationRequestSecurityDecision,
} from "./proof.js";

export const ALLOCATION_RETRY_AFTER_SECONDS = 5;

export type AllocationServiceResult =
  | { readonly allocationId: string; readonly status: "pending" }
  | { readonly allocationId: string; readonly runnerLabel: string; readonly status: "ready" };

export type AllocationServiceErrorCode =
  | "allocation-conflict"
  | "allocation-not-authorised"
  | "controller-unavailable"
  | "internal-error"
  | "runner-unavailable";

export class AllocationServiceError extends Error {
  readonly code: AllocationServiceErrorCode;

  constructor(code: AllocationServiceErrorCode) {
    super("The allocation request could not be completed");
    this.name = "AllocationServiceError";
    this.code = code;
  }
}

export interface PostTrustAllocationState {
  readonly heartbeat: ReconcilerHeartbeatStore;
  readonly ledger: AllocationControlLedger;
}

/** The control-state capability is not supplied until the security decision exists. */
export interface PostTrustAllocationStateProvider {
  open(decision: VerifiedAllocationRequestSecurityDecision): Promise<PostTrustAllocationState>;
}

export interface ControllerDependencyHealthPort {
  read(): Promise<
    Pick<ControllerHealthSnapshot, "authoritativeLedger" | "doppler" | "switchyardApi">
  >;
}

export type AcceptedCheckRunResult =
  | { readonly checkRunId: string; readonly outcome: "completed" }
  | { readonly outcome: "deferred" };

export interface AcceptedCheckRunPort {
  ensureAccepted(input: {
    readonly allocation: AllocationRecord;
    readonly store: CheckRunCreationStore;
  }): Promise<AcceptedCheckRunResult>;
}

export interface AllocationAdmissionPlanner {
  planAzure(input: {
    readonly allocationCreatedAt: string;
    readonly attemptedAt: string;
    readonly trust: VerifiedWorkloadTrust;
  }): Promise<{
    readonly deadlines: AzureAttemptDeadlines;
    readonly worstCaseCostUsdCents: number;
  }>;
  planBlacksmith(input: {
    readonly attemptedAt: string;
    readonly trust: VerifiedWorkloadTrust;
  }): Promise<{ readonly worstCaseCostUsdCents: number }>;
}

export interface AzureProvisioningDispatchPort {
  dispatch(request: {
    readonly allocation_id: string;
    readonly ordinal: 1;
    readonly provider: "azure";
  }): Promise<void>;
}

export interface PortableAllocationServiceOptions {
  readonly admission: AllocationAdmissionPlanner;
  readonly azureDispatch: AzureProvisioningDispatchPort;
  readonly checkRunAppSlug: string;
  readonly checkRuns: AcceptedCheckRunPort;
  readonly dependencyHealth: ControllerDependencyHealthPort;
  readonly now?: () => Date;
  readonly security: AllocationRequestSecurityVerifier;
  readonly state: PostTrustAllocationStateProvider;
}

/** Pure injected orchestration. This package registers no HTTP or Function runtime. */
export class PortableAllocationService {
  readonly #admission: AllocationAdmissionPlanner;
  readonly #azureDispatch: AzureProvisioningDispatchPort;
  readonly #checkRunAppSlug: string;
  readonly #checkRuns: AcceptedCheckRunPort;
  readonly #dependencyHealth: ControllerDependencyHealthPort;
  readonly #now: () => Date;
  readonly #security: AllocationRequestSecurityVerifier;
  readonly #state: PostTrustAllocationStateProvider;

  constructor(options: PortableAllocationServiceOptions) {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(options.checkRunAppSlug)) {
      throw new TypeError("checkRunAppSlug is invalid");
    }
    this.#admission = options.admission;
    this.#azureDispatch = options.azureDispatch;
    this.#checkRunAppSlug = options.checkRunAppSlug;
    this.#checkRuns = options.checkRuns;
    this.#dependencyHealth = options.dependencyHealth;
    this.#now = options.now ?? (() => new Date());
    this.#security = options.security;
    this.#state = options.state;
  }

  async allocate(input: unknown): Promise<AllocationServiceResult> {
    let decision: VerifiedAllocationRequestSecurityDecision;
    try {
      decision = await this.#security.verify(input);
    } catch (error) {
      if (error instanceof ProofVerificationError) {
        throw new AllocationServiceError(
          error.classification === "invalid-proof"
            ? "allocation-not-authorised"
            : "controller-unavailable",
        );
      }
      throw new AllocationServiceError("controller-unavailable");
    }

    let state: PostTrustAllocationState;
    let health: ControllerHealthSnapshot;
    const now = this.#requiredNow();
    try {
      state = await this.#state.open(decision);
      const [dependencies, heartbeat] = await Promise.all([
        this.#dependencyHealth.read(),
        state.heartbeat.getReconcilerHeartbeat(),
      ]);
      if (heartbeat === null) {
        throw new TypeError("reconciler heartbeat is not initialised");
      }
      health = {
        ...dependencies,
        reconciler: { lastSucceededAt: heartbeat.lastSucceededAt },
        trustVerification: "verified",
      };
    } catch {
      throw new AllocationServiceError("controller-unavailable");
    }
    const readiness = evaluateControllerReadiness(health, now);
    if (!readiness.ready) {
      throw new AllocationServiceError(
        readiness.failure.classification === "security-failure"
          ? "allocation-not-authorised"
          : "controller-unavailable",
      );
    }

    let allocation: AllocationRecord;
    try {
      allocation = (
        await state.ledger.acceptAllocation({
          acceptedAt: now.toISOString(),
          checkRunAppSlug: this.#checkRunAppSlug,
          evidence: {
            request: {
              backupChoice: decision.policyInput.backupChoice,
              profile: decision.policyInput.profile,
            },
            trust: decision.trust,
          },
        })
      ).allocation;
    } catch (error) {
      throw normaliseStateError(error);
    }

    for (let transition = 0; transition < 12; transition += 1) {
      const transitionNow = this.#requiredNow();
      if (!evaluateControllerReadiness(health, transitionNow).ready) {
        throw new AllocationServiceError("controller-unavailable");
      }
      const projection = projectAllocationControllerState({
        allocation,
        controllerHealth: health,
        now: transitionNow,
      });
      try {
        const result = await this.#applyProjection(projection, allocation, state.ledger);
        if ("response" in result) return result.response;
        allocation = result.allocation;
      } catch (error) {
        if (
          error instanceof AllocationLedgerError &&
          error.code === "optimistic-concurrency-conflict"
        ) {
          const reloaded = await state.ledger.getAllocation(allocation.allocationId);
          if (reloaded === undefined) throw new AllocationServiceError("controller-unavailable");
          allocation = reloaded;
          continue;
        }
        throw normaliseStateError(error);
      }
    }
    throw new AllocationServiceError("controller-unavailable");
  }

  async #applyProjection(
    projection: ControllerAllocationProjection,
    allocation: AllocationRecord,
    ledger: AllocationControlLedger,
  ): Promise<
    { readonly allocation: AllocationRecord } | { readonly response: AllocationServiceResult }
  > {
    switch (projection.action) {
      case "await-check-run": {
        const coordinated = await this.#checkRuns.ensureAccepted({ allocation, store: ledger });
        if (coordinated.outcome === "deferred") {
          return { response: { allocationId: allocation.allocationId, status: "pending" } };
        }
        const updated = await ledger.getAllocation(allocation.allocationId);
        if (
          updated === undefined ||
          updated.checkRunCreation.delivery.lifecycle.phase === "not-created" ||
          updated.checkRunCreation.delivery.lifecycle.checkRunId !== coordinated.checkRunId
        ) {
          throw new AllocationServiceError("controller-unavailable");
        }
        return { allocation: updated };
      }
      case "reserve-azure": {
        const attemptedAt = this.#requiredNow().toISOString();
        const plan = await this.#admission.planAzure({
          allocationCreatedAt: allocation.createdAt,
          attemptedAt,
          trust: allocation.acceptance.trust,
        });
        const reserved = await ledger.reserveProviderAttempt({
          allocationId: allocation.allocationId,
          attemptedAt,
          deadlines: plan.deadlines,
          expectedAllocationRevision: allocation.revision,
          ordinal: 1,
          provider: "azure",
          worstCaseCostUsdCents: plan.worstCaseCostUsdCents,
        });
        return { allocation: reserved.allocation };
      }
      case "dispatch-azure":
        try {
          await this.#azureDispatch.dispatch({
            allocation_id: allocation.allocationId,
            ordinal: 1,
            provider: "azure",
          });
        } catch {
          throw new AllocationServiceError("controller-unavailable");
        }
        return { response: { allocationId: allocation.allocationId, status: "pending" } };
      case "repair-azure-assignment":
        // The queue-driven reconciler owns this transition. It must re-read
        // the exact numeric runner registration and prove online+idle again
        // before persisting the immutable assignment.
        return { response: { allocationId: allocation.allocationId, status: "pending" } };
      case "reserve-blacksmith": {
        const attemptedAt = this.#requiredNow().toISOString();
        const plan = await this.#admission.planBlacksmith({
          attemptedAt,
          trust: allocation.acceptance.trust,
        });
        const reserved = await ledger.reserveProviderAttempt({
          allocationId: allocation.allocationId,
          attemptedAt,
          deadlines: null,
          expectedAllocationRevision: allocation.revision,
          ordinal: projection.request.ordinal,
          provider: projection.request.provider,
          worstCaseCostUsdCents: plan.worstCaseCostUsdCents,
        });
        return { allocation: reserved.allocation };
      }
      case "complete-blacksmith-attempt": {
        const attempt = allocation.attempts[1];
        if (attempt === undefined || attempt.provider !== "blacksmith") {
          throw new AllocationServiceError("controller-unavailable");
        }
        return {
          allocation: await ledger.markProviderAttemptSucceeded({
            allocationId: allocation.allocationId,
            expectedAllocationRevision: allocation.revision,
            expectedAttemptRevision: attempt.revision,
            ordinal: 2,
            succeededAt: this.#requiredNow().toISOString(),
          }),
        };
      }
      case "assign-blacksmith":
        return {
          allocation: await ledger.assignRunner({
            allocationId: allocation.allocationId,
            assignment: {
              assignedAt: this.#requiredNow().toISOString(),
              attemptOrdinal: projection.request.ordinal,
              provider: projection.request.provider,
              runnerLabel: projection.request.approvedManagedLabel.runnerLabel,
            },
            expectedAllocationRevision: allocation.revision,
          }),
        };
      case "return-assignment":
        return {
          response: {
            allocationId: allocation.allocationId,
            runnerLabel: projection.assignment.runnerLabel,
            status: "ready",
          },
        };
      case "stop-allocation":
        return {
          allocation: await ledger.stopAllocation({
            allocationId: allocation.allocationId,
            expectedRevision: allocation.revision,
            reason: projection.reason,
            stoppedAt: this.#requiredNow().toISOString(),
          }),
        };
      case "runner-unavailable":
        throw new AllocationServiceError("runner-unavailable");
      case "fail":
        throw failureToServiceError(projection.failure);
    }
  }

  #requiredNow(): Date {
    const now = this.#now();
    if (!(now instanceof Date) || !Number.isFinite(now.valueOf())) {
      throw new AllocationServiceError("controller-unavailable");
    }
    return now;
  }
}

function failureToServiceError(failure: AllocationFailure): AllocationServiceError {
  switch (failure.classification) {
    case "security-failure":
      return new AllocationServiceError("allocation-not-authorised");
    case "provider-unavailable":
      return new AllocationServiceError("runner-unavailable");
    case "controller-unavailable":
    case "invalid-configuration":
      return new AllocationServiceError("controller-unavailable");
    case "unexpected-internal-error":
      return new AllocationServiceError("internal-error");
  }
}

function normaliseStateError(error: unknown): AllocationServiceError {
  if (error instanceof AllocationServiceError) return error;
  if (error instanceof AllocationLedgerError) {
    if (error.code === "allocation-conflict") {
      return new AllocationServiceError("allocation-conflict");
    }
    return new AllocationServiceError("controller-unavailable");
  }
  return new AllocationServiceError("controller-unavailable");
}
