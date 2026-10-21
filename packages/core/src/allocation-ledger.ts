import type { AllocationIdentity } from "./allocation-identity.js";
import { allocationIdempotencyKey, parseAllocationIdentity } from "./allocation-identity.js";
import type { BackupChoice } from "./backup-choice.js";
import { parseBackupChoice } from "./backup-choice.js";
import type { CapabilityProfile } from "./capabilities.js";
import { parseCapabilityProfile } from "./capabilities.js";
import {
  applyCheckRunDeliverySuccess,
  type CheckRunDeliveryRecord,
  initialiseCheckRunDelivery,
  MAX_CHECK_RUN_DELIVERY_ATTEMPTS,
  parseCheckRunDeliveryRecord,
  type RedactedCheckRunDeliveryFailure,
  type SwitchyardCheckRunSnapshot,
  scheduleCheckRunRetry,
  validateCheckRunDeliveryTransition,
} from "./check-run.js";
import type { VerifiedWorkloadTrust } from "./github-trust.js";
import {
  parseVerifiedWorkloadTrust,
  requireFullCommitSha,
  requirePositiveDecimalString,
} from "./github-trust.js";
import type { ProviderName } from "./provider.js";
import { PROVIDER_LIMITS } from "./provider-limits.js";
import { requireExactKeys, requireRecord } from "./validation.js";

export const CONTROL_LEDGER_SCHEMA_VERSION = 10;
export const CHECK_RUN_CREATION_LEASE_MAX_SECONDS = 120;
export const UNASSIGNED_ABANDONMENT_MINUTES = 15;
export const AZURE_PROVIDER_STOP_MARGIN_MINUTES = 5;
export const AZURE_ALLOCATION_LIFETIME_MINUTES = 45;
export const AZURE_COMPUTE_LIFETIME_MINUTES = 40;
export const AZURE_PILOT_LOCATION = "uksouth" as const;
export const AZURE_PILOT_ZONES = ["1", "2", "3"] as const;

export type AzurePilotZone = (typeof AZURE_PILOT_ZONES)[number];
export type AzurePilotVmSize = "Standard_D4ds_v6" | "Standard_D8ds_v6";

export const ALLOCATION_LIFECYCLE_STATES = [
  "accepted",
  "provisioning",
  "ready",
  "assigned",
  "cleanup_pending",
  "ended",
] as const;

export type AllocationLifecycleState = (typeof ALLOCATION_LIFECYCLE_STATES)[number];

export const TERMINAL_WORKLOAD_CONCLUSIONS = [
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "never_started",
] as const;

export type TerminalWorkloadConclusion = (typeof TERMINAL_WORKLOAD_CONCLUSIONS)[number];

export const PROVIDER_UNAVAILABLE_CLASSIFICATIONS = [
  "concurrency-limit",
  "daily-allowance",
  "zones-exhausted",
  "management-plane-provisioning",
  "readiness-timeout",
] as const;

export type ProviderUnavailableClassification =
  (typeof PROVIDER_UNAVAILABLE_CLASSIFICATIONS)[number];

export const FATAL_AZURE_ABORT_CLASSIFICATIONS = [
  "allocation-expired-before-assignment",
  "ambiguous-runner",
  "deadline-missed-after-success",
  "github-jit-failed",
  "jit-launch-failed",
  "lost-runner-before-assignment",
  "malformed-provider-output",
  "schedule-executed-before-assignment",
  "schedule-submission-unconfirmed",
  "schedule-failed",
  "schedule-rejected",
  "workload-terminal-before-assignment",
  "workload-start-unverified-at-cutoff",
] as const;

export type FatalAzureAbortClassification = (typeof FATAL_AZURE_ABORT_CLASSIFICATIONS)[number];

export interface VerifiedAllocationRequestEvidence {
  readonly backupChoice: BackupChoice;
  readonly profile: CapabilityProfile;
}

export interface AllocationAcceptanceEvidence {
  readonly request: VerifiedAllocationRequestEvidence;
  readonly trust: VerifiedWorkloadTrust;
}

export interface AzureAttemptDeadlines {
  readonly absoluteExpiry: string;
  readonly computeDeadline: string;
  readonly latestSafeStart: string;
}

export type TerminalEvidence =
  | {
      readonly concludedAt: string;
      readonly conclusion: Exclude<TerminalWorkloadConclusion, "never_started">;
      readonly githubJobId: string;
      readonly source: "github-job";
    }
  | {
      readonly concludedAt: string;
      readonly conclusion: Exclude<TerminalWorkloadConclusion, "never_started">;
      readonly repositoryId: string;
      readonly runAttempt: number;
      readonly runId: string;
      readonly source: "github-workflow-run";
    }
  | {
      readonly concludedAt: string;
      readonly conclusion: "never_started";
      readonly source: "allocation-never-returned";
    };

export interface AllocationCleanupState {
  readonly phase: "not-started" | "pending" | "settled";
  readonly providerResourcesSettled: boolean;
  readonly runnerRegistrationSettled: boolean;
  readonly settledAt: string | null;
  readonly terminalEvidence: TerminalEvidence | null;
}

export type WorkloadBindingState =
  | { readonly state: "not-assigned" }
  | { readonly state: "authorised" }
  | { readonly state: "awaiting-correlation" }
  | { readonly githubJobId: string; readonly state: "bound" }
  | {
      readonly reason: "expected-job-missing" | "different-job" | "ambiguous-job";
      readonly state: "binding-failed";
    };

export interface LifecycleCheckRunKey {
  readonly allocationId: string;
  readonly appSlug: string;
  readonly headSha: string;
  readonly repository: {
    readonly name: string;
    readonly owner: string;
  };
}

export interface CheckRunCreationState {
  readonly delivery: CheckRunDeliveryRecord;
  readonly key: LifecycleCheckRunKey;
  readonly leaseExpiresAt: string | null;
  readonly leaseOwner: string | null;
  readonly leaseRevision: number;
}

export interface AttemptCleanupState {
  readonly phase: "not-started" | "pending" | "settled";
  readonly providerResourcesSettled: boolean;
  readonly runnerRegistrationSettled: boolean;
  readonly settledAt: string | null;
}

export interface ProviderAttemptReservation {
  readonly concurrencyReleasedAt: string | null;
  readonly finalCostUsdCents: number | null;
  readonly requestedCostUsdCents: number;
  readonly reservedCostUsdCents: number;
  readonly settledAt: string | null;
  readonly settledFromRevision: string | null;
  readonly settlementKind: "aborted" | "terminal" | "unavailable" | null;
  readonly state: "not-held" | "held" | "settled";
  readonly utcDay: string;
}

export type ScheduleOperationStatus = "requested" | "accepted" | "executed" | "rejected" | "failed";

export interface GenerationScheduleOperation {
  readonly acceptedAt: string | null;
  readonly deadlineType: "CompleteBy";
  readonly lastCheckedAt: string;
  /** Azure generates this identifier. It is adopted exactly once after submit. */
  readonly providerOperationId: string | null;
  /** Controller-generated request correlation, persisted before the provider call. */
  readonly requestCorrelationId: string;
  readonly requestedDeadline: string;
  readonly status: ScheduleOperationStatus;
  readonly targetVmResourceId: string;
}

export interface GenerationZoneDeployment {
  readonly availabilityZone: AzurePilotZone;
  readonly childDeploymentId: string;
  readonly completedAt: string | null;
  readonly deploymentId: string;
  readonly deploymentName: string;
  readonly outcome: "management-plane-unavailable" | "pending" | "no-vm-created" | "vm-created";
  readonly requestedAt: string;
  readonly residualResourcesSettledAt: string | null;
  readonly vmAbsenceVerifiedAt: string | null;
  readonly vmResourceId: string | null;
}

export interface GenerationLaunchPrerequisites {
  readonly bootstrapSucceeded: true;
  readonly checkedAt: string;
  readonly dockerHealthy: true;
  readonly localNvmeMounted: true;
}

export interface GenerationManagedRunCommand {
  readonly boundVmResourceId: string;
  readonly deleteCompletedAt: string | null;
  readonly deleteRequestedAt: string | null;
  readonly launchConfirmedAt: string | null;
  readonly managedRunCommandId: string;
  readonly requestedAt: string;
}

export interface GenerationJitMintIntent {
  readonly jitDeploymentId: string;
  readonly intentId: string;
  readonly requestedAt: string;
}

export type GenerationOperationKind =
  | "base-deployment"
  | "jit-mint-launch"
  | "run-command-delete"
  | "schedule-submit";

export interface GenerationOperationLease {
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly kind: GenerationOperationKind;
  readonly leaseId: string;
}

export interface GenerationBasePlanEvidence {
  /** Non-secret per-allocation public key. The private key is never persisted. */
  readonly adminSshPublicKey: string;
  readonly adminSshPublicKeySha256: string;
  readonly baseTemplateSha256: string;
  readonly imageVersion: string;
  readonly nonSecretBootstrapSha256: string;
  readonly sharedRunnerSubnetId: string;
  readonly subscriptionId: string;
}

export interface GenerationRunnerReadiness {
  readonly checkedAt: string;
  readonly idle: true;
  readonly online: true;
}

export interface GenerationCleanupState {
  readonly phase: "not-started" | "pending" | "settled";
  readonly providerResourcesSettled: boolean;
  readonly runnerRegistrationSettled: boolean;
  readonly settledAt: string | null;
  readonly startedAt: string | null;
}

export interface PhysicalGeneration {
  readonly basePlan: GenerationBasePlanEvidence;
  readonly cleanup: GenerationCleanupState;
  readonly createdAt: string;
  readonly generationNumber: number;
  readonly jitMintIntent: GenerationJitMintIntent | null;
  readonly launchPrerequisites: GenerationLaunchPrerequisites | null;
  readonly location: typeof AZURE_PILOT_LOCATION;
  readonly managedRunCommand: GenerationManagedRunCommand | null;
  readonly operationLease: GenerationOperationLease | null;
  readonly providerVmId: string | null;
  readonly readyAt: string | null;
  readonly reservedIncrementalCostUsdCents: number;
  readonly resourceGroupId: string;
  readonly resourceGroupName: string;
  readonly revision: string;
  readonly runnerReadiness: GenerationRunnerReadiness | null;
  readonly runnerRegistrationId: string | null;
  readonly schedule: GenerationScheduleOperation | null;
  readonly state: "planned" | "provisioning" | "ready" | "fenced" | "cleanup_pending" | "settled";
  readonly updatedAt: string;
  readonly vmResourceId: string | null;
  readonly vmSize: AzurePilotVmSize;
  readonly zoneDeployments: readonly GenerationZoneDeployment[];
}

export interface ProviderUnavailableEvidence {
  readonly classification: ProviderUnavailableClassification;
  readonly recordedAt: string;
}

export interface FatalAzureAbortEvidence {
  readonly classification: FatalAzureAbortClassification;
  readonly recordedAt: string;
}

export interface ProviderAttempt {
  readonly admission: "reserved" | "capacity-unavailable";
  readonly attemptedAt: string;
  readonly cleanup: AttemptCleanupState;
  readonly deadlines: AzureAttemptDeadlines | null;
  readonly fatalAbort: FatalAzureAbortEvidence | null;
  readonly fatalAbortIntent: FatalAzureAbortEvidence | null;
  readonly ordinal: number;
  readonly outcome: "aborted" | "pending" | "succeeded" | "unavailable";
  readonly physicalGenerations: readonly PhysicalGeneration[];
  readonly provider: ProviderName;
  readonly reservation: ProviderAttemptReservation;
  readonly revision: string;
  readonly succeededAt: string | null;
  readonly unavailable: ProviderUnavailableEvidence | null;
  readonly updatedAt: string;
}

export type RunnerAssignment =
  | {
      readonly assignedAt: string;
      readonly attemptOrdinal: 1;
      readonly generationNumber: 1;
      readonly provider: "azure";
      readonly readinessCheckedAt: string;
      readonly runnerIdle: true;
      readonly runnerRegistrationId: string;
      readonly runnerOnline: true;
      readonly runnerLabel: string;
    }
  | {
      readonly assignedAt: string;
      readonly attemptOrdinal: 2;
      readonly provider: "blacksmith";
      readonly runnerLabel: string;
    };

export interface AllocationStop {
  readonly reason: "save-money" | "all-providers-unavailable";
  readonly stoppedAt: string;
  readonly stoppedFromRevision: string;
}

export interface AllocationAbandonment {
  readonly abandonedAt: string;
  readonly abandonedFromRevision: string;
  readonly reason: "controller-progress-timeout";
}

export interface AllocationRecord {
  readonly acceptance: AllocationAcceptanceEvidence;
  readonly abandonment: AllocationAbandonment | null;
  readonly allocationId: string;
  readonly attempts: readonly ProviderAttempt[];
  readonly checkRunCreation: CheckRunCreationState;
  readonly cleanup: AllocationCleanupState;
  readonly createdAt: string;
  readonly identity: AllocationIdentity;
  readonly lifecycleState: AllocationLifecycleState;
  readonly revision: string;
  readonly runnerAssignment: RunnerAssignment | null;
  readonly stop: AllocationStop | null;
  readonly updatedAt: string;
  readonly workloadBinding: WorkloadBindingState;
}

export interface AcceptAllocationRequest {
  readonly acceptedAt: string;
  readonly checkRunAppSlug: string;
  readonly evidence: AllocationAcceptanceEvidence;
}

export interface AcceptAllocationResult {
  readonly allocation: AllocationRecord;
  readonly acceptance: "created" | "exact-retry";
}

export interface ReserveProviderAttemptRequest {
  readonly allocationId: string;
  readonly attemptedAt: string;
  readonly deadlines: AzureAttemptDeadlines | null;
  readonly expectedAllocationRevision: string;
  readonly ordinal: number;
  readonly provider: ProviderName;
  readonly worstCaseCostUsdCents: number;
}

export type ReserveProviderAttemptResult =
  | {
      readonly allocation: AllocationRecord;
      readonly attempt: ProviderAttempt;
      readonly outcome: "reserved";
      readonly reservation: "created" | "exact-retry";
    }
  | {
      readonly allocation: AllocationRecord;
      readonly attempt: ProviderAttempt;
      readonly constraint: "concurrency-limit" | "daily-allowance";
      readonly outcome: "capacity-unavailable";
      readonly provider: ProviderName;
      readonly reservation: "created" | "exact-retry";
    };

export interface SettleUnavailableProviderAttemptRequest {
  readonly allocationId: string;
  readonly classification: Exclude<
    ProviderUnavailableClassification,
    "concurrency-limit" | "daily-allowance"
  >;
  readonly cleanup: AttemptCleanupState;
  readonly expectedAllocationRevision: string;
  readonly expectedAttemptRevision: string;
  readonly finalCostUsdCents: number;
  readonly ordinal: 1;
  readonly settledAt: string;
}

export interface MarkProviderAttemptSucceededRequest {
  readonly allocationId: string;
  readonly expectedAllocationRevision: string;
  readonly expectedAttemptRevision: string;
  readonly ordinal: number;
  readonly succeededAt: string;
}

export interface AssignRunnerRequest {
  readonly allocationId: string;
  readonly assignment: RunnerAssignment;
  readonly expectedAllocationRevision: string;
}

export interface AllocationStatePatch {
  readonly checkRunDelivery?: CheckRunDeliveryRecord;
  readonly cleanup?: AllocationCleanupState;
  readonly lifecycleState?: "assigned" | "cleanup_pending";
  readonly workloadBinding?: WorkloadBindingState;
}

export interface UpdateAllocationStateRequest {
  readonly allocationId: string;
  readonly expectedRevision: string;
  readonly patch: AllocationStatePatch;
  readonly updatedAt: string;
}

export interface StopAllocationRequest {
  readonly allocationId: string;
  readonly expectedRevision: string;
  readonly reason: AllocationStop["reason"];
  readonly stoppedAt: string;
}

export interface AbandonUnassignedAllocationRequest {
  readonly abandonedAt: string;
  readonly allocationId: string;
  readonly expectedRevision: string;
  readonly reason: AllocationAbandonment["reason"];
}

export interface ListOpenAllocationsRequest {
  readonly continuationToken?: string;
  readonly pageSize: number;
}

export interface OpenAllocationsPage {
  readonly allocations: readonly AllocationRecord[];
  readonly continuationToken: string | null;
}

export function allocationNeedsReconciliation(allocation: AllocationRecord): boolean {
  const delivery = allocation.checkRunCreation.delivery;
  return (
    allocation.lifecycleState !== "ended" ||
    delivery.lifecycle.phase !== "concluded" ||
    delivery.retry !== null
  );
}

export interface AddPhysicalGenerationRequest {
  readonly allocationId: string;
  readonly attemptOrdinal: 1;
  readonly availabilityZone: AzurePilotZone;
  readonly baseDeploymentName: string;
  readonly baseDeploymentId: string;
  readonly basePlan: GenerationBasePlanEvidence;
  readonly childDeploymentId: string;
  readonly createdAt: string;
  readonly expectedAttemptRevision: string;
  readonly generationNumber: 1;
  readonly location: typeof AZURE_PILOT_LOCATION;
  readonly reservedIncrementalCostUsdCents: number;
  readonly resourceGroupId: string;
  readonly resourceGroupName: string;
  readonly vmSize: AzurePilotVmSize;
}

export type AddPhysicalGenerationResult =
  | {
      readonly allocation: AllocationRecord;
      readonly attempt: ProviderAttempt;
      readonly generation: PhysicalGeneration;
      readonly outcome: "added";
      readonly reservation: "created" | "exact-retry";
    }
  | {
      readonly constraint: "daily-allowance";
      readonly outcome: "capacity-unavailable";
      readonly provider: "azure";
    };

export interface PhysicalGenerationState {
  readonly cleanup: GenerationCleanupState;
  readonly jitMintIntent: GenerationJitMintIntent | null;
  readonly launchPrerequisites: GenerationLaunchPrerequisites | null;
  readonly managedRunCommand: GenerationManagedRunCommand | null;
  readonly operationLease: GenerationOperationLease | null;
  readonly providerVmId: string | null;
  readonly readyAt: string | null;
  readonly runnerReadiness: GenerationRunnerReadiness | null;
  readonly runnerRegistrationId: string | null;
  readonly schedule: GenerationScheduleOperation | null;
  readonly state: PhysicalGeneration["state"];
  readonly vmResourceId: string | null;
  readonly zoneDeployments: readonly GenerationZoneDeployment[];
}

export interface UpdatePhysicalGenerationRequest {
  readonly allocationId: string;
  readonly attemptOrdinal: 1;
  readonly expectedRevision: string;
  readonly generationNumber: number;
  readonly state: PhysicalGenerationState;
  readonly updatedAt: string;
}

export interface FencedPhysicalGenerationUpdateRequest extends UpdatePhysicalGenerationRequest {
  readonly expectedAllocationRevision: string;
  readonly expectedAttemptRevision: string;
}

export interface SettleFinalProviderAttemptRequest {
  readonly allocationId: string;
  readonly cleanup: AttemptCleanupState;
  readonly expectedAllocationRevision: string;
  readonly expectedAttemptRevision: string;
  readonly finalCostUsdCents: number;
  readonly ordinal: number;
  readonly settledAt: string;
}

export interface BeginFatalAzureAbortRequest {
  readonly allocationId: string;
  readonly classification: FatalAzureAbortClassification;
  readonly expectedAllocationRevision: string;
  readonly expectedAttemptRevision: string;
  readonly ordinal: 1;
  readonly recordedAt: string;
}

export interface SettleFatalAzureAbortRequest {
  readonly allocationId: string;
  readonly classification: FatalAzureAbortClassification;
  readonly cleanup: AttemptCleanupState;
  readonly expectedAllocationRevision: string;
  readonly expectedAttemptRevision: string;
  readonly finalCostUsdCents: number;
  readonly ordinal: 1;
  readonly settledAt: string;
}

export interface ProviderCounterSnapshot {
  readonly accountedDailyCostUsdCents: number;
  readonly activeReservations: number;
}

export interface ProviderControlState extends ProviderCounterSnapshot {
  readonly initialisedAt: string;
  readonly provider: ProviderName;
  readonly revision: string;
  readonly utcDay: string;
}

export interface AcquireCheckRunCreationLeaseRequest extends LifecycleCheckRunKey {
  readonly acquiredAt: string;
  readonly leaseExpiresAt: string;
  readonly leaseOwner: string;
}

export type AcquireCheckRunCreationLeaseResult =
  | { readonly checkRunId: string; readonly outcome: "completed" }
  | {
      readonly leaseExpiresAt: string;
      readonly leaseOwner: string;
      readonly leaseRevision: number;
      readonly outcome: "acquired";
    }
  | { readonly leaseExpiresAt: string; readonly outcome: "busy" }
  | { readonly notBefore: string; readonly outcome: "deferred" }
  | { readonly outcome: "exhausted" };

export interface CompleteCheckRunCreationRequest {
  readonly allocationId: string;
  readonly checkRunId: string;
  readonly completedAt: string;
  readonly leaseOwner: string;
  readonly leaseRevision: number;
}

export interface RenewCheckRunCreationLeaseRequest {
  readonly allocationId: string;
  readonly leaseExpiresAt: string;
  readonly leaseOwner: string;
  readonly leaseRevision: number;
  readonly renewedAt: string;
}

export interface RenewCheckRunCreationLeaseResult {
  readonly leaseExpiresAt: string;
  readonly leaseOwner: string;
  readonly leaseRevision: number;
}

export interface FailCheckRunCreationRequest {
  readonly allocationId: string;
  readonly failedAt: string;
  readonly failure: RedactedCheckRunDeliveryFailure;
  readonly leaseOwner: string;
  readonly leaseRevision: number;
}

export interface CheckRunCreationStore {
  acquireCheckRunCreationLease(
    request: AcquireCheckRunCreationLeaseRequest,
  ): Promise<AcquireCheckRunCreationLeaseResult>;
  completeCheckRunCreation(request: CompleteCheckRunCreationRequest): Promise<AllocationRecord>;
  failCheckRunCreation(request: FailCheckRunCreationRequest): Promise<AllocationRecord>;
  renewCheckRunCreationLease(
    request: RenewCheckRunCreationLeaseRequest,
  ): Promise<RenewCheckRunCreationLeaseResult>;
}

/**
 * The post-trust capability for authoritative allocation and counter state.
 * Approved branch evidence and reconciler heartbeat storage are deliberately
 * separate application ports, even when one storage adapter implements all of
 * them.
 */
