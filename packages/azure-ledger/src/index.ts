import {
  type ListTableEntitiesOptions,
  RestError,
  TableClient,
  type TableEntity,
  type TableEntityResult,
  type TableEntityResultPage,
  type TableTransactionResponse,
  type TransactionAction,
} from "@azure/data-tables";
import { ManagedIdentityCredential } from "@azure/identity";
import type {
  AllocationIdentity,
  ApprovedBranchEvidence,
  ApprovedBranchEvidenceRecordResult,
  ApprovedBranchEvidenceStore,
  ProviderName,
} from "@switchyard/core";
import {
  type AbandonUnassignedAllocationRequest,
  type AcceptAllocationRequest,
  type AcceptAllocationResult,
  type AcquireCheckRunCreationLeaseRequest,
  type AcquireCheckRunCreationLeaseResult,
  type AddPhysicalGenerationRequest,
  type AddPhysicalGenerationResult,
  type AllocationControlLedger,
  AllocationLedgerError,
  type AllocationRecord,
  type AssignRunnerRequest,
  abandonUnassignedAllocationRecord,
  acquireCheckRunCreationLeaseRecord,
  allocationIdForIdentity,
  allocationNeedsReconciliation,
  appendPhysicalGeneration,
  appendProviderAttempt,
  applyAllocationStatePatch,
  applyFencedPhysicalGenerationUpdate,
  applyPhysicalGenerationState,
  assertValidAllocationRecord,
  assignRunnerRecord,
  type BeginFatalAzureAbortRequest,
  beginFatalAzureAbortRecords,
  CONTROL_LEDGER_SCHEMA_VERSION,
  type CompleteCheckRunCreationRequest,
  completeCheckRunCreationRecord,
  createAcceptedAllocationRecord,
  createPhysicalGeneration,
  createProviderAttempt,
  evaluateAdditionalAllowance,
  evaluateProviderAttemptReservation,
  exactGenerationRetry,
  exactProviderAttemptRetry,
  type FailCheckRunCreationRequest,
  type FencedPhysicalGenerationUpdateRequest,
  failCheckRunCreationRecord,
  isExactAcceptanceRetry,
  isExactAttemptSuccessRetry,
  isExactFatalAzureAbortIntentRetry,
  isExactFatalAzureAbortRetry,
  isExactFinalSettlementRetry,
  isExactUnassignedAbandonmentRetry,
  isExactUnavailableSettlementRetry,
  type ListOpenAllocationsRequest,
  type MarkProviderAttemptSucceededRequest,
  markProviderAttemptSucceededRecords,
  type OpenAllocationsPage,
  type PhysicalGeneration,
  PROVIDER_LIMITS,
  type ProviderAttempt,
  type ProviderControlState,
  parseApprovedBranchEvidence,
  parseStrictJson,
  type ReconcilerHeartbeatState,
  type ReconcilerHeartbeatStore,
  type RenewCheckRunCreationLeaseRequest,
  type RenewCheckRunCreationLeaseResult,
  type ReserveProviderAttemptRequest,
  type ReserveProviderAttemptResult,
  renewCheckRunCreationLeaseRecord,
  type SettleFatalAzureAbortRequest,
  type SettleFinalProviderAttemptRequest,
  type SettleUnavailableProviderAttemptRequest,
  type StopAllocationRequest,
  sameAllocationState,
  samePhysicalGenerationState,
  settleFatalAzureAbortRecords,
  settleFinalAttemptRecords,
  settleUnavailableAttemptRecords,
  stopAllocationRecord,
  type UpdateAllocationStateRequest,
  type UpdatePhysicalGenerationRequest,
  validateHeldReservationCounters,
} from "@switchyard/core";

export const AZURE_TABLE_LEDGER_SCHEMA_VERSION = CONTROL_LEDGER_SCHEMA_VERSION;
export const AZURE_TABLE_LEDGER_PARTITION_KEY = "control-v10";

const MAX_TRANSACTION_RETRIES = 8;
const SYSTEM_ENTITY_KEYS = ["etag", "partitionKey", "rowKey", "timestamp"] as const;

export interface AzureTableAllocationLedgerOptions {
  readonly accountName: string;
  readonly ledgerInstanceId: string;
  readonly managedIdentityClientId: string;
  readonly schemaVersion: number;
  readonly tableName: string;
}

export interface AzureLedgerInstanceEvidence {
  readonly initialisedAt: string;
  readonly ledgerInstanceId: string;
  readonly schemaVersion: number;
  readonly utcDay: string;
}

export interface AzureTableClientPort {
  getEntity<T extends object = Record<string, unknown>>(
    partitionKey: string,
    rowKey: string,
  ): Promise<TableEntityResult<T>>;
  listEntities<T extends object = Record<string, unknown>>(
    options?: ListTableEntitiesOptions,
  ): {
    byPage(settings?: {
      readonly continuationToken?: string;
      readonly maxPageSize?: number;
    }): AsyncIterableIterator<TableEntityResultPage<T>>;
  };
  submitTransaction(actions: TransactionAction[]): Promise<TableTransactionResponse>;
}

interface PersistedLedgerEvidence {
  readonly ledgerInstanceId: string;
  readonly schemaVersion: number;
}

interface AllocationDocument
  extends Omit<AllocationRecord, "attempts" | "revision">,
    PersistedLedgerEvidence {
  readonly attemptCount: number;
}

interface AttemptDocument
  extends Omit<ProviderAttempt, "physicalGenerations" | "revision">,
    PersistedLedgerEvidence {
  readonly generationCount: number;
}

interface AllocationEntityProperties extends Record<string, unknown> {
  readonly allocationId: string;
  readonly allocatorCheckRunId: string;
  readonly attemptCount: number;
  readonly document: string;
  readonly entityType: "allocation";
  readonly ledgerInstanceId: string;
  readonly lifecycleState: AllocationRecord["lifecycleState"];
  readonly repositoryId: string;
  readonly runAttempt: number;
  readonly runId: string;
  readonly schemaVersion: number;
}

interface AttemptEntityProperties extends Record<string, unknown> {
  readonly admission: ProviderAttempt["admission"];
  readonly allocationId: string;
  readonly document: string;
  readonly entityType: "provider-attempt";
  readonly generationCount: number;
  readonly ledgerInstanceId: string;
  readonly ordinal: number;
  readonly outcome: ProviderAttempt["outcome"];
  readonly provider: ProviderName;
  readonly reservationState: ProviderAttempt["reservation"]["state"];
  readonly reservedCostUsdCents: number;
  readonly schemaVersion: number;
}

interface GenerationEntityProperties extends Record<string, unknown> {
  readonly allocationId: string;
  readonly attemptOrdinal: number;
  readonly document: string;
  readonly entityType: "physical-generation";
  readonly generationNumber: number;
  readonly ledgerInstanceId: string;
  readonly scheduleStatus: string;
  readonly schemaVersion: number;
  readonly state: PhysicalGeneration["state"];
}

interface ProviderControlEntityProperties extends Record<string, unknown> {
  readonly accountedDailyCostUsdCents: number;
  readonly activeReservations: number;
  readonly document: string;
  readonly entityType: "provider-control";
  readonly ledgerInstanceId: string;
  readonly provider: ProviderName;
  readonly schemaVersion: number;
  readonly utcDay: string;
}

interface ProviderControlDocument extends Omit<ProviderControlState, "revision"> {
  readonly ledgerInstanceId: string;
  readonly schemaVersion: number;
}

interface BootstrapRegistryDocument {
  readonly initialisedAt: string;
  readonly ledgerInstanceId: string;
  readonly partitionKey: string;
  readonly schemaVersion: number;
  readonly utcDay: string;
}

interface AllowanceHistoryState {
  readonly accountedDailyCostUsdCents: number;
  readonly archivedAt: string;
  readonly provider: ProviderName;
  readonly revision: string;
  readonly utcDay: string;
}

interface AllowanceHistoryDocument
  extends Omit<AllowanceHistoryState, "revision">,
    PersistedLedgerEvidence {}

interface BootstrapRegistryEntityProperties extends Record<string, unknown> {
  readonly document: string;
  readonly entityType: "bootstrap-registry";
  readonly ledgerInstanceId: string;
  readonly schemaVersion: number;
}

interface AllowanceHistoryEntityProperties extends Record<string, unknown> {
  readonly accountedDailyCostUsdCents: number;
  readonly archivedAt: string;
  readonly document: string;
  readonly entityType: "allowance-history";
  readonly ledgerInstanceId: string;
  readonly provider: ProviderName;
  readonly schemaVersion: number;
  readonly utcDay: string;
}

interface BranchEvidenceEntityProperties extends Record<string, unknown> {
  readonly commitSha: string;
  readonly document: string;
  readonly entityType: "approved-branch-evidence";
  readonly ledgerInstanceId: string;
  readonly repositoryId: string;
  readonly runId: string;
  readonly schemaVersion: number;
}

interface HeartbeatEntityProperties extends Record<string, unknown> {
  readonly document: string;
  readonly entityType: "reconciler-heartbeat";
  readonly lastSucceededAt: string;
  readonly ledgerInstanceId: string;
  readonly schemaVersion: number;
}

interface AllocationRead {
  readonly entity: TableEntity<AllocationEntityProperties>;
  readonly record: AllocationRecord;
}

interface AttemptRead {
  readonly entity: TableEntity<AttemptEntityProperties>;
  readonly record: ProviderAttempt;
}

interface BootstrapRegistryRead {
  readonly revision: string;
  readonly state: BootstrapRegistryDocument;
}

interface ControlRead {
  readonly entity: TableEntity<ProviderControlEntityProperties>;
  readonly state: ProviderControlState;
}

interface HistoryRead {
  readonly entity: TableEntity<Record<string, unknown>>;
  readonly state: AllowanceHistoryState;
}

type AllowanceRead =
  | { readonly kind: "current"; readonly value: number }
  | { readonly history: HistoryRead; readonly kind: "history"; readonly value: number };

export function createAzureTableAllocationLedger(
  options: AzureTableAllocationLedgerOptions,
): AzureTableAllocationLedger {
  const accountName = requireStorageAccountName(options.accountName);
  const tableName = requireTableName(options.tableName);
  const credential = new ManagedIdentityCredential(
    requireNonEmpty(options.managedIdentityClientId, "managedIdentityClientId"),
  );
  return new AzureTableAllocationLedger(
    new TableClient(`https://${accountName}.table.core.windows.net`, tableName, credential),
    {
      ledgerInstanceId: requireLedgerInstanceId(options.ledgerInstanceId),
      schemaVersion: requireLedgerSchemaVersion(options.schemaVersion),
    },
  );
}

