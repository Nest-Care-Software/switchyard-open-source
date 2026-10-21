import {
  abandonUnassignedAllocationRecord,
  type AcceptAllocationRequest,
  type AcceptAllocationResult,
  acquireCheckRunCreationLeaseRecord,
  type AcquireCheckRunCreationLeaseRequest,
  type AcquireCheckRunCreationLeaseResult,
  type AddPhysicalGenerationRequest,
  type AddPhysicalGenerationResult,
  type AbandonUnassignedAllocationRequest,
  type AllocationControlLedger,
  AllocationLedgerError,
  type AllocationRecord,
  allocationIdForIdentity,
  allocationNeedsReconciliation,
  appendPhysicalGeneration,
  appendProviderAttempt,
  applyAllocationStatePatch,
  applyFencedPhysicalGenerationUpdate,
  applyPhysicalGenerationState,
  assertValidAllocationRecord,
  type AssignRunnerRequest,
  assignRunnerRecord,
  type BeginFatalAzureAbortRequest,
  beginFatalAzureAbortRecords,
  type CompleteCheckRunCreationRequest,
  completeCheckRunCreationRecord,
  CONTROL_LEDGER_SCHEMA_VERSION,
  createAcceptedAllocationRecord,
  createPhysicalGeneration,
  createProviderAttempt,
  evaluateAdditionalAllowance,
  evaluateProviderAttemptReservation,
  exactGenerationRetry,
  exactProviderAttemptRetry,
  type FailCheckRunCreationRequest,
  failCheckRunCreationRecord,
  type FencedPhysicalGenerationUpdateRequest,
  isExactAcceptanceRetry,
  isExactAttemptSuccessRetry,
  isExactFinalSettlementRetry,
  isExactFatalAzureAbortIntentRetry,
  isExactFatalAzureAbortRetry,
  isExactUnavailableSettlementRetry,
  isExactUnassignedAbandonmentRetry,
  type ListOpenAllocationsRequest,
  type MarkProviderAttemptSucceededRequest,
  type OpenAllocationsPage,
  markProviderAttemptSucceededRecords,
  type ProviderControlState,
  type ProviderCounterSnapshot,
  type ReserveProviderAttemptRequest,
  type ReserveProviderAttemptResult,
  replacePhysicalGeneration,
  type RenewCheckRunCreationLeaseRequest,
  type RenewCheckRunCreationLeaseResult,
  renewCheckRunCreationLeaseRecord,
  sameAllocationState,
  samePhysicalGenerationState,
  type SettleFinalProviderAttemptRequest,
  type SettleFatalAzureAbortRequest,
  settleFatalAzureAbortRecords,
  settleFinalAttemptRecords,
  type SettleUnavailableProviderAttemptRequest,
  settleUnavailableAttemptRecords,
  type StopAllocationRequest,
  stopAllocationRecord,
  type UpdateAllocationStateRequest,
  type UpdatePhysicalGenerationRequest,
  validateHeldReservationCounters,
} from "../allocation-ledger.js";
import type { AllocationIdentity } from "../allocation-identity.js";
import type {
  ApprovedBranchEvidence,
  ApprovedBranchEvidenceRecordResult,
  ApprovedBranchEvidenceStore,
} from "../github-trust.js";
import { parseApprovedBranchEvidence } from "../github-trust.js";
import { PROVIDER_LIMITS } from "../provider-limits.js";
import type { ProviderName } from "../provider.js";
import type { ReconcilerHeartbeatState } from "../controller-health.js";
import type { ReconcilerHeartbeatStore } from "../controller-health.js";

export const IN_MEMORY_LEDGER_SCHEMA_VERSION = CONTROL_LEDGER_SCHEMA_VERSION;

export interface InMemoryLedgerInstanceEvidence {
  readonly initialisedAt: string;
  readonly ledgerInstanceId: string;
  readonly schemaVersion: number;
  readonly utcDay: string;
}

export interface InMemoryLedgerStore {
  readonly kind: "switchyard-in-memory-ledger-store";
}

interface AllowanceHistoryState {
  accountedDailyCostUsdCents: number;
  provider: ProviderName;
  utcDay: string;
}

interface InMemoryLedgerState {
  readonly allocations: Map<string, AllocationRecord>;
  readonly allowanceHistory: Map<string, AllowanceHistoryState>;
  afterCommitFailure: Error | undefined;
  readonly branchEvidence: Map<string, ApprovedBranchEvidence>;
  heartbeat: ReconcilerHeartbeatState | null;
  heartbeatRowPresent: boolean;
  readonly providerControls: Map<ProviderName, ProviderControlState>;
  registry: InMemoryLedgerInstanceEvidence | undefined;
  revision: number;
}