export interface AllocationControlLedger extends CheckRunCreationStore {
  abandonUnassignedAllocation(
    request: AbandonUnassignedAllocationRequest,
  ): Promise<AllocationRecord>;
  acceptAllocation(request: AcceptAllocationRequest): Promise<AcceptAllocationResult>;
  addPhysicalGeneration(
    request: AddPhysicalGenerationRequest,
  ): Promise<AddPhysicalGenerationResult>;
  assignRunner(request: AssignRunnerRequest): Promise<AllocationRecord>;
  beginFatalAzureAbort(request: BeginFatalAzureAbortRequest): Promise<AllocationRecord>;
  getAllocation(allocationId: string): Promise<AllocationRecord | undefined>;
  getAllocationByIdentity(identity: AllocationIdentity): Promise<AllocationRecord | undefined>;
  listOpenAllocations(request: ListOpenAllocationsRequest): Promise<OpenAllocationsPage>;
  markProviderAttemptSucceeded(
    request: MarkProviderAttemptSucceededRequest,
  ): Promise<AllocationRecord>;
  reserveProviderAttempt(
    request: ReserveProviderAttemptRequest,
  ): Promise<ReserveProviderAttemptResult>;
  settleFinalProviderAttempt(request: SettleFinalProviderAttemptRequest): Promise<AllocationRecord>;
  settleFatalAzureAbort(request: SettleFatalAzureAbortRequest): Promise<AllocationRecord>;
  settleUnavailableProviderAttempt(
    request: SettleUnavailableProviderAttemptRequest,
  ): Promise<AllocationRecord>;
  stopAllocation(request: StopAllocationRequest): Promise<AllocationRecord>;
  updateAllocationState(request: UpdateAllocationStateRequest): Promise<AllocationRecord>;
  updatePhysicalGeneration(request: UpdatePhysicalGenerationRequest): Promise<AllocationRecord>;
  updatePhysicalGenerationFenced(
    request: FencedPhysicalGenerationUpdateRequest,
  ): Promise<AllocationRecord>;
}

export type AllocationLedgerErrorCode =
  | "allocation-conflict"
  | "authoritative-state-corrupt"
  | "invalid-ledger-request"
  | "ledger-unavailable"
  | "not-found"
  | "optimistic-concurrency-conflict"
  | "precondition-failed";

export class AllocationLedgerError extends Error {
  readonly code: AllocationLedgerErrorCode;

  constructor(code: AllocationLedgerErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AllocationLedgerError";
    this.code = code;
  }
}

export function allocationIdForIdentity(identity: AllocationIdentity): string {
  return `sy1-${stableIdentityHash(allocationIdempotencyKey(parseAllocationIdentity(identity)))}`;
}

export function azureRunnerLabelForAllocation(allocationId: string): string {
  return `switchyard-${requireAllocationId(allocationId)}`;
}

export function utcDayFor(instant: string): string {
  return requireUtcInstant(instant, "instant").slice(0, 10);
}

export function createAcceptedAllocationRecord(
  request: AcceptAllocationRequest,
  revision: string,
): AllocationRecord {
  const acceptedAt = requireUtcInstant(request.acceptedAt, "acceptedAt");
  const acceptance = validateAcceptanceEvidence(request.evidence);
  const identity = acceptance.trust.identity;
  const allocationId = allocationIdForIdentity(identity);
  const appSlug = requireAppSlug(request.checkRunAppSlug);
  const key: LifecycleCheckRunKey = {
    allocationId,
    appSlug,
    headSha: acceptance.trust.workflow.commitSha,
    repository: {
      name: acceptance.trust.repository.name,
      owner: acceptance.trust.repository.owner,
    },
  };
  return {
    acceptance,
    abandonment: null,
    allocationId,
    attempts: [],
    checkRunCreation: {
      delivery: initialiseCheckRunDelivery({
        allocationId,
        headSha: acceptance.trust.workflow.commitSha,
      }),
      key,
      leaseExpiresAt: null,
      leaseOwner: null,
      leaseRevision: 0,
    },
    cleanup: {
      phase: "not-started",
      providerResourcesSettled: false,
      runnerRegistrationSettled: false,
      settledAt: null,
      terminalEvidence: null,
    },
    createdAt: acceptedAt,
    identity,
    lifecycleState: "accepted",
    revision: requireRevision(revision),
    runnerAssignment: null,
    stop: null,
    updatedAt: acceptedAt,
    workloadBinding: { state: "not-assigned" },
  };
}

export function isExactAcceptanceRetry(
  allocation: AllocationRecord,
  request: AcceptAllocationRequest,
): boolean {
  try {
    const expected = createAcceptedAllocationRecord(request, allocation.revision);
    return (
      allocation.allocationId === expected.allocationId &&
      equal(allocation.identity, expected.identity) &&
      equal(allocation.acceptance, expected.acceptance) &&
      equal(allocation.checkRunCreation.key, expected.checkRunCreation.key)
    );
  } catch {
    return false;
  }
}

export function evaluateProviderAttemptReservation(
  provider: ProviderName,
  activeReservations: number,
  accountedDailyCostUsdCents: number,
  requestedCostUsdCents: number,
): "concurrency-limit" | "daily-allowance" | undefined {
  const limits = PROVIDER_LIMITS[provider];
  requireAuthoritativeCounter(
    activeReservations,
    limits.maximumConcurrentAllocations,
    "active reservations",
  );
  requireAuthoritativeCounter(
    accountedDailyCostUsdCents,
    limits.dailyAllowanceUsdCents,
    "allowance",
  );
  requirePositiveSafeInteger(requestedCostUsdCents, "worstCaseCostUsdCents");
  if (activeReservations === limits.maximumConcurrentAllocations) {
    return "concurrency-limit";
  }
  if (requestedCostUsdCents > limits.dailyAllowanceUsdCents - accountedDailyCostUsdCents) {
    return "daily-allowance";
  }
  return undefined;
}

export function createProviderAttempt(
  allocation: AllocationRecord,
  request: ReserveProviderAttemptRequest,
  revision: string,
  constraint?: "concurrency-limit" | "daily-allowance",
): ProviderAttempt {
  validateNextAttempt(allocation, request);
  const attemptedAt = requireUtcInstant(request.attemptedAt, "attemptedAt");
  if (attemptedAt < allocation.updatedAt) {
    throw precondition("attemptedAt cannot precede the allocation's latest durable state");
  }
  const provider = requireProvider(request.provider);
  const deadlines = validateAttemptDeadlines(
    request.deadlines,
    provider,
    allocation.createdAt,
    attemptedAt,
    allocation.acceptance.request.profile,
    allocation.acceptance.trust.workload.timeoutMinutes,
  );
  const requestedCost = requirePositiveSafeInteger(
    request.worstCaseCostUsdCents,
    "worstCaseCostUsdCents",
  );
  if (requestedCost > PROVIDER_LIMITS[provider].dailyAllowanceUsdCents) {
    throw invalid("worstCaseCostUsdCents exceeds the provider's complete daily allowance");
  }
  const unavailable =
    constraint === undefined
      ? null
      : ({
          classification: constraint,
          recordedAt: attemptedAt,
        } satisfies ProviderUnavailableEvidence);
  const capacityUnavailable = unavailable !== null;
  return {
    admission: capacityUnavailable ? "capacity-unavailable" : "reserved",
    attemptedAt,
    cleanup: capacityUnavailable
      ? {
          phase: "settled",
          providerResourcesSettled: true,
          runnerRegistrationSettled: true,
          settledAt: attemptedAt,
        }
      : provider === "azure"
        ? {
            phase: "not-started",
            providerResourcesSettled: false,
            runnerRegistrationSettled: false,
            settledAt: null,
          }
        : {
            phase: "settled",
            providerResourcesSettled: true,
            runnerRegistrationSettled: true,
            settledAt: attemptedAt,
          },
    deadlines,
    fatalAbort: null,
    fatalAbortIntent: null,
    ordinal: request.ordinal,
    outcome: capacityUnavailable ? "unavailable" : "pending",
    physicalGenerations: [],
    provider,
    reservation: {
      concurrencyReleasedAt: null,
      finalCostUsdCents: capacityUnavailable ? 0 : null,
      requestedCostUsdCents: requestedCost,
      reservedCostUsdCents: capacityUnavailable ? 0 : requestedCost,
      settledAt: null,
      settledFromRevision: null,
      settlementKind: null,
      state: capacityUnavailable ? "not-held" : "held",
      utcDay: attemptedAt.slice(0, 10),
    },
    revision: requireRevision(revision),
    succeededAt: null,
    unavailable,
    updatedAt: attemptedAt,
  };
}

export function appendProviderAttempt(
  allocation: AllocationRecord,
  attempt: ProviderAttempt,
  revision: string,
): AllocationRecord {
  if (attempt.ordinal !== allocation.attempts.length + 1) {
    throw precondition("provider attempt ordinal is not the next stable ordinal");
  }
  return {
    ...allocation,
    attempts: [...allocation.attempts, attempt],
    lifecycleState: attempt.admission === "capacity-unavailable" ? "accepted" : "provisioning",
    revision: requireRevision(revision),
    updatedAt: attempt.attemptedAt,
  };
}

export function exactProviderAttemptRetry(
  allocation: AllocationRecord,
  request: ReserveProviderAttemptRequest,
): ReserveProviderAttemptResult | undefined {
  const attempt = allocation.attempts.find((entry) => entry.ordinal === request.ordinal);
  if (attempt === undefined) {
    return undefined;
  }
  let attemptedAt: string;
  let deadlines: AzureAttemptDeadlines | null;
  let provider: ProviderName;
  let requestedCostUsdCents: number;
  try {
    if (requireAllocationId(request.allocationId) !== allocation.allocationId) {
      throw invalid("allocationId does not match the loaded allocation");
    }
    requireRevision(request.expectedAllocationRevision);
    requirePositiveSafeInteger(request.ordinal, "ordinal");
    attemptedAt = requireUtcInstant(request.attemptedAt, "attemptedAt");
    provider = requireProvider(request.provider);
    deadlines = validateAttemptDeadlines(
      request.deadlines,
      provider,
      allocation.createdAt,
      attemptedAt,
      allocation.acceptance.request.profile,
      allocation.acceptance.trust.workload.timeoutMinutes,
    );
    requestedCostUsdCents = requirePositiveSafeInteger(
      request.worstCaseCostUsdCents,
      "worstCaseCostUsdCents",
    );
    if (requestedCostUsdCents > PROVIDER_LIMITS[provider].dailyAllowanceUsdCents) {
      throw invalid("worstCaseCostUsdCents exceeds the provider's complete daily allowance");
    }
  } catch {
    throw conflict("provider attempt ordinal was reused with different immutable request data");
  }
  if (
    provider !== attempt.provider ||
    attemptedAt !== attempt.attemptedAt ||
    !equal(deadlines, attempt.deadlines) ||
    requestedCostUsdCents !== attempt.reservation.requestedCostUsdCents
  ) {
    throw conflict("provider attempt ordinal was reused with different immutable request data");
  }
  if (attempt.admission === "capacity-unavailable") {
    const classification = attempt.unavailable?.classification;
    if (classification !== "concurrency-limit" && classification !== "daily-allowance") {
      throw corrupt("capacity-unavailable attempt lacks its capacity classification");
    }
    return {
      allocation,
      attempt,
      constraint: classification,
      outcome: "capacity-unavailable",
      provider: attempt.provider,
      reservation: "exact-retry",
    };
  }
  return { allocation, attempt, outcome: "reserved", reservation: "exact-retry" };
}

export function settleUnavailableAttemptRecords(
  allocation: AllocationRecord,
  attempt: ProviderAttempt,
  request: SettleUnavailableProviderAttemptRequest,
  allocationRevision: string,
  attemptRevision: string,
): { readonly allocation: AllocationRecord; readonly attempt: ProviderAttempt } {
  validateSettleUnavailableRequest(request);
  if (attempt.ordinal !== 1 || attempt.provider !== "azure") {
    throw precondition("only Azure attempt 1 may be settled as fallback-eligible unavailable");
  }
  if (attempt.admission !== "reserved" || attempt.reservation.state !== "held") {
    throw precondition("only a held Azure reservation can use unavailable settlement");
  }
  if (attempt.outcome !== "pending" || allocation.runnerAssignment !== null) {
    throw precondition("an assigned or final provider attempt cannot become unavailable");
  }
  if (
    request.expectedAllocationRevision !== allocation.revision ||
    request.expectedAttemptRevision !== attempt.revision
  ) {
    throw optimisticConflict();
  }
  const settledAt = requireUtcInstant(request.settledAt, "settledAt");
  if (settledAt < attempt.updatedAt || settledAt < allocation.updatedAt) {
    throw precondition("unavailable settlement cannot move time backwards");
  }
  const cleanup = validateAttemptCleanup(request.cleanup, attempt.cleanup);
  if (
    cleanup.phase !== "settled" ||
    !cleanup.providerResourcesSettled ||
    !cleanup.runnerRegistrationSettled ||
    cleanup.settledAt !== settledAt ||
    attempt.physicalGenerations.some((generation) => generation.cleanup.phase !== "settled")
  ) {
    throw precondition("Azure cleanup must be safely settled before fallback releases its hold");
  }
  const finalCost = requireNonNegativeSafeInteger(request.finalCostUsdCents, "finalCostUsdCents");
  if (finalCost > attempt.reservation.reservedCostUsdCents) {
    throw precondition("finalCostUsdCents cannot exceed the held conservative reservation");
  }
  const updatedAttempt: ProviderAttempt = {
    ...attempt,
    cleanup,
    outcome: "unavailable",
    reservation: {
      ...attempt.reservation,
      concurrencyReleasedAt: settledAt,
      finalCostUsdCents: finalCost,
      settledAt,
      settledFromRevision: request.expectedAttemptRevision,
      settlementKind: "unavailable",
      state: "settled",
    },
    revision: requireRevision(attemptRevision),
    unavailable: { classification: request.classification, recordedAt: settledAt },
    updatedAt: settledAt,
  };
  const updatedAllocation = replaceAttempt(allocation, updatedAttempt, {
    lifecycleState: "accepted",
    revision: allocationRevision,
    updatedAt: settledAt,
  });
  return { allocation: updatedAllocation, attempt: updatedAttempt };
}

export function settleFatalAzureAbortRecords(
  allocation: AllocationRecord,
  attempt: ProviderAttempt,
  request: SettleFatalAzureAbortRequest,
  allocationRevision: string,
  attemptRevision: string,
): { readonly allocation: AllocationRecord; readonly attempt: ProviderAttempt } {
  requireAllocationId(request.allocationId);
  const classification = requireFatalAzureAbortClassification(request.classification);
  const settledAt = requireUtcInstant(request.settledAt, "settledAt");
  if (attempt.ordinal !== 1 || attempt.provider !== "azure") {
    throw precondition("only Azure attempt 1 may use fatal abort settlement");
  }
  if (attempt.admission !== "reserved" || attempt.reservation.state !== "held") {
    throw precondition("fatal abort requires a held Azure reservation");
  }
  if (
    (attempt.outcome !== "pending" && attempt.outcome !== "succeeded") ||
    allocation.runnerAssignment !== null ||
    allocation.stop !== null
  ) {
    throw precondition("fatal abort is only valid before an immutable runner assignment");
  }
  if (
    attempt.fatalAbortIntent?.classification !== classification ||
    attempt.fatalAbortIntent.recordedAt > settledAt
  ) {
    throw precondition("fatal abort settlement must match its durable pre-cleanup intent");
  }
  if (
    request.expectedAllocationRevision !== allocation.revision ||
    request.expectedAttemptRevision !== attempt.revision
  ) {
    throw optimisticConflict();
  }
  if (settledAt < allocation.updatedAt || settledAt < attempt.updatedAt) {
    throw precondition("fatal abort settlement cannot move time backwards");
  }
  const cleanup = validateAttemptCleanup(request.cleanup, attempt.cleanup);
  if (
    cleanup.phase !== "settled" ||
    !cleanup.providerResourcesSettled ||
    !cleanup.runnerRegistrationSettled ||
    cleanup.settledAt !== settledAt ||
    attempt.physicalGenerations.some((generation) => generation.cleanup.phase !== "settled")
  ) {
    throw precondition("fatal abort requires complete Azure and runner cleanup");
  }
  const finalCost = requireNonNegativeSafeInteger(request.finalCostUsdCents, "finalCostUsdCents");
  if (finalCost > attempt.reservation.reservedCostUsdCents) {
    throw precondition("finalCostUsdCents cannot exceed the held conservative reservation");
  }
  const fatalAbort = attempt.fatalAbortIntent;
  const updatedAttempt: ProviderAttempt = {
    ...attempt,
    cleanup,
    fatalAbort,
    outcome: "aborted",
    reservation: {
      ...attempt.reservation,
      concurrencyReleasedAt: settledAt,
      finalCostUsdCents: finalCost,
      settledAt,
      settledFromRevision: request.expectedAttemptRevision,
      settlementKind: "aborted",
      state: "settled",
    },
    revision: requireRevision(attemptRevision),
    updatedAt: settledAt,
  };
  const terminalEvidence: TerminalEvidence = {
    concludedAt: settledAt,
    conclusion: "never_started",
    source: "allocation-never-returned",
  };
  const replaced = replaceAttempt(allocation, updatedAttempt, {
    lifecycleState: "ended",
    revision: allocationRevision,
    updatedAt: settledAt,
  });
  return {
    allocation: {
      ...replaced,
      cleanup: {
        phase: "settled",
        providerResourcesSettled: true,
        runnerRegistrationSettled: true,
        settledAt,
        terminalEvidence,
      },
    },
    attempt: updatedAttempt,
  };
}

export function beginFatalAzureAbortRecords(
  allocation: AllocationRecord,
  attempt: ProviderAttempt,
  request: BeginFatalAzureAbortRequest,
  allocationRevision: string,
  attemptRevision: string,
): { readonly allocation: AllocationRecord; readonly attempt: ProviderAttempt } {
  requireAllocationId(request.allocationId);
  const classification = requireFatalAzureAbortClassification(request.classification);
  const recordedAt = requireUtcInstant(request.recordedAt, "recordedAt");
  if (
    attempt.provider !== "azure" ||
    attempt.ordinal !== 1 ||
    attempt.admission !== "reserved" ||
    attempt.reservation.state !== "held" ||
    (attempt.outcome !== "pending" && attempt.outcome !== "succeeded") ||
    attempt.fatalAbortIntent !== null ||
    allocation.runnerAssignment !== null ||
    allocation.lifecycleState === "ended"
  ) {
    throw precondition("fatal Azure abort intent is valid only before runner assignment");
  }
  if (
    request.expectedAllocationRevision !== allocation.revision ||
    request.expectedAttemptRevision !== attempt.revision
  ) {
    throw optimisticConflict();
  }
  if (recordedAt < allocation.updatedAt || recordedAt < attempt.updatedAt) {
    throw precondition("fatal abort intent cannot move time backwards");
  }
  if (
    attempt.physicalGenerations.some(
      (generation) =>
        generation.operationLease !== null && generation.operationLease.expiresAt > recordedAt,
    )
  ) {
    throw precondition("fatal Azure abort cannot race an active provider operation lease");
  }
  const fatalAbortIntent: FatalAzureAbortEvidence = { classification, recordedAt };
  const updatedAttempt: ProviderAttempt = {
    ...attempt,
    fatalAbortIntent,
    revision: requireRevision(attemptRevision),
    updatedAt: recordedAt,
  };
  return {
    allocation: replaceAttempt(allocation, updatedAttempt, {
      lifecycleState: allocation.lifecycleState,
      revision: allocationRevision,
      updatedAt: recordedAt,
    }),
    attempt: updatedAttempt,
  };
}

export function isExactFatalAzureAbortIntentRetry(
  allocation: AllocationRecord,
  request: BeginFatalAzureAbortRequest,
): boolean {
  const attempt = allocation.attempts[request.ordinal - 1];
  return (
    attempt?.fatalAbortIntent?.classification === request.classification &&
    attempt.fatalAbortIntent.recordedAt === request.recordedAt
  );
}

export function isExactFatalAzureAbortRetry(
  allocation: AllocationRecord,
  request: SettleFatalAzureAbortRequest,
): boolean {
  const attempt = allocation.attempts[request.ordinal - 1];
  return (
    attempt?.outcome === "aborted" &&
    attempt.fatalAbort?.classification === request.classification &&
    attempt.fatalAbortIntent?.classification === request.classification &&
    equal(attempt.cleanup, request.cleanup) &&
    attempt.reservation.state === "settled" &&
    attempt.reservation.settlementKind === "aborted" &&
    attempt.reservation.finalCostUsdCents === request.finalCostUsdCents &&
    attempt.reservation.settledAt === request.settledAt &&
    attempt.reservation.settledFromRevision === request.expectedAttemptRevision
  );
}

export function isExactUnavailableSettlementRetry(
  allocation: AllocationRecord,
  request: SettleUnavailableProviderAttemptRequest,
): boolean {
  const attempt = allocation.attempts[request.ordinal - 1];
  return (
    attempt !== undefined &&
    attempt.outcome === "unavailable" &&
    attempt.unavailable?.classification === request.classification &&
    attempt.unavailable.recordedAt === request.settledAt &&
    equal(attempt.cleanup, request.cleanup) &&
    attempt.reservation.state === "settled" &&
    attempt.reservation.settlementKind === "unavailable" &&
    attempt.reservation.finalCostUsdCents === request.finalCostUsdCents &&
    attempt.reservation.settledAt === request.settledAt &&
    attempt.reservation.settledFromRevision === request.expectedAttemptRevision
  );
}