export class AzureTableAllocationLedger
  implements AllocationControlLedger, ApprovedBranchEvidenceStore, ReconcilerHeartbeatStore
{
  readonly #client: AzureTableClientPort;
  readonly #expectedLedgerInstanceId: string;
  readonly #expectedSchemaVersion: number;

  constructor(
    client: AzureTableClientPort,
    evidence: Pick<AzureLedgerInstanceEvidence, "ledgerInstanceId" | "schemaVersion">,
  ) {
    this.#client = client;
    this.#expectedLedgerInstanceId = requireLedgerInstanceId(evidence.ledgerInstanceId);
    this.#expectedSchemaVersion = requireLedgerSchemaVersion(evidence.schemaVersion);
  }

  async acceptAllocation(request: AcceptAllocationRequest): Promise<AcceptAllocationResult> {
    await this.#requiredFoundation();
    const candidate = createAcceptedAllocationRecord(request, "candidate");
    const existing = await this.#readAllocation(candidate.allocationId);
    if (existing !== undefined) {
      if (!isExactAcceptanceRetry(existing.record, request)) {
        throw conflict(
          "allocation identity was reused with different immutable acceptance evidence",
        );
      }
      return { allocation: existing.record, acceptance: "exact-retry" };
    }
    try {
      await this.#client.submitTransaction([
        ["create", toAllocationEntity(candidate, this.#expectedLedgerInstanceId)],
      ]);
      return {
        allocation: await this.#requiredAllocation(candidate.allocationId),
        acceptance: "created",
      };
    } catch (error) {
      const recovered = await this.#readAllocation(candidate.allocationId);
      if (recovered !== undefined && isExactAcceptanceRetry(recovered.record, request)) {
        return { allocation: recovered.record, acceptance: "exact-retry" };
      }
      if (recovered !== undefined) {
        throw conflict(
          "allocation identity was reused with different immutable acceptance evidence",
        );
      }
      throw unavailable("Azure Tables did not confirm allocation acceptance", error);
    }
  }

  async abandonUnassignedAllocation(
    request: AbandonUnassignedAllocationRequest,
  ): Promise<AllocationRecord> {
    await this.#requiredFoundation();
    const current = await this.#requiredAllocation(request.allocationId);
    if (isExactUnassignedAbandonmentRetry(current, request)) return current;
    const updated = abandonUnassignedAllocationRecord(current, request, "pending-commit");
    return this.#replaceAllocation(
      current,
      updated,
      request.allocationId,
      (candidate) => isExactUnassignedAbandonmentRetry(candidate, request),
      "unassigned allocation abandonment",
    );
  }

  async getAllocation(allocationId: string): Promise<AllocationRecord | undefined> {
    await this.#requiredFoundation();
    return (await this.#readAllocation(allocationId))?.record;
  }

  async getAllocationByIdentity(
    identity: AllocationIdentity,
  ): Promise<AllocationRecord | undefined> {
    return this.getAllocation(allocationIdForIdentity(identity));
  }

  async listOpenAllocations(request: ListOpenAllocationsRequest): Promise<OpenAllocationsPage> {
    await this.#requiredFoundation();
    const pageSize = requireOpenPageSize(request.pageSize);
    const continuationToken = optionalContinuationToken(request.continuationToken);
    let page: TableEntityResultPage<AllocationEntityProperties>;
    try {
      const iterator = this.#client
        .listEntities<AllocationEntityProperties>({
          queryOptions: {
            filter: `PartitionKey eq '${AZURE_TABLE_LEDGER_PARTITION_KEY}' and RowKey ge 'allocation!' and RowKey lt 'allocation"'`,
          },
        })
        .byPage({
          ...(continuationToken === undefined ? {} : { continuationToken }),
          maxPageSize: pageSize,
        });
      const next = await iterator.next();
      if (next.done) return { allocations: [], continuationToken: null };
      page = next.value;
    } catch (error) {
      throw unavailable("Azure Tables open-allocation enumeration failed", error);
    }
    if (page.length > pageSize) {
      throw corrupt("Azure Tables returned an oversized open-allocation page");
    }
    const seen = new Set<string>();
    const allocations: AllocationRecord[] = [];
    for (const entity of page) {
      const rowKey = typeof entity.rowKey === "string" ? entity.rowKey : "";
      if (!rowKey.startsWith("allocation!")) {
        throw corrupt("open-allocation query returned a non-allocation row");
      }
      const document = parseAllocationEntity(
        entity as TableEntity<AllocationEntityProperties>,
        rowKey,
        this.#expectedLedgerInstanceId,
        this.#expectedSchemaVersion,
      );
      if (seen.has(document.allocationId)) {
        throw corrupt("open-allocation page contains duplicate state");
      }
      seen.add(document.allocationId);
      const current = await this.#readAllocation(document.allocationId);
      if (current === undefined) {
        throw corrupt("enumerated allocation disappeared during authoritative re-read");
      }
      if (allocationNeedsReconciliation(current.record)) {
        allocations.push(current.record);
      }
    }
    return {
      allocations,
      continuationToken: optionalContinuationToken(page.continuationToken) ?? null,
    };
  }

  async reserveProviderAttempt(
    request: ReserveProviderAttemptRequest,
  ): Promise<ReserveProviderAttemptResult> {
    await this.#requiredFoundation();
    for (let retry = 0; retry < MAX_TRANSACTION_RETRIES; retry += 1) {
      const current = await this.#requiredAllocation(request.allocationId);
      const exact = exactProviderAttemptRetry(current, request);
      if (exact !== undefined) {
        return exact;
      }
      if (request.expectedAllocationRevision !== current.revision) {
        throw optimisticConflict();
      }
      const control = await this.#requiredControl(request.provider);
      const rollover = await this.#controlForAdmission(control, request.attemptedAt.slice(0, 10));
      const refusal = evaluateProviderAttemptReservation(
        request.provider,
        rollover.control.activeReservations,
        rollover.control.accountedDailyCostUsdCents,
        request.worstCaseCostUsdCents,
      );
      const attempt = createProviderAttempt(current, request, "pending-commit", refusal);
      const allocation = appendProviderAttempt(current, attempt, "pending-commit");
      const actions: TransactionAction[] = [
        [
          "update",
          toAllocationEntity(allocation, this.#expectedLedgerInstanceId),
          "Replace",
          { etag: current.revision },
        ],
        ["create", toAttemptEntity(current.allocationId, attempt, this.#expectedLedgerInstanceId)],
      ];
      if (refusal === undefined) {
        actions.push([
          "update",
          toControlEntity(
            {
              ...rollover.control,
              accountedDailyCostUsdCents:
                rollover.control.accountedDailyCostUsdCents +
                attempt.reservation.reservedCostUsdCents,
              activeReservations: rollover.control.activeReservations + 1,
            },
            this.#expectedLedgerInstanceId,
          ),
          "Replace",
          { etag: control.state.revision },
        ]);
        if (rollover.history !== undefined) {
          actions.push([
            "create",
            toHistoryEntity(rollover.history, this.#expectedLedgerInstanceId),
          ]);
        }
      }
      try {
        await this.#client.submitTransaction(actions);
        const committed = await this.#requiredAllocation(request.allocationId);
        const committedAttempt = requiredAttempt(committed, request.ordinal);
        return refusal === undefined
          ? {
              allocation: committed,
              attempt: committedAttempt,
              outcome: "reserved",
              reservation: "created",
            }
          : {
              allocation: committed,
              attempt: committedAttempt,
              constraint: refusal,
              outcome: "capacity-unavailable",
              provider: request.provider,
              reservation: "created",
            };
      } catch (error) {
        const recovered = await this.#readAllocation(request.allocationId);
        if (recovered !== undefined) {
          const result = exactProviderAttemptRetry(recovered.record, request);
          if (result !== undefined) {
            return { ...result, reservation: "exact-retry" } as ReserveProviderAttemptResult;
          }
        }
        if (isConcurrencyRace(error)) {
          continue;
        }
        throw unavailable("Azure Tables did not confirm the atomic provider reservation", error);
      }
    }
    const recovered = await this.#requiredAllocation(request.allocationId);
    const exact = exactProviderAttemptRetry(recovered, request);
    if (exact !== undefined) {
      return { ...exact, reservation: "exact-retry" } as ReserveProviderAttemptResult;
    }
    throw unavailable("Azure Tables provider reservation contention exceeded its retry limit");
  }

  async settleUnavailableProviderAttempt(
    request: SettleUnavailableProviderAttemptRequest,
  ): Promise<AllocationRecord> {
    return this.#settleHeldAttempt(request, "unavailable");
  }

  async settleFinalProviderAttempt(
    request: SettleFinalProviderAttemptRequest,
  ): Promise<AllocationRecord> {
    return this.#settleHeldAttempt(request, "terminal");
  }

  async settleFatalAzureAbort(request: SettleFatalAzureAbortRequest): Promise<AllocationRecord> {
    return this.#settleHeldAttempt(request, "aborted");
  }

  async beginFatalAzureAbort(request: BeginFatalAzureAbortRequest): Promise<AllocationRecord> {
    await this.#requiredFoundation();
    const current = await this.#requiredAllocation(request.allocationId);
    if (isExactFatalAzureAbortIntentRetry(current, request)) return current;
    const attempt = requiredAttempt(current, request.ordinal);
    const updated = beginFatalAzureAbortRecords(
      current,
      attempt,
      request,
      "pending-commit",
      "pending-commit",
    );
    try {
      await this.#client.submitTransaction([
        [
          "update",
          toAllocationEntity(updated.allocation, this.#expectedLedgerInstanceId),
          "Replace",
          { etag: current.revision },
        ],
        [
          "update",
          toAttemptEntity(current.allocationId, updated.attempt, this.#expectedLedgerInstanceId),
          "Replace",
          { etag: attempt.revision },
        ],
      ]);
    } catch (error) {
      const recovered = await this.#requiredAllocation(request.allocationId);
      if (isExactFatalAzureAbortIntentRetry(recovered, request)) return recovered;
      if (isConcurrencyRace(error)) throw optimisticConflict();
      throw unavailable("Azure Tables did not confirm fatal abort intent", error);
    }
    return this.#requiredAllocation(request.allocationId);
  }

  async markProviderAttemptSucceeded(
    request: MarkProviderAttemptSucceededRequest,
  ): Promise<AllocationRecord> {
    await this.#requiredFoundation();
    const current = await this.#requiredAllocation(request.allocationId);
    if (isExactAttemptSuccessRetry(current, request)) {
      return current;
    }
    const attempt = requiredAttempt(current, request.ordinal);
    const updated = markProviderAttemptSucceededRecords(
      current,
      attempt,
      request,
      "pending-commit",
      "pending-commit",
    );
    try {
      await this.#client.submitTransaction([
        [
          "update",
          toAllocationEntity(updated.allocation, this.#expectedLedgerInstanceId),
          "Replace",
          { etag: current.revision },
        ],
        [
          "update",
          toAttemptEntity(current.allocationId, updated.attempt, this.#expectedLedgerInstanceId),
          "Replace",
          { etag: attempt.revision },
        ],
      ]);
    } catch (error) {
      const recovered = await this.#requiredAllocation(request.allocationId);
      if (isExactAttemptSuccessRetry(recovered, request)) {
        return recovered;
      }
      if (isConcurrencyRace(error)) {
        throw optimisticConflict();
      }
      throw unavailable("Azure Tables did not confirm provider success", error);
    }
    return this.#requiredAllocation(request.allocationId);
  }

  async assignRunner(request: AssignRunnerRequest): Promise<AllocationRecord> {
    await this.#requiredFoundation();
    const current = await this.#requiredAllocation(request.allocationId);
    const updated = assignRunnerRecord(current, request, "pending-commit");
    if (updated === current) {
      return current;
    }
    return this.#replaceAllocation(
      current,
      updated,
      request.allocationId,
      (candidate) => assignRunnerRecord(candidate, request, candidate.revision) === candidate,
      "runner assignment",
    );
  }

  async updateAllocationState(request: UpdateAllocationStateRequest): Promise<AllocationRecord> {
    await this.#requiredFoundation();
    const current = await this.#requiredAllocation(request.allocationId);
    if (request.expectedRevision !== current.revision) {
      if (sameAllocationState(current, request)) {
        return current;
      }
      throw optimisticConflict();
    }
    const updated = applyAllocationStatePatch(current, request, "pending-commit");
    if (sameAllocationDocument(current, updated)) {
      return current;
    }
    return this.#replaceAllocation(
      current,
      updated,
      request.allocationId,
      (candidate) => sameAllocationState(candidate, request),
      "allocation-state update",
    );
  }

  async stopAllocation(request: StopAllocationRequest): Promise<AllocationRecord> {
    await this.#requiredFoundation();
    const current = await this.#requiredAllocation(request.allocationId);
    const updated = stopAllocationRecord(current, request, "pending-commit");
    if (updated === current) {
      return current;
    }
    return this.#replaceAllocation(
      current,
      updated,
      request.allocationId,
      (candidate) => stopAllocationRecord(candidate, request, candidate.revision) === candidate,
      "allocation stop",
    );
  }

  async addPhysicalGeneration(
    request: AddPhysicalGenerationRequest,
  ): Promise<AddPhysicalGenerationResult> {
    await this.#requiredFoundation();
    for (let retry = 0; retry < MAX_TRANSACTION_RETRIES; retry += 1) {
      const current = await this.#requiredAllocation(request.allocationId);
      const exact = exactGenerationRetry(current, request);
      if (exact !== undefined) {
        return exact;
      }
      const attempt = requiredAttempt(current, request.attemptOrdinal);
      if (request.expectedAttemptRevision !== attempt.revision) {
        throw optimisticConflict();
      }
      const generation = createPhysicalGeneration(current, attempt, request, "pending-commit");
      const control = await this.#requiredControl(attempt.provider);
      const allowance = await this.#readAllowance(
        control,
        attempt.provider,
        attempt.reservation.utcDay,
      );
      const reread = await this.#requiredAllocation(request.allocationId);
      const afterControlRead = exactGenerationRetry(reread, request);
      if (afterControlRead !== undefined) {
        return afterControlRead;
      }
      const rereadAttempt = requiredAttempt(reread, request.attemptOrdinal);
      if (rereadAttempt.revision !== attempt.revision) {
        continue;
      }
      validateHeldReservationCounters(
        attempt.provider,
        control.state.activeReservations,
        allowance.value,
        attempt.reservation.reservedCostUsdCents,
      );
      if (
        generation.reservedIncrementalCostUsdCents > 0 &&
        evaluateAdditionalAllowance(
          attempt.provider,
          allowance.value,
          generation.reservedIncrementalCostUsdCents,
        )
      ) {
        return {
          constraint: "daily-allowance",
          outcome: "capacity-unavailable",
          provider: "azure",
        };
      }
      const updated = appendPhysicalGeneration(current, attempt, generation, "pending-commit");
      const actions: TransactionAction[] = [
        [
          "update",
          toAttemptEntity(request.allocationId, updated.attempt, this.#expectedLedgerInstanceId),
          "Replace",
          { etag: attempt.revision },
        ],
        [
          "create",
          toGenerationEntity(
            request.allocationId,
            request.attemptOrdinal,
            generation,
            this.#expectedLedgerInstanceId,
          ),
        ],
        this.#allowanceUpdateAction(
          control,
          allowance,
          allowance.value + generation.reservedIncrementalCostUsdCents,
        ),
      ];
      try {
        await this.#client.submitTransaction(actions);
        const committed = await this.#requiredAllocation(request.allocationId);
        const committedAttempt = requiredAttempt(committed, request.attemptOrdinal);
        const committedGeneration = committedAttempt.physicalGenerations.find(
          (entry) => entry.generationNumber === request.generationNumber,
        );
        if (committedGeneration === undefined) {
          throw corrupt("committed generation is missing from its Azure attempt aggregate");
        }
        return {
          allocation: committed,
          attempt: committedAttempt,
          generation: committedGeneration,
          outcome: "added",
          reservation: "created",
        };
      } catch (error) {
        const recovered = await this.#requiredAllocation(request.allocationId);
        const result = exactGenerationRetry(recovered, request);
        if (result?.outcome === "added") {
          return { ...result, reservation: "exact-retry" };
        }
        if (isConcurrencyRace(error)) {
          continue;
        }
        throw unavailable("Azure Tables did not confirm the generation reservation", error);
      }
    }
    const exact = exactGenerationRetry(
      await this.#requiredAllocation(request.allocationId),
      request,
    );
    if (exact?.outcome === "added") {
      return { ...exact, reservation: "exact-retry" };
    }
    throw unavailable("Azure Tables generation contention exceeded its retry limit");
  }

  async updatePhysicalGeneration(
    request: UpdatePhysicalGenerationRequest,
  ): Promise<AllocationRecord> {
    await this.#requiredFoundation();
    const allocation = await this.#requiredAllocation(request.allocationId);
    const attempt = requiredAttempt(allocation, request.attemptOrdinal);
    const generation = attempt.physicalGenerations.find(
      (entry) => entry.generationNumber === request.generationNumber,
    );
    if (generation === undefined) {
      throw new AllocationLedgerError("not-found", "physical generation was not found");
    }
    if (request.expectedRevision !== generation.revision) {
      if (samePhysicalGenerationState(attempt, generation, request)) {
        return allocation;
      }
      throw optimisticConflict();
    }
    const updated = applyPhysicalGenerationState(attempt, generation, request, "pending-commit");
    if (sameGenerationDocument(generation, updated)) {
      return allocation;
    }
    try {
      await this.#client.submitTransaction([
        [
          "update",
          toGenerationEntity(
            request.allocationId,
            request.attemptOrdinal,
            updated,
            this.#expectedLedgerInstanceId,
          ),
          "Replace",
          { etag: generation.revision },
        ],
      ]);
    } catch (error) {
      const recovered = await this.#requiredAllocation(request.allocationId);
      const recoveredAttempt = requiredAttempt(recovered, request.attemptOrdinal);
      const recoveredGeneration = recoveredAttempt.physicalGenerations.find(
        (entry) => entry.generationNumber === request.generationNumber,
      );
      if (
        recoveredGeneration !== undefined &&
        samePhysicalGenerationState(recoveredAttempt, recoveredGeneration, request)
      ) {
        return recovered;
      }
      if (isConcurrencyRace(error)) {
        throw optimisticConflict();
      }
      throw unavailable("Azure Tables did not confirm the generation update", error);
    }
    return this.#requiredAllocation(request.allocationId);
  }

  async updatePhysicalGenerationFenced(
    request: FencedPhysicalGenerationUpdateRequest,
  ): Promise<AllocationRecord> {
    await this.#requiredFoundation();
    const allocation = await this.#requiredAllocation(request.allocationId);
    const attempt = requiredAttempt(allocation, request.attemptOrdinal);
    const generation = attempt.physicalGenerations.find(
      (entry) => entry.generationNumber === request.generationNumber,
    );
    if (generation === undefined) {
      throw new AllocationLedgerError("not-found", "physical generation was not found");
    }
    if (
      request.expectedAllocationRevision !== allocation.revision ||
      request.expectedAttemptRevision !== attempt.revision ||
      request.expectedRevision !== generation.revision
    ) {
      if (samePhysicalGenerationState(attempt, generation, request)) return allocation;
      throw optimisticConflict();
    }
    const updated = applyFencedPhysicalGenerationUpdate(allocation, attempt, generation, request, {
      allocation: "pending-commit",
      attempt: "pending-commit",
      generation: "pending-commit",
    });
    const updatedAttempt = requiredAttempt(updated, request.attemptOrdinal);
    const updatedGeneration = updatedAttempt.physicalGenerations.find(
      (entry) => entry.generationNumber === request.generationNumber,
    );
    if (updatedGeneration === undefined) throw corrupt("fenced generation update lost its row");
    try {
      await this.#client.submitTransaction([
        [
          "update",
          toAllocationEntity(updated, this.#expectedLedgerInstanceId),
          "Replace",
          { etag: allocation.revision },
        ],
        [
          "update",
          toAttemptEntity(request.allocationId, updatedAttempt, this.#expectedLedgerInstanceId),
          "Replace",
          { etag: attempt.revision },
        ],
        [
          "update",
          toGenerationEntity(
            request.allocationId,
            request.attemptOrdinal,
            updatedGeneration,
            this.#expectedLedgerInstanceId,
          ),
          "Replace",
          { etag: generation.revision },
        ],
      ]);
    } catch (error) {
      const recovered = await this.#requiredAllocation(request.allocationId);
      const recoveredAttempt = requiredAttempt(recovered, request.attemptOrdinal);
      const recoveredGeneration = recoveredAttempt.physicalGenerations.find(
        (entry) => entry.generationNumber === request.generationNumber,
      );
      if (
        recoveredGeneration !== undefined &&
        samePhysicalGenerationState(recoveredAttempt, recoveredGeneration, request)
      ) {
        return recovered;
      }
      if (isConcurrencyRace(error)) throw optimisticConflict();
      throw unavailable("Azure Tables did not confirm the fenced generation update", error);
    }
    return this.#requiredAllocation(request.allocationId);
  }

  async acquireCheckRunCreationLease(
    request: AcquireCheckRunCreationLeaseRequest,
  ): Promise<AcquireCheckRunCreationLeaseResult> {
    await this.#requiredFoundation();
    const current = await this.#requiredAllocation(request.allocationId);
    const updated = acquireCheckRunCreationLeaseRecord(current, request, "pending-commit");
    if (updated.allocation === current) {
      return updated.result;
    }
    try {
      await this.#client.submitTransaction([
        [
          "update",
          toAllocationEntity(updated.allocation, this.#expectedLedgerInstanceId),
          "Replace",
          { etag: current.revision },
        ],
      ]);
      return acquireCheckRunCreationLeaseRecord(
        await this.#requiredAllocation(request.allocationId),
        request,
        "already-committed",
      ).result;
    } catch (error) {
      const recovered = await this.#requiredAllocation(request.allocationId);
      const result = acquireCheckRunCreationLeaseRecord(recovered, request, "recovered");
      if (result.allocation === recovered) {
        return result.result;
      }
      if (isConcurrencyRace(error)) {
        throw optimisticConflict();
      }
      throw unavailable("Azure Tables did not confirm the Check Run creation lease", error);
    }
  }

  async completeCheckRunCreation(
    request: CompleteCheckRunCreationRequest,
  ): Promise<AllocationRecord> {
    await this.#requiredFoundation();
    const current = await this.#requiredAllocation(request.allocationId);
    const updated = completeCheckRunCreationRecord(current, request, "pending-commit");
    if (updated === current) {
      return current;
    }
    return this.#replaceAllocation(
      current,
      updated,
      request.allocationId,
      (candidate) =>
        completeCheckRunCreationRecord(candidate, request, candidate.revision) === candidate,
      "Check Run creation completion",
    );
  }

  async renewCheckRunCreationLease(
    request: RenewCheckRunCreationLeaseRequest,
  ): Promise<RenewCheckRunCreationLeaseResult> {
    await this.#requiredFoundation();
    const current = await this.#requiredAllocation(request.allocationId);
    const updated = renewCheckRunCreationLeaseRecord(current, request, "pending-commit");
    if (updated.allocation === current) {
      return updated.result;
    }
    try {
      await this.#client.submitTransaction([
        [
          "update",
          toAllocationEntity(updated.allocation, this.#expectedLedgerInstanceId),
          "Replace",
          { etag: current.revision },
        ],
      ]);
    } catch (error) {
      const recovered = await this.#requiredAllocation(request.allocationId);
      const exact = renewCheckRunCreationLeaseRecord(recovered, request, "recovered");
      if (exact.allocation === recovered) {
        return exact.result;
      }
      if (isConcurrencyRace(error)) {
        throw optimisticConflict();
      }
      throw unavailable("Azure Tables did not confirm the Check Run creation lease renewal", error);
    }
    return renewCheckRunCreationLeaseRecord(
      await this.#requiredAllocation(request.allocationId),
      request,
      "already-committed",
    ).result;
  }

  async failCheckRunCreation(request: FailCheckRunCreationRequest): Promise<AllocationRecord> {
    await this.#requiredFoundation();
    const current = await this.#requiredAllocation(request.allocationId);
    const updated = failCheckRunCreationRecord(current, request, "pending-commit");
    if (updated === current) {
      return current;
    }
    return this.#replaceAllocation(
      current,
      updated,
      request.allocationId,
      (candidate) =>
        candidate.checkRunCreation.delivery.retry?.attempt ===
        updated.checkRunCreation.delivery.retry?.attempt,
      "Check Run creation failure",
    );
  }

  async load(input: {
    readonly repositoryId: string;
    readonly runId: string;
  }): Promise<ApprovedBranchEvidence | null> {
    await this.#requiredFoundation();
    const rowKey = branchEvidenceRowKey(input.repositoryId, input.runId);
    const entity = await this.#getOptionalEntity<BranchEvidenceEntityProperties>(rowKey);
    return entity === undefined
      ? null
      : parseBranchEvidenceEntity(
          entity,
          rowKey,
          this.#expectedLedgerInstanceId,
          this.#expectedSchemaVersion,
        );
  }

  async recordInitial(
    evidenceValue: ApprovedBranchEvidence,
  ): Promise<ApprovedBranchEvidenceRecordResult> {
    await this.#requiredFoundation();
    const evidence = parseApprovedBranchEvidence(evidenceValue);
    const existing = await this.load(evidence);
    if (existing !== null) {
      return equal(existing, evidence) ? "matched" : "conflict";
    }
    try {
      await this.#client.submitTransaction([
        ["create", toBranchEvidenceEntity(evidence, this.#expectedLedgerInstanceId)],
      ]);
      return "recorded";
    } catch (error) {
      const recovered = await this.load(evidence);
      if (recovered !== null) {
        return equal(recovered, evidence) ? "matched" : "conflict";
      }
      throw unavailable("Azure Tables did not confirm approved branch evidence", error);
    }
  }

  async getReconcilerHeartbeat(): Promise<ReconcilerHeartbeatState | null> {
    await this.#requiredFoundation();
    const entity = await this.#getOptionalEntity<HeartbeatEntityProperties>(heartbeatRowKey());
    if (entity === undefined) {
      throw corrupt("required reconciler heartbeat row is missing");
    }
    return parseHeartbeatEntity(
      entity,
      this.#expectedLedgerInstanceId,
      this.#expectedSchemaVersion,
    );
  }

  async recordReconcilerHeartbeat(input: {
    readonly lastSucceededAt: string;
  }): Promise<ReconcilerHeartbeatState> {
    await this.#requiredFoundation();
    const lastSucceededAt = requireUtcInstant(input.lastSucceededAt, "lastSucceededAt");
    for (let retry = 0; retry < MAX_TRANSACTION_RETRIES; retry += 1) {
      const entity = await this.#getOptionalEntity<HeartbeatEntityProperties>(heartbeatRowKey());
      if (entity === undefined) {
        throw corrupt("required reconciler heartbeat row is missing");
      }
      const current = parseHeartbeatEntity(
        entity,
        this.#expectedLedgerInstanceId,
        this.#expectedSchemaVersion,
      );
      if (current !== null) {
        if (lastSucceededAt < current.lastSucceededAt) {
          throw new AllocationLedgerError(
            "precondition-failed",
            "reconciler heartbeat cannot move backwards",
          );
        }
        if (lastSucceededAt === current.lastSucceededAt) {
          return current;
        }
      }
      try {
        await this.#client.submitTransaction([
          [
            "update",
            toHeartbeatEntity(lastSucceededAt, this.#expectedLedgerInstanceId),
            "Replace",
            { etag: requireRevision(entity.etag, "reconciler heartbeat") },
          ],
        ]);
        const committed = await this.getReconcilerHeartbeat();
        if (committed === null) {
          throw corrupt("committed reconciler heartbeat unexpectedly became empty");
        }
        return committed;
      } catch (error) {
        if (isConcurrencyRace(error)) {
          continue;
        }
        throw unavailable("Azure Tables did not confirm the reconciler heartbeat", error);
      }
    }
    throw unavailable("Azure Tables heartbeat contention exceeded its retry limit");
  }

  async #settleHeldAttempt(
    request:
      | SettleUnavailableProviderAttemptRequest
      | SettleFinalProviderAttemptRequest
      | SettleFatalAzureAbortRequest,
    kind: "aborted" | "unavailable" | "terminal",
  ): Promise<AllocationRecord> {
    await this.#requiredFoundation();
    for (let retry = 0; retry < MAX_TRANSACTION_RETRIES; retry += 1) {
      const current = await this.#requiredAllocation(request.allocationId);
      if (
        (kind === "unavailable" &&
          isExactUnavailableSettlementRetry(
            current,
            request as SettleUnavailableProviderAttemptRequest,
          )) ||
        (kind === "aborted" &&
          isExactFatalAzureAbortRetry(current, request as SettleFatalAzureAbortRequest)) ||
        (kind === "terminal" &&
          isExactFinalSettlementRetry(current, request as SettleFinalProviderAttemptRequest))
      ) {
        return current;
      }
      const attempt = requiredAttempt(current, request.ordinal);
      const control = await this.#requiredControl(attempt.provider);
      const allowance = await this.#readAllowance(
        control,
        attempt.provider,
        attempt.reservation.utcDay,
      );
      const reread = await this.#requiredAllocation(request.allocationId);
      if (
        (kind === "unavailable" &&
          isExactUnavailableSettlementRetry(
            reread,
            request as SettleUnavailableProviderAttemptRequest,
          )) ||
        (kind === "aborted" &&
          isExactFatalAzureAbortRetry(reread, request as SettleFatalAzureAbortRequest)) ||
        (kind === "terminal" &&
          isExactFinalSettlementRetry(reread, request as SettleFinalProviderAttemptRequest))
      ) {
        return reread;
      }
      const rereadAttempt = requiredAttempt(reread, request.ordinal);
      if (reread.revision !== current.revision || rereadAttempt.revision !== attempt.revision) {
        throw optimisticConflict();
      }
      validateHeldReservationCounters(
        attempt.provider,
        control.state.activeReservations,
        allowance.value,
        attempt.reservation.reservedCostUsdCents,
      );
      const settled =
        kind === "unavailable"
          ? settleUnavailableAttemptRecords(
              current,
              attempt,
              request as SettleUnavailableProviderAttemptRequest,
              "pending-commit",
              "pending-commit",
            )
          : kind === "aborted"
            ? settleFatalAzureAbortRecords(
                current,
                attempt,
                request as SettleFatalAzureAbortRequest,
                "pending-commit",
                "pending-commit",
              )
            : settleFinalAttemptRecords(
                current,
                attempt,
                request as SettleFinalProviderAttemptRequest,
                "pending-commit",
                "pending-commit",
              );
      const updatedCost =
        allowance.value - attempt.reservation.reservedCostUsdCents + request.finalCostUsdCents;
      validateAllowanceCost(attempt.provider, updatedCost);
      const updatedControl: ProviderControlState = {
        ...control.state,
        accountedDailyCostUsdCents:
          allowance.kind === "current" ? updatedCost : control.state.accountedDailyCostUsdCents,
        activeReservations: control.state.activeReservations - 1,
      };
      const actions: TransactionAction[] = [
        [
          "update",
          toAllocationEntity(settled.allocation, this.#expectedLedgerInstanceId),
          "Replace",
          { etag: current.revision },
        ],
        [
          "update",
          toAttemptEntity(request.allocationId, settled.attempt, this.#expectedLedgerInstanceId),
          "Replace",
          { etag: attempt.revision },
        ],
        [
          "update",
          toControlEntity(updatedControl, this.#expectedLedgerInstanceId),
          "Replace",
          { etag: control.state.revision },
        ],
      ];
      if (allowance.kind === "history") {
        actions.push([
          "update",
          toHistoryEntity(
            { ...allowance.history.state, accountedDailyCostUsdCents: updatedCost },
            this.#expectedLedgerInstanceId,
          ),
          "Replace",
          { etag: allowance.history.state.revision },
        ]);
      }
      try {
        await this.#client.submitTransaction(actions);
        return this.#requiredAllocation(request.allocationId);
      } catch (error) {
        const recovered = await this.#requiredAllocation(request.allocationId);
        const exact =
          kind === "unavailable"
            ? isExactUnavailableSettlementRetry(
                recovered,
                request as SettleUnavailableProviderAttemptRequest,
              )
            : kind === "aborted"
              ? isExactFatalAzureAbortRetry(recovered, request as SettleFatalAzureAbortRequest)
              : isExactFinalSettlementRetry(
                  recovered,
                  request as SettleFinalProviderAttemptRequest,
                );
        if (exact) {
          return recovered;
        }
        if (isConcurrencyRace(error)) {
          continue;
        }
        throw unavailable(`Azure Tables did not confirm ${kind} settlement`, error);
      }
    }
    throw unavailable(`Azure Tables ${kind} settlement contention exceeded its retry limit`);
  }

  async #replaceAllocation(
    current: AllocationRecord,
    updated: AllocationRecord,
    allocationId: string,
    recoveredIsExact: (candidate: AllocationRecord) => boolean,
    operation: string,
  ): Promise<AllocationRecord> {
    assertAuthoritativeAllocationAggregate(updated);
    try {
      await this.#client.submitTransaction([
        [
          "update",
          toAllocationEntity(updated, this.#expectedLedgerInstanceId),
          "Replace",
          { etag: current.revision },
        ],
      ]);
    } catch (error) {
      const recovered = await this.#requiredAllocation(allocationId);
      if (recoveredIsExact(recovered)) {
        return recovered;
      }
      if (isConcurrencyRace(error)) {
        throw optimisticConflict();
      }
      throw unavailable(`Azure Tables did not confirm the ${operation}`, error);
    }
    return this.#requiredAllocation(allocationId);
  }

  #allowanceUpdateAction(
    control: ControlRead,
    allowance: AllowanceRead,
    value: number,
  ): TransactionAction {
    validateAllowanceCost(control.state.provider, value);
    if (allowance.kind === "current") {
      return [
        "update",
        toControlEntity(
          { ...control.state, accountedDailyCostUsdCents: value },
          this.#expectedLedgerInstanceId,
        ),
        "Replace",
        { etag: control.state.revision },
      ];
    }
    return [
      "update",
      toHistoryEntity(
        { ...allowance.history.state, accountedDailyCostUsdCents: value },
        this.#expectedLedgerInstanceId,
      ),
      "Replace",
      { etag: allowance.history.state.revision },
    ];
  }

  async #controlForAdmission(
    current: ControlRead,
    utcDay: string,
  ): Promise<{
    readonly control: ProviderControlState;
    readonly history?: AllowanceHistoryState;
  }> {
    requireUtcDay(utcDay, "attempt UTC day");
    if (utcDay < current.state.utcDay) {
      throw corrupt("provider admission cannot use an older UTC day");
    }
    if (utcDay === current.state.utcDay) {
      return { control: current.state };
    }
    if ((await this.#readHistory(current.state.provider, current.state.utcDay)) !== undefined) {
      throw corrupt("allowance history already exists before atomic UTC rollover");
    }
    return {
      control: { ...current.state, accountedDailyCostUsdCents: 0, utcDay },
      history: {
        accountedDailyCostUsdCents: current.state.accountedDailyCostUsdCents,
        archivedAt: `${utcDay}T00:00:00.000Z`,
        provider: current.state.provider,
        revision: "pending-create",
        utcDay: current.state.utcDay,
      },
    };
  }

  async #readAllowance(
    control: ControlRead,
    provider: ProviderName,
    utcDay: string,
  ): Promise<AllowanceRead> {
    if (utcDay === control.state.utcDay) {
      return {
        kind: "current",
        value: control.state.accountedDailyCostUsdCents,
      };
    }
    if (utcDay > control.state.utcDay) {
      throw corrupt("a held reservation cannot refer to a future provider-control day");
    }
    const history = await this.#readHistory(provider, utcDay);
    if (history === undefined) {
      throw corrupt("allowance history required by a held reservation is missing");
    }
    return { history, kind: "history", value: history.state.accountedDailyCostUsdCents };
  }

  async #requiredAllocation(allocationId: string): Promise<AllocationRecord> {
    const allocation = await this.#readAllocation(allocationId);
    if (allocation === undefined) {
      throw new AllocationLedgerError("not-found", "allocation was not found");
    }
    return allocation.record;
  }

  async #readAllocation(allocationId: string): Promise<AllocationRead | undefined> {
    const rowKey = allocationRowKey(allocationId);
    const entity = await this.#getOptionalEntity<AllocationEntityProperties>(rowKey);
    if (entity === undefined) {
      return undefined;
    }
    const document = parseAllocationEntity(
      entity,
      rowKey,
      this.#expectedLedgerInstanceId,
      this.#expectedSchemaVersion,
    );
    const attempts: ProviderAttempt[] = [];
    for (let ordinal = 1; ordinal <= document.attemptCount; ordinal += 1) {
      attempts.push((await this.#readRequiredAttempt(allocationId, ordinal)).record);
    }
    const {
      attemptCount: _attemptCount,
      ledgerInstanceId: _instance,
      schemaVersion: _schema,
      ...base
    } = document;
    const record: AllocationRecord = {
      ...base,
      attempts,
      revision: requireRevision(entity.etag, "allocation"),
    };
    assertAuthoritativeAllocationAggregate(record);
    return { entity, record };
  }

  async #readRequiredAttempt(allocationId: string, ordinal: number): Promise<AttemptRead> {
    const rowKey = attemptRowKey(allocationId, ordinal);
    const entity = await this.#getOptionalEntity<AttemptEntityProperties>(rowKey);
    if (entity === undefined) {
      throw corrupt("allocation references a missing provider attempt row");
    }
    const document = parseAttemptEntity(
      entity,
      rowKey,
      this.#expectedLedgerInstanceId,
      this.#expectedSchemaVersion,
    );
    const physicalGenerations: PhysicalGeneration[] = [];
    for (let number = 1; number <= document.generationCount; number += 1) {
      physicalGenerations.push(await this.#readRequiredGeneration(allocationId, ordinal, number));
    }
    const {
      generationCount: _count,
      ledgerInstanceId: _instance,
      schemaVersion: _schema,
      ...base
    } = document;
    return {
      entity,
      record: {
        ...base,
        physicalGenerations,
        revision: requireRevision(entity.etag, "provider attempt"),
      },
    };
  }

  async #readRequiredGeneration(
    allocationId: string,
    attemptOrdinal: number,
    generationNumber: number,
  ): Promise<PhysicalGeneration> {
    const rowKey = generationRowKey(allocationId, attemptOrdinal, generationNumber);
    const entity = await this.#getOptionalEntity<GenerationEntityProperties>(rowKey);
    if (entity === undefined) {
      throw corrupt("Azure attempt references a missing physical generation row");
    }
    return parseGenerationEntity(
      entity,
      rowKey,
      this.#expectedLedgerInstanceId,
      this.#expectedSchemaVersion,
    );
  }

  async #requiredControl(provider: ProviderName): Promise<ControlRead> {
    const foundation = await this.#requiredFoundation();
    return provider === "azure" ? foundation.azure : foundation.blacksmith;
  }

  async #requiredFoundation(): Promise<{
    readonly azure: ControlRead;
    readonly blacksmith: ControlRead;
    readonly registry: BootstrapRegistryRead;
  }> {
    const [registry, azure, blacksmith, heartbeat] = await Promise.all([
      this.#readBootstrapRegistry(),
      this.#readControl("azure"),
      this.#readControl("blacksmith"),
      this.#getOptionalEntity<HeartbeatEntityProperties>(heartbeatRowKey()),
    ]);
    if (
      registry === undefined ||
      azure === undefined ||
      blacksmith === undefined ||
      heartbeat === undefined
    ) {
      throw corrupt("ledger runtime foundation is incomplete");
    }
    validateRuntimeFoundation(
      registry,
      azure,
      blacksmith,
      heartbeat,
      this.#expectedLedgerInstanceId,
      this.#expectedSchemaVersion,
    );
    return { azure, blacksmith, registry };
  }

  async #readBootstrapRegistry(): Promise<BootstrapRegistryRead | undefined> {
    const entity = await this.#getOptionalEntity<BootstrapRegistryEntityProperties>(
      bootstrapRegistryRowKey(),
    );
    return entity === undefined
      ? undefined
      : parseBootstrapRegistryEntity(
          entity,
          this.#expectedLedgerInstanceId,
          this.#expectedSchemaVersion,
        );
  }

  async #readControl(provider: ProviderName): Promise<ControlRead | undefined> {
    const entity = await this.#getOptionalEntity<ProviderControlEntityProperties>(
      controlRowKey(provider),
    );
    return entity === undefined
      ? undefined
      : parseControlEntity(
          entity,
          provider,
          this.#expectedLedgerInstanceId,
          this.#expectedSchemaVersion,
        );
  }

  async #readHistory(provider: ProviderName, utcDay: string): Promise<HistoryRead | undefined> {
    const rowKey = historyRowKey(provider, utcDay);
    const entity = await this.#getOptionalEntity<AllowanceHistoryEntityProperties>(rowKey);
    return entity === undefined
      ? undefined
      : parseHistoryEntity(
          entity,
          rowKey,
          provider,
          this.#expectedLedgerInstanceId,
          this.#expectedSchemaVersion,
        );
  }

  async #getOptionalEntity<T extends object>(rowKey: string): Promise<TableEntity<T> | undefined> {
    try {
      return (await this.#client.getEntity<T>(
        AZURE_TABLE_LEDGER_PARTITION_KEY,
        rowKey,
      )) as TableEntity<T>;
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw unavailable(`Azure Tables read failed for required row ${rowKey}`, error);
    }
  }
}