const STORE_STATES = new WeakMap<InMemoryLedgerStore, InMemoryLedgerState>();

export function createInitialisedInMemoryLedgerStore(
  evidence: InMemoryLedgerInstanceEvidence,
): InMemoryLedgerStore {
  const persisted = validateInstanceEvidence(evidence);
  const store: InMemoryLedgerStore = { kind: "switchyard-in-memory-ledger-store" };
  const state: InMemoryLedgerState = {
    allocations: new Map(),
    allowanceHistory: new Map(),
    afterCommitFailure: undefined,
    branchEvidence: new Map(),
    heartbeat: null,
    heartbeatRowPresent: true,
    providerControls: new Map(),
    registry: clone(persisted),
    revision: 0,
  };
  for (const provider of ["azure", "blacksmith"] as const) {
    state.revision += 1;
    state.providerControls.set(provider, {
      accountedDailyCostUsdCents: 0,
      activeReservations: 0,
      initialisedAt: persisted.initialisedAt,
      provider,
      revision: `memory-${state.revision}`,
      utcDay: persisted.utcDay,
    });
  }
  STORE_STATES.set(store, state);
  return store;
}

export class InMemoryAllocationLedger
  implements AllocationControlLedger, ApprovedBranchEvidenceStore, ReconcilerHeartbeatStore
{
  readonly #expectedEvidence: InMemoryLedgerInstanceEvidence;
  readonly #state: InMemoryLedgerState;

  constructor(store: InMemoryLedgerStore, expectedEvidence: InMemoryLedgerInstanceEvidence) {
    const state = STORE_STATES.get(store);
    if (state === undefined) {
      throw corrupt("in-memory ledger store is not an initialised ledger store");
    }
    this.#state = state;
    this.#expectedEvidence = validateInstanceEvidence(expectedEvidence);
    this.#requiredFoundation();
  }

  async acceptAllocation(request: AcceptAllocationRequest): Promise<AcceptAllocationResult> {
    this.#requiredFoundation();
    const candidate = createAcceptedAllocationRecord(request, "candidate");
    const existing = this.#state.allocations.get(candidate.allocationId);
    if (existing !== undefined) {
      assertAuthoritativeAllocationAggregate(existing);
      if (!isExactAcceptanceRetry(existing, request)) {
        throw conflict(
          "allocation identity was reused with different immutable acceptance evidence",
        );
      }
      return { allocation: clone(existing), acceptance: "exact-retry" };
    }
    const allocation = createAcceptedAllocationRecord(request, this.#nextRevision());
    this.#writeAllocation(allocation);
    const responseLost = await this.#afterCommit();
    return {
      allocation: clone(allocation),
      acceptance: responseLost ? "exact-retry" : "created",
    };
  }

  async abandonUnassignedAllocation(
    request: AbandonUnassignedAllocationRequest,
  ): Promise<AllocationRecord> {
    this.#requiredFoundation();
    const current = this.#requiredAllocation(request.allocationId);
    if (isExactUnassignedAbandonmentRetry(current, request)) return clone(current);
    const updated = abandonUnassignedAllocationRecord(current, request, this.#nextRevision());
    this.#writeAllocation(updated);
    await this.#afterCommit();
    return clone(updated);
  }

  async beginFatalAzureAbort(request: BeginFatalAzureAbortRequest): Promise<AllocationRecord> {
    this.#requiredFoundation();
    const current = this.#requiredAllocation(request.allocationId);
    if (isExactFatalAzureAbortIntentRetry(current, request)) return clone(current);
    const attempt = this.#requiredAttempt(current, request.ordinal);
    const updated = beginFatalAzureAbortRecords(
      current,
      attempt,
      request,
      this.#nextRevision(),
      this.#nextRevision(),
    );
    this.#writeAllocation(updated.allocation);
    await this.#afterCommit();
    return clone(updated.allocation);
  }

  async getAllocation(allocationId: string): Promise<AllocationRecord | undefined> {
    this.#requiredFoundation();
    const allocation = this.#state.allocations.get(allocationId);
    if (allocation === undefined) {
      return undefined;
    }
    assertAuthoritativeAllocationAggregate(allocation);
    return clone(allocation);
  }

  async getAllocationByIdentity(
    identity: AllocationIdentity,
  ): Promise<AllocationRecord | undefined> {
    return this.getAllocation(allocationIdForIdentity(identity));
  }

  async listOpenAllocations(request: ListOpenAllocationsRequest): Promise<OpenAllocationsPage> {
    this.#requiredFoundation();
    const pageSize = requireOpenPageSize(request.pageSize);
    const afterAllocationId = decodeMemoryContinuationToken(request.continuationToken);
    const authoritative = [...this.#state.allocations.values()].map((allocation) => {
      assertAuthoritativeAllocationAggregate(allocation);
      return allocation;
    });
    const open = authoritative
      .filter(allocationNeedsReconciliation)
      .filter(
        (allocation) =>
          afterAllocationId === undefined || allocation.allocationId > afterAllocationId,
      )
      .sort((left, right) => left.allocationId.localeCompare(right.allocationId));
    const allocations = open.slice(0, pageSize).map((allocation) => clone(allocation));
    return {
      allocations,
      continuationToken:
        allocations.length < open.length
          ? `memory-open-v1:${allocations.at(-1)?.allocationId}`
          : null,
    };
  }

  async reserveProviderAttempt(
    request: ReserveProviderAttemptRequest,
  ): Promise<ReserveProviderAttemptResult> {
    this.#requiredFoundation();
    const current = this.#requiredAllocation(request.allocationId);
    const exact = exactProviderAttemptRetry(current, request);
    if (exact !== undefined) {
      return clone(exact);
    }
    if (request.expectedAllocationRevision !== current.revision) {
      throw optimisticConflict();
    }
    const currentControl = this.#requiredControl(request.provider);
    const control = this.#controlForAdmission(currentControl, request.attemptedAt.slice(0, 10));
    const refusal = evaluateProviderAttemptReservation(
      request.provider,
      control.activeReservations,
      control.accountedDailyCostUsdCents,
      request.worstCaseCostUsdCents,
    );
    const attempt = createProviderAttempt(current, request, this.#nextRevision(), refusal);
    const allocation = appendProviderAttempt(current, attempt, this.#nextRevision());
    this.#writeAllocation(allocation);
    if (refusal === undefined) {
      this.#archiveRollover(currentControl, control);
      this.#state.providerControls.set(request.provider, {
        ...control,
        accountedDailyCostUsdCents:
          control.accountedDailyCostUsdCents + attempt.reservation.reservedCostUsdCents,
        activeReservations: control.activeReservations + 1,
        revision: this.#nextRevision(),
      });
    }
    const responseLost = await this.#afterCommit();
    if (refusal !== undefined) {
      return {
        allocation: clone(allocation),
        attempt: clone(attempt),
        constraint: refusal,
        outcome: "capacity-unavailable",
        provider: request.provider,
        reservation: responseLost ? "exact-retry" : "created",
      };
    }
    return {
      allocation: clone(allocation),
      attempt: clone(attempt),
      outcome: "reserved",
      reservation: responseLost ? "exact-retry" : "created",
    };
  }

  async settleUnavailableProviderAttempt(
    request: SettleUnavailableProviderAttemptRequest,
  ): Promise<AllocationRecord> {
    this.#requiredFoundation();
    const current = this.#requiredAllocation(request.allocationId);
    if (isExactUnavailableSettlementRetry(current, request)) {
      return clone(current);
    }
    const attempt = this.#requiredAttempt(current, request.ordinal);
    const control = this.#requiredControl(attempt.provider);
    const allowance = this.#requiredAllowance(control, attempt.reservation.utcDay);
    validateHeldReservationCounters(
      attempt.provider,
      control.activeReservations,
      allowance.accountedDailyCostUsdCents,
      attempt.reservation.reservedCostUsdCents,
    );
    const settled = settleUnavailableAttemptRecords(
      current,
      attempt,
      request,
      this.#nextRevision(),
      this.#nextRevision(),
    );
    this.#writeAllocation(settled.allocation);
    this.#state.providerControls.set(attempt.provider, {
      ...control,
      activeReservations: control.activeReservations - 1,
      revision: this.#nextRevision(),
    });
    this.#setAllowanceCost(
      control,
      allowance,
      allowance.accountedDailyCostUsdCents -
        attempt.reservation.reservedCostUsdCents +
        request.finalCostUsdCents,
    );
    await this.#afterCommit();
    return clone(settled.allocation);
  }

  async settleFatalAzureAbort(request: SettleFatalAzureAbortRequest): Promise<AllocationRecord> {
    this.#requiredFoundation();
    const current = this.#requiredAllocation(request.allocationId);
    if (isExactFatalAzureAbortRetry(current, request)) {
      return clone(current);
    }
    const attempt = this.#requiredAttempt(current, request.ordinal);
    const control = this.#requiredControl(attempt.provider);
    const allowance = this.#requiredAllowance(control, attempt.reservation.utcDay);
    validateHeldReservationCounters(
      attempt.provider,
      control.activeReservations,
      allowance.accountedDailyCostUsdCents,
      attempt.reservation.reservedCostUsdCents,
    );
    const settled = settleFatalAzureAbortRecords(
      current,
      attempt,
      request,
      this.#nextRevision(),
      this.#nextRevision(),
    );
    this.#writeAllocation(settled.allocation);
    this.#state.providerControls.set(attempt.provider, {
      ...control,
      activeReservations: control.activeReservations - 1,
      revision: this.#nextRevision(),
    });
    this.#setAllowanceCost(
      control,
      allowance,
      allowance.accountedDailyCostUsdCents -
        attempt.reservation.reservedCostUsdCents +
        request.finalCostUsdCents,
    );
    await this.#afterCommit();
    return clone(settled.allocation);
  }

  async markProviderAttemptSucceeded(
    request: MarkProviderAttemptSucceededRequest,
  ): Promise<AllocationRecord> {
    this.#requiredFoundation();
    const current = this.#requiredAllocation(request.allocationId);
    if (isExactAttemptSuccessRetry(current, request)) {
      return clone(current);
    }
    const attempt = this.#requiredAttempt(current, request.ordinal);
    const updated = markProviderAttemptSucceededRecords(
      current,
      attempt,
      request,
      this.#nextRevision(),
      this.#nextRevision(),
    );
    this.#writeAllocation(updated.allocation);
    await this.#afterCommit();
    return clone(updated.allocation);
  }

  async assignRunner(request: AssignRunnerRequest): Promise<AllocationRecord> {
    this.#requiredFoundation();
    const current = this.#requiredAllocation(request.allocationId);
    const updated = assignRunnerRecord(current, request, this.#nextRevision());
    if (updated === current) {
      return clone(current);
    }
    this.#writeAllocation(updated);
    await this.#afterCommit();
    return clone(updated);
  }

  async updateAllocationState(request: UpdateAllocationStateRequest): Promise<AllocationRecord> {
    this.#requiredFoundation();
    const current = this.#requiredAllocation(request.allocationId);
    if (request.expectedRevision !== current.revision) {
      if (sameAllocationState(current, request)) {
        return clone(current);
      }
      throw optimisticConflict();
    }
    const candidate = applyAllocationStatePatch(current, request, "candidate");
    assertAuthoritativeAllocationAggregate(candidate);
    if (sameApartFromRevision(current, candidate)) {
      return clone(current);
    }
    const updated = { ...candidate, revision: this.#nextRevision() };
    this.#writeAllocation(updated);
    await this.#afterCommit();
    return clone(updated);
  }

  async stopAllocation(request: StopAllocationRequest): Promise<AllocationRecord> {
    this.#requiredFoundation();
    const current = this.#requiredAllocation(request.allocationId);
    const updated = stopAllocationRecord(current, request, this.#nextRevision());
    if (updated === current) {
      return clone(current);
    }
    this.#writeAllocation(updated);
    await this.#afterCommit();
    return clone(updated);
  }

  async addPhysicalGeneration(
    request: AddPhysicalGenerationRequest,
  ): Promise<AddPhysicalGenerationResult> {
    this.#requiredFoundation();
    const current = this.#requiredAllocation(request.allocationId);
    const exact = exactGenerationRetry(current, request);
    if (exact !== undefined) {
      return clone(exact);
    }
    const attempt = this.#requiredAttempt(current, request.attemptOrdinal);
    if (request.expectedAttemptRevision !== attempt.revision) {
      throw optimisticConflict();
    }
    const generation = createPhysicalGeneration(current, attempt, request, this.#nextRevision());
    const control = this.#requiredControl(attempt.provider);
    const allowance = this.#requiredAllowance(control, attempt.reservation.utcDay);
    validateHeldReservationCounters(
      attempt.provider,
      control.activeReservations,
      allowance.accountedDailyCostUsdCents,
      attempt.reservation.reservedCostUsdCents,
    );
    if (
      generation.reservedIncrementalCostUsdCents > 0 &&
      evaluateAdditionalAllowance(
        attempt.provider,
        allowance.accountedDailyCostUsdCents,
        generation.reservedIncrementalCostUsdCents,
      )
    ) {
      return {
        constraint: "daily-allowance",
        outcome: "capacity-unavailable",
        provider: "azure",
      };
    }
    const updated = appendPhysicalGeneration(current, attempt, generation, this.#nextRevision());
    this.#writeAllocation(updated.allocation);
    this.#setAllowanceCost(
      control,
      allowance,
      allowance.accountedDailyCostUsdCents + generation.reservedIncrementalCostUsdCents,
    );
    const responseLost = await this.#afterCommit();
    return {
      allocation: clone(updated.allocation),
      attempt: clone(updated.attempt),
      generation: clone(generation),
      outcome: "added",
      reservation: responseLost ? "exact-retry" : "created",
    };
  }

  async updatePhysicalGeneration(
    request: UpdatePhysicalGenerationRequest,
  ): Promise<AllocationRecord> {
    this.#requiredFoundation();
    const current = this.#requiredAllocation(request.allocationId);
    const attempt = this.#requiredAttempt(current, request.attemptOrdinal);
    const generation = attempt.physicalGenerations.find(
      (entry) => entry.generationNumber === request.generationNumber,
    );
    if (generation === undefined) {
      throw new AllocationLedgerError("not-found", "physical generation was not found");
    }
    if (request.expectedRevision !== generation.revision) {
      if (samePhysicalGenerationState(attempt, generation, request)) {
        return clone(current);
      }
      throw optimisticConflict();
    }
    const updatedGeneration = applyPhysicalGenerationState(
      attempt,
      generation,
      request,
      this.#nextRevision(),
    );
    const updated = replacePhysicalGeneration(current, attempt, updatedGeneration);
    this.#writeAllocation(updated);
    await this.#afterCommit();
    return clone(updated);
  }

  async updatePhysicalGenerationFenced(
    request: FencedPhysicalGenerationUpdateRequest,
  ): Promise<AllocationRecord> {
    this.#requiredFoundation();
    const current = this.#requiredAllocation(request.allocationId);
    const attempt = this.#requiredAttempt(current, request.attemptOrdinal);
    const generation = attempt.physicalGenerations.find(
      (entry) => entry.generationNumber === request.generationNumber,
    );
    if (generation === undefined) {
      throw new AllocationLedgerError("not-found", "physical generation was not found");
    }
    if (
      request.expectedAllocationRevision !== current.revision ||
      request.expectedAttemptRevision !== attempt.revision ||
      request.expectedRevision !== generation.revision
    ) {
      if (samePhysicalGenerationState(attempt, generation, request)) return clone(current);
      throw optimisticConflict();
    }
    const updated = applyFencedPhysicalGenerationUpdate(current, attempt, generation, request, {
      allocation: this.#nextRevision(),
      attempt: this.#nextRevision(),
      generation: this.#nextRevision(),
    });
    this.#writeAllocation(updated);
    await this.#afterCommit();
    return clone(updated);
  }

  async settleFinalProviderAttempt(
    request: SettleFinalProviderAttemptRequest,
  ): Promise<AllocationRecord> {
    this.#requiredFoundation();
    const current = this.#requiredAllocation(request.allocationId);
    if (isExactFinalSettlementRetry(current, request)) {
      return clone(current);
    }
    const attempt = this.#requiredAttempt(current, request.ordinal);
    const control = this.#requiredControl(attempt.provider);
    const allowance = this.#requiredAllowance(control, attempt.reservation.utcDay);
    validateHeldReservationCounters(
      attempt.provider,
      control.activeReservations,
      allowance.accountedDailyCostUsdCents,
      attempt.reservation.reservedCostUsdCents,
    );
    const settled = settleFinalAttemptRecords(
      current,
      attempt,
      request,
      this.#nextRevision(),
      this.#nextRevision(),
    );
    this.#writeAllocation(settled.allocation);
    this.#state.providerControls.set(attempt.provider, {
      ...control,
      activeReservations: control.activeReservations - 1,
      revision: this.#nextRevision(),
    });
    this.#setAllowanceCost(
      control,
      allowance,
      allowance.accountedDailyCostUsdCents -
        attempt.reservation.reservedCostUsdCents +
        request.finalCostUsdCents,
    );
    await this.#afterCommit();
    return clone(settled.allocation);
  }

  async acquireCheckRunCreationLease(
    request: AcquireCheckRunCreationLeaseRequest,
  ): Promise<AcquireCheckRunCreationLeaseResult> {
    this.#requiredFoundation();
    const current = this.#requiredAllocation(request.allocationId);
    const updated = acquireCheckRunCreationLeaseRecord(current, request, this.#nextRevision());
    if (updated.allocation !== current) {
      this.#writeAllocation(updated.allocation);
      await this.#afterCommit();
    }
    return clone(updated.result);
  }

  async completeCheckRunCreation(
    request: CompleteCheckRunCreationRequest,
  ): Promise<AllocationRecord> {
    this.#requiredFoundation();
    const current = this.#requiredAllocation(request.allocationId);
    const updated = completeCheckRunCreationRecord(current, request, this.#nextRevision());
    if (updated === current) {
      return clone(current);
    }
    this.#writeAllocation(updated);
    await this.#afterCommit();
    return clone(updated);
  }

  async renewCheckRunCreationLease(
    request: RenewCheckRunCreationLeaseRequest,
  ): Promise<RenewCheckRunCreationLeaseResult> {
    this.#requiredFoundation();
    const current = this.#requiredAllocation(request.allocationId);
    const updated = renewCheckRunCreationLeaseRecord(current, request, this.#nextRevision());
    if (updated.allocation !== current) {
      this.#writeAllocation(updated.allocation);
      await this.#afterCommit();
    }
    return clone(updated.result);
  }

  async failCheckRunCreation(request: FailCheckRunCreationRequest): Promise<AllocationRecord> {
    this.#requiredFoundation();
    const current = this.#requiredAllocation(request.allocationId);
    const updated = failCheckRunCreationRecord(current, request, this.#nextRevision());
    if (updated === current) {
      return clone(current);
    }
    this.#writeAllocation(updated);
    await this.#afterCommit();
    return clone(updated);
  }

  async load(input: {
    readonly repositoryId: string;
    readonly runId: string;
  }): Promise<ApprovedBranchEvidence | null> {
    this.#requiredFoundation();
    return clone(
      this.#state.branchEvidence.get(branchKey(input.repositoryId, input.runId)) ?? null,
    );
  }

  async recordInitial(
    evidenceValue: ApprovedBranchEvidence,
  ): Promise<ApprovedBranchEvidenceRecordResult> {
    this.#requiredFoundation();
    const evidence = parseApprovedBranchEvidence(evidenceValue);
    const key = branchKey(evidence.repositoryId, evidence.runId);
    const existing = this.#state.branchEvidence.get(key);
    if (existing !== undefined) {
      return equal(existing, evidence) ? "matched" : "conflict";
    }
    this.#state.branchEvidence.set(key, evidence);
    await this.#afterCommit();
    return "recorded";
  }

  async getReconcilerHeartbeat(): Promise<ReconcilerHeartbeatState | null> {
    this.#requiredFoundation();
    return clone(this.#state.heartbeat);
  }

  async recordReconcilerHeartbeat(input: {
    readonly lastSucceededAt: string;
  }): Promise<ReconcilerHeartbeatState> {
    this.#requiredFoundation();
    const lastSucceededAt = canonicalInstant(input.lastSucceededAt, "lastSucceededAt");
    const current = this.#state.heartbeat;
    if (current !== null && lastSucceededAt < current.lastSucceededAt) {
      throw new AllocationLedgerError(
        "precondition-failed",
        "reconciler heartbeat cannot move backwards",
      );
    }
    if (current?.lastSucceededAt === lastSucceededAt) {
      return clone(current);
    }
    const updated = { lastSucceededAt, revision: this.#nextRevision() };
    this.#state.heartbeat = updated;
    await this.#afterCommit();
    return clone(updated);
  }

  getCounterSnapshot(provider: ProviderName, utcDay: string): ProviderCounterSnapshot {
    const control = this.#requiredControl(provider);
    const allowance = this.#requiredAllowance(control, utcDay);
    return {
      activeReservations: control.activeReservations,
      accountedDailyCostUsdCents: allowance.accountedDailyCostUsdCents,
    };
  }

  failAfterNextCommit(error = new Error("injected failure after commit")): void {
    this.#state.afterCommitFailure = error;
  }

  unsafeDeleteRegistry(): void {
    this.#state.registry = undefined;
  }

  unsafeDeleteProviderControl(provider: ProviderName): void {
    this.#state.providerControls.delete(provider);
  }

  unsafeDeleteHeartbeatRow(): void {
    this.#state.heartbeatRowPresent = false;
  }

  unsafeSetCounterState(
    provider: ProviderName,
    utcDay: string,
    state: ProviderCounterSnapshot,
  ): void {
    const control = this.#requiredControl(provider);
    if (control.utcDay === utcDay) {
      this.#state.providerControls.set(provider, {
        ...control,
        ...state,
        revision: this.#nextRevision(),
      });
      return;
    }
    this.#state.allowanceHistory.set(allowanceKey(provider, utcDay), {
      accountedDailyCostUsdCents: state.accountedDailyCostUsdCents,
      provider,
      utcDay,
    });
    this.#state.providerControls.set(provider, {
      ...control,
      activeReservations: state.activeReservations,
      revision: this.#nextRevision(),
    });
  }

  unsafeMutateAllocation(
    allocationId: string,
    mutate: (allocation: AllocationRecord) => AllocationRecord,
  ): void {
    const current = this.#requiredAllocation(allocationId);
    this.#state.allocations.set(allocationId, mutate(clone(current)));
  }

  #requiredFoundation(): void {
    const registry = this.#state.registry;
    if (registry === undefined) {
      throw corrupt("ledger instance registry is missing");
    }
    if (!sameEvidence(registry, this.#expectedEvidence)) {
      throw corrupt("ledger instance registry disagrees with configured runtime evidence");
    }
    if (!this.#state.heartbeatRowPresent) {
      throw corrupt("required reconciler heartbeat row is missing");
    }
    for (const provider of ["azure", "blacksmith"] as const) {
      const control = this.#state.providerControls.get(provider);
      if (
        control === undefined ||
        control.provider !== provider ||
        control.initialisedAt !== registry.initialisedAt ||
        control.utcDay < registry.utcDay
      ) {
        throw corrupt(`${provider} provider control disagrees with ledger instance evidence`);
      }
    }
  }

  #requiredAllocation(allocationId: string): AllocationRecord {
    const allocation = this.#state.allocations.get(allocationId);
    if (allocation === undefined) {
      throw new AllocationLedgerError("not-found", "allocation was not found");
    }
    assertAuthoritativeAllocationAggregate(allocation);
    return allocation;
  }

  #writeAllocation(allocation: AllocationRecord): void {
    assertAuthoritativeAllocationAggregate(allocation);
    this.#state.allocations.set(allocation.allocationId, allocation);
  }

  #requiredAttempt(allocation: AllocationRecord, ordinal: number) {
    const attempt = allocation.attempts[ordinal - 1];
    if (attempt === undefined || attempt.ordinal !== ordinal) {
      throw new AllocationLedgerError("not-found", "provider attempt was not found");
    }
    return attempt;
  }

  #requiredControl(provider: ProviderName): ProviderControlState {
    const control = this.#state.providerControls.get(provider);
    if (control === undefined) {
      throw corrupt(`${provider} provider control is missing`);
    }
    const limits = PROVIDER_LIMITS[provider];
    if (
      control.provider !== provider ||
      !Number.isSafeInteger(control.activeReservations) ||
      control.activeReservations < 0 ||
      control.activeReservations > limits.maximumConcurrentAllocations ||
      !Number.isSafeInteger(control.accountedDailyCostUsdCents) ||
      control.accountedDailyCostUsdCents < 0 ||
      control.accountedDailyCostUsdCents > limits.dailyAllowanceUsdCents
    ) {
      throw corrupt(`${provider} provider control counters are outside authoritative limits`);
    }
    return control;
  }

  #requiredAllowance(control: ProviderControlState, utcDay: string): AllowanceHistoryState {
    if (utcDay === control.utcDay) {
      return {
        accountedDailyCostUsdCents: control.accountedDailyCostUsdCents,
        provider: control.provider,
        utcDay,
      };
    }
    if (utcDay > control.utcDay) {
      throw corrupt("a held reservation cannot refer to a future provider-control day");
    }
    const history = this.#state.allowanceHistory.get(allowanceKey(control.provider, utcDay));
    if (history === undefined) {
      throw corrupt("allowance history required by a held reservation is missing");
    }
    return history;
  }

  #controlForAdmission(control: ProviderControlState, utcDay: string): ProviderControlState {
    if (utcDay < control.utcDay) {
      throw corrupt("an admission cannot use a UTC day older than provider control");
    }
    if (utcDay === control.utcDay) {
      return control;
    }
    return { ...control, accountedDailyCostUsdCents: 0, utcDay };
  }

  #archiveRollover(previous: ProviderControlState, next: ProviderControlState): void {
    if (previous.utcDay === next.utcDay) {
      return;
    }
    const key = allowanceKey(previous.provider, previous.utcDay);
    if (this.#state.allowanceHistory.has(key)) {
      throw corrupt("allowance history already exists before atomic UTC rollover");
    }
    this.#state.allowanceHistory.set(key, {
      accountedDailyCostUsdCents: previous.accountedDailyCostUsdCents,
      provider: previous.provider,
      utcDay: previous.utcDay,
    });
  }

  #setAllowanceCost(
    control: ProviderControlState,
    allowance: AllowanceHistoryState,
    value: number,
  ): void {
    if (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > PROVIDER_LIMITS[control.provider].dailyAllowanceUsdCents
    ) {
      throw corrupt("settlement would move allowance outside authoritative limits");
    }
    if (allowance.utcDay === control.utcDay) {
      this.#state.providerControls.set(control.provider, {
        ...this.#requiredControl(control.provider),
        accountedDailyCostUsdCents: value,
        revision: this.#nextRevision(),
      });
      return;
    }
    this.#state.allowanceHistory.set(allowanceKey(control.provider, allowance.utcDay), {
      ...allowance,
      accountedDailyCostUsdCents: value,
    });
  }

  #nextRevision(): string {
    this.#state.revision += 1;
    return `memory-${this.#state.revision}`;
  }

  async #afterCommit(): Promise<boolean> {
    await Promise.resolve();
    if (this.#state.afterCommitFailure === undefined) {
      return false;
    }
    this.#state.afterCommitFailure = undefined;
    return true;
  }
}