export function markProviderAttemptSucceededRecords(
  allocation: AllocationRecord,
  attempt: ProviderAttempt,
  request: MarkProviderAttemptSucceededRequest,
  allocationRevision: string,
  attemptRevision: string,
): { readonly allocation: AllocationRecord; readonly attempt: ProviderAttempt } {
  requireAllocationId(request.allocationId);
  const succeededAt = requireUtcInstant(request.succeededAt, "succeededAt");
  if (
    request.expectedAllocationRevision !== allocation.revision ||
    request.expectedAttemptRevision !== attempt.revision
  ) {
    throw optimisticConflict();
  }
  if (
    request.ordinal !== attempt.ordinal ||
    attempt.admission !== "reserved" ||
    attempt.reservation.state !== "held" ||
    attempt.outcome !== "pending" ||
    attempt.fatalAbortIntent !== null ||
    allocation.runnerAssignment !== null
  ) {
    throw precondition("only the current successful held attempt can become ready");
  }
  if (succeededAt < attempt.updatedAt || succeededAt < allocation.updatedAt) {
    throw precondition("succeededAt cannot move time backwards");
  }
  if (attempt.provider === "azure") {
    const latest = attempt.physicalGenerations.at(-1);
    if (
      latest === undefined ||
      latest.generationNumber !== 1 ||
      latest.state !== "ready" ||
      latest.schedule?.status !== "accepted" ||
      latest.schedule.targetVmResourceId !== latest.vmResourceId ||
      latest.managedRunCommand?.deleteCompletedAt === null ||
      latest.runnerReadiness === null ||
      latest.readyAt === null ||
      attempt.deadlines === null ||
      latest.readyAt > attempt.deadlines.latestSafeStart ||
      succeededAt > attempt.deadlines.latestSafeStart
    ) {
      throw precondition("Azure success requires the latest safely ready physical generation");
    }
    if (attempt.physicalGenerations.length !== 1) {
      throw precondition("the V1 Azure attempt can succeed only with generation one");
    }
  } else if (attempt.physicalGenerations.length !== 0 || attempt.deadlines !== null) {
    throw corrupt("Blacksmith attempt contains Azure physical state");
  }
  const updatedAttempt: ProviderAttempt = {
    ...attempt,
    outcome: "succeeded",
    revision: requireRevision(attemptRevision),
    succeededAt,
    updatedAt: succeededAt,
  };
  return {
    allocation: replaceAttempt(allocation, updatedAttempt, {
      lifecycleState: "ready",
      revision: allocationRevision,
      updatedAt: succeededAt,
    }),
    attempt: updatedAttempt,
  };
}

export function isExactAttemptSuccessRetry(
  allocation: AllocationRecord,
  request: MarkProviderAttemptSucceededRequest,
): boolean {
  const attempt = allocation.attempts[request.ordinal - 1];
  return attempt?.outcome === "succeeded" && attempt.succeededAt === request.succeededAt;
}

export function assignRunnerRecord(
  allocation: AllocationRecord,
  request: AssignRunnerRequest,
  revision: string,
): AllocationRecord {
  requireAllocationId(request.allocationId);
  if (allocation.runnerAssignment !== null) {
    try {
      const retried = validateRunnerAssignment(request.assignment, allocation);
      if (equal(allocation.runnerAssignment, retried)) {
        return allocation;
      }
    } catch {
      // A write-once assignment reports every non-exact replay as a conflict.
    }
    throw conflict("runner assignment is immutable and conflicts with the persisted assignment");
  }
  const assignment = validateRunnerAssignment(request.assignment, allocation);
  if (request.expectedAllocationRevision !== allocation.revision) {
    throw optimisticConflict();
  }
  const attempt = allocation.attempts[assignment.attemptOrdinal - 1];
  if (
    attempt === undefined ||
    attempt.provider !== assignment.provider ||
    attempt.outcome !== "succeeded" ||
    attempt.fatalAbortIntent !== null ||
    attempt.reservation.state !== "held"
  ) {
    throw precondition("runner assignment requires its exact successful held provider attempt");
  }
  if (assignment.assignedAt < allocation.updatedAt || assignment.assignedAt < attempt.updatedAt) {
    throw precondition("assignedAt cannot move time backwards");
  }
  if (assignment.provider === "azure") {
    const generation = attempt.physicalGenerations[0];
    const tenMinuteCutoff = new Date(Date.parse(allocation.createdAt) + 10 * 60_000).toISOString();
    const readinessCutoff =
      attempt.deadlines !== null && attempt.deadlines.latestSafeStart < tenMinuteCutoff
        ? attempt.deadlines.latestSafeStart
        : tenMinuteCutoff;
    if (
      generation?.generationNumber !== 1 ||
      generation.state !== "ready" ||
      generation.runnerReadiness === null ||
      generation.schedule?.status !== "accepted" ||
      generation.runnerRegistrationId !== assignment.runnerRegistrationId ||
      assignment.readinessCheckedAt <= (attempt.succeededAt ?? "") ||
      assignment.readinessCheckedAt <= generation.runnerReadiness.checkedAt ||
      assignment.readinessCheckedAt > assignment.assignedAt ||
      generation.schedule.lastCheckedAt < assignment.readinessCheckedAt ||
      generation.schedule.lastCheckedAt > assignment.assignedAt ||
      attempt.deadlines === null ||
      assignment.assignedAt > readinessCutoff
    ) {
      throw precondition(
        "Azure assignment repair requires fresh exact runner and schedule checks before the readiness cutoff",
      );
    }
  }
  return {
    ...allocation,
    cleanup:
      assignment.provider === "blacksmith"
        ? {
            ...allocation.cleanup,
            providerResourcesSettled: true,
            runnerRegistrationSettled: true,
          }
        : allocation.cleanup,
    lifecycleState: "assigned",
    revision: requireRevision(revision),
    runnerAssignment: assignment,
    updatedAt: assignment.assignedAt,
    workloadBinding:
      assignment.provider === "blacksmith"
        ? { state: "awaiting-correlation" }
        : { state: "authorised" },
  };
}

export function applyAllocationStatePatch(
  current: AllocationRecord,
  request: UpdateAllocationStateRequest,
  revision: string,
): AllocationRecord {
  requireAllocationId(request.allocationId);
  const updatedAt = requireUtcInstant(request.updatedAt, "updatedAt");
  if (updatedAt < current.updatedAt) {
    throw precondition("updatedAt cannot move backwards");
  }
  if (current.lifecycleState === "ended") {
    if (
      request.patch.lifecycleState !== undefined ||
      request.patch.cleanup !== undefined ||
      request.patch.workloadBinding !== undefined
    ) {
      throw precondition("an ended allocation is immutable except for Check Run delivery");
    }
  }
  const lifecycleState = request.patch.lifecycleState ?? current.lifecycleState;
  if (
    request.patch.lifecycleState !== undefined &&
    !(
      current.lifecycleState === "assigned" &&
      (request.patch.lifecycleState === "assigned" ||
        request.patch.lifecycleState === "cleanup_pending")
    )
  ) {
    throw precondition(
      "allocation lifecycle updates may only begin final cleanup after assignment",
    );
  }
  const workloadBinding = request.patch.workloadBinding
    ? validateWorkloadBinding(request.patch.workloadBinding, current.workloadBinding)
    : current.workloadBinding;
  const cleanup = request.patch.cleanup
    ? validateAllocationCleanup(request.patch.cleanup, current.cleanup)
    : current.cleanup;
  validateTerminalEvidenceBinding(
    cleanup.terminalEvidence,
    current.identity,
    workloadBinding,
    current.stop !== null,
  );
  const delivery = request.patch.checkRunDelivery
    ? validateCheckRunDelivery(
        request.patch.checkRunDelivery,
        current.checkRunCreation.delivery,
        current,
      )
    : current.checkRunCreation.delivery;
  if (
    cleanup.phase === "settled" &&
    lifecycleState !== "cleanup_pending" &&
    lifecycleState !== "ended"
  ) {
    throw precondition(
      "settled allocation cleanup requires final cleanup or ended lifecycle state",
    );
  }
  if (
    cleanup.terminalEvidence !== null &&
    (cleanup.terminalEvidence.concludedAt < current.createdAt ||
      cleanup.terminalEvidence.concludedAt > updatedAt)
  ) {
    throw precondition("terminal evidence must fall within allocation timestamps");
  }
  if (
    cleanup.settledAt !== null &&
    (cleanup.settledAt < current.createdAt ||
      cleanup.settledAt > updatedAt ||
      (cleanup.terminalEvidence !== null &&
        cleanup.settledAt < cleanup.terminalEvidence.concludedAt))
  ) {
    throw precondition("cleanup settlement must follow terminal evidence within update time");
  }
  return {
    ...current,
    checkRunCreation: { ...current.checkRunCreation, delivery },
    cleanup,
    lifecycleState,
    revision: requireRevision(revision),
    updatedAt: current.lifecycleState === "ended" ? current.updatedAt : updatedAt,
    workloadBinding,
  };
}

export function sameAllocationState(
  allocation: AllocationRecord,
  request: UpdateAllocationStateRequest,
): boolean {
  try {
    return equal(
      withoutAllocationRevision(
        applyAllocationStatePatch(allocation, request, allocation.revision),
      ),
      withoutAllocationRevision(allocation),
    );
  } catch {
    return false;
  }
}

export function stopAllocationRecord(
  allocation: AllocationRecord,
  request: StopAllocationRequest,
  revision: string,
): AllocationRecord {
  requireAllocationId(request.allocationId);
  const stoppedAt = requireUtcInstant(request.stoppedAt, "stoppedAt");
  if (allocation.stop !== null) {
    if (
      allocation.stop.reason === request.reason &&
      allocation.stop.stoppedAt === stoppedAt &&
      allocation.stop.stoppedFromRevision === request.expectedRevision
    ) {
      return allocation;
    }
    throw conflict("allocation stop retry conflicts with persisted stop evidence");
  }
  if (allocation.abandonment !== null) {
    throw precondition("an abandoned allocation cannot record a provider-policy stop");
  }
  if (request.expectedRevision !== allocation.revision) {
    throw optimisticConflict();
  }
  if (
    allocation.runnerAssignment !== null ||
    allocation.attempts.length === 0 ||
    allocation.attempts.some(
      (attempt) => attempt.outcome !== "unavailable" || attempt.reservation.state === "held",
    )
  ) {
    throw precondition("only fully unavailable, safely released attempts can stop unassigned");
  }
  const backupChoice = allocation.acceptance.request.backupChoice;
  if (
    (request.reason === "save-money" &&
      (backupChoice !== "Save money" || allocation.attempts.length !== 1)) ||
    (request.reason === "all-providers-unavailable" &&
      (backupChoice !== "Keep going" || allocation.attempts.length !== 2))
  ) {
    throw precondition("stop reason does not match backup policy and ordered attempt history");
  }
  if (stoppedAt < allocation.updatedAt) {
    throw precondition("stoppedAt cannot move time backwards");
  }
  const terminalEvidence: TerminalEvidence = {
    concludedAt: stoppedAt,
    conclusion: "never_started",
    source: "allocation-never-returned",
  };
  return {
    ...allocation,
    cleanup: {
      phase: "settled",
      providerResourcesSettled: true,
      runnerRegistrationSettled: true,
      settledAt: stoppedAt,
      terminalEvidence,
    },
    lifecycleState: "ended",
    revision: requireRevision(revision),
    stop: {
      reason: request.reason,
      stoppedAt,
      stoppedFromRevision: request.expectedRevision,
    },
    updatedAt: stoppedAt,
  };
}

export function abandonUnassignedAllocationRecord(
  allocation: AllocationRecord,
  request: AbandonUnassignedAllocationRequest,
  revision: string,
): AllocationRecord {
  requireAllocationId(request.allocationId);
  const abandonedAt = requireUtcInstant(request.abandonedAt, "abandonedAt");
  if (allocation.abandonment !== null) {
    if (
      allocation.abandonment.reason === request.reason &&
      allocation.abandonment.abandonedAt === abandonedAt &&
      allocation.abandonment.abandonedFromRevision === request.expectedRevision
    ) {
      return allocation;
    }
    throw conflict("allocation abandonment retry conflicts with persisted evidence");
  }
  if (request.expectedRevision !== allocation.revision) {
    throw optimisticConflict();
  }
  if (request.reason !== "controller-progress-timeout") {
    throw invalid("allocation abandonment reason is not recognised");
  }
  const earliestAbandonment = new Date(
    Date.parse(allocation.createdAt) + UNASSIGNED_ABANDONMENT_MINUTES * 60_000,
  ).toISOString();
  if (abandonedAt < earliestAbandonment || abandonedAt < allocation.updatedAt) {
    throw precondition("unassigned allocation abandonment is earlier than its safety window");
  }
  if (
    allocation.lifecycleState === "ended" ||
    allocation.runnerAssignment !== null ||
    allocation.stop !== null ||
    allocation.attempts.some(
      (attempt) =>
        attempt.outcome !== "unavailable" ||
        attempt.reservation.state === "held" ||
        attempt.cleanup.phase !== "settled" ||
        !attempt.cleanup.providerResourcesSettled ||
        !attempt.cleanup.runnerRegistrationSettled,
    )
  ) {
    throw precondition(
      "only an unassigned allocation with no held or unsettled provider work can be abandoned",
    );
  }
  return {
    ...allocation,
    abandonment: {
      abandonedAt,
      abandonedFromRevision: request.expectedRevision,
      reason: request.reason,
    },
    cleanup: {
      phase: "settled",
      providerResourcesSettled: true,
      runnerRegistrationSettled: true,
      settledAt: abandonedAt,
      terminalEvidence: {
        concludedAt: abandonedAt,
        conclusion: "never_started",
        source: "allocation-never-returned",
      },
    },
    lifecycleState: "ended",
    revision: requireRevision(revision),
    updatedAt: abandonedAt,
  };
}

export function isExactUnassignedAbandonmentRetry(
  allocation: AllocationRecord,
  request: AbandonUnassignedAllocationRequest,
): boolean {
  return (
    allocation.abandonment?.reason === request.reason &&
    allocation.abandonment.abandonedAt === request.abandonedAt &&
    allocation.abandonment.abandonedFromRevision === request.expectedRevision
  );
}

export function createPhysicalGeneration(
  allocation: AllocationRecord,
  attempt: ProviderAttempt,
  request: AddPhysicalGenerationRequest,
  revision: string,
): PhysicalGeneration {
  if (
    attempt.provider !== "azure" ||
    attempt.ordinal !== 1 ||
    attempt.deadlines === null ||
    attempt.outcome !== "pending" ||
    attempt.reservation.state !== "held" ||
    attempt.fatalAbortIntent !== null ||
    allocation.runnerAssignment !== null
  ) {
    throw precondition("physical generations belong only to the pending held Azure attempt 1");
  }
  if (request.generationNumber !== 1 || attempt.physicalGenerations.length !== 0) {
    throw precondition("the V1 Azure pilot permits exactly physical generation one");
  }
  const incrementalCost = requireNonNegativeSafeInteger(
    request.reservedIncrementalCostUsdCents,
    "reservedIncrementalCostUsdCents",
  );
  if (incrementalCost !== 0) {
    throw precondition("the Azure attempt reservation already covers generation one");
  }
  const createdAt = requireUtcInstant(request.createdAt, "createdAt");
  if (createdAt < attempt.updatedAt || createdAt > attempt.deadlines.latestSafeStart) {
    throw precondition("a physical generation must be reserved no later than latestSafeStart");
  }
  const resourceGroupId = requireAzureResourceId(request.resourceGroupId, "resourceGroupId");
  const resourceGroupName = requireAzureResourceName(
    request.resourceGroupName,
    "resourceGroupName",
  );
  requireAzureResourceGroupBinding(resourceGroupId, resourceGroupName);
  const baseDeploymentName = requireAzureResourceName(
    request.baseDeploymentName,
    "baseDeploymentName",
  );
  const basePlan = validateGenerationBasePlan(request.basePlan);
  const baseDeploymentId = requireExactSubscriptionDeploymentId(
    request.baseDeploymentId,
    basePlan.subscriptionId,
    baseDeploymentName,
  );
  const childDeploymentValue = requireAzureResourceId(
    request.childDeploymentId,
    "childDeploymentId",
  );
  const childDeploymentName = childDeploymentValue.split("/").at(-1);
  if (childDeploymentName === undefined) throw invalid("child deployment name is missing");
  const childDeploymentId = requireExactAzureDeploymentId(
    childDeploymentValue,
    resourceGroupId,
    childDeploymentName,
  );
  return {
    basePlan,
    cleanup: {
      phase: "not-started",
      providerResourcesSettled: false,
      runnerRegistrationSettled: false,
      settledAt: null,
      startedAt: null,
    },
    createdAt,
    generationNumber: 1,
    jitMintIntent: null,
    launchPrerequisites: null,
    location: requireAzurePilotLocation(request.location),
    managedRunCommand: null,
    operationLease: null,
    providerVmId: null,
    readyAt: null,
    reservedIncrementalCostUsdCents: incrementalCost,
    resourceGroupId,
    resourceGroupName,
    revision: requireRevision(revision),
    runnerReadiness: null,
    runnerRegistrationId: null,
    schedule: null,
    state: "planned",
    updatedAt: createdAt,
    vmResourceId: null,
    vmSize: requireAzurePilotVmSize(request.vmSize, allocation.acceptance.request.profile),
    zoneDeployments: [
      {
        availabilityZone: requireAzurePilotZone(request.availabilityZone),
        childDeploymentId,
        completedAt: null,
        deploymentId: baseDeploymentId,
        deploymentName: baseDeploymentName,
        outcome: "pending",
        requestedAt: createdAt,
        residualResourcesSettledAt: null,
        vmAbsenceVerifiedAt: null,
        vmResourceId: null,
      },
    ],
  };
}

export function appendPhysicalGeneration(
  allocation: AllocationRecord,
  attempt: ProviderAttempt,
  generation: PhysicalGeneration,
  attemptRevision: string,
): { readonly allocation: AllocationRecord; readonly attempt: ProviderAttempt } {
  const updatedAttempt: ProviderAttempt = {
    ...attempt,
    physicalGenerations: [...attempt.physicalGenerations, generation],
    reservation: {
      ...attempt.reservation,
      reservedCostUsdCents:
        attempt.reservation.reservedCostUsdCents + generation.reservedIncrementalCostUsdCents,
    },
    revision: requireRevision(attemptRevision),
    updatedAt: generation.createdAt,
  };
  return {
    allocation: replaceAttemptWithoutAllocationRevision(allocation, updatedAttempt),
    attempt: updatedAttempt,
  };
}

export function exactGenerationRetry(
  allocation: AllocationRecord,
  request: AddPhysicalGenerationRequest,
): AddPhysicalGenerationResult | undefined {
  const attempt = allocation.attempts[request.attemptOrdinal - 1];
  const generation = attempt?.physicalGenerations.find(
    (entry) => entry.generationNumber === request.generationNumber,
  );
  if (attempt === undefined || generation === undefined) {
    return undefined;
  }
  if (
    generation.createdAt !== request.createdAt ||
    !equal(generation.basePlan, request.basePlan) ||
    generation.reservedIncrementalCostUsdCents !== request.reservedIncrementalCostUsdCents ||
    generation.location !== request.location ||
    generation.resourceGroupId !== request.resourceGroupId ||
    generation.resourceGroupName !== request.resourceGroupName ||
    generation.vmSize !== request.vmSize ||
    generation.zoneDeployments[0]?.availabilityZone !== request.availabilityZone ||
    generation.zoneDeployments[0]?.childDeploymentId !== request.childDeploymentId ||
    generation.zoneDeployments[0]?.deploymentId !== request.baseDeploymentId ||
    generation.zoneDeployments[0]?.deploymentName !== request.baseDeploymentName
  ) {
    throw conflict("physical generation number was reused with different reservation data");
  }
  return {
    allocation,
    attempt,
    generation,
    outcome: "added",
    reservation: "exact-retry",
  };
}