function toAllocationEntity(
  allocation: AllocationRecord,
  ledgerInstanceId: string,
): TableEntity<AllocationEntityProperties> {
  assertAuthoritativeAllocationAggregate(allocation);
  const document: AllocationDocument = {
    ...withoutAllocationStorageFields(allocation),
    attemptCount: allocation.attempts.length,
    ledgerInstanceId,
    schemaVersion: AZURE_TABLE_LEDGER_SCHEMA_VERSION,
  };
  return {
    allocationId: allocation.allocationId,
    allocatorCheckRunId: allocation.identity.allocator_check_run_id,
    attemptCount: allocation.attempts.length,
    document: JSON.stringify(document),
    entityType: "allocation",
    ledgerInstanceId,
    lifecycleState: allocation.lifecycleState,
    partitionKey: AZURE_TABLE_LEDGER_PARTITION_KEY,
    repositoryId: allocation.identity.repository_id,
    rowKey: allocationRowKey(allocation.allocationId),
    runAttempt: allocation.identity.run_attempt,
    runId: allocation.identity.run_id,
    schemaVersion: AZURE_TABLE_LEDGER_SCHEMA_VERSION,
  };
}

function assertAuthoritativeAllocationAggregate(allocation: AllocationRecord): void {
  try {
    assertValidAllocationRecord(allocation);
  } catch (error) {
    throw corrupt("allocation aggregate is not valid authoritative state", error);
  }
}