function validateInstanceEvidence(
  value: InMemoryLedgerInstanceEvidence,
): InMemoryLedgerInstanceEvidence {
  if (
    typeof value.ledgerInstanceId !== "string" ||
    value.ledgerInstanceId.trim().length === 0 ||
    value.ledgerInstanceId.length > 256
  ) {
    throw new AllocationLedgerError(
      "invalid-ledger-request",
      "ledgerInstanceId must be a non-empty string of at most 256 characters",
    );
  }
  if (value.schemaVersion !== IN_MEMORY_LEDGER_SCHEMA_VERSION) {
    throw new AllocationLedgerError(
      "invalid-ledger-request",
      `schemaVersion must be ${IN_MEMORY_LEDGER_SCHEMA_VERSION}`,
    );
  }
  const initialisedAt = canonicalInstant(value.initialisedAt, "initialisedAt");
  if (value.utcDay !== initialisedAt.slice(0, 10)) {
    throw new AllocationLedgerError(
      "invalid-ledger-request",
      "utcDay must match the UTC day of initialisedAt",
    );
  }
  return { ...value };
}

function sameEvidence(
  left: InMemoryLedgerInstanceEvidence,
  right: InMemoryLedgerInstanceEvidence,
): boolean {
  return (
    left.initialisedAt === right.initialisedAt &&
    left.ledgerInstanceId === right.ledgerInstanceId &&
    left.schemaVersion === right.schemaVersion &&
    left.utcDay === right.utcDay
  );
}