export function applyPhysicalGenerationState(
  attempt: ProviderAttempt,
  current: PhysicalGeneration,
  request: UpdatePhysicalGenerationRequest,
  revision: string,
): PhysicalGeneration {
  if (attempt.deadlines === null || attempt.provider !== "azure" || attempt.ordinal !== 1) {
    throw precondition("the physical generation has no Azure attempt deadlines");
  }
  const updatedAt = requireUtcInstant(request.updatedAt, "updatedAt");
  if (updatedAt < current.updatedAt) {
    throw precondition("generation updatedAt cannot move backwards");
  }
  if (generationRank(request.state.state) < generationRank(current.state)) {
    throw precondition("physical generation state cannot move backwards");
  }
  const createsProviderIntent =
    request.state.zoneDeployments.length > current.zoneDeployments.length ||
    (current.schedule === null && request.state.schedule !== null) ||
    (current.jitMintIntent === null && request.state.jitMintIntent !== null) ||
    (current.operationLease === null && request.state.operationLease !== null) ||
    (current.managedRunCommand === null && request.state.managedRunCommand !== null);
  if (
    attempt.fatalAbortIntent !== null &&
    (createsProviderIntent || request.state.state === "ready")
  ) {
    throw precondition("fatal Azure abort intent permits cleanup updates only");
  }
  if (
    createsProviderIntent &&
    (updatedAt > attempt.deadlines.latestSafeStart ||
      generationRank(current.state) >= generationRank("fenced"))
  ) {
    throw precondition(
      "new zone, schedule or JIT intent is forbidden after latestSafeStart or fencing",
    );
  }
  const cleanup = validateGenerationCleanup(request.state.cleanup, current.cleanup);
  const operationLease = validateGenerationOperationLease(
    request.state.operationLease,
    current.operationLease,
    current.createdAt,
    updatedAt,
  );
  if (
    current.operationLease !== null &&
    operationLease !== null &&
    request.state.state !== current.state
  ) {
    throw precondition("an active provider operation lease freezes generation lifecycle state");
  }
  if (
    current.operationLease !== null &&
    generationRank(request.state.state) >= generationRank("fenced")
  ) {
    throw precondition("cleanup cannot begin while a provider operation lease is active");
  }
  const vmResourceIdValue = immutableNullableIdentifier(
    current.vmResourceId,
    request.state.vmResourceId,
    "vmResourceId",
  );
  const vmResourceId =
    vmResourceIdValue === null
      ? null
      : requireAzureVmResourceId(vmResourceIdValue, current.resourceGroupId);
  const schedule = validateSchedule(
    request.state.schedule,
    current.schedule,
    attempt.deadlines.computeDeadline,
    current.createdAt,
    vmResourceId,
  );
  if (schedule !== null && schedule.lastCheckedAt > updatedAt) {
    throw precondition("schedule lastCheckedAt cannot be later than generation updatedAt");
  }
  const providerVmId = immutableNullableIdentifier(
    current.providerVmId,
    request.state.providerVmId,
    "providerVmId",
  );
  const readyAt = immutableNullableInstant(current.readyAt, request.state.readyAt, "readyAt");
  const runnerRegistrationIdValue = immutableNullableIdentifier(
    current.runnerRegistrationId,
    request.state.runnerRegistrationId,
    "runnerRegistrationId",
  );
  const runnerRegistrationId =
    runnerRegistrationIdValue === null
      ? null
      : requirePositiveDecimalString(runnerRegistrationIdValue, "runnerRegistrationId");
  const zoneDeployments = validateZoneDeployments(
    request.state.zoneDeployments,
    current.zoneDeployments,
    current.createdAt,
    updatedAt,
    current.resourceGroupId,
    current.basePlan.subscriptionId,
  );
  const vmCreatingDeployment = zoneDeployments.find(
    (deployment) => deployment.outcome === "vm-created",
  );
  if ((vmCreatingDeployment?.vmResourceId ?? null) !== vmResourceId) {
    throw precondition("generation VM identity must match its sole successful zone deployment");
  }
  const launchPrerequisites = validateLaunchPrerequisites(
    request.state.launchPrerequisites,
    current.launchPrerequisites,
    current.createdAt,
    updatedAt,
  );
  const jitMintIntent = validateJitMintIntent(
    request.state.jitMintIntent,
    current.jitMintIntent,
    schedule,
    launchPrerequisites,
    current.resourceGroupId,
    current.createdAt,
    updatedAt,
  );
  const managedRunCommand = validateManagedRunCommand(
    request.state.managedRunCommand,
    current.managedRunCommand,
    vmResourceId,
    schedule,
    launchPrerequisites,
    current.createdAt,
    updatedAt,
  );
  if ((managedRunCommand !== null || runnerRegistrationId !== null) && jitMintIntent === null) {
    throw precondition("JIT runner evidence requires a durable one-shot mint intent");
  }
  const runnerReadiness = validateRunnerReadiness(
    request.state.runnerReadiness,
    current.runnerReadiness,
    managedRunCommand,
    current.createdAt,
    updatedAt,
  );
  if (
    request.state.state === "ready" &&
    (schedule?.status !== "accepted" ||
      readyAt === null ||
      readyAt > attempt.deadlines.latestSafeStart ||
      (schedule.acceptedAt !== null && readyAt < schedule.acceptedAt) ||
      vmResourceId === null ||
      providerVmId === null ||
      runnerRegistrationId === null ||
      launchPrerequisites === null ||
      managedRunCommand?.deleteCompletedAt === null ||
      runnerReadiness === null ||
      schedule.lastCheckedAt < runnerReadiness.checkedAt ||
      readyAt < runnerReadiness.checkedAt)
  ) {
    throw precondition(
      "a ready generation requires exact VM, schedule, bootstrap, launch deletion and online-idle runner evidence",
    );
  }
  if (generationRank(request.state.state) < generationRank("ready") && readyAt !== null) {
    throw precondition("readyAt is valid only once a generation reaches ready");
  }
  if (readyAt !== null && (readyAt < current.createdAt || readyAt > updatedAt)) {
    throw precondition("readyAt must fall within generation timestamps");
  }
  if (cleanup.phase === "settled" && request.state.state !== "settled") {
    throw precondition("settled generation cleanup requires settled generation state");
  }
  if (
    cleanup.settledAt !== null &&
    (cleanup.settledAt < current.createdAt || cleanup.settledAt > updatedAt)
  ) {
    throw precondition("generation cleanup settledAt must fall within generation timestamps");
  }
  return {
    ...current,
    cleanup,
    jitMintIntent,
    launchPrerequisites,
    managedRunCommand,
    operationLease,
    providerVmId,
    readyAt,
    revision: requireRevision(revision),
    runnerReadiness,
    runnerRegistrationId,
    schedule,
    state: request.state.state,
    updatedAt,
    vmResourceId,
    zoneDeployments,
  };
}

export function replacePhysicalGeneration(
  allocation: AllocationRecord,
  attempt: ProviderAttempt,
  generation: PhysicalGeneration,
): AllocationRecord {
  const generations = [...attempt.physicalGenerations];
  const index = generations.findIndex(
    (entry) => entry.generationNumber === generation.generationNumber,
  );
  if (index < 0) {
    throw new AllocationLedgerError("not-found", "physical generation was not found");
  }
  generations[index] = generation;
  return replaceAttemptWithoutAllocationRevision(allocation, {
    ...attempt,
    physicalGenerations: generations,
  });
}

export function applyFencedPhysicalGenerationUpdate(
  allocation: AllocationRecord,
  attempt: ProviderAttempt,
  generation: PhysicalGeneration,
  request: FencedPhysicalGenerationUpdateRequest,
  revisions: {
    readonly allocation: string;
    readonly attempt: string;
    readonly generation: string;
  },
): AllocationRecord {
  if (
    request.expectedAllocationRevision !== allocation.revision ||
    request.expectedAttemptRevision !== attempt.revision ||
    request.expectedRevision !== generation.revision
  ) {
    throw optimisticConflict();
  }
  const updatedGeneration = applyPhysicalGenerationState(
    attempt,
    generation,
    request,
    revisions.generation,
  );
  const generations = attempt.physicalGenerations.map((entry) =>
    entry.generationNumber === generation.generationNumber ? updatedGeneration : entry,
  );
  const updatedAttempt: ProviderAttempt = {
    ...attempt,
    physicalGenerations: generations,
    revision: requireRevision(revisions.attempt),
    updatedAt: request.updatedAt,
  };
  const attempts = allocation.attempts.map((entry) =>
    entry.ordinal === attempt.ordinal ? updatedAttempt : entry,
  );
  return {
    ...allocation,
    attempts,
    revision: requireRevision(revisions.allocation),
    updatedAt: request.updatedAt,
  };
}

export function samePhysicalGenerationState(
  attempt: ProviderAttempt,
  generation: PhysicalGeneration,
  request: UpdatePhysicalGenerationRequest,
): boolean {
  try {
    return equal(
      withoutGenerationRevision(
        applyPhysicalGenerationState(attempt, generation, request, generation.revision),
      ),
      withoutGenerationRevision(generation),
    );
  } catch {
    return false;
  }
}

export function settleFinalAttemptRecords(
  allocation: AllocationRecord,
  attempt: ProviderAttempt,
  request: SettleFinalProviderAttemptRequest,
  allocationRevision: string,
  attemptRevision: string,
): { readonly allocation: AllocationRecord; readonly attempt: ProviderAttempt } {
  requireAllocationId(request.allocationId);
  requirePositiveSafeInteger(request.ordinal, "ordinal");
  const settledAt = requireUtcInstant(request.settledAt, "settledAt");
  if (
    request.expectedAllocationRevision !== allocation.revision ||
    request.expectedAttemptRevision !== attempt.revision
  ) {
    throw optimisticConflict();
  }
  if (
    allocation.runnerAssignment?.attemptOrdinal !== attempt.ordinal ||
    attempt.outcome !== "succeeded" ||
    attempt.reservation.state !== "held" ||
    allocation.lifecycleState !== "cleanup_pending" ||
    allocation.cleanup.phase !== "settled" ||
    allocation.cleanup.terminalEvidence === null
  ) {
    throw precondition("terminal workload evidence and settled cleanup are required for release");
  }
  if (
    attempt.provider === "blacksmith" &&
    allocation.cleanup.terminalEvidence.source !== "github-job" &&
    allocation.cleanup.terminalEvidence.source !== "github-workflow-run"
  ) {
    throw precondition(
      "Blacksmith release requires the mapped job or whole workflow to be terminal",
    );
  }
  validateTerminalEvidenceBinding(
    allocation.cleanup.terminalEvidence,
    allocation.identity,
    allocation.workloadBinding,
  );
  const cleanup = validateAttemptCleanup(request.cleanup, attempt.cleanup);
  if (
    cleanup.phase !== "settled" ||
    !cleanup.providerResourcesSettled ||
    !cleanup.runnerRegistrationSettled ||
    (attempt.provider === "azure" &&
      attempt.physicalGenerations.some((generation) => generation.cleanup.phase !== "settled"))
  ) {
    throw precondition("provider attempt cleanup is incomplete");
  }
  const finalCost = requireNonNegativeSafeInteger(request.finalCostUsdCents, "finalCostUsdCents");
  if (finalCost > attempt.reservation.reservedCostUsdCents) {
    throw precondition("finalCostUsdCents cannot exceed the conservative reservation");
  }
  if (settledAt < allocation.updatedAt || settledAt < attempt.updatedAt) {
    throw precondition("settledAt cannot move time backwards");
  }
  const updatedAttempt: ProviderAttempt = {
    ...attempt,
    cleanup,
    reservation: {
      ...attempt.reservation,
      concurrencyReleasedAt: settledAt,
      finalCostUsdCents: finalCost,
      settledAt,
      settledFromRevision: request.expectedAttemptRevision,
      settlementKind: "terminal",
      state: "settled",
    },
    revision: requireRevision(attemptRevision),
    updatedAt: settledAt,
  };
  return {
    allocation: replaceAttempt(allocation, updatedAttempt, {
      lifecycleState: "ended",
      revision: allocationRevision,
      updatedAt: settledAt,
    }),
    attempt: updatedAttempt,
  };
}

export function isExactFinalSettlementRetry(
  allocation: AllocationRecord,
  request: SettleFinalProviderAttemptRequest,
): boolean {
  const attempt = allocation.attempts[request.ordinal - 1];
  return (
    attempt !== undefined &&
    attempt.reservation.state === "settled" &&
    attempt.reservation.settlementKind === "terminal" &&
    attempt.reservation.finalCostUsdCents === request.finalCostUsdCents &&
    attempt.reservation.settledAt === request.settledAt &&
    attempt.reservation.settledFromRevision === request.expectedAttemptRevision &&
    equal(attempt.cleanup, request.cleanup)
  );
}

export function validateHeldReservationCounters(
  provider: ProviderName,
  activeReservations: number,
  accountedDailyCostUsdCents: number,
  heldCostUsdCents: number,
): void {
  const limits = PROVIDER_LIMITS[provider];
  requireAuthoritativeCounter(
    activeReservations,
    limits.maximumConcurrentAllocations,
    "active reservations",
  );
  requireAuthoritativeCounter(
    accountedDailyCostUsdCents,
    limits.dailyAllowanceUsdCents,
    "allowance",
  );
  requirePositiveSafeInteger(heldCostUsdCents, "heldCostUsdCents");
  if (activeReservations < 1 || accountedDailyCostUsdCents < heldCostUsdCents) {
    throw corrupt("authoritative counters cannot cover the held provider attempt reservation");
  }
}

export function evaluateAdditionalAllowance(
  provider: ProviderName,
  accountedDailyCostUsdCents: number,
  requestedCostUsdCents: number,
): boolean {
  const limit = PROVIDER_LIMITS[provider].dailyAllowanceUsdCents;
  requireAuthoritativeCounter(accountedDailyCostUsdCents, limit, "allowance");
  requirePositiveSafeInteger(requestedCostUsdCents, "requestedCostUsdCents");
  return requestedCostUsdCents > limit - accountedDailyCostUsdCents;
}

export function acquireCheckRunCreationLeaseRecord(
  allocation: AllocationRecord,
  request: AcquireCheckRunCreationLeaseRequest,
  revision: string,
): { readonly allocation: AllocationRecord; readonly result: AcquireCheckRunCreationLeaseResult } {
  validateCheckRunKey(request, allocation.checkRunCreation.key);
  const acquiredAt = requireUtcInstant(request.acquiredAt, "acquiredAt");
  const leaseExpiresAt = requireUtcInstant(request.leaseExpiresAt, "leaseExpiresAt");
  const leaseOwner = requireLeaseOwner(request.leaseOwner);
  const duration = Date.parse(leaseExpiresAt) - Date.parse(acquiredAt);
  if (duration <= 0 || duration > CHECK_RUN_CREATION_LEASE_MAX_SECONDS * 1000) {
    throw invalid(
      `Check Run creation lease must be positive and at most ${CHECK_RUN_CREATION_LEASE_MAX_SECONDS} seconds`,
    );
  }
  const state = allocation.checkRunCreation;
  if (state.delivery.lifecycle.phase !== "not-created") {
    return {
      allocation,
      result: { outcome: "completed", checkRunId: state.delivery.lifecycle.checkRunId },
    };
  }
  if (state.delivery.retry?.attempt === MAX_CHECK_RUN_DELIVERY_ATTEMPTS) {
    return { allocation, result: { outcome: "exhausted" } };
  }
  if (state.delivery.retry !== null && acquiredAt < state.delivery.retry.notBefore) {
    return {
      allocation,
      result: { outcome: "deferred", notBefore: state.delivery.retry.notBefore },
    };
  }
  if (
    state.leaseOwner !== null &&
    state.leaseExpiresAt !== null &&
    acquiredAt <= state.leaseExpiresAt
  ) {
    if (state.leaseOwner === leaseOwner) {
      return {
        allocation,
        result: {
          leaseExpiresAt: state.leaseExpiresAt,
          leaseOwner,
          leaseRevision: state.leaseRevision,
          outcome: "acquired",
        },
      };
    }
    return { allocation, result: { leaseExpiresAt: state.leaseExpiresAt, outcome: "busy" } };
  }
  const leaseRevision = state.leaseRevision + 1;
  const updated: AllocationRecord = {
    ...allocation,
    checkRunCreation: {
      ...state,
      leaseExpiresAt,
      leaseOwner,
      leaseRevision,
    },
    revision: requireRevision(revision),
    updatedAt: maxInstant(allocation.updatedAt, acquiredAt),
  };
  return {
    allocation: updated,
    result: { leaseExpiresAt, leaseOwner, leaseRevision, outcome: "acquired" },
  };
}

export function renewCheckRunCreationLeaseRecord(
  allocation: AllocationRecord,
  request: RenewCheckRunCreationLeaseRequest,
  revision: string,
): {
  readonly allocation: AllocationRecord;
  readonly result: RenewCheckRunCreationLeaseResult;
} {
  requireAllocationId(request.allocationId);
  const renewedAt = requireUtcInstant(request.renewedAt, "renewedAt");
  const leaseExpiresAt = requireUtcInstant(request.leaseExpiresAt, "leaseExpiresAt");
  const leaseOwner = requireLeaseOwner(request.leaseOwner);
  const leaseRevision = requirePositiveSafeInteger(request.leaseRevision, "leaseRevision");
  const duration = Date.parse(leaseExpiresAt) - Date.parse(renewedAt);
  if (duration <= 0 || duration > CHECK_RUN_CREATION_LEASE_MAX_SECONDS * 1000) {
    throw invalid(
      `renewed Check Run creation lease must be positive and at most ${CHECK_RUN_CREATION_LEASE_MAX_SECONDS} seconds`,
    );
  }
  const state = allocation.checkRunCreation;
  if (
    state.delivery.lifecycle.phase !== "not-created" ||
    state.leaseOwner === null ||
    state.leaseExpiresAt === null
  ) {
    throw optimisticConflict("Check Run creation lease is absent or creation already completed");
  }
  const renewedRevision = leaseRevision + 1;
  if (
    state.leaseOwner === leaseOwner &&
    state.leaseRevision === renewedRevision &&
    state.leaseExpiresAt === leaseExpiresAt
  ) {
    return {
      allocation,
      result: { leaseExpiresAt, leaseOwner, leaseRevision: renewedRevision },
    };
  }
  validateLeaseHolder(state, leaseOwner, leaseRevision, renewedAt);
  if (leaseExpiresAt < state.leaseExpiresAt) {
    throw invalid("renewed Check Run creation lease cannot shorten its current expiry");
  }
  const updated: AllocationRecord = {
    ...allocation,
    checkRunCreation: {
      ...state,
      leaseExpiresAt,
      leaseRevision: renewedRevision,
    },
    revision: requireRevision(revision),
    updatedAt: maxInstant(allocation.updatedAt, renewedAt),
  };
  return {
    allocation: updated,
    result: { leaseExpiresAt, leaseOwner, leaseRevision: renewedRevision },
  };
}

export function completeCheckRunCreationRecord(
  allocation: AllocationRecord,
  request: CompleteCheckRunCreationRequest,
  revision: string,
): AllocationRecord {
  requireAllocationId(request.allocationId);
  const checkRunId = requirePositiveDecimalString(request.checkRunId, "checkRunId");
  const completedAt = requireUtcInstant(request.completedAt, "completedAt");
  const state = allocation.checkRunCreation;
  if (state.delivery.lifecycle.phase !== "not-created") {
    if (state.delivery.lifecycle.checkRunId === checkRunId) {
      return allocation;
    }
    throw conflict("Check Run creation retry returned a conflicting numeric ID");
  }
  validateLeaseHolder(state, request.leaseOwner, request.leaseRevision, completedAt);
  const snapshot = acceptedCheckRunSnapshot(allocation);
  const delivery = applyCheckRunDeliverySuccess(
    state.delivery,
    { operation: "create", snapshot },
    checkRunId,
  );
  return {
    ...allocation,
    checkRunCreation: {
      ...state,
      delivery,
      leaseExpiresAt: null,
      leaseOwner: null,
    },
    revision: requireRevision(revision),
    updatedAt: maxInstant(allocation.updatedAt, completedAt),
  };
}

export function failCheckRunCreationRecord(
  allocation: AllocationRecord,
  request: FailCheckRunCreationRequest,
  revision: string,
): AllocationRecord {
  requireAllocationId(request.allocationId);
  const failedAt = requireUtcInstant(request.failedAt, "failedAt");
  const state = allocation.checkRunCreation;
  if (state.delivery.lifecycle.phase !== "not-created") {
    return allocation;
  }
  validateLeaseHolder(state, request.leaseOwner, request.leaseRevision, failedAt);
  const delivery = scheduleCheckRunRetry(
    state.delivery,
    "create",
    request.failure,
    new Date(failedAt),
  );
  return {
    ...allocation,
    checkRunCreation: {
      ...state,
      delivery,
      leaseExpiresAt: null,
      leaseOwner: null,
    },
    revision: requireRevision(revision),
    updatedAt: maxInstant(allocation.updatedAt, failedAt),
  };
}

export function acceptedCheckRunSnapshot(allocation: AllocationRecord): SwitchyardCheckRunSnapshot {
  return {
    allocationId: allocation.allocationId,
    cleanupResult: null,
    durationSeconds: null,
    estimatedCostUsdCents: null,
    fallbackUsed: null,
    headSha: allocation.acceptance.trust.workflow.commitSha,
    provider: null,
    revision: 0,
    stage: "accepted",
    workloadOutcome: null,
  };
}

/** Deterministic durable-state projection used by best-effort lifecycle reporting. */
export function lifecycleCheckRunSnapshot(
  allocation: AllocationRecord,
): SwitchyardCheckRunSnapshot {
  if (allocation.lifecycleState === "ended" || allocation.lifecycleState === "cleanup_pending") {
    const evidence = allocation.cleanup.terminalEvidence;
    if (evidence === null) {
      throw corrupt("terminal lifecycle state has no workload evidence for its Check Run");
    }
    const provider = allocation.attempts.at(-1)?.provider ?? null;
    if (provider === null && allocation.attempts.length !== 0) {
      throw corrupt("a provider-less Check Run projection must have zero attempts");
    }
    const durationSeconds = Math.ceil(
      (Date.parse(evidence.concludedAt) - Date.parse(allocation.createdAt)) / 1_000,
    );
    if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 0) {
      throw corrupt("Check Run lifecycle duration is invalid");
    }
    const estimatedCostUsdCents = allocation.attempts.reduce(
      (total, attempt) =>
        total + (attempt.reservation.finalCostUsdCents ?? attempt.reservation.reservedCostUsdCents),
      0,
    );
    return {
      allocationId: allocation.allocationId,
      cleanupResult: allocation.lifecycleState === "ended" ? "succeeded" : "pending",
      durationSeconds,
      estimatedCostUsdCents,
      fallbackUsed: provider === "blacksmith",
      headSha: allocation.acceptance.trust.workflow.commitSha,
      provider,
      revision: allocation.lifecycleState === "ended" ? 5 : 4,
      stage: allocation.lifecycleState === "ended" ? "ended" : "cleanup-pending",
      workloadOutcome: checkRunWorkloadOutcome(evidence.conclusion),
    };
  }

  const assignment = allocation.runnerAssignment;
  if (assignment !== null) {
    return {
      allocationId: allocation.allocationId,
      cleanupResult: null,
      durationSeconds: null,
      estimatedCostUsdCents: null,
      fallbackUsed: assignment.provider === "blacksmith",
      headSha: allocation.acceptance.trust.workflow.commitSha,
      provider: assignment.provider,
      revision: 3,
      stage: "runner-ready",
      workloadOutcome: null,
    };
  }

  const attempt = allocation.attempts.at(-1);
  if (attempt !== undefined) {
    return {
      allocationId: allocation.allocationId,
      cleanupResult: null,
      durationSeconds: null,
      estimatedCostUsdCents: null,
      fallbackUsed: attempt.provider === "blacksmith",
      headSha: allocation.acceptance.trust.workflow.commitSha,
      provider: attempt.provider,
      revision: attempt.provider === "blacksmith" ? 2 : 1,
      stage: "provider-selected",
      workloadOutcome: null,
    };
  }
  return acceptedCheckRunSnapshot(allocation);
}

function checkRunWorkloadOutcome(
  conclusion: TerminalWorkloadConclusion,
): SwitchyardCheckRunSnapshot["workloadOutcome"] {
  switch (conclusion) {
    case "succeeded":
      return "succeeded";
    case "cancelled":
      return "cancelled";
    case "timed_out":
      return "timed-out";
    case "never_started":
      return "never-started";
    case "failed":
      return "failed";
  }
}