function toAttemptEntity(
  allocationId: string,
  attempt: ProviderAttempt,
  ledgerInstanceId: string,
): TableEntity<AttemptEntityProperties> {
  const document: AttemptDocument = {
    ...withoutAttemptStorageFields(attempt),
    generationCount: attempt.physicalGenerations.length,
    ledgerInstanceId,
    schemaVersion: AZURE_TABLE_LEDGER_SCHEMA_VERSION,
  };
  return {
    admission: attempt.admission,
    allocationId,
    document: JSON.stringify(document),
    entityType: "provider-attempt",
    generationCount: attempt.physicalGenerations.length,
    ledgerInstanceId,
    ordinal: attempt.ordinal,
    outcome: attempt.outcome,
    partitionKey: AZURE_TABLE_LEDGER_PARTITION_KEY,
    provider: attempt.provider,
    reservationState: attempt.reservation.state,
    reservedCostUsdCents: attempt.reservation.reservedCostUsdCents,
    rowKey: attemptRowKey(allocationId, attempt.ordinal),
    schemaVersion: AZURE_TABLE_LEDGER_SCHEMA_VERSION,
  };
}

function toGenerationEntity(
  allocationId: string,
  attemptOrdinal: number,
  generation: PhysicalGeneration,
  ledgerInstanceId: string,
): TableEntity<GenerationEntityProperties> {
  const { revision: _revision, ...generationDocument } = generation;
  const document = {
    ...generationDocument,
    ledgerInstanceId,
    schemaVersion: AZURE_TABLE_LEDGER_SCHEMA_VERSION,
  };
  return {
    allocationId,
    attemptOrdinal,
    document: JSON.stringify(document),
    entityType: "physical-generation",
    generationNumber: generation.generationNumber,
    ledgerInstanceId,
    partitionKey: AZURE_TABLE_LEDGER_PARTITION_KEY,
    rowKey: generationRowKey(allocationId, attemptOrdinal, generation.generationNumber),
    scheduleStatus: generation.schedule?.status ?? "not-requested",
    schemaVersion: AZURE_TABLE_LEDGER_SCHEMA_VERSION,
    state: generation.state,
  };
}