function canonicalInstant(value: string, path: string): string {
  const parsed = new Date(value);
  if (
    typeof value !== "string" ||
    Number.isNaN(parsed.valueOf()) ||
    parsed.toISOString() !== value
  ) {
    throw new AllocationLedgerError(
      "invalid-ledger-request",
      `${path} must be a canonical UTC instant`,
    );
  }
  return value;
}

function allowanceKey(provider: ProviderName, utcDay: string): string {
  return `${provider}!${utcDay}`;
}

function branchKey(repositoryId: string, runId: string): string {
  return `${repositoryId}!${runId}`;
}

function sameApartFromRevision(left: AllocationRecord, right: AllocationRecord): boolean {
  const { revision: _left, ...leftValue } = left;
  const { revision: _right, ...rightValue } = right;
  return equal(leftValue, rightValue);
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function requireOpenPageSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new AllocationLedgerError(
      "invalid-ledger-request",
      "open-allocation pageSize must be an integer from 1 to 100",
    );
  }
  return value;
}

function decodeMemoryContinuationToken(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const match = /^memory-open-v1:(sy1-[0-9a-f]{64})$/.exec(value);
  if (match === null) {
    throw new AllocationLedgerError(
      "invalid-ledger-request",
      "open-allocation continuation token is malformed",
    );
  }
  return match[1];
}

function assertAuthoritativeAllocationAggregate(allocation: AllocationRecord): void {
  try {
    assertValidAllocationRecord(allocation);
  } catch (error) {
    throw new AllocationLedgerError(
      "authoritative-state-corrupt",
      "allocation aggregate is not valid authoritative state",
      { cause: error },
    );
  }
}

function optimisticConflict(): AllocationLedgerError {
  return new AllocationLedgerError(
    "optimistic-concurrency-conflict",
    "the ledger record changed after it was read",
  );
}

function conflict(message: string): AllocationLedgerError {
  return new AllocationLedgerError("allocation-conflict", message);
}

function corrupt(message: string): AllocationLedgerError {
  return new AllocationLedgerError("authoritative-state-corrupt", message);
}