function assertExactPersistedAllocationShape(value: unknown): void {
  try {
    const allocation = exactPersistedRecord(
      value,
      [
        "acceptance",
        "abandonment",
        "allocationId",
        "attempts",
        "checkRunCreation",
        "cleanup",
        "createdAt",
        "identity",
        "lifecycleState",
        "revision",
        "runnerAssignment",
        "stop",
        "updatedAt",
        "workloadBinding",
      ],
      "allocation",
    );
    requirePersistedEnum(
      allocation.lifecycleState,
      ALLOCATION_LIFECYCLE_STATES,
      "allocation.lifecycleState",
    );
    parseAllocationIdentity(allocation.identity);

    const acceptance = exactPersistedRecord(
      allocation.acceptance,
      ["request", "trust"],
      "allocation.acceptance",
    );
    const request = exactPersistedRecord(
      acceptance.request,
      ["backupChoice", "profile"],
      "allocation.acceptance.request",
    );
    parseBackupChoice(request.backupChoice, "allocation.acceptance.request.backupChoice");
    parseCapabilityProfile(request.profile, "allocation.acceptance.request.profile");
    parseVerifiedWorkloadTrust(acceptance.trust);

    if (allocation.abandonment !== null) {
      const abandonment = exactPersistedRecord(
        allocation.abandonment,
        ["abandonedAt", "abandonedFromRevision", "reason"],
        "allocation.abandonment",
      );
      requirePersistedEnum(
        abandonment.reason,
        ["controller-progress-timeout"] as const,
        "allocation.abandonment.reason",
      );
    }

    const creation = exactPersistedRecord(
      allocation.checkRunCreation,
      ["delivery", "key", "leaseExpiresAt", "leaseOwner", "leaseRevision"],
      "allocation.checkRunCreation",
    );
    parseCheckRunDeliveryRecord(creation.delivery);
    const checkRunKey = exactPersistedRecord(
      creation.key,
      ["allocationId", "appSlug", "headSha", "repository"],
      "allocation.checkRunCreation.key",
    );
    exactPersistedRecord(
      checkRunKey.repository,
      ["name", "owner"],
      "allocation.checkRunCreation.key.repository",
    );
    assertPersistedCleanup(allocation.cleanup, "allocation.cleanup", true);
    assertPersistedWorkloadBinding(allocation.workloadBinding);

    if (!Array.isArray(allocation.attempts)) {
      throw invalid("allocation.attempts must be an array");
    }
    for (const [index, attempt] of allocation.attempts.entries()) {
      assertPersistedAttemptShape(attempt, index);
    }

    if (allocation.runnerAssignment !== null) {
      const assignmentValue = requireRecord(
        allocation.runnerAssignment,
        "allocation.runnerAssignment",
      );
      const assignment = exactPersistedRecord(
        assignmentValue,
        assignmentValue.provider === "azure"
          ? [
              "assignedAt",
              "attemptOrdinal",
              "generationNumber",
              "provider",
              "readinessCheckedAt",
              "runnerIdle",
              "runnerLabel",
              "runnerRegistrationId",
              "runnerOnline",
            ]
          : ["assignedAt", "attemptOrdinal", "provider", "runnerLabel"],
        "allocation.runnerAssignment",
      );
      requirePersistedEnum(
        assignment.provider,
        ["azure", "blacksmith"] as const,
        "allocation.runnerAssignment.provider",
      );
    }
    if (allocation.stop !== null) {
      const stop = exactPersistedRecord(
        allocation.stop,
        ["reason", "stoppedAt", "stoppedFromRevision"],
        "allocation.stop",
      );
      requirePersistedEnum(
        stop.reason,
        ["save-money", "all-providers-unavailable"] as const,
        "allocation.stop.reason",
      );
    }
  } catch (error) {
    if (error instanceof AllocationLedgerError && error.code === "authoritative-state-corrupt") {
      throw error;
    }
    throw corrupt("persisted allocation contains malformed or non-exact schema-10 state", error);
  }
}

function assertPersistedAttemptShape(value: unknown, index: number): void {
  const path = `allocation.attempts[${index}]`;
  const attempt = exactPersistedRecord(
    value,
    [
      "admission",
      "attemptedAt",
      "cleanup",
      "deadlines",
      "fatalAbort",
      "fatalAbortIntent",
      "ordinal",
      "outcome",
      "physicalGenerations",
      "provider",
      "reservation",
      "revision",
      "succeededAt",
      "unavailable",
      "updatedAt",
    ],
    path,
  );
  requirePersistedEnum(
    attempt.admission,
    ["reserved", "capacity-unavailable"] as const,
    `${path}.admission`,
  );
  requirePersistedEnum(
    attempt.outcome,
    ["aborted", "pending", "succeeded", "unavailable"] as const,
    `${path}.outcome`,
  );
  requirePersistedEnum(attempt.provider, ["azure", "blacksmith"] as const, `${path}.provider`);
  assertPersistedCleanup(attempt.cleanup, `${path}.cleanup`, false);
  if (attempt.deadlines !== null) {
    exactPersistedRecord(
      attempt.deadlines,
      ["absoluteExpiry", "computeDeadline", "latestSafeStart"],
      `${path}.deadlines`,
    );
  }
  const reservation = exactPersistedRecord(
    attempt.reservation,
    [
      "concurrencyReleasedAt",
      "finalCostUsdCents",
      "requestedCostUsdCents",
      "reservedCostUsdCents",
      "settledAt",
      "settledFromRevision",
      "settlementKind",
      "state",
      "utcDay",
    ],
    `${path}.reservation`,
  );
  requirePersistedEnum(
    reservation.state,
    ["not-held", "held", "settled"] as const,
    `${path}.reservation.state`,
  );
  if (reservation.settlementKind !== null) {
    requirePersistedEnum(
      reservation.settlementKind,
      ["aborted", "terminal", "unavailable"] as const,
      `${path}.reservation.settlementKind`,
    );
  }
  if (attempt.unavailable !== null) {
    const unavailable = exactPersistedRecord(
      attempt.unavailable,
      ["classification", "recordedAt"],
      `${path}.unavailable`,
    );
    requirePersistedEnum(
      unavailable.classification,
      PROVIDER_UNAVAILABLE_CLASSIFICATIONS,
      `${path}.unavailable.classification`,
    );
  }
  if (attempt.fatalAbort !== null) {
    const fatalAbort = exactPersistedRecord(
      attempt.fatalAbort,
      ["classification", "recordedAt"],
      `${path}.fatalAbort`,
    );
    requirePersistedEnum(
      fatalAbort.classification,
      FATAL_AZURE_ABORT_CLASSIFICATIONS,
      `${path}.fatalAbort.classification`,
    );
  }
  if (attempt.fatalAbortIntent !== null) {
    const fatalAbortIntent = exactPersistedRecord(
      attempt.fatalAbortIntent,
      ["classification", "recordedAt"],
      `${path}.fatalAbortIntent`,
    );
    requirePersistedEnum(
      fatalAbortIntent.classification,
      FATAL_AZURE_ABORT_CLASSIFICATIONS,
      `${path}.fatalAbortIntent.classification`,
    );
  }
  if (!Array.isArray(attempt.physicalGenerations)) {
    throw invalid(`${path}.physicalGenerations must be an array`);
  }
  for (const [generationIndex, generation] of attempt.physicalGenerations.entries()) {
    assertPersistedGenerationShape(generation, `${path}.physicalGenerations[${generationIndex}]`);
  }
}

function assertPersistedGenerationShape(value: unknown, path: string): void {
  const generation = exactPersistedRecord(
    value,
    [
      "basePlan",
      "cleanup",
      "createdAt",
      "generationNumber",
      "jitMintIntent",
      "launchPrerequisites",
      "location",
      "managedRunCommand",
      "operationLease",
      "providerVmId",
      "readyAt",
      "reservedIncrementalCostUsdCents",
      "resourceGroupId",
      "resourceGroupName",
      "revision",
      "runnerReadiness",
      "runnerRegistrationId",
      "schedule",
      "state",
      "updatedAt",
      "vmResourceId",
      "vmSize",
      "zoneDeployments",
    ],
    path,
  );
  requirePersistedEnum(
    generation.state,
    ["planned", "provisioning", "ready", "fenced", "cleanup_pending", "settled"] as const,
    `${path}.state`,
  );
  exactPersistedRecord(
    generation.basePlan,
    [
      "adminSshPublicKeySha256",
      "adminSshPublicKey",
      "baseTemplateSha256",
      "imageVersion",
      "nonSecretBootstrapSha256",
      "sharedRunnerSubnetId",
      "subscriptionId",
    ],
    `${path}.basePlan`,
  );
  assertPersistedCleanup(generation.cleanup, `${path}.cleanup`, false, true);
  if (generation.schedule !== null) {
    const schedule = exactPersistedRecord(
      generation.schedule,
      [
        "acceptedAt",
        "deadlineType",
        "lastCheckedAt",
        "providerOperationId",
        "requestCorrelationId",
        "requestedDeadline",
        "status",
        "targetVmResourceId",
      ],
      `${path}.schedule`,
    );
    requirePersistedEnum(
      schedule.status,
      ["requested", "accepted", "executed", "rejected", "failed"] as const,
      `${path}.schedule.status`,
    );
  }
  if (generation.launchPrerequisites !== null) {
    exactPersistedRecord(
      generation.launchPrerequisites,
      ["bootstrapSucceeded", "checkedAt", "dockerHealthy", "localNvmeMounted"],
      `${path}.launchPrerequisites`,
    );
  }
  if (generation.jitMintIntent !== null) {
    exactPersistedRecord(
      generation.jitMintIntent,
      ["intentId", "jitDeploymentId", "requestedAt"],
      `${path}.jitMintIntent`,
    );
  }
  if (generation.managedRunCommand !== null) {
    exactPersistedRecord(
      generation.managedRunCommand,
      [
        "boundVmResourceId",
        "deleteCompletedAt",
        "deleteRequestedAt",
        "launchConfirmedAt",
        "managedRunCommandId",
        "requestedAt",
      ],
      `${path}.managedRunCommand`,
    );
  }
  if (generation.operationLease !== null) {
    exactPersistedRecord(
      generation.operationLease,
      ["acquiredAt", "expiresAt", "kind", "leaseId"],
      `${path}.operationLease`,
    );
  }
  if (generation.runnerReadiness !== null) {
    exactPersistedRecord(
      generation.runnerReadiness,
      ["checkedAt", "idle", "online"],
      `${path}.runnerReadiness`,
    );
  }
  if (!Array.isArray(generation.zoneDeployments)) {
    throw invalid(`${path}.zoneDeployments must be an array`);
  }
  for (const [index, deploymentValue] of generation.zoneDeployments.entries()) {
    const deployment = exactPersistedRecord(
      deploymentValue,
      [
        "availabilityZone",
        "childDeploymentId",
        "completedAt",
        "deploymentId",
        "deploymentName",
        "outcome",
        "requestedAt",
        "residualResourcesSettledAt",
        "vmAbsenceVerifiedAt",
        "vmResourceId",
      ],
      `${path}.zoneDeployments[${index}]`,
    );
    requirePersistedEnum(
      deployment.outcome,
      ["pending", "no-vm-created", "management-plane-unavailable", "vm-created"] as const,
      `${path}.zoneDeployments[${index}].outcome`,
    );
  }
}

function assertPersistedCleanup(
  value: unknown,
  path: string,
  allocation: boolean,
  generation = false,
): void {
  const keys = allocation
    ? ([
        "phase",
        "providerResourcesSettled",
        "runnerRegistrationSettled",
        "settledAt",
        "terminalEvidence",
      ] as const)
    : generation
      ? ([
          "phase",
          "providerResourcesSettled",
          "runnerRegistrationSettled",
          "settledAt",
          "startedAt",
        ] as const)
      : (["phase", "providerResourcesSettled", "runnerRegistrationSettled", "settledAt"] as const);
  const cleanup = exactPersistedRecord(value, keys, path);
  requirePersistedEnum(
    cleanup.phase,
    ["not-started", "pending", "settled"] as const,
    `${path}.phase`,
  );
  if (
    typeof cleanup.providerResourcesSettled !== "boolean" ||
    typeof cleanup.runnerRegistrationSettled !== "boolean"
  ) {
    throw invalid(`${path} settlement flags must be booleans`);
  }
  if (allocation && cleanup.terminalEvidence !== null) {
    assertPersistedTerminalEvidenceShape(cleanup.terminalEvidence, `${path}.terminalEvidence`);
  }
}

function assertPersistedTerminalEvidenceShape(value: unknown, path: string): void {
  const evidence = requireRecord(value, path);
  if (evidence.source === "github-job") {
    requireExactKeys(evidence, ["concludedAt", "conclusion", "githubJobId", "source"], path);
  } else if (evidence.source === "github-workflow-run") {
    requireExactKeys(
      evidence,
      ["concludedAt", "conclusion", "repositoryId", "runAttempt", "runId", "source"],
      path,
    );
  } else if (evidence.source === "allocation-never-returned") {
    requireExactKeys(evidence, ["concludedAt", "conclusion", "source"], path);
  } else {
    throw invalid(`${path}.source is not recognised`);
  }
  requirePersistedEnum(evidence.conclusion, TERMINAL_WORKLOAD_CONCLUSIONS, `${path}.conclusion`);
}

function assertPersistedWorkloadBinding(value: unknown): void {
  const path = "allocation.workloadBinding";
  const binding = requireRecord(value, path);
  if (
    binding.state === "not-assigned" ||
    binding.state === "authorised" ||
    binding.state === "awaiting-correlation"
  ) {
    requireExactKeys(binding, ["state"], path);
    return;
  }
  if (binding.state === "bound") {
    requireExactKeys(binding, ["githubJobId", "state"], path);
    return;
  }
  if (binding.state === "binding-failed") {
    requireExactKeys(binding, ["reason", "state"], path);
    requirePersistedEnum(
      binding.reason,
      ["expected-job-missing", "different-job", "ambiguous-job"] as const,
      `${path}.reason`,
    );
    return;
  }
  throw invalid(`${path}.state is not recognised`);
}

function exactPersistedRecord(
  value: unknown,
  keys: readonly string[],
  path: string,
): Record<string, unknown> {
  const record = requireRecord(value, path);
  requireExactKeys(record, keys, path);
  return record;
}

function requirePersistedEnum<const T extends readonly unknown[]>(
  value: unknown,
  allowed: T,
  path: string,
): T[number] {
  if (!allowed.includes(value)) {
    throw invalid(`${path} is not recognised`);
  }
  return value as T[number];
}

export function assertValidAllocationRecord(value: AllocationRecord): void {
  assertExactPersistedAllocationShape(value);
  const allocationId = requireAllocationId(value.allocationId);
  const acceptance = validateAcceptanceEvidence(value.acceptance);
  if (
    allocationIdForIdentity(value.identity) !== allocationId ||
    !equal(parseAllocationIdentity(value.identity), acceptance.trust.identity)
  ) {
    throw corrupt("allocation identity and immutable acceptance evidence disagree");
  }
  requireRevision(value.revision);
  requireUtcInstant(value.createdAt, "createdAt");
  requireUtcInstant(value.updatedAt, "updatedAt");
  if (
    value.updatedAt < value.createdAt ||
    !ALLOCATION_LIFECYCLE_STATES.includes(value.lifecycleState)
  ) {
    throw corrupt("allocation lifecycle timestamps or state are invalid");
  }
  const expected = createAcceptedAllocationRecord(
    {
      acceptedAt: value.createdAt,
      checkRunAppSlug: value.checkRunCreation.key.appSlug,
      evidence: acceptance,
    },
    value.revision,
  );
  if (!equal(expected.checkRunCreation.key, value.checkRunCreation.key)) {
    throw corrupt("Check Run creation key disagrees with immutable acceptance evidence");
  }
  validatePersistedCheckRunCreation(value.checkRunCreation, value);
  let prefix: AllocationRecord = { ...value, attempts: [] };
  for (const attempt of value.attempts) {
    validatePersistedAttempt(prefix, attempt);
    prefix = { ...prefix, attempts: [...prefix.attempts, attempt] };
  }
  if (value.runnerAssignment !== null) {
    const assignment = validateRunnerAssignment(value.runnerAssignment, value);
    validatePersistedRunnerAssignment(assignment, value);
  }
  validateAllocationCleanup(value.cleanup, value.cleanup);
  validateWorkloadBinding(value.workloadBinding, value.workloadBinding);
  validateTerminalEvidenceBinding(
    value.cleanup.terminalEvidence,
    value.identity,
    value.workloadBinding,
    value.stop !== null ||
      value.abandonment !== null ||
      value.attempts.some((attempt) => attempt.outcome === "aborted"),
  );
  validatePersistedAllocationLifecycle(value);
  if (
    value.lifecycleState === "ended" &&
    value.abandonment === null &&
    value.stop === null &&
    !value.attempts.some(
      (attempt) =>
        attempt.reservation.settlementKind === "terminal" ||
        attempt.reservation.settlementKind === "aborted",
    )
  ) {
    throw corrupt("ended allocation lacks stop or terminal settlement evidence");
  }
}

function validatePersistedAllocationLifecycle(allocation: AllocationRecord): void {
  const latestAttempt = allocation.attempts.at(-1);
  const hasAssignment = allocation.runnerAssignment !== null;
  if (
    (hasAssignment &&
      allocation.lifecycleState !== "assigned" &&
      allocation.lifecycleState !== "cleanup_pending" &&
      allocation.lifecycleState !== "ended") ||
    (!hasAssignment &&
      (allocation.lifecycleState === "assigned" || allocation.lifecycleState === "cleanup_pending"))
  ) {
    throw corrupt("allocation lifecycle disagrees with immutable runner assignment");
  }
  if (
    (allocation.lifecycleState === "provisioning" && latestAttempt === undefined) ||
    (allocation.lifecycleState === "ready" && latestAttempt?.outcome !== "succeeded") ||
    (allocation.lifecycleState === "assigned" && !hasAssignment) ||
    (allocation.lifecycleState === "cleanup_pending" && allocation.cleanup.phase === "not-started")
  ) {
    throw corrupt("allocation lifecycle disagrees with provider attempt or cleanup state");
  }
  if (
    (allocation.lifecycleState === "accepted" &&
      latestAttempt !== undefined &&
      latestAttempt.outcome !== "unavailable") ||
    (allocation.lifecycleState === "provisioning" &&
      latestAttempt?.outcome !== "pending" &&
      latestAttempt?.admission !== "capacity-unavailable")
  ) {
    throw corrupt("allocation lifecycle does not match its latest ordered attempt");
  }
  if (allocation.stop !== null) {
    requireUtcInstant(allocation.stop.stoppedAt, "stop.stoppedAt");
    requireRevision(allocation.stop.stoppedFromRevision);
    if (
      allocation.lifecycleState !== "ended" ||
      hasAssignment ||
      allocation.cleanup.phase !== "settled" ||
      allocation.cleanup.terminalEvidence?.source !== "allocation-never-returned" ||
      allocation.cleanup.terminalEvidence.concludedAt !== allocation.stop.stoppedAt ||
      allocation.stop.stoppedAt !== allocation.updatedAt ||
      allocation.attempts.some(
        (attempt) => attempt.outcome !== "unavailable" || attempt.reservation.state === "held",
      ) ||
      (allocation.stop.reason !== "save-money" &&
        allocation.stop.reason !== "all-providers-unavailable") ||
      (allocation.stop.reason === "save-money" &&
        (allocation.acceptance.request.backupChoice !== "Save money" ||
          allocation.attempts.length !== 1)) ||
      (allocation.stop.reason === "all-providers-unavailable" &&
        (allocation.acceptance.request.backupChoice !== "Keep going" ||
          allocation.attempts.length !== 2))
    ) {
      throw corrupt("allocation stop evidence disagrees with ordered attempt history");
    }
  }
  if (allocation.abandonment !== null) {
    requireUtcInstant(allocation.abandonment.abandonedAt, "abandonment.abandonedAt");
    requireRevision(allocation.abandonment.abandonedFromRevision);
    const earliestAbandonment = new Date(
      Date.parse(allocation.createdAt) + UNASSIGNED_ABANDONMENT_MINUTES * 60_000,
    ).toISOString();
    if (
      allocation.abandonment.reason !== "controller-progress-timeout" ||
      allocation.abandonment.abandonedAt < earliestAbandonment ||
      allocation.abandonment.abandonedAt !== allocation.updatedAt ||
      allocation.lifecycleState !== "ended" ||
      hasAssignment ||
      allocation.stop !== null ||
      allocation.cleanup.phase !== "settled" ||
      allocation.cleanup.terminalEvidence?.source !== "allocation-never-returned" ||
      allocation.cleanup.terminalEvidence.conclusion !== "never_started" ||
      allocation.cleanup.terminalEvidence.concludedAt !== allocation.abandonment.abandonedAt ||
      !allocation.cleanup.providerResourcesSettled ||
      !allocation.cleanup.runnerRegistrationSettled ||
      allocation.cleanup.settledAt !== allocation.abandonment.abandonedAt ||
      allocation.attempts.some(
        (attempt) =>
          attempt.outcome !== "unavailable" ||
          attempt.reservation.state === "held" ||
          attempt.cleanup.phase !== "settled" ||
          !attempt.cleanup.providerResourcesSettled ||
          !attempt.cleanup.runnerRegistrationSettled,
      )
    ) {
      throw corrupt("allocation abandonment evidence disagrees with provider state");
    }
  }
  if (
    allocation.abandonment === null &&
    allocation.stop === null &&
    allocation.lifecycleState === "ended" &&
    (allocation.cleanup.phase !== "settled" ||
      (hasAssignment
        ? latestAttempt?.reservation.settlementKind !== "terminal"
        : latestAttempt?.reservation.settlementKind !== "aborted"))
  ) {
    throw corrupt("terminal allocation lacks assignment and settled provider evidence");
  }
  const checkRunLifecycle = allocation.checkRunCreation.delivery.lifecycle;
  if (checkRunLifecycle.phase === "concluded" && allocation.lifecycleState !== "ended") {
    throw corrupt("lifecycle Check Run concluded before the allocation ended");
  }
}

function validateAcceptanceEvidence(
  value: AllocationAcceptanceEvidence,
): AllocationAcceptanceEvidence {
  if (typeof value !== "object" || value === null) {
    throw invalid("acceptance evidence must be an object");
  }
  const trust = parseVerifiedWorkloadTrust(value.trust);
  const request = {
    backupChoice: parseBackupChoice(value.request.backupChoice, "evidence.request.backupChoice"),
    profile: parseCapabilityProfile(value.request.profile, "evidence.request.profile"),
  };
  if (
    request.backupChoice !== trust.workload.backupChoice ||
    request.profile !== trust.workload.profile
  ) {
    throw invalid("verified request evidence disagrees with trusted workload mapping");
  }
  return { request, trust };
}