function toControlEntity(
  control: ProviderControlState,
  ledgerInstanceId: string,
): TableEntity<ProviderControlEntityProperties> {
  const { revision: _revision, ...state } = control;
  const document: ProviderControlDocument = {
    ...state,
    ledgerInstanceId,
    schemaVersion: AZURE_TABLE_LEDGER_SCHEMA_VERSION,
  };
  return {
    accountedDailyCostUsdCents: control.accountedDailyCostUsdCents,
    activeReservations: control.activeReservations,
    document: JSON.stringify(document),
    entityType: "provider-control",
    ledgerInstanceId,
    partitionKey: AZURE_TABLE_LEDGER_PARTITION_KEY,
    provider: control.provider,
    rowKey: controlRowKey(control.provider),
    schemaVersion: AZURE_TABLE_LEDGER_SCHEMA_VERSION,
    utcDay: control.utcDay,
  };
}

function toHistoryEntity(
  history: AllowanceHistoryState,
  ledgerInstanceId: string,
): TableEntity<AllowanceHistoryEntityProperties> {
  const { revision: _revision, ...state } = history;
  const document: AllowanceHistoryDocument = {
    ...state,
    ledgerInstanceId,
    schemaVersion: AZURE_TABLE_LEDGER_SCHEMA_VERSION,
  };
  return {
    accountedDailyCostUsdCents: history.accountedDailyCostUsdCents,
    archivedAt: history.archivedAt,
    document: JSON.stringify(document),
    entityType: "allowance-history",
    ledgerInstanceId,
    partitionKey: AZURE_TABLE_LEDGER_PARTITION_KEY,
    provider: history.provider,
    rowKey: historyRowKey(history.provider, history.utcDay),
    schemaVersion: AZURE_TABLE_LEDGER_SCHEMA_VERSION,
    utcDay: history.utcDay,
  };
}

function toBranchEvidenceEntity(
  evidence: ApprovedBranchEvidence,
  ledgerInstanceId: string,
): TableEntity<BranchEvidenceEntityProperties> {
  const document = {
    ...evidence,
    ledgerInstanceId,
    schemaVersion: AZURE_TABLE_LEDGER_SCHEMA_VERSION,
  };
  return {
    commitSha: evidence.commitSha,
    document: JSON.stringify(document),
    entityType: "approved-branch-evidence",
    ledgerInstanceId,
    partitionKey: AZURE_TABLE_LEDGER_PARTITION_KEY,
    repositoryId: evidence.repositoryId,
    rowKey: branchEvidenceRowKey(evidence.repositoryId, evidence.runId),
    runId: evidence.runId,
    schemaVersion: AZURE_TABLE_LEDGER_SCHEMA_VERSION,
  };
}

function toHeartbeatEntity(
  lastSucceededAt: string,
  ledgerInstanceId: string,
): TableEntity<HeartbeatEntityProperties> {
  return {
    document: JSON.stringify({
      lastSucceededAt,
      ledgerInstanceId,
      schemaVersion: AZURE_TABLE_LEDGER_SCHEMA_VERSION,
    }),
    entityType: "reconciler-heartbeat",
    lastSucceededAt,
    ledgerInstanceId,
    partitionKey: AZURE_TABLE_LEDGER_PARTITION_KEY,
    rowKey: heartbeatRowKey(),
    schemaVersion: AZURE_TABLE_LEDGER_SCHEMA_VERSION,
  };
}

function parseAllocationEntity(
  entity: TableEntity<AllocationEntityProperties>,
  expectedRowKey: string,
  expectedLedgerInstanceId: string,
  expectedSchemaVersion: number,
): AllocationDocument {
  assertEntity(
    entity,
    [
      "allocationId",
      "allocatorCheckRunId",
      "attemptCount",
      "document",
      "entityType",
      "ledgerInstanceId",
      "lifecycleState",
      "repositoryId",
      "runAttempt",
      "runId",
      "schemaVersion",
    ],
    expectedRowKey,
    "allocation",
  );
  if (entity.entityType !== "allocation") {
    throw corrupt("allocation entity type is invalid");
  }
  const document = parseJsonObject(entity.document, "allocation document");
  requireExactObjectKeys(
    document,
    [
      "acceptance",
      "abandonment",
      "allocationId",
      "attemptCount",
      "checkRunCreation",
      "cleanup",
      "createdAt",
      "identity",
      "ledgerInstanceId",
      "lifecycleState",
      "runnerAssignment",
      "schemaVersion",
      "stop",
      "updatedAt",
      "workloadBinding",
    ],
    "allocation document",
  );
  assertEvidence(document, entity, expectedLedgerInstanceId, expectedSchemaVersion, "allocation");
  const attemptCount = requireInteger(document.attemptCount, "attemptCount", 0, 2);
  const identity = requireObject(document.identity, "allocation identity");
  if (
    document.allocationId !== entity.allocationId ||
    document.lifecycleState !== entity.lifecycleState ||
    attemptCount !== entity.attemptCount ||
    identity.repository_id !== entity.repositoryId ||
    identity.run_id !== entity.runId ||
    identity.run_attempt !== entity.runAttempt ||
    identity.allocator_check_run_id !== entity.allocatorCheckRunId
  ) {
    throw corrupt("allocation entity columns disagree with its immutable document");
  }
  return document as unknown as AllocationDocument;
}

function parseAttemptEntity(
  entity: TableEntity<AttemptEntityProperties>,
  expectedRowKey: string,
  expectedLedgerInstanceId: string,
  expectedSchemaVersion: number,
): AttemptDocument {
  assertEntity(
    entity,
    [
      "admission",
      "allocationId",
      "document",
      "entityType",
      "generationCount",
      "ledgerInstanceId",
      "ordinal",
      "outcome",
      "provider",
      "reservationState",
      "reservedCostUsdCents",
      "schemaVersion",
    ],
    expectedRowKey,
    "provider attempt",
  );
  if (entity.entityType !== "provider-attempt") {
    throw corrupt("provider attempt entity type is invalid");
  }
  const document = parseJsonObject(entity.document, "provider attempt document");
  requireExactObjectKeys(
    document,
    [
      "admission",
      "attemptedAt",
      "cleanup",
      "deadlines",
      "fatalAbort",
      "fatalAbortIntent",
      "generationCount",
      "ledgerInstanceId",
      "ordinal",
      "outcome",
      "provider",
      "reservation",
      "schemaVersion",
      "succeededAt",
      "unavailable",
      "updatedAt",
    ],
    "provider attempt document",
  );
  assertEvidence(
    document,
    entity,
    expectedLedgerInstanceId,
    expectedSchemaVersion,
    "provider attempt",
  );
  const reservation = requireObject(document.reservation, "provider attempt reservation");
  if (
    document.admission !== entity.admission ||
    document.ordinal !== entity.ordinal ||
    document.outcome !== entity.outcome ||
    document.provider !== entity.provider ||
    document.generationCount !== entity.generationCount ||
    reservation.state !== entity.reservationState ||
    reservation.reservedCostUsdCents !== entity.reservedCostUsdCents
  ) {
    throw corrupt("provider attempt entity columns disagree with its document");
  }
  requireInteger(document.ordinal, "attempt ordinal", 1, 2);
  requireInteger(document.generationCount, "generationCount", 0, 1);
  return document as unknown as AttemptDocument;
}