function validateNextAttempt(
  allocation: AllocationRecord,
  request: ReserveProviderAttemptRequest,
): void {
  requireAllocationId(request.allocationId);
  requireRevision(request.expectedAllocationRevision);
  requirePositiveSafeInteger(request.ordinal, "ordinal");
  if (request.allocationId !== allocation.allocationId) {
    throw invalid("allocationId does not match the loaded allocation");
  }
  if (allocation.runnerAssignment !== null || allocation.lifecycleState === "ended") {
    throw precondition("an assigned or ended allocation cannot start another provider attempt");
  }
  if (allocation.checkRunCreation.delivery.lifecycle.phase !== "in-progress") {
    throw precondition("the lifecycle Check Run must be durably created before reservation");
  }
  if (request.ordinal !== allocation.attempts.length + 1) {
    throw precondition("provider attempts require consecutive positive ordinals");
  }
  if (request.ordinal === 1) {
    if (request.provider !== "azure") {
      throw precondition("provider attempt 1 must be Azure");
    }
    return;
  }
  if (request.ordinal !== 2 || request.provider !== "blacksmith") {
    throw precondition("the only fallback transition is Blacksmith attempt 2");
  }
  const azure = allocation.attempts[0];
  if (
    allocation.acceptance.request.backupChoice !== "Keep going" ||
    azure?.provider !== "azure" ||
    azure.ordinal !== 1 ||
    azure.outcome !== "unavailable" ||
    azure.reservation.state === "held" ||
    azure.cleanup.phase !== "settled"
  ) {
    throw precondition("Blacksmith attempt 2 requires safely settled unavailable Azure attempt 1");
  }
}

function validateAttemptDeadlines(
  value: AzureAttemptDeadlines | null,
  provider: ProviderName,
  allocationCreatedAt: string,
  attemptedAt: string,
  profile: CapabilityProfile,
  timeoutMinutes: number,
): AzureAttemptDeadlines | null {
  parseCapabilityProfile(profile, "profile");
  if (provider === "blacksmith") {
    if (value !== null) {
      throw invalid("Blacksmith attempts cannot contain Azure deadlines");
    }
    return null;
  }
  if (value === null) {
    throw invalid("Azure attempt 1 requires immutable compute and deletion deadlines");
  }
  const latestSafeStart = requireUtcInstant(value.latestSafeStart, "deadlines.latestSafeStart");
  const computeDeadline = requireUtcInstant(value.computeDeadline, "deadlines.computeDeadline");
  const absoluteExpiry = requireUtcInstant(value.absoluteExpiry, "deadlines.absoluteExpiry");
  if (
    attemptedAt > latestSafeStart ||
    latestSafeStart >= computeDeadline ||
    computeDeadline >= absoluteExpiry
  ) {
    throw invalid("Azure deadlines do not preserve the safe attempt, compute and expiry order");
  }
  const expectedLatest =
    Date.parse(computeDeadline) - (timeoutMinutes + AZURE_PROVIDER_STOP_MARGIN_MINUTES) * 60_000;
  const allocationCreatedAtMilliseconds = Date.parse(
    requireUtcInstant(allocationCreatedAt, "allocationCreatedAt"),
  );
  if (
    Date.parse(computeDeadline) !==
      allocationCreatedAtMilliseconds + AZURE_COMPUTE_LIFETIME_MINUTES * 60_000 ||
    Date.parse(absoluteExpiry) !==
      allocationCreatedAtMilliseconds + AZURE_ALLOCATION_LIFETIME_MINUTES * 60_000 ||
    Date.parse(latestSafeStart) !== expectedLatest
  ) {
    throw invalid(
      "Azure deadlines must be exactly +40m compute and +45m deletion from allocation acceptance, with the mapped timeout plus stop margin",
    );
  }
  return { absoluteExpiry, computeDeadline, latestSafeStart };
}

function validateSettleUnavailableRequest(request: SettleUnavailableProviderAttemptRequest): void {
  requireAllocationId(request.allocationId);
  requireRevision(request.expectedAllocationRevision);
  requireRevision(request.expectedAttemptRevision);
  if (
    request.classification !== "zones-exhausted" &&
    request.classification !== "management-plane-provisioning" &&
    request.classification !== "readiness-timeout"
  ) {
    throw invalid("classification is not a fallback-eligible Azure unavailable outcome");
  }
}

function validateRunnerAssignment(
  value: RunnerAssignment,
  allocation: AllocationRecord,
): RunnerAssignment {
  const assignedAt = requireUtcInstant(value.assignedAt, "assignment.assignedAt");
  const runnerLabel = requireRunnerLabel(value.runnerLabel);
  if (value.provider === "azure") {
    if (
      value.attemptOrdinal !== 1 ||
      value.generationNumber !== 1 ||
      value.runnerIdle !== true ||
      value.runnerOnline !== true ||
      runnerLabel !== azureRunnerLabelForAllocation(allocation.allocationId)
    ) {
      throw invalid(
        "Azure assignment must use attempt 1, generation 1 and its exact unique allocation label",
      );
    }
    return {
      assignedAt,
      attemptOrdinal: 1,
      generationNumber: 1,
      provider: "azure",
      readinessCheckedAt: requireUtcInstant(
        value.readinessCheckedAt,
        "assignment.readinessCheckedAt",
      ),
      runnerIdle: true,
      runnerLabel,
      runnerRegistrationId: requirePositiveDecimalString(
        value.runnerRegistrationId,
        "assignment.runnerRegistrationId",
      ),
      runnerOnline: true,
    };
  }
  if (
    value.provider !== "blacksmith" ||
    value.attemptOrdinal !== 2 ||
    runnerLabel !== allocation.acceptance.trust.workload.blacksmithRunnerLabel
  ) {
    throw invalid("Blacksmith assignment must use attempt 2 and the exact approved managed label");
  }
  return { assignedAt, attemptOrdinal: 2, provider: "blacksmith", runnerLabel };
}

function validatePersistedRunnerAssignment(
  assignment: RunnerAssignment,
  allocation: AllocationRecord,
): void {
  const attempt = allocation.attempts[assignment.attemptOrdinal - 1];
  if (
    attempt?.provider !== assignment.provider ||
    attempt.outcome !== "succeeded" ||
    attempt.succeededAt === null ||
    assignment.assignedAt < attempt.succeededAt ||
    assignment.assignedAt > allocation.updatedAt
  ) {
    throw corrupt("runner assignment disagrees with its successful provider attempt");
  }
  if (assignment.provider === "blacksmith") return;
  const generation = attempt.physicalGenerations[0];
  const generationStateMatchesLifecycle =
    (allocation.lifecycleState === "assigned" && generation?.state === "ready") ||
    ((allocation.lifecycleState === "cleanup_pending" || allocation.lifecycleState === "ended") &&
      generation !== undefined &&
      ["ready", "fenced", "cleanup_pending", "settled"].includes(generation.state));
  if (
    attempt.deadlines === null ||
    attempt.physicalGenerations.length !== 1 ||
    generation?.generationNumber !== 1 ||
    !generationStateMatchesLifecycle ||
    generation.runnerReadiness === null ||
    generation.runnerRegistrationId !== assignment.runnerRegistrationId ||
    assignment.readinessCheckedAt <= attempt.succeededAt ||
    assignment.readinessCheckedAt <= generation.runnerReadiness.checkedAt ||
    assignment.readinessCheckedAt > assignment.assignedAt ||
    assignment.assignedAt > attempt.deadlines.latestSafeStart
  ) {
    throw corrupt(
      "Azure assignment lacks a fresh exact online-idle repair check within its safety window",
    );
  }
}

function validateAllocationCleanup(
  value: AllocationCleanupState,
  current: AllocationCleanupState,
): AllocationCleanupState {
  if (cleanupRank(value.phase) < cleanupRank(current.phase)) {
    throw precondition("allocation cleanup phase cannot move backwards");
  }
  if (
    (current.runnerRegistrationSettled && !value.runnerRegistrationSettled) ||
    (current.providerResourcesSettled && !value.providerResourcesSettled)
  ) {
    throw precondition("settled allocation cleanup evidence cannot be cleared");
  }
  const terminalEvidence = value.terminalEvidence
    ? validateTerminalEvidence(value.terminalEvidence)
    : null;
  if (current.terminalEvidence !== null && !equal(current.terminalEvidence, terminalEvidence)) {
    throw precondition("terminal evidence is immutable once recorded");
  }
  const settledAt = nullableUtcInstant(value.settledAt, "cleanup.settledAt");
  if (
    value.phase === "settled" &&
    (terminalEvidence === null ||
      !value.runnerRegistrationSettled ||
      !value.providerResourcesSettled ||
      settledAt === null)
  ) {
    throw precondition("settled cleanup requires terminal evidence and all owned cleanup");
  }
  if (value.phase !== "settled" && settledAt !== null) {
    throw precondition("cleanup settledAt is valid only for settled cleanup");
  }
  return {
    phase: value.phase,
    providerResourcesSettled: requireBoolean(
      value.providerResourcesSettled,
      "cleanup.providerResourcesSettled",
    ),
    runnerRegistrationSettled: requireBoolean(
      value.runnerRegistrationSettled,
      "cleanup.runnerRegistrationSettled",
    ),
    settledAt,
    terminalEvidence,
  };
}

function validateAttemptCleanup(
  value: AttemptCleanupState,
  current: AttemptCleanupState,
): AttemptCleanupState {
  if (cleanupRank(value.phase) < cleanupRank(current.phase)) {
    throw precondition("provider-attempt cleanup phase cannot move backwards");
  }
  if (
    (current.providerResourcesSettled && !value.providerResourcesSettled) ||
    (current.runnerRegistrationSettled && !value.runnerRegistrationSettled)
  ) {
    throw precondition("settled provider-attempt cleanup evidence cannot be cleared");
  }
  const settledAt = nullableUtcInstant(value.settledAt, "attempt.cleanup.settledAt");
  if (
    value.phase === "settled" &&
    (!value.providerResourcesSettled || !value.runnerRegistrationSettled || settledAt === null)
  ) {
    throw precondition("settled provider-attempt cleanup requires complete safety evidence");
  }
  if (value.phase !== "settled" && settledAt !== null) {
    throw precondition("provider-attempt cleanup settledAt requires settled phase");
  }
  return {
    phase: value.phase,
    providerResourcesSettled: requireBoolean(
      value.providerResourcesSettled,
      "attempt.cleanup.providerResourcesSettled",
    ),
    runnerRegistrationSettled: requireBoolean(
      value.runnerRegistrationSettled,
      "attempt.cleanup.runnerRegistrationSettled",
    ),
    settledAt,
  };
}

function validateGenerationCleanup(
  value: GenerationCleanupState,
  current: GenerationCleanupState,
): GenerationCleanupState {
  if (cleanupRank(value.phase) < cleanupRank(current.phase)) {
    throw precondition("generation cleanup phase cannot move backwards");
  }
  if (
    (current.providerResourcesSettled && !value.providerResourcesSettled) ||
    (current.runnerRegistrationSettled && !value.runnerRegistrationSettled)
  ) {
    throw precondition("settled generation cleanup evidence cannot be cleared");
  }
  const settledAt = nullableUtcInstant(value.settledAt, "generation.cleanup.settledAt");
  const startedAt = nullableUtcInstant(value.startedAt, "generation.cleanup.startedAt");
  if (current.startedAt !== null && current.startedAt !== startedAt) {
    throw precondition("generation cleanup start is immutable once recorded");
  }
  if (
    (value.phase === "not-started" &&
      (startedAt !== null ||
        settledAt !== null ||
        value.providerResourcesSettled ||
        value.runnerRegistrationSettled)) ||
    (value.phase !== "not-started" && startedAt === null) ||
    (value.phase !== "settled" && settledAt !== null) ||
    (value.phase === "settled" &&
      (settledAt === null ||
        !value.providerResourcesSettled ||
        !value.runnerRegistrationSettled ||
        (startedAt !== null && settledAt < startedAt)))
  ) {
    throw precondition("generation cleanup phase and settlement evidence disagree");
  }
  return {
    phase: value.phase,
    providerResourcesSettled: requireBoolean(
      value.providerResourcesSettled,
      "generation.cleanup.providerResourcesSettled",
    ),
    runnerRegistrationSettled: requireBoolean(
      value.runnerRegistrationSettled,
      "generation.cleanup.runnerRegistrationSettled",
    ),
    settledAt,
    startedAt,
  };
}

function validateTerminalEvidence(value: TerminalEvidence): TerminalEvidence {
  const concludedAt = requireUtcInstant(value.concludedAt, "terminalEvidence.concludedAt");
  const conclusion = value.conclusion as TerminalWorkloadConclusion;
  if (!TERMINAL_WORKLOAD_CONCLUSIONS.includes(conclusion)) {
    throw invalid("terminal evidence has an unsupported conclusion");
  }
  if (value.source === "github-job") {
    if (conclusion === "never_started") {
      throw invalid("GitHub job terminal evidence requires a concrete terminal job conclusion");
    }
    return {
      concludedAt,
      conclusion: conclusion as Exclude<TerminalWorkloadConclusion, "never_started">,
      githubJobId: requirePositiveDecimalString(value.githubJobId, "terminalEvidence.githubJobId"),
      source: "github-job",
    };
  }
  if (value.source === "github-workflow-run") {
    if (conclusion === "never_started") {
      throw invalid("GitHub workflow terminal evidence requires a terminal run conclusion");
    }
    return {
      concludedAt,
      conclusion: conclusion as Exclude<TerminalWorkloadConclusion, "never_started">,
      repositoryId: requirePositiveDecimalString(
        value.repositoryId,
        "terminalEvidence.repositoryId",
      ),
      runAttempt: requirePositiveSafeInteger(value.runAttempt, "terminalEvidence.runAttempt"),
      runId: requirePositiveDecimalString(value.runId, "terminalEvidence.runId"),
      source: "github-workflow-run",
    };
  }
  if (value.source !== "allocation-never-returned" || value.conclusion !== "never_started") {
    throw invalid("terminal evidence has an unsupported source or conclusion");
  }
  return { concludedAt, conclusion: "never_started", source: "allocation-never-returned" };
}

function validateTerminalEvidenceBinding(
  evidence: TerminalEvidence | null,
  identity: AllocationIdentity,
  workloadBinding: WorkloadBindingState,
  allowAllocationNeverReturned = false,
): void {
  if (evidence === null) {
    return;
  }
  if (evidence.source === "allocation-never-returned") {
    if (!allowAllocationNeverReturned) {
      throw precondition("allocation-never-returned evidence is reserved for an unassigned stop");
    }
    return;
  }
  if (evidence.source === "github-job") {
    if (workloadBinding.state !== "bound" || workloadBinding.githubJobId !== evidence.githubJobId) {
      throw precondition(
        "GitHub job terminal evidence requires the identical durably bound workload job ID",
      );
    }
    return;
  }
  if (
    evidence.repositoryId !== identity.repository_id ||
    evidence.runId !== identity.run_id ||
    evidence.runAttempt !== identity.run_attempt
  ) {
    throw precondition("GitHub workflow terminal evidence does not match allocation identity");
  }
}

function validateWorkloadBinding(
  value: WorkloadBindingState,
  current: WorkloadBindingState,
): WorkloadBindingState {
  if (current.state === "bound" || current.state === "binding-failed") {
    if (!equal(value, current)) {
      throw precondition("a final workload binding result is immutable");
    }
    return current;
  }
  if (
    value.state === "not-assigned" ||
    value.state === "authorised" ||
    value.state === "awaiting-correlation"
  ) {
    if (value.state !== current.state) {
      throw precondition("workload binding cannot return to a different pre-binding state");
    }
    return value;
  }
  if (current.state !== "awaiting-correlation" && current.state !== "authorised") {
    throw precondition("only an assigned workload can record job correlation");
  }
  if (value.state === "bound") {
    return {
      state: "bound",
      githubJobId: requirePositiveDecimalString(value.githubJobId, "workloadBinding.githubJobId"),
    };
  }
  if (
    (current.state !== "awaiting-correlation" && current.state !== "authorised") ||
    (value.reason !== "expected-job-missing" &&
      value.reason !== "different-job" &&
      value.reason !== "ambiguous-job")
  ) {
    throw invalid("binding failure reason is not recognised");
  }
  return value;
}

function validateCheckRunDelivery(
  value: CheckRunDeliveryRecord,
  current: CheckRunDeliveryRecord,
  allocation: AllocationRecord,
): CheckRunDeliveryRecord {
  let parsed: CheckRunDeliveryRecord;
  try {
    parsed = validateCheckRunDeliveryTransition(current, value);
  } catch (error) {
    throw precondition("Check Run delivery transition is not authoritative", error);
  }
  if (
    parsed.lifecycle.allocationId !== allocation.allocationId ||
    parsed.lifecycle.headSha !== allocation.acceptance.trust.workflow.commitSha
  ) {
    throw precondition("Check Run delivery does not belong to this allocation and commit");
  }
  if (current.lifecycle.phase === "not-created" && parsed.lifecycle.phase !== "not-created") {
    throw precondition("Check Run creation must be persisted through the lease coordinator");
  }
  if (
    current.lifecycle.phase !== "not-created" &&
    (parsed.lifecycle.phase === "not-created" ||
      parsed.lifecycle.checkRunId !== current.lifecycle.checkRunId)
  ) {
    throw precondition("persisted lifecycle Check Run identity is immutable");
  }
  return parsed;
}

function validateSchedule(
  value: GenerationScheduleOperation | null,
  current: GenerationScheduleOperation | null,
  computeDeadline: string,
  generationCreatedAt: string,
  vmResourceIdValue: string | null,
): GenerationScheduleOperation | null {
  if (value === null) {
    if (current !== null) {
      throw precondition("schedule-operation evidence cannot be removed");
    }
    return null;
  }
  const requestedDeadline = requireUtcInstant(
    value.requestedDeadline,
    "schedule.requestedDeadline",
  );
  if (requestedDeadline !== computeDeadline) {
    throw precondition("each generation schedule must use the original compute deadline");
  }
  const requestCorrelationId = requireNonEmpty(
    value.requestCorrelationId,
    "schedule.requestCorrelationId",
  );
  const providerOperationId =
    value.providerOperationId === null
      ? null
      : requireNonEmpty(value.providerOperationId, "schedule.providerOperationId");
  const targetVmResourceId = requireAzureResourceId(
    value.targetVmResourceId,
    "schedule.targetVmResourceId",
  );
  const vmResourceId =
    vmResourceIdValue === null ? null : requireAzureResourceId(vmResourceIdValue, "vmResourceId");
  if (value.deadlineType !== "CompleteBy" || targetVmResourceId !== vmResourceId) {
    throw precondition(
      "Compute Schedule must use CompleteBy and target the generation's exact VM resource ID",
    );
  }
  if (
    current !== null &&
    (current.requestCorrelationId !== requestCorrelationId ||
      current.requestedDeadline !== requestedDeadline ||
      current.targetVmResourceId !== targetVmResourceId)
  ) {
    throw precondition("schedule operation identity and requested deadline are immutable");
  }
  if (
    current !== null &&
    current.providerOperationId !== null &&
    current.providerOperationId !== providerOperationId
  ) {
    throw precondition("the Azure provider schedule operation ID is immutable after adoption");
  }
  if (current !== null && current.providerOperationId !== null && providerOperationId === null) {
    throw precondition("the Azure provider schedule operation ID cannot be removed");
  }
  const acceptedAt = nullableUtcInstant(value.acceptedAt, "schedule.acceptedAt");
  if (current?.acceptedAt != null && current.acceptedAt !== acceptedAt) {
    throw precondition("schedule acceptance evidence is immutable");
  }
  if ((value.status === "accepted" || value.status === "executed") && acceptedAt === null) {
    throw precondition("an accepted or executed schedule requires acceptance evidence");
  }
  if ((value.status === "requested" || value.status === "rejected") && acceptedAt !== null) {
    throw precondition("a non-accepted schedule cannot contain acceptance evidence");
  }
  if (value.status !== "requested" && providerOperationId === null) {
    throw precondition("a provider schedule result requires its Azure operation ID");
  }
  if (
    !(["requested", "accepted", "executed", "rejected", "failed"] as const).includes(value.status)
  ) {
    throw invalid("schedule status is not recognised");
  }
  const lastCheckedAt = requireUtcInstant(value.lastCheckedAt, "schedule.lastCheckedAt");
  if (
    lastCheckedAt < generationCreatedAt ||
    (current !== null && lastCheckedAt < current.lastCheckedAt)
  ) {
    throw precondition("schedule lastCheckedAt cannot move backwards");
  }
  if (acceptedAt !== null && acceptedAt > lastCheckedAt) {
    throw precondition("schedule acceptedAt cannot be later than lastCheckedAt");
  }
  if (acceptedAt !== null && acceptedAt < generationCreatedAt) {
    throw precondition("schedule acceptedAt cannot predate its physical generation");
  }
  if (current !== null && !scheduleTransitionAllowed(current.status, value.status)) {
    throw precondition("schedule status cannot leave its terminal safety result");
  }
  return {
    acceptedAt,
    deadlineType: "CompleteBy",
    lastCheckedAt,
    providerOperationId,
    requestCorrelationId,
    requestedDeadline,
    status: value.status,
    targetVmResourceId,
  };
}

function validateZoneDeployments(
  value: readonly GenerationZoneDeployment[],
  current: readonly GenerationZoneDeployment[],
  generationCreatedAt: string,
  updatedAt: string,
  resourceGroupId: string,
  subscriptionId: string,
): readonly GenerationZoneDeployment[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > AZURE_PILOT_ZONES.length) {
    throw precondition("a physical generation requires one to three ordered UK South zone tries");
  }
  if (value.length < current.length || value.length > current.length + 1) {
    throw precondition("zone deployment history is append-only and progresses one zone at a time");
  }
  const parsed = value.map((entry, index): GenerationZoneDeployment => {
    const requestedAt = requireUtcInstant(
      entry.requestedAt,
      `zoneDeployments[${index}].requestedAt`,
    );
    const completedAt = nullableUtcInstant(
      entry.completedAt,
      `zoneDeployments[${index}].completedAt`,
    );
    const vmAbsenceVerifiedAt = nullableUtcInstant(
      entry.vmAbsenceVerifiedAt,
      `zoneDeployments[${index}].vmAbsenceVerifiedAt`,
    );
    const residualResourcesSettledAt = nullableUtcInstant(
      entry.residualResourcesSettledAt,
      `zoneDeployments[${index}].residualResourcesSettledAt`,
    );
    const vmResourceId =
      entry.vmResourceId === null
        ? null
        : requireAzureResourceId(entry.vmResourceId, `zoneDeployments[${index}].vmResourceId`);
    const childDeploymentId = requireAzureResourceId(
      entry.childDeploymentId,
      `zoneDeployments[${index}].childDeploymentId`,
    );
    const childDeploymentName = childDeploymentId.split("/").at(-1);
    if (
      childDeploymentName === undefined ||
      requireExactAzureDeploymentId(childDeploymentId, resourceGroupId, childDeploymentName) !==
        childDeploymentId ||
      (current[0] !== undefined && childDeploymentId !== current[0].childDeploymentId)
    ) {
      throw precondition("all zone tries must bind the exact immutable child deployment");
    }
    if (entry.availabilityZone !== AZURE_PILOT_ZONES[index]) {
      throw precondition("Azure zones must be tried once in fixed order 1, 2, 3");
    }
    if (requestedAt < generationCreatedAt || requestedAt > updatedAt) {
      throw precondition("zone deployment request must fall within generation timestamps");
    }
    if (entry.outcome === "pending") {
      if (
        completedAt !== null ||
        residualResourcesSettledAt !== null ||
        vmAbsenceVerifiedAt !== null ||
        vmResourceId !== null
      ) {
        throw precondition("a pending zone deployment cannot claim completion or VM evidence");
      }
    } else if (
      entry.outcome === "no-vm-created" ||
      entry.outcome === "management-plane-unavailable"
    ) {
      if (
        completedAt === null ||
        residualResourcesSettledAt === null ||
        vmAbsenceVerifiedAt === null ||
        vmResourceId !== null ||
        vmAbsenceVerifiedAt < completedAt ||
        residualResourcesSettledAt < vmAbsenceVerifiedAt ||
        residualResourcesSettledAt > updatedAt ||
        vmAbsenceVerifiedAt > updatedAt
      ) {
        throw precondition(
          "provider unavailability requires durable proof that no VM or residual resource exists",
        );
      }
    } else if (entry.outcome === "vm-created") {
      if (
        completedAt === null ||
        residualResourcesSettledAt !== null ||
        vmResourceId === null ||
        vmAbsenceVerifiedAt !== null
      ) {
        throw precondition("a successful zone deployment requires its exact VM resource ID");
      }
    } else {
      throw invalid("zone deployment outcome is not recognised");
    }
    if (completedAt !== null && (completedAt < requestedAt || completedAt > updatedAt)) {
      throw precondition("zone deployment completion must follow its request within update time");
    }
    return {
      availabilityZone: requireAzurePilotZone(entry.availabilityZone),
      childDeploymentId,
      completedAt,
      deploymentId: requireExactSubscriptionDeploymentId(
        entry.deploymentId,
        subscriptionId,
        entry.deploymentName,
      ),
      deploymentName: requireAzureResourceName(entry.deploymentName, "deploymentName"),
      outcome: entry.outcome,
      requestedAt,
      residualResourcesSettledAt,
      vmAbsenceVerifiedAt,
      vmResourceId,
    };
  });
  for (const [index, prior] of current.entries()) {
    const next = parsed[index];
    if (next === undefined) throw precondition("zone deployment history cannot be removed");
    if (prior.outcome !== "pending" && !equal(prior, next)) {
      throw precondition("completed zone deployment evidence is immutable");
    }
    if (
      prior.outcome === "pending" &&
      (prior.availabilityZone !== next.availabilityZone ||
        prior.childDeploymentId !== next.childDeploymentId ||
        prior.deploymentId !== next.deploymentId ||
        prior.deploymentName !== next.deploymentName ||
        prior.requestedAt !== next.requestedAt)
    ) {
      throw precondition("zone deployment identity is immutable");
    }
  }
  if (parsed.length > current.length) {
    const previous = parsed.at(-2);
    if (previous?.outcome !== "no-vm-created" || previous.vmAbsenceVerifiedAt === null) {
      throw precondition("the next fixed zone may start only after verified no-VM evidence");
    }
  }
  const vmCreated = parsed.filter((entry) => entry.outcome === "vm-created");
  if (vmCreated.length > 1 || (vmCreated.length === 1 && parsed.at(-1) !== vmCreated[0])) {
    throw precondition("zone progression stops permanently once any VM exists");
  }
  return parsed;
}

function validateLaunchPrerequisites(
  value: GenerationLaunchPrerequisites | null,
  current: GenerationLaunchPrerequisites | null,
  generationCreatedAt: string,
  updatedAt: string,
): GenerationLaunchPrerequisites | null {
  if (value === null) {
    if (current !== null) throw precondition("launch prerequisite evidence cannot be removed");
    return null;
  }
  const checkedAt = requireUtcInstant(value.checkedAt, "launchPrerequisites.checkedAt");
  if (
    value.bootstrapSucceeded !== true ||
    value.localNvmeMounted !== true ||
    value.dockerHealthy !== true ||
    checkedAt < generationCreatedAt ||
    checkedAt > updatedAt
  ) {
    throw precondition("launch requires checked bootstrap, local NVMe and Docker health evidence");
  }
  const parsed: GenerationLaunchPrerequisites = {
    bootstrapSucceeded: true,
    checkedAt,
    dockerHealthy: true,
    localNvmeMounted: true,
  };
  if (current !== null && !equal(current, parsed)) {
    throw precondition("launch prerequisite evidence is immutable");
  }
  return parsed;
}

function validateJitMintIntent(
  value: GenerationJitMintIntent | null,
  current: GenerationJitMintIntent | null,
  schedule: GenerationScheduleOperation | null,
  prerequisites: GenerationLaunchPrerequisites | null,
  resourceGroupId: string,
  generationCreatedAt: string,
  updatedAt: string,
): GenerationJitMintIntent | null {
  if (value === null) {
    if (current !== null) throw precondition("JIT mint intent cannot be removed");
    return null;
  }
  if (
    prerequisites === null ||
    (schedule?.status !== "accepted" && !(schedule?.status === "executed" && current !== null))
  ) {
    throw precondition("JIT mint intent requires an accepted schedule and prepared VM");
  }
  const requestedAt = requireUtcInstant(value.requestedAt, "jitMintIntent.requestedAt");
  if (
    requestedAt < generationCreatedAt ||
    requestedAt < prerequisites.checkedAt ||
    requestedAt < (schedule.acceptedAt ?? "") ||
    requestedAt > updatedAt
  ) {
    throw precondition("JIT mint intent timestamp is outside its protected generation interval");
  }
  const intentId = requireNonEmpty(value.intentId, "jitMintIntent.intentId");
  if (!/^sy-[a-f0-9]{24}-g1-jit-mint$/.test(intentId)) {
    throw precondition("JIT mint intent ID is not the deterministic generation-one identity");
  }
  const jitDeploymentName = intentId.slice(0, -"-mint".length);
  const jitDeploymentId = requireAzureResourceId(value.jitDeploymentId, "jitDeploymentId");
  if (
    jitDeploymentId !==
    `${resourceGroupId}/providers/Microsoft.Resources/deployments/${jitDeploymentName}`
  ) {
    throw precondition("JIT mint intent must bind the exact deterministic JIT deployment");
  }
  const parsed: GenerationJitMintIntent = { intentId, jitDeploymentId, requestedAt };
  if (current !== null && !equal(current, parsed)) {
    throw precondition("JIT mint intent is immutable and one-shot");
  }
  return parsed;
}

function validateGenerationOperationLease(
  value: GenerationOperationLease | null,
  current: GenerationOperationLease | null,
  generationCreatedAt: string,
  updatedAt: string,
): GenerationOperationLease | null {
  if (value === null) return null;
  const acquiredAt = requireUtcInstant(value.acquiredAt, "operationLease.acquiredAt");
  const expiresAt = requireUtcInstant(value.expiresAt, "operationLease.expiresAt");
  if (
    acquiredAt < generationCreatedAt ||
    acquiredAt > updatedAt ||
    expiresAt <= acquiredAt ||
    Date.parse(expiresAt) - Date.parse(acquiredAt) > 120_000
  ) {
    throw precondition("provider operation lease must be a bounded two-minute generation lease");
  }
  if (
    !(
      ["base-deployment", "schedule-submit", "jit-mint-launch", "run-command-delete"] as const
    ).includes(value.kind)
  ) {
    throw invalid("provider operation lease kind is not recognised");
  }
  const leaseId = requireNonEmpty(value.leaseId, "operationLease.leaseId");
  if (!/^[a-f0-9-]{36}$/.test(leaseId)) {
    throw invalid("provider operation lease ID must be a canonical UUID");
  }
  const parsed = { acquiredAt, expiresAt, kind: value.kind, leaseId };
  if (current !== null && !equal(current, parsed)) {
    throw precondition("provider operation lease is immutable until explicitly released");
  }
  return parsed;
}

function validateManagedRunCommand(
  value: GenerationManagedRunCommand | null,
  current: GenerationManagedRunCommand | null,
  vmResourceId: string | null,
  schedule: GenerationScheduleOperation | null,
  prerequisites: GenerationLaunchPrerequisites | null,
  generationCreatedAt: string,
  updatedAt: string,
): GenerationManagedRunCommand | null {
  if (value === null) {
    if (current !== null) throw precondition("Managed Run Command evidence cannot be removed");
    return null;
  }
  if (
    vmResourceId === null ||
    (schedule?.status !== "accepted" && !(schedule?.status === "executed" && current !== null)) ||
    schedule.targetVmResourceId !== vmResourceId ||
    prerequisites === null
  ) {
    throw precondition(
      "JIT launch cannot start before exact schedule acceptance and all launch prerequisites",
    );
  }
  const requestedAt = requireUtcInstant(value.requestedAt, "managedRunCommand.requestedAt");
  const launchConfirmedAt = nullableUtcInstant(
    value.launchConfirmedAt,
    "managedRunCommand.launchConfirmedAt",
  );
  const deleteRequestedAt = nullableUtcInstant(
    value.deleteRequestedAt,
    "managedRunCommand.deleteRequestedAt",
  );
  const deleteCompletedAt = nullableUtcInstant(
    value.deleteCompletedAt,
    "managedRunCommand.deleteCompletedAt",
  );
  const boundVmResourceId = requireAzureResourceId(
    value.boundVmResourceId,
    "managedRunCommand.boundVmResourceId",
  );
  if (
    boundVmResourceId !== vmResourceId ||
    requestedAt < prerequisites.checkedAt ||
    requestedAt < (schedule.acceptedAt ?? "") ||
    requestedAt < generationCreatedAt ||
    requestedAt > updatedAt
  ) {
    throw precondition("Managed Run Command must bind the exact protected and prepared VM");
  }
  if (
    (launchConfirmedAt !== null && launchConfirmedAt < requestedAt) ||
    (deleteRequestedAt !== null &&
      (launchConfirmedAt === null || deleteRequestedAt < launchConfirmedAt)) ||
    (deleteCompletedAt !== null &&
      (deleteRequestedAt === null || deleteCompletedAt < deleteRequestedAt)) ||
    [launchConfirmedAt, deleteRequestedAt, deleteCompletedAt].some(
      (instant) => instant !== null && instant > updatedAt,
    )
  ) {
    throw precondition("Managed Run Command launch and deletion evidence is out of order");
  }
  const parsed: GenerationManagedRunCommand = {
    boundVmResourceId,
    deleteCompletedAt,
    deleteRequestedAt,
    launchConfirmedAt,
    managedRunCommandId: requireExactManagedRunCommandId(value.managedRunCommandId, vmResourceId),
    requestedAt,
  };
  if (
    current !== null &&
    (current.boundVmResourceId !== parsed.boundVmResourceId ||
      current.managedRunCommandId !== parsed.managedRunCommandId ||
      current.requestedAt !== parsed.requestedAt ||
      (current.launchConfirmedAt !== null && current.launchConfirmedAt !== launchConfirmedAt) ||
      (current.deleteRequestedAt !== null && current.deleteRequestedAt !== deleteRequestedAt) ||
      (current.deleteCompletedAt !== null && current.deleteCompletedAt !== deleteCompletedAt))
  ) {
    throw precondition("Managed Run Command identity and completed milestones are immutable");
  }
  return parsed;
}

function validateRunnerReadiness(
  value: GenerationRunnerReadiness | null,
  current: GenerationRunnerReadiness | null,
  managedRunCommand: GenerationManagedRunCommand | null,
  generationCreatedAt: string,
  updatedAt: string,
): GenerationRunnerReadiness | null {
  if (value === null) {
    if (current !== null) throw precondition("runner readiness evidence cannot be removed");
    return null;
  }
  const checkedAt = requireUtcInstant(value.checkedAt, "runnerReadiness.checkedAt");
  if (
    value.online !== true ||
    value.idle !== true ||
    managedRunCommand?.deleteCompletedAt === null ||
    managedRunCommand?.deleteCompletedAt === undefined ||
    checkedAt < managedRunCommand.deleteCompletedAt ||
    checkedAt < generationCreatedAt ||
    checkedAt > updatedAt
  ) {
    throw precondition(
      "runner readiness requires an exact online-idle check after Run Command deletion",
    );
  }
  const parsed: GenerationRunnerReadiness = { checkedAt, idle: true, online: true };
  if (current !== null && !equal(current, parsed)) {
    throw precondition("runner readiness evidence is immutable");
  }
  return parsed;
}

function validateCheckRunKey(value: LifecycleCheckRunKey, expected: LifecycleCheckRunKey): void {
  const parsed: LifecycleCheckRunKey = {
    allocationId: requireAllocationId(value.allocationId),
    appSlug: requireAppSlug(value.appSlug),
    headSha: requireFullCommitSha(value.headSha, "checkRunKey.headSha"),
    repository: {
      name: requireRepositoryPart(value.repository.name, "checkRunKey.repository.name"),
      owner: requireRepositoryPart(value.repository.owner, "checkRunKey.repository.owner"),
    },
  };
  if (!equal(parsed, expected)) {
    throw conflict("Check Run creation key conflicts with immutable allocation evidence");
  }
}

function validateLeaseHolder(
  state: CheckRunCreationState,
  ownerValue: string,
  revisionValue: number,
  completedAt: string,
): void {
  const owner = requireLeaseOwner(ownerValue);
  const revision = requirePositiveSafeInteger(revisionValue, "leaseRevision");
  if (
    state.leaseOwner !== owner ||
    state.leaseRevision !== revision ||
    state.leaseExpiresAt === null ||
    completedAt > state.leaseExpiresAt
  ) {
    throw optimisticConflict("Check Run creation lease is absent, expired or has been replaced");
  }
}

function validatePersistedCheckRunCreation(
  state: CheckRunCreationState,
  allocation: AllocationRecord,
): void {
  validateCheckRunKey(state.key, state.key);
  const delivery = parseCheckRunDeliveryRecord(state.delivery);
  if (
    delivery.lifecycle.allocationId !== allocation.allocationId ||
    delivery.lifecycle.headSha !== allocation.acceptance.trust.workflow.commitSha ||
    !Number.isSafeInteger(state.leaseRevision) ||
    state.leaseRevision < 0
  ) {
    throw corrupt("Check Run creation coordination state is inconsistent");
  }
  if ((state.leaseOwner === null) !== (state.leaseExpiresAt === null)) {
    throw corrupt("Check Run creation lease owner and expiry must be present together");
  }
  if (state.leaseOwner !== null && state.leaseExpiresAt !== null) {
    requireLeaseOwner(state.leaseOwner);
    requireUtcInstant(state.leaseExpiresAt, "checkRunCreation.leaseExpiresAt");
  }
}

function validatePersistedAttempt(
  allocationPrefix: AllocationRecord,
  attempt: ProviderAttempt,
): void {
  const checkRunLifecycle = allocationPrefix.checkRunCreation.delivery.lifecycle;
  if (checkRunLifecycle.phase === "not-created") {
    throw corrupt("provider attempt exists before lifecycle Check Run creation");
  }
  const validationPrefix: AllocationRecord = {
    ...allocationPrefix,
    checkRunCreation: {
      ...allocationPrefix.checkRunCreation,
      delivery: {
        lifecycle: {
          allocationId: checkRunLifecycle.allocationId,
          checkRunId: checkRunLifecycle.checkRunId,
          headSha: checkRunLifecycle.headSha,
          phase: "in-progress",
          publishedRevision: checkRunLifecycle.publishedRevision,
          stage: "accepted",
        },
        retry: null,
      },
    },
    lifecycleState: "accepted",
    runnerAssignment: null,
    updatedAt: attempt.attemptedAt,
  };
  const request: ReserveProviderAttemptRequest = {
    allocationId: validationPrefix.allocationId,
    attemptedAt: attempt.attemptedAt,
    deadlines: attempt.deadlines,
    expectedAllocationRevision: validationPrefix.revision,
    ordinal: attempt.ordinal,
    provider: attempt.provider,
    worstCaseCostUsdCents: attempt.reservation.requestedCostUsdCents,
  };
  const expected = createProviderAttempt(
    validationPrefix,
    request,
    attempt.revision,
    attempt.admission === "capacity-unavailable"
      ? (attempt.unavailable?.classification as "concurrency-limit" | "daily-allowance")
      : undefined,
  );
  requireRevision(attempt.revision);
  requireUtcInstant(attempt.attemptedAt, "attempt.attemptedAt");
  requireUtcInstant(attempt.updatedAt, "attempt.updatedAt");
  if (
    attempt.provider !== expected.provider ||
    attempt.ordinal !== expected.ordinal ||
    attempt.admission !== expected.admission ||
    attempt.updatedAt < attempt.attemptedAt ||
    attempt.physicalGenerations.length > 1
  ) {
    throw corrupt("persisted provider attempt violates ordered immutable evidence");
  }
  const cleanup = validateAttemptCleanup(attempt.cleanup, attempt.cleanup);
  if (attempt.fatalAbortIntent !== null) {
    requireFatalAzureAbortClassification(attempt.fatalAbortIntent.classification);
    const intentAt = requireUtcInstant(
      attempt.fatalAbortIntent.recordedAt,
      "attempt.fatalAbortIntent.recordedAt",
    );
    if (intentAt < attempt.attemptedAt || intentAt > attempt.updatedAt) {
      throw corrupt("fatal abort intent timestamp is outside its durable interval");
    }
  }
  if (
    cleanup.settledAt !== null &&
    (cleanup.settledAt < attempt.attemptedAt || cleanup.settledAt > attempt.updatedAt)
  ) {
    throw corrupt("provider-attempt cleanup timestamp is outside its durable interval");
  }
  validatePersistedReservation(attempt);
  if (
    attempt.admission === "capacity-unavailable" &&
    (attempt.outcome !== "unavailable" ||
      attempt.reservation.state !== "not-held" ||
      cleanup.phase !== "settled" ||
      (attempt.unavailable?.classification !== "concurrency-limit" &&
        attempt.unavailable?.classification !== "daily-allowance"))
  ) {
    throw corrupt("capacity-unavailable attempt incorrectly claims a held reservation");
  }
  if (
    attempt.admission === "reserved" &&
    (attempt.unavailable?.classification === "concurrency-limit" ||
      attempt.unavailable?.classification === "daily-allowance")
  ) {
    throw corrupt("a held attempt cannot retroactively claim an admission refusal");
  }
  if (attempt.outcome === "pending") {
    if (
      attempt.succeededAt !== null ||
      attempt.unavailable !== null ||
      attempt.fatalAbort !== null ||
      attempt.reservation.state !== "held"
    ) {
      throw corrupt("pending provider attempt contains a final outcome");
    }
  } else if (attempt.outcome === "succeeded") {
    const succeededAt = nullableUtcInstant(attempt.succeededAt, "attempt.succeededAt");
    if (
      succeededAt === null ||
      succeededAt < attempt.attemptedAt ||
      succeededAt > attempt.updatedAt ||
      attempt.unavailable !== null ||
      attempt.fatalAbort !== null ||
      attempt.admission !== "reserved" ||
      attempt.reservation.state === "not-held"
    ) {
      throw corrupt("successful provider attempt has inconsistent durable evidence");
    }
  } else if (attempt.outcome === "unavailable") {
    const classification = attempt.unavailable?.classification;
    const recordedAt = nullableUtcInstant(
      attempt.unavailable?.recordedAt ?? null,
      "attempt.unavailable.recordedAt",
    );
    if (
      (attempt.admission === "reserved" &&
        (attempt.provider !== "azure" || attempt.ordinal !== 1)) ||
      (attempt.admission === "capacity-unavailable" &&
        !(
          (attempt.provider === "azure" && attempt.ordinal === 1) ||
          (attempt.provider === "blacksmith" && attempt.ordinal === 2)
        )) ||
      attempt.succeededAt !== null ||
      attempt.fatalAbort !== null ||
      recordedAt === null ||
      recordedAt < attempt.attemptedAt ||
      recordedAt > attempt.updatedAt ||
      !PROVIDER_UNAVAILABLE_CLASSIFICATIONS.includes(classification as never)
    ) {
      throw corrupt("unavailable provider attempt has inconsistent durable evidence");
    }
    if (
      attempt.admission === "reserved" &&
      (classification === "concurrency-limit" || classification === "daily-allowance")
    ) {
      throw corrupt("held Azure attempt uses an admission-only unavailable classification");
    }
  } else if (attempt.outcome === "aborted") {
    const recordedAt = nullableUtcInstant(
      attempt.fatalAbort?.recordedAt ?? null,
      "attempt.fatalAbort.recordedAt",
    );
    if (
      attempt.provider !== "azure" ||
      attempt.ordinal !== 1 ||
      attempt.admission !== "reserved" ||
      attempt.unavailable !== null ||
      recordedAt === null ||
      recordedAt > attempt.updatedAt ||
      !FATAL_AZURE_ABORT_CLASSIFICATIONS.includes(
        attempt.fatalAbort?.classification as FatalAzureAbortClassification,
      ) ||
      !equal(attempt.fatalAbort, attempt.fatalAbortIntent) ||
      cleanup.phase !== "settled" ||
      attempt.reservation.state !== "settled"
    ) {
      throw corrupt("fatally aborted Azure attempt has inconsistent durable evidence");
    }
  } else {
    throw corrupt("provider attempt outcome is invalid");
  }
  if (attempt.provider === "blacksmith" && attempt.physicalGenerations.length !== 0) {
    throw corrupt("Blacksmith attempt contains physical generations");
  }
  if (attempt.provider === "blacksmith" && cleanup.phase !== "settled") {
    throw corrupt("Blacksmith attempt incorrectly claims controller-owned resource cleanup");
  }
  if (
    (attempt.reservation.settlementKind === "unavailable" ||
      attempt.reservation.settlementKind === "aborted") &&
    cleanup.settledAt !== attempt.reservation.settledAt
  ) {
    throw corrupt("provider attempt cleanup and reservation settlement timestamps disagree");
  }
  let totalReserved = attempt.reservation.requestedCostUsdCents;
  for (let index = 0; index < attempt.physicalGenerations.length; index += 1) {
    const generation = attempt.physicalGenerations[index];
    if (generation === undefined || generation.generationNumber !== index + 1) {
      throw corrupt("Azure physical generations are not consecutively ordered");
    }
    requireRevision(generation.revision);
    requireUtcInstant(generation.createdAt, "generation.createdAt");
    requireUtcInstant(generation.updatedAt, "generation.updatedAt");
    validatePersistedGeneration(attempt, generation, allocationPrefix.acceptance.request.profile);
    totalReserved += generation.reservedIncrementalCostUsdCents;
  }
  if (
    attempt.admission === "reserved" &&
    attempt.reservation.reservedCostUsdCents !== totalReserved
  ) {
    throw corrupt("provider attempt reservation does not cover its physical generations");
  }
}