function parseGenerationEntity(
  entity: TableEntity<GenerationEntityProperties>,
  expectedRowKey: string,
  expectedLedgerInstanceId: string,
  expectedSchemaVersion: number,
): PhysicalGeneration {
  assertEntity(
    entity,
    [
      "allocationId",
      "attemptOrdinal",
      "document",
      "entityType",
      "generationNumber",
      "ledgerInstanceId",
      "scheduleStatus",
      "schemaVersion",
      "state",
    ],
    expectedRowKey,
    "physical generation",
  );
  if (entity.entityType !== "physical-generation") {
    throw corrupt("physical generation entity type is invalid");
  }
  const document = parseJsonObject(entity.document, "physical generation document");
  requireExactObjectKeys(
    document,
    [
      "basePlan",
      "cleanup",
      "createdAt",
      "generationNumber",
      "jitMintIntent",
      "ledgerInstanceId",
      "launchPrerequisites",
      "location",
      "managedRunCommand",
      "operationLease",
      "providerVmId",
      "readyAt",
      "reservedIncrementalCostUsdCents",
      "resourceGroupId",
      "resourceGroupName",
      "runnerReadiness",
      "runnerRegistrationId",
      "schedule",
      "schemaVersion",
      "state",
      "updatedAt",
      "vmResourceId",
      "vmSize",
      "zoneDeployments",
    ],
    "physical generation document",
  );
  assertEvidence(
    document,
    entity,
    expectedLedgerInstanceId,
    expectedSchemaVersion,
    "physical generation",
  );
  const scheduleStatus =
    document.schedule === null
      ? "not-requested"
      : requireObject(document.schedule, "generation schedule").status;
  if (
    document.generationNumber !== entity.generationNumber ||
    document.state !== entity.state ||
    scheduleStatus !== entity.scheduleStatus
  ) {
    throw corrupt("physical generation entity columns disagree with its document");
  }
  requireInteger(entity.attemptOrdinal, "attemptOrdinal", 1, 1);
  requireInteger(document.generationNumber, "generationNumber", 1, 1);
  const { ledgerInstanceId: _instance, schemaVersion: _schema, ...generation } = document;
  return {
    ...(generation as unknown as Omit<PhysicalGeneration, "revision">),
    revision: requireRevision(entity.etag, "physical generation"),
  };
}

function parseControlEntity(
  entity: TableEntity<ProviderControlEntityProperties>,
  provider: ProviderName,
  expectedLedgerInstanceId: string,
  expectedSchemaVersion: number,
): ControlRead {
  assertEntity(
    entity,
    [
      "accountedDailyCostUsdCents",
      "activeReservations",
      "document",
      "entityType",
      "ledgerInstanceId",
      "provider",
      "schemaVersion",
      "utcDay",
    ],
    controlRowKey(provider),
    `${provider} provider control`,
  );
  if (entity.entityType !== "provider-control" || entity.provider !== provider) {
    throw corrupt(`${provider} provider control identity is invalid`);
  }
  const document = parseJsonObject(entity.document, `${provider} provider control document`);
  requireExactObjectKeys(
    document,
    [
      "accountedDailyCostUsdCents",
      "activeReservations",
      "initialisedAt",
      "ledgerInstanceId",
      "provider",
      "schemaVersion",
      "utcDay",
    ],
    `${provider} provider control document`,
  );
  assertEvidence(
    document,
    entity,
    expectedLedgerInstanceId,
    expectedSchemaVersion,
    `${provider} control`,
  );
  if (
    document.provider !== provider ||
    document.utcDay !== entity.utcDay ||
    document.activeReservations !== entity.activeReservations ||
    document.accountedDailyCostUsdCents !== entity.accountedDailyCostUsdCents
  ) {
    throw corrupt(`${provider} provider control columns disagree with its document`);
  }
  const activeReservations = requireInteger(
    document.activeReservations,
    `${provider} active reservations`,
    0,
    PROVIDER_LIMITS[provider].maximumConcurrentAllocations,
  );
  const accountedDailyCostUsdCents = requireInteger(
    document.accountedDailyCostUsdCents,
    `${provider} daily allowance`,
    0,
    PROVIDER_LIMITS[provider].dailyAllowanceUsdCents,
  );
  return {
    entity,
    state: {
      accountedDailyCostUsdCents,
      activeReservations,
      initialisedAt: requireUtcInstant(document.initialisedAt, "control initialisedAt"),
      provider,
      revision: requireRevision(entity.etag, `${provider} provider control`),
      utcDay: requireUtcDay(document.utcDay, "control utcDay"),
    },
  };
}

function parseBootstrapRegistryEntity(
  entity: TableEntity<BootstrapRegistryEntityProperties>,
  expectedLedgerInstanceId: string,
  expectedSchemaVersion: number,
): BootstrapRegistryRead {
  assertEntity(
    entity,
    ["document", "entityType", "ledgerInstanceId", "schemaVersion"],
    bootstrapRegistryRowKey(),
    "bootstrap registry",
  );
  if (entity.entityType !== "bootstrap-registry") {
    throw corrupt("bootstrap registry entity type is invalid");
  }
  const document = parseJsonObject(entity.document, "bootstrap registry document");
  requireExactObjectKeys(
    document,
    ["initialisedAt", "ledgerInstanceId", "partitionKey", "schemaVersion", "utcDay"],
    "bootstrap registry document",
  );
  assertEvidence(
    document,
    entity,
    expectedLedgerInstanceId,
    expectedSchemaVersion,
    "bootstrap registry",
  );
  if (document.partitionKey !== AZURE_TABLE_LEDGER_PARTITION_KEY) {
    throw corrupt("bootstrap registry names a different control partition");
  }
  const initialisedAt = requireUtcInstant(document.initialisedAt, "registry initialisedAt");
  const utcDay = requireUtcDay(document.utcDay, "registry utcDay");
  if (initialisedAt.slice(0, 10) !== utcDay) {
    throw corrupt("bootstrap registry UTC day disagrees with initialisation time");
  }
  return {
    revision: requireRevision(entity.etag, "bootstrap registry"),
    state: document as unknown as BootstrapRegistryDocument,
  };
}

function parseHistoryEntity(
  entity: TableEntity<AllowanceHistoryEntityProperties>,
  expectedRowKey: string,
  provider: ProviderName,
  expectedLedgerInstanceId: string,
  expectedSchemaVersion: number,
): HistoryRead {
  assertEntity(
    entity,
    [
      "accountedDailyCostUsdCents",
      "archivedAt",
      "document",
      "entityType",
      "ledgerInstanceId",
      "provider",
      "schemaVersion",
      "utcDay",
    ],
    expectedRowKey,
    "allowance history",
  );
  if (entity.entityType !== "allowance-history" || entity.provider !== provider) {
    throw corrupt("allowance history identity is invalid");
  }
  const document = parseJsonObject(entity.document, "allowance history document");
  requireExactObjectKeys(
    document,
    [
      "accountedDailyCostUsdCents",
      "archivedAt",
      "ledgerInstanceId",
      "provider",
      "schemaVersion",
      "utcDay",
    ],
    "allowance history document",
  );
  assertEvidence(
    document,
    entity,
    expectedLedgerInstanceId,
    expectedSchemaVersion,
    "allowance history",
  );
  if (
    document.provider !== provider ||
    document.utcDay !== entity.utcDay ||
    document.archivedAt !== entity.archivedAt ||
    document.accountedDailyCostUsdCents !== entity.accountedDailyCostUsdCents
  ) {
    throw corrupt("allowance history columns disagree with its document");
  }
  return {
    entity,
    state: {
      accountedDailyCostUsdCents: requireInteger(
        document.accountedDailyCostUsdCents,
        "historical allowance",
        0,
        PROVIDER_LIMITS[provider].dailyAllowanceUsdCents,
      ),
      archivedAt: requireUtcInstant(document.archivedAt, "history archivedAt"),
      provider,
      revision: requireRevision(entity.etag, "allowance history"),
      utcDay: requireUtcDay(document.utcDay, "history utcDay"),
    },
  };
}

function parseBranchEvidenceEntity(
  entity: TableEntity<BranchEvidenceEntityProperties>,
  expectedRowKey: string,
  expectedLedgerInstanceId: string,
  expectedSchemaVersion: number,
): ApprovedBranchEvidence {
  assertEntity(
    entity,
    [
      "commitSha",
      "document",
      "entityType",
      "ledgerInstanceId",
      "repositoryId",
      "runId",
      "schemaVersion",
    ],
    expectedRowKey,
    "approved branch evidence",
  );
  if (entity.entityType !== "approved-branch-evidence") {
    throw corrupt("approved branch evidence entity type is invalid");
  }
  const document = parseJsonObject(entity.document, "approved branch evidence document");
  requireExactObjectKeys(
    document,
    [
      "approvedRunAttempt",
      "commitSha",
      "kind",
      "ledgerInstanceId",
      "ref",
      "repositoryId",
      "runId",
      "schemaVersion",
    ],
    "approved branch evidence document",
  );
  assertEvidence(
    document,
    entity,
    expectedLedgerInstanceId,
    expectedSchemaVersion,
    "approved branch evidence",
  );
  if (
    document.commitSha !== entity.commitSha ||
    document.repositoryId !== entity.repositoryId ||
    document.runId !== entity.runId
  ) {
    throw corrupt("approved branch evidence columns disagree with its document");
  }
  try {
    const {
      ledgerInstanceId: _ledgerInstanceId,
      schemaVersion: _schemaVersion,
      ...evidence
    } = document;
    return parseApprovedBranchEvidence(evidence as unknown as ApprovedBranchEvidence);
  } catch (error) {
    throw corrupt("approved branch evidence document is invalid", error);
  }
}