function validatePersistedReservation(attempt: ProviderAttempt): void {
  const reservation = attempt.reservation;
  const requested = requirePositiveSafeInteger(
    reservation.requestedCostUsdCents,
    "attempt.reservation.requestedCostUsdCents",
  );
  const reserved = requireNonNegativeSafeInteger(
    reservation.reservedCostUsdCents,
    "attempt.reservation.reservedCostUsdCents",
  );
  requireUtcDay(reservation.utcDay, "attempt.reservation.utcDay");
  if (reservation.utcDay !== attempt.attemptedAt.slice(0, 10)) {
    throw corrupt("provider attempt reservation UTC day disagrees with admission time");
  }
  if (reservation.state === "not-held") {
    if (
      attempt.admission !== "capacity-unavailable" ||
      reserved !== 0 ||
      reservation.finalCostUsdCents !== 0 ||
      reservation.concurrencyReleasedAt !== null ||
      reservation.settledAt !== null ||
      reservation.settledFromRevision !== null ||
      reservation.settlementKind !== null
    ) {
      throw corrupt("non-held provider reservation contains settlement or cost evidence");
    }
    return;
  }
  if (attempt.admission !== "reserved" || reserved < requested) {
    throw corrupt("held provider reservation does not cover its immutable request");
  }
  if (reservation.state === "held") {
    if (
      reservation.finalCostUsdCents !== null ||
      reservation.concurrencyReleasedAt !== null ||
      reservation.settledAt !== null ||
      reservation.settledFromRevision !== null ||
      reservation.settlementKind !== null
    ) {
      throw corrupt("held provider reservation contains settlement evidence");
    }
    return;
  }
  if (reservation.state !== "settled") {
    throw corrupt("provider reservation state is invalid");
  }
  const finalCost = requireNonNegativeSafeInteger(
    reservation.finalCostUsdCents ?? -1,
    "attempt.reservation.finalCostUsdCents",
  );
  const settledAt = nullableUtcInstant(reservation.settledAt, "attempt.reservation.settledAt");
  const releasedAt = nullableUtcInstant(
    reservation.concurrencyReleasedAt,
    "attempt.reservation.concurrencyReleasedAt",
  );
  if (
    finalCost > reserved ||
    settledAt === null ||
    releasedAt !== settledAt ||
    settledAt !== attempt.updatedAt ||
    reservation.settledFromRevision === null ||
    (reservation.settlementKind !== "aborted" &&
      reservation.settlementKind !== "unavailable" &&
      reservation.settlementKind !== "terminal") ||
    (reservation.settlementKind === "aborted" && attempt.outcome !== "aborted") ||
    (reservation.settlementKind === "unavailable" && attempt.outcome !== "unavailable") ||
    (reservation.settlementKind === "terminal" && attempt.outcome !== "succeeded")
  ) {
    throw corrupt("settled provider reservation evidence is inconsistent");
  }
  requireRevision(reservation.settledFromRevision);
}

function validatePersistedGeneration(
  attempt: ProviderAttempt,
  generation: PhysicalGeneration,
  profile: CapabilityProfile,
): void {
  if (attempt.provider !== "azure" || attempt.deadlines === null) {
    throw corrupt("physical generation has no Azure attempt deadline contract");
  }
  if (
    generation.createdAt < attempt.attemptedAt ||
    generation.createdAt > attempt.deadlines.latestSafeStart ||
    generation.updatedAt < generation.createdAt
  ) {
    throw corrupt("physical generation timestamps are outside the Azure attempt window");
  }
  const incremental = requireNonNegativeSafeInteger(
    generation.reservedIncrementalCostUsdCents,
    "generation.reservedIncrementalCostUsdCents",
  );
  if (generation.generationNumber !== 1 || incremental !== 0) {
    throw corrupt("physical generation incremental reservation is inconsistent");
  }
  validateGenerationBasePlan(generation.basePlan);
  const cleanup = validateGenerationCleanup(generation.cleanup, generation.cleanup);
  validateGenerationOperationLease(
    generation.operationLease,
    generation.operationLease,
    generation.createdAt,
    generation.updatedAt,
  );
  if (
    cleanup.startedAt !== null &&
    (cleanup.startedAt < generation.createdAt || cleanup.startedAt > generation.updatedAt)
  ) {
    throw corrupt("physical generation cleanup start is outside its durable interval");
  }
  if (
    cleanup.settledAt !== null &&
    (cleanup.settledAt < generation.createdAt || cleanup.settledAt > generation.updatedAt)
  ) {
    throw corrupt("physical generation cleanup timestamp is outside its durable interval");
  }
  if (
    !(
      ["planned", "provisioning", "ready", "fenced", "cleanup_pending", "settled"] as const
    ).includes(generation.state)
  ) {
    throw corrupt("physical generation state is invalid");
  }
  requireAzurePilotLocation(generation.location);
  requireAzurePilotVmSize(generation.vmSize, profile);
  const resourceGroupId = requireAzureResourceId(
    generation.resourceGroupId,
    "generation.resourceGroupId",
  );
  const resourceGroupName = requireAzureResourceName(
    generation.resourceGroupName,
    "generation.resourceGroupName",
  );
  requireAzureResourceGroupBinding(resourceGroupId, resourceGroupName);
  const vmResourceIdValue = immutableNullableIdentifier(
    null,
    generation.vmResourceId,
    "generation.vmResourceId",
  );
  const vmResourceId =
    vmResourceIdValue === null
      ? null
      : requireAzureVmResourceId(vmResourceIdValue, resourceGroupId);
  const schedule = validateSchedule(
    generation.schedule,
    null,
    attempt.deadlines.computeDeadline,
    generation.createdAt,
    vmResourceId,
  );
  const zoneDeployments = validateZoneDeployments(
    generation.zoneDeployments,
    generation.zoneDeployments,
    generation.createdAt,
    generation.updatedAt,
    resourceGroupId,
    generation.basePlan.subscriptionId,
  );
  immutableNullableIdentifier(null, generation.providerVmId, "generation.providerVmId");
  const runnerRegistrationIdValue = immutableNullableIdentifier(
    null,
    generation.runnerRegistrationId,
    "generation.runnerRegistrationId",
  );
  if (runnerRegistrationIdValue !== null) {
    requirePositiveDecimalString(runnerRegistrationIdValue, "generation.runnerRegistrationId");
  }
  const readyAt = nullableUtcInstant(generation.readyAt, "generation.readyAt");
  const launchPrerequisites = validateLaunchPrerequisites(
    generation.launchPrerequisites,
    generation.launchPrerequisites,
    generation.createdAt,
    generation.updatedAt,
  );
  const jitMintIntent = validateJitMintIntent(
    generation.jitMintIntent,
    generation.jitMintIntent,
    schedule,
    launchPrerequisites,
    resourceGroupId,
    generation.createdAt,
    generation.updatedAt,
  );
  const managedRunCommand = validateManagedRunCommand(
    generation.managedRunCommand,
    generation.managedRunCommand,
    vmResourceId,
    schedule,
    launchPrerequisites,
    generation.createdAt,
    generation.updatedAt,
  );
  if (
    (managedRunCommand !== null || generation.runnerRegistrationId !== null) &&
    jitMintIntent === null
  ) {
    throw corrupt("persisted JIT runner evidence lacks its one-shot mint intent");
  }
  const runnerReadiness = validateRunnerReadiness(
    generation.runnerReadiness,
    generation.runnerReadiness,
    managedRunCommand,
    generation.createdAt,
    generation.updatedAt,
  );
  const vmDeployment = zoneDeployments.find((entry) => entry.outcome === "vm-created");
  if ((vmDeployment?.vmResourceId ?? null) !== vmResourceId) {
    throw corrupt("physical generation VM disagrees with its zone deployment history");
  }
  if (
    generation.state === "ready" &&
    (schedule?.status !== "accepted" ||
      readyAt === null ||
      readyAt > attempt.deadlines.latestSafeStart ||
      (schedule.acceptedAt !== null && readyAt < schedule.acceptedAt) ||
      generation.vmResourceId === null ||
      generation.providerVmId === null ||
      generation.runnerRegistrationId === null ||
      launchPrerequisites === null ||
      managedRunCommand?.deleteCompletedAt === null ||
      runnerReadiness === null ||
      schedule.lastCheckedAt < runnerReadiness.checkedAt ||
      readyAt < runnerReadiness.checkedAt)
  ) {
    throw corrupt("ready physical generation lacks its immutable safety evidence");
  }
  if (generationRank(generation.state) < generationRank("ready") && readyAt !== null) {
    throw corrupt("pre-ready physical generation contains ready evidence");
  }
  if (readyAt !== null && (readyAt < generation.createdAt || readyAt > generation.updatedAt)) {
    throw corrupt("physical generation readyAt is outside its durable interval");
  }
  if (
    (generation.state === "settled") !== (cleanup.phase === "settled") ||
    (cleanup.phase === "settled" &&
      (!cleanup.providerResourcesSettled || !cleanup.runnerRegistrationSettled))
  ) {
    throw corrupt("physical generation state and cleanup settlement disagree");
  }
}

function replaceAttempt(
  allocation: AllocationRecord,
  attempt: ProviderAttempt,
  change: {
    readonly lifecycleState: AllocationLifecycleState;
    readonly revision: string;
    readonly updatedAt: string;
  },
): AllocationRecord {
  const attempts = [...allocation.attempts];
  if (attempts[attempt.ordinal - 1] === undefined) {
    throw new AllocationLedgerError("not-found", "provider attempt was not found");
  }
  attempts[attempt.ordinal - 1] = attempt;
  return {
    ...allocation,
    attempts,
    lifecycleState: change.lifecycleState,
    revision: requireRevision(change.revision),
    updatedAt: change.updatedAt,
  };
}

function replaceAttemptWithoutAllocationRevision(
  allocation: AllocationRecord,
  attempt: ProviderAttempt,
): AllocationRecord {
  const attempts = [...allocation.attempts];
  if (attempts[attempt.ordinal - 1] === undefined) {
    throw new AllocationLedgerError("not-found", "provider attempt was not found");
  }
  attempts[attempt.ordinal - 1] = attempt;
  return { ...allocation, attempts };
}

function requireAuthoritativeCounter(value: number, limit: number, kind: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > limit) {
    throw corrupt(`${kind} counter is outside its authoritative range`);
  }
}

function requireProvider(value: ProviderName): ProviderName {
  if (value !== "azure" && value !== "blacksmith") {
    throw invalid("provider must be azure or blacksmith");
  }
  return value;
}

function requireFatalAzureAbortClassification(
  value: FatalAzureAbortClassification,
): FatalAzureAbortClassification {
  if (!FATAL_AZURE_ABORT_CLASSIFICATIONS.includes(value)) {
    throw invalid("fatal Azure abort classification is not recognised");
  }
  return value;
}

function validateGenerationBasePlan(value: GenerationBasePlanEvidence): GenerationBasePlanEvidence {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid("basePlan must be an exact generation plan object");
  }
  const sha256 = (digest: string, name: string): string => {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw invalid(`${name} must be a lowercase SHA-256`);
    return digest;
  };
  if (!/^[A-Za-z0-9-]{1,64}$/.test(value.subscriptionId)) {
    throw invalid("basePlan.subscriptionId is invalid");
  }
  if (value.imageVersion === "latest" || !/^[A-Za-z0-9._-]{5,128}$/.test(value.imageVersion)) {
    throw invalid("basePlan.imageVersion must be a pinned Marketplace version");
  }
  const adminSshPublicKey = validateOpenSshPublicKey(value.adminSshPublicKey);
  const adminSshPublicKeySha256 = sha256(
    value.adminSshPublicKeySha256,
    "basePlan.adminSshPublicKeySha256",
  );
  return {
    adminSshPublicKey,
    adminSshPublicKeySha256,
    baseTemplateSha256: sha256(value.baseTemplateSha256, "basePlan.baseTemplateSha256"),
    imageVersion: value.imageVersion,
    nonSecretBootstrapSha256: sha256(
      value.nonSecretBootstrapSha256,
      "basePlan.nonSecretBootstrapSha256",
    ),
    sharedRunnerSubnetId: requireAzureResourceId(
      value.sharedRunnerSubnetId,
      "basePlan.sharedRunnerSubnetId",
    ),
    subscriptionId: value.subscriptionId,
  };
}

function validateOpenSshPublicKey(value: string): string {
  if (
    typeof value !== "string" ||
    value.length > 1_024 ||
    !/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    throw invalid("basePlan.adminSshPublicKey must be one bounded Ed25519 OpenSSH public key");
  }
  return value;
}

function requireAzurePilotLocation(value: string): typeof AZURE_PILOT_LOCATION {
  if (value !== AZURE_PILOT_LOCATION) {
    throw invalid("Azure V1 location must be uksouth");
  }
  return value;
}

function requireAzurePilotZone(value: string): AzurePilotZone {
  if (!AZURE_PILOT_ZONES.includes(value as AzurePilotZone)) {
    throw invalid("Azure V1 availability zone must be 1, 2 or 3");
  }
  return value as AzurePilotZone;
}

function requireAzurePilotVmSize(value: string, profile: CapabilityProfile): AzurePilotVmSize {
  const expected = profile === "linux-x64-standard" ? "Standard_D4ds_v6" : "Standard_D8ds_v6";
  if ((value !== "Standard_D4ds_v6" && value !== "Standard_D8ds_v6") || value !== expected) {
    throw invalid("Azure VM size must match the centrally approved capability profile");
  }
  return value;
}

function requireAzureResourceName(value: string, path: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._()-]{1,90}$/.test(value)) {
    throw invalid(`${path} must be a bounded literal Azure resource or deployment name`);
  }
  return value;
}

function requireAzureResourceId(value: string, path: string): string {
  if (
    typeof value !== "string" ||
    value.length > 1024 ||
    !/^\/subscriptions\/[A-Za-z0-9-]+\/resourceGroups\/[A-Za-z0-9._()-]+(?:\/providers\/[A-Za-z0-9.]+\/[A-Za-z0-9/._()-]+)?$/i.test(
      value,
    )
  ) {
    throw invalid(`${path} must be a canonical bounded Azure resource ID`);
  }
  return value;
}

function requireAzureResourceGroupBinding(
  resourceGroupId: string,
  resourceGroupName: string,
): void {
  if (
    resourceGroupId !==
    `/subscriptions/${resourceGroupId.split("/")[2]}/resourceGroups/${resourceGroupName}`
  ) {
    throw invalid("resourceGroupId and resourceGroupName must identify the same exact group");
  }
}

function azureDeploymentResourceId(resourceGroupId: string, deploymentName: string): string {
  return `${resourceGroupId}/providers/Microsoft.Resources/deployments/${deploymentName}`;
}

function requireExactAzureDeploymentId(
  value: string,
  resourceGroupId: string,
  deploymentNameValue: string,
): string {
  const deploymentName = requireAzureResourceName(deploymentNameValue, "deploymentName");
  const deploymentId = requireAzureResourceId(value, "deploymentId");
  if (deploymentId !== azureDeploymentResourceId(resourceGroupId, deploymentName)) {
    throw precondition("zone deployment ID must bind its exact allocation resource group and name");
  }
  return deploymentId;
}

function requireExactSubscriptionDeploymentId(
  value: string,
  subscriptionId: string,
  deploymentNameValue: string,
): string {
  const deploymentName = requireAzureResourceName(deploymentNameValue, "deploymentName");
  const expected = `/subscriptions/${subscriptionId}/providers/Microsoft.Resources/deployments/${deploymentName}`;
  if (value !== expected) {
    throw precondition("zone deployment ID must bind its exact subscription and name");
  }
  return value;
}

function requireAzureVmResourceId(value: string, resourceGroupId: string): string {
  const vmResourceId = requireAzureResourceId(value, "vmResourceId");
  const expectedPrefix = `${resourceGroupId}/providers/Microsoft.Compute/virtualMachines/`;
  if (!vmResourceId.startsWith(expectedPrefix) || vmResourceId.length === expectedPrefix.length) {
    throw precondition("VM resource ID must belong to the exact allocation resource group");
  }
  return vmResourceId;
}

function requireExactManagedRunCommandId(value: string, vmResourceId: string): string {
  const managedRunCommandId = requireAzureResourceId(
    value,
    "managedRunCommand.managedRunCommandId",
  );
  if (managedRunCommandId !== `${vmResourceId}/runCommands/launch-jit-g1`) {
    throw precondition(
      "Managed Run Command ID must be the exact canonical launch-jit-g1 child of its VM",
    );
  }
  return managedRunCommandId;
}

function requireAllocationId(value: string): string {
  if (!/^sy1-[0-9a-f]{64}$/.test(value)) {
    throw invalid("allocationId is not a canonical Switchyard allocation ID");
  }
  return value;
}

function requireRunnerLabel(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw invalid("runnerLabel must be a literal GitHub runner label");
  }
  return value;
}

function requireAppSlug(value: string): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(value)) {
    throw invalid("checkRunAppSlug must be a literal GitHub App slug");
  }
  return value;
}

function requireRepositoryPart(value: string, path: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw invalid(`${path} is invalid`);
  }
  return value;
}

function requireLeaseOwner(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw invalid("leaseOwner must be a bounded opaque coordinator identifier");
  }
  return value;
}

function stableIdentityHash(value: string): string {
  const mask = 0xffff_ffff_ffff_ffffn;
  const prime = 0x0000_0100_0000_01b3n;
  const seeds = [
    0xcbf2_9ce4_8422_2325n,
    0x8422_2325_cbf2_9ce4n,
    0x9e37_79b1_85eb_ca87n,
    0xd6e8_feb8_6659_fd93n,
  ] as const;
  return seeds
    .map((seed) => {
      let hash: bigint = seed;
      for (let index = 0; index < value.length; index += 1) {
        hash ^= BigInt(value.charCodeAt(index));
        hash = (hash * prime) & mask;
      }
      return hash.toString(16).padStart(16, "0");
    })
    .join("");
}

function requireUtcInstant(value: string, path: string): string {
  if (typeof value !== "string") {
    throw invalid(`${path} must be a canonical UTC instant`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw invalid(`${path} must use canonical ISO 8601 UTC form`);
  }
  return value;
}

function nullableUtcInstant(value: string | null, path: string): string | null {
  return value === null ? null : requireUtcInstant(value, path);
}

function requireUtcDay(value: string, path: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw corrupt(`${path} must use YYYY-MM-DD form`);
  }
  const instant = `${value}T00:00:00.000Z`;
  if (new Date(instant).toISOString() !== instant) {
    throw corrupt(`${path} must be a real UTC calendar day`);
  }
  return value;
}

function maxInstant(left: string, right: string): string {
  return left > right ? left : right;
}

function requireNonEmpty(value: string, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalid(`${path} must be a non-empty string`);
  }
  return value;
}

function immutableNullableIdentifier(
  current: string | null,
  value: string | null,
  path: string,
): string | null {
  const validated = value === null ? null : requireNonEmpty(value, path);
  if (current !== null && current !== validated) {
    throw precondition(`${path} is immutable once recorded`);
  }
  return validated;
}

function immutableNullableInstant(
  current: string | null,
  value: string | null,
  path: string,
): string | null {
  const validated = nullableUtcInstant(value, path);
  if (current !== null && current !== validated) {
    throw precondition(`${path} is immutable once recorded`);
  }
  return validated;
}

function requireBoolean(value: boolean, path: string): boolean {
  if (typeof value !== "boolean") {
    throw invalid(`${path} must be boolean`);
  }
  return value;
}

function requirePositiveSafeInteger(value: number, path: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw invalid(`${path} must be a positive safe integer`);
  }
  return value;
}

function requireNonNegativeSafeInteger(value: number, path: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalid(`${path} must be a non-negative safe integer`);
  }
  return value;
}

function requireRevision(value: string): string {
  return requireNonEmpty(value, "revision");
}

function cleanupRank(state: AllocationCleanupState["phase"]): number {
  return ["not-started", "pending", "settled"].indexOf(state);
}

function generationRank(state: PhysicalGeneration["state"]): number {
  return ["planned", "provisioning", "ready", "fenced", "cleanup_pending", "settled"].indexOf(
    state,
  );
}

function scheduleTransitionAllowed(
  current: ScheduleOperationStatus,
  next: ScheduleOperationStatus,
): boolean {
  if (current === "rejected" || current === "failed") {
    return next === current;
  }
  if (current === "executed") return next === "executed" || next === "failed";
  if (current === "accepted") {
    return next === "accepted" || next === "executed" || next === "failed";
  }
  return true;
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function withoutAllocationRevision(record: AllocationRecord): Omit<AllocationRecord, "revision"> {
  const { revision: _revision, ...rest } = record;
  return rest;
}

function withoutGenerationRevision(
  generation: PhysicalGeneration,
): Omit<PhysicalGeneration, "revision"> {
  const { revision: _revision, ...rest } = generation;
  return rest;
}

function invalid(message: string): AllocationLedgerError {
  return new AllocationLedgerError("invalid-ledger-request", message);
}

function conflict(message: string): AllocationLedgerError {
  return new AllocationLedgerError("allocation-conflict", message);
}

function precondition(message: string, cause?: unknown): AllocationLedgerError {
  return new AllocationLedgerError("precondition-failed", message, { cause });
}

function optimisticConflict(
  message = "the ledger record changed after it was read",
): AllocationLedgerError {
  return new AllocationLedgerError("optimistic-concurrency-conflict", message);
}

function corrupt(message: string, cause?: unknown): AllocationLedgerError {
  return new AllocationLedgerError("authoritative-state-corrupt", message, { cause });
}