function parseHeartbeatEntity(
  entity: TableEntity<HeartbeatEntityProperties>,
  expectedLedgerInstanceId: string,
  expectedSchemaVersion: number,
): ReconcilerHeartbeatState | null {
  assertEntity(
    entity,
    ["document", "entityType", "lastSucceededAt", "ledgerInstanceId", "schemaVersion"],
    heartbeatRowKey(),
    "reconciler heartbeat",
  );
  if (entity.entityType !== "reconciler-heartbeat") {
    throw corrupt("reconciler heartbeat entity type is invalid");
  }
  const document = parseJsonObject(entity.document, "reconciler heartbeat document");
  requireExactObjectKeys(
    document,
    ["lastSucceededAt", "ledgerInstanceId", "schemaVersion"],
    "reconciler heartbeat document",
  );
  assertEvidence(
    document,
    entity,
    expectedLedgerInstanceId,
    expectedSchemaVersion,
    "reconciler heartbeat",
  );
  if (document.lastSucceededAt === null) {
    if (entity.lastSucceededAt !== "") {
      throw corrupt("empty reconciler heartbeat columns disagree with its document");
    }
    return null;
  }
  const lastSucceededAt = requireUtcInstant(document.lastSucceededAt, "heartbeat lastSucceededAt");
  if (entity.lastSucceededAt !== lastSucceededAt) {
    throw corrupt("reconciler heartbeat columns disagree with its document");
  }
  return {
    lastSucceededAt,
    revision: requireRevision(entity.etag, "reconciler heartbeat"),
  };
}

function validateRuntimeFoundation(
  registry: BootstrapRegistryRead,
  azure: ControlRead,
  blacksmith: ControlRead,
  heartbeat: TableEntity<HeartbeatEntityProperties>,
  expectedLedgerInstanceId: string,
  expectedSchemaVersion: number,
): void {
  parseHeartbeatEntity(heartbeat, expectedLedgerInstanceId, expectedSchemaVersion);
  for (const control of [azure, blacksmith]) {
    if (
      control.state.initialisedAt !== registry.state.initialisedAt ||
      control.state.utcDay < registry.state.utcDay
    ) {
      throw corrupt("provider control disagrees with immutable ledger registry evidence");
    }
  }
}

function assertEntity(
  entity: Record<string, unknown>,
  propertyKeys: readonly string[],
  expectedRowKey: string,
  kind: string,
): void {
  const required = [...SYSTEM_ENTITY_KEYS.filter((key) => key !== "timestamp"), ...propertyKeys];
  const allowed = [...SYSTEM_ENTITY_KEYS, ...propertyKeys];
  const unsupported = Object.keys(entity).find((key) => !allowed.includes(key));
  const missing = required.find((key) => !(key in entity));
  if (unsupported !== undefined || missing !== undefined) {
    throw corrupt(
      `${kind} entity has ${unsupported === undefined ? `missing property ${missing}` : `unsupported property ${unsupported}`}`,
    );
  }
  if (
    entity.partitionKey !== AZURE_TABLE_LEDGER_PARTITION_KEY ||
    entity.rowKey !== expectedRowKey
  ) {
    throw corrupt(`${kind} entity keys do not match the requested row`);
  }
  requireRevision(entity.etag, `${kind} entity`);
  if (
    entity.timestamp !== undefined &&
    (!(entity.timestamp instanceof Date) || Number.isNaN(entity.timestamp.valueOf()))
  ) {
    throw corrupt(`${kind} entity timestamp is invalid`);
  }
}

function assertEvidence(
  document: Record<string, unknown>,
  entity: { readonly ledgerInstanceId: unknown; readonly schemaVersion: unknown },
  expectedLedgerInstanceId: string,
  expectedSchemaVersion: number,
  kind: string,
): void {
  if (
    document.ledgerInstanceId !== expectedLedgerInstanceId ||
    entity.ledgerInstanceId !== expectedLedgerInstanceId ||
    document.schemaVersion !== expectedSchemaVersion ||
    entity.schemaVersion !== expectedSchemaVersion
  ) {
    throw corrupt(`${kind} disagrees with configured ledger instance or schema evidence`);
  }
}

function withoutAllocationStorageFields(
  allocation: AllocationRecord,
): Omit<AllocationRecord, "attempts" | "revision"> {
  const { attempts: _attempts, revision: _revision, ...document } = allocation;
  return document;
}

function withoutAttemptStorageFields(
  attempt: ProviderAttempt,
): Omit<ProviderAttempt, "physicalGenerations" | "revision"> {
  const { physicalGenerations: _generations, revision: _revision, ...document } = attempt;
  return document;
}

function sameAllocationDocument(left: AllocationRecord, right: AllocationRecord): boolean {
  return equal(withoutAllocationStorageFields(left), withoutAllocationStorageFields(right));
}

function sameGenerationDocument(left: PhysicalGeneration, right: PhysicalGeneration): boolean {
  const { revision: _left, ...leftValue } = left;
  const { revision: _right, ...rightValue } = right;
  return equal(leftValue, rightValue);
}

function requiredAttempt(allocation: AllocationRecord, ordinal: number): ProviderAttempt {
  const attempt = allocation.attempts[ordinal - 1];
  if (attempt === undefined || attempt.ordinal !== ordinal) {
    throw new AllocationLedgerError("not-found", "provider attempt was not found");
  }
  return attempt;
}

function validateAllowanceCost(provider: ProviderName, value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > PROVIDER_LIMITS[provider].dailyAllowanceUsdCents
  ) {
    throw corrupt("allowance update would move authoritative state outside its limits");
  }
}

function parseJsonObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "string") {
    throw corrupt(`${path} must be JSON text`);
  }
  try {
    parseStrictJson(value);
    return requireObject(JSON.parse(value) as unknown, path);
  } catch (error) {
    if (error instanceof AllocationLedgerError) {
      throw error;
    }
    throw corrupt(`${path} is not valid object JSON`, error);
  }
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw corrupt(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactObjectKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  path: string,
): void {
  const actual = Object.keys(value);
  const unsupported = actual.find((key) => !expectedKeys.includes(key));
  const missing = expectedKeys.find((key) => !actual.includes(key));
  if (unsupported !== undefined || missing !== undefined) {
    throw corrupt(
      `${path} has ${unsupported === undefined ? `missing field ${missing}` : `unsupported field ${unsupported}`}`,
    );
  }
}

function allocationRowKey(allocationId: string): string {
  return `allocation!${requireNonEmpty(allocationId, "allocationId")}`;
}

function attemptRowKey(allocationId: string, ordinal: number): string {
  return `attempt!${requireNonEmpty(allocationId, "allocationId")}!${String(requireInteger(ordinal, "ordinal", 1, 2)).padStart(2, "0")}`;
}

function generationRowKey(
  allocationId: string,
  attemptOrdinal: number,
  generationNumber: number,
): string {
  return `generation!${requireNonEmpty(allocationId, "allocationId")}!${String(requireInteger(attemptOrdinal, "attemptOrdinal", 1, 1)).padStart(2, "0")}!${String(requireInteger(generationNumber, "generationNumber", 1, 1)).padStart(2, "0")}`;
}

function branchEvidenceRowKey(repositoryId: string, runId: string): string {
  return `branch-evidence!${requirePositiveDecimal(repositoryId, "repositoryId")}!${requirePositiveDecimal(runId, "runId")}`;
}

function controlRowKey(provider: ProviderName): string {
  return `control!${provider}`;
}

function bootstrapRegistryRowKey(): string {
  return "bootstrap!ledger";
}

function heartbeatRowKey(): string {
  return "heartbeat!reconciler";
}

function historyRowKey(provider: ProviderName, utcDay: string): string {
  return `allowance-history!${provider}!${requireUtcDay(utcDay, "history UTC day")}`;
}

function requireStorageAccountName(value: string): string {
  if (!/^[a-z0-9]{3,24}$/.test(value)) {
    throw invalid("accountName must be a 3-24 character lowercase Azure Storage account name");
  }
  return value;
}

function requireTableName(value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9]{2,62}$/.test(value)) {
    throw invalid("tableName must be a valid 3-63 character Azure Table name");
  }
  return value;
}

function requireLedgerInstanceId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 256) {
    throw invalid("ledgerInstanceId must be a non-empty string of at most 256 characters");
  }
  return value;
}

function requireLedgerSchemaVersion(value: unknown): number {
  if (value !== AZURE_TABLE_LEDGER_SCHEMA_VERSION) {
    throw invalid(`schemaVersion must be ${AZURE_TABLE_LEDGER_SCHEMA_VERSION}`);
  }
  return value;
}

function requireNonEmpty(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalid(`${path} must be a non-empty string`);
  }
  return value;
}

function requirePositiveDecimal(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw invalid(`${path} must be a positive decimal string`);
  }
  return value;
}

function requireInteger(value: unknown, path: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw corrupt(`${path} is outside its allowed integer range`);
  }
  return value as number;
}

function requireRevision(value: unknown, kind: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw corrupt(`${kind} revision is missing`);
  }
  return value;
}

function requireUtcInstant(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw invalid(`${path} must be a canonical UTC instant`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw invalid(`${path} must use canonical ISO 8601 UTC form`);
  }
  return value;
}

function requireUtcDay(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw corrupt(`${path} must use YYYY-MM-DD UTC form`);
  }
  const instant = `${value}T00:00:00.000Z`;
  if (new Date(instant).toISOString() !== instant) {
    throw corrupt(`${path} must be a real UTC calendar day`);
  }
  return value;
}

function requireOpenPageSize(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 100) {
    throw invalid("open-allocation pageSize must be an integer from 1 to 100");
  }
  return value as number;
}

function optionalContinuationToken(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length < 1 || value.length > 4096) {
    throw invalid("open-allocation continuation token is invalid");
  }
  return value;
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isNotFound(error: unknown): boolean {
  return error instanceof RestError ? error.statusCode === 404 : statusCode(error) === 404;
}

function isConcurrencyRace(error: unknown): boolean {
  const status = error instanceof RestError ? error.statusCode : statusCode(error);
  return status === 409 || status === 412;
}

function statusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) {
    return undefined;
  }
  return typeof error.statusCode === "number" ? error.statusCode : undefined;
}

function invalid(message: string): AllocationLedgerError {
  return new AllocationLedgerError("invalid-ledger-request", message);
}

function conflict(message: string): AllocationLedgerError {
  return new AllocationLedgerError("allocation-conflict", message);
}

function optimisticConflict(): AllocationLedgerError {
  return new AllocationLedgerError(
    "optimistic-concurrency-conflict",
    "the ledger record changed after it was read",
  );
}

function corrupt(message: string, cause?: unknown): AllocationLedgerError {
  return new AllocationLedgerError("authoritative-state-corrupt", message, { cause });
}

function unavailable(message: string, cause?: unknown): AllocationLedgerError {
  return new AllocationLedgerError("ledger-unavailable", message, { cause });
}
