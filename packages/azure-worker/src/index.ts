import { createHash, randomUUID } from "node:crypto";
import {
  type AllocationControlLedger,
  AllocationLedgerError,
  type AllocationRecord,
  AZURE_PILOT_LOCATION,
  AZURE_PILOT_ZONES,
  type AzurePilotVmSize,
  azureGenerationOneNames,
  azureRunnerLabelForAllocation,
  type FatalAzureAbortClassification,
  type GenerationManagedRunCommand,
  type GenerationOperationKind,
  type GenerationScheduleOperation,
  type GenerationZoneDeployment,
  type PhysicalGeneration,
  type PhysicalGenerationState,
  type ProviderAttempt,
} from "@switchyard/core";

export const AZURE_BASE_TEMPLATE_PATH = "infra/templates/azure-allocation/main.json" as const;
export const AZURE_JIT_LAUNCH_TEMPLATE_PATH =
  "infra/templates/azure-allocation/jit-launch.json" as const;

export type AzureWorkerIncidentCode =
  | "authoritative-state-invalid"
  | "cleanup-failed"
  | "unknown-external-failure"
  | FatalAzureAbortClassification;

export type AzureWorkerResult =
  | { readonly allocationId: string; readonly outcome: "ignored"; readonly reason: string }
  | { readonly allocationId: string; readonly outcome: "progress"; readonly stage: string }
  | {
      readonly allocationId: string;
      readonly code: AzureWorkerIncidentCode;
      readonly cleanupPending: boolean;
      readonly outcome: "incident";
    }
  | {
      readonly allocationId: string;
      readonly classification:
        | "management-plane-provisioning"
        | "readiness-timeout"
        | "zones-exhausted";
      readonly outcome: "unavailable";
    }
  | {
      readonly allocationId: string;
      readonly outcome: "ready";
      readonly runnerLabel: string;
    };

export interface AzureGenerationPlan {
  readonly adminSshPublicKey: string;
  readonly baseTemplateSha256: string;
  readonly baseDeploymentNameByZone: Readonly<Record<"1" | "2" | "3", string>>;
  readonly imageVersion: string;
  readonly nonSecretBootstrapCustomData: string;
  readonly resourceGroupId: string;
  readonly resourceGroupName: string;
  readonly sharedRunnerSubnetId: string;
  readonly subscriptionId: string;
}

export interface AzureGenerationPlanningPort {
  plan(input: {
    readonly allocation: AllocationRecord;
    readonly attempt: ProviderAttempt;
    readonly generationNumber: 1;
    readonly location: typeof AZURE_PILOT_LOCATION;
    readonly persistedBasePlan?: PhysicalGeneration["basePlan"];
    readonly vmSize: AzurePilotVmSize;
  }): Promise<AzureGenerationPlan>;
}

export type AzureBaseDeploymentObservation =
  | { readonly outcome: "pending" }
  | {
      readonly childDeploymentId: string;
      readonly completedAt: string;
      readonly deploymentId: string;
      readonly outcome: "management-plane-unavailable" | "no-vm-created";
      readonly residualResourcesSettledAt: string;
      readonly vmAbsenceVerifiedAt: string;
    }
  | {
      readonly childDeploymentId: string;
      readonly completedAt: string;
      readonly deploymentId: string;
      readonly outcome: "vm-created";
      readonly providerVmId: string;
      readonly vmResourceId: string;
    };

export type AzureLaunchObservation =
  | { readonly outcome: "absent" }
  | {
      readonly launchConfirmedAt: string;
      readonly managedRunCommandId: string;
      readonly outcome: "launched";
      readonly requestedAt: string;
    };

export type AzureManagedRunCommandDeletionObservation =
  | {
      readonly checkedAt: string;
      readonly outcome: "pending";
      readonly requestedAt: string;
    }
  | {
      readonly completedAt: string;
      readonly outcome: "deleted";
      readonly requestedAt: string;
    };

export type AzureCleanupVmObservation =
  | { readonly checkedAt: string; readonly outcome: "absent" }
  | {
      readonly checkedAt: string;
      readonly outcome: "exact";
      readonly providerVmId: string;
      readonly vmResourceId: string;
    };

export interface AzureResourcePort {
  deleteManagedRunCommand(input: {
    readonly deleteRequestedAt: string;
    readonly managedRunCommandId: string;
    readonly submitDelete: boolean;
  }): Promise<AzureManagedRunCommandDeletionObservation>;
  deleteResourceGroup(input: {
    readonly resourceGroupId: string;
  }): Promise<{ readonly requestedAt: string }>;
  ensureBaseDeployment(input: {
    readonly allocation: AllocationRecord;
    readonly attempt: ProviderAttempt;
    readonly availabilityZone: "1" | "2" | "3";
    readonly deployment: GenerationZoneDeployment;
    readonly plan: AzureGenerationPlan;
    readonly templatePath: typeof AZURE_BASE_TEMPLATE_PATH;
  }): Promise<AzureBaseDeploymentObservation>;
  fenceCompute(input: {
    readonly computeDeadline: string;
    readonly providerVmId: string | null;
    readonly resourceGroupId: string;
    readonly vmResourceId: string | null;
  }): Promise<
    { readonly outcome: "pending" } | { readonly outcome: "settled"; readonly settledAt: string }
  >;
  launchJit(input: {
    readonly acceptedSchedule: GenerationScheduleOperation & { readonly status: "accepted" };
    readonly encodedJitConfiguration: string;
    readonly generation: PhysicalGeneration;
    readonly jitDeploymentName: string;
    readonly managedRunCommandId: string;
    readonly templatePath: typeof AZURE_JIT_LAUNCH_TEMPLATE_PATH;
  }): Promise<Exclude<AzureLaunchObservation, { readonly outcome: "absent" }>>;
  observeJitLaunch(input: {
    readonly generation: PhysicalGeneration;
  }): Promise<AzureLaunchObservation>;
  observeLaunchPrerequisites(input: {
    readonly providerVmId: string;
    readonly vmResourceId: string;
  }): Promise<
    | { readonly outcome: "pending" }
    | {
        readonly checkedAt: string;
        readonly bootstrapSucceeded: true;
        readonly dockerHealthy: true;
        readonly localNvmeMounted: true;
        readonly outcome: "ready";
      }
  >;
  observeCleanupVm(input: {
    readonly resourceGroupId: string;
    readonly vmResourceId: string;
  }): Promise<AzureCleanupVmObservation>;
  resourceGroupAbsent(input: {
    readonly resourceGroupId: string;
  }): Promise<{ readonly absent: boolean; readonly checkedAt: string }>;
  settleDeployments(input: { readonly deploymentIds: readonly string[] }): Promise<{
    readonly allTerminalOrAbsent: boolean;
    readonly deploymentIds: readonly string[];
    readonly settledAt: string;
  }>;
}

export interface AzureComputeSchedulePort {
  ensureCompleteBy(input: {
    readonly existing: GenerationScheduleOperation & { readonly status: "requested" | "accepted" };
    readonly correlationId: string;
    readonly providerVmId: string;
    readonly requestedDeadline: string;
    readonly targetVmResourceId: string;
  }): Promise<GenerationScheduleOperation>;
}

export type ExactRunnerObservation =
  | { readonly outcome: "absent"; readonly checkedAt: string }
  | {
      readonly checkedAt: string;
      readonly idle: boolean;
      readonly online: boolean;
      readonly outcome: "exact";
      readonly runnerRegistrationId: string;
    }
  | {
      readonly checkedAt: string;
      readonly outcome: "ambiguous";
      readonly runnerRegistrationIds: readonly string[];
    };

export interface AzureRunnerGitHubPort {
  fenceRunner(input: {
    readonly runnerLabel: string;
    readonly runnerRegistrationId: string | null;
  }): Promise<{
    readonly allMatchingRegistrationsAbsent: true;
    readonly runnerLabel: string;
    readonly settledAt: string;
  }>;
  mintJitConfiguration(input: {
    readonly allocationId: string;
    readonly runnerLabel: string;
  }): Promise<{
    readonly encodedJitConfiguration: string;
    readonly runnerRegistrationId: string;
  }>;
  observeExactRunner(input: { readonly runnerLabel: string }): Promise<ExactRunnerObservation>;
}

export interface AzureWorkerAlertPort {
  raise(input: {
    readonly allocationId: string;
    readonly code: AzureWorkerIncidentCode;
    readonly generationNumber: 1;
  }): Promise<void>;
}

export interface AzureGenerationOneWorkerOptions {
  readonly alerts: AzureWorkerAlertPort;
  readonly azure: AzureResourcePort;
  readonly github: AzureRunnerGitHubPort;
  readonly ledger: AllocationControlLedger;
  readonly now?: () => Date;
  readonly planning: AzureGenerationPlanningPort;
  readonly schedule: AzureComputeSchedulePort;
}

export interface AzureProvisioningQueueMessage {
  readonly allocation_id: string;
  readonly ordinal: 1;
  readonly provider: "azure";
}

export interface AzureAssignedCleanupRequest {
  readonly allocationId: string;
}

/**
 * Restartable, production-disabled generation-one orchestration. Runtime SDK
 * adapters and Function registration deliberately live outside this package.
 */
export class AzureGenerationOneWorker {
  readonly #alerts: AzureWorkerAlertPort;
  readonly #azure: AzureResourcePort;
  readonly #github: AzureRunnerGitHubPort;
  readonly #ledger: AllocationControlLedger;
  readonly #now: () => Date;
  readonly #planning: AzureGenerationPlanningPort;
  readonly #schedule: AzureComputeSchedulePort;

  constructor(options: AzureGenerationOneWorkerOptions) {
    this.#alerts = options.alerts;
    this.#azure = options.azure;
    this.#github = options.github;
    this.#ledger = options.ledger;
    this.#now = options.now ?? (() => new Date());
    this.#planning = options.planning;
    this.#schedule = options.schedule;
  }

  async reconcile(inputValue: unknown): Promise<AzureWorkerResult> {
    const input = parseQueueMessage(inputValue);
    const allocationId = input.allocation_id;
    let aggregate: AzureAggregate;
    try {
      aggregate = await this.#load(allocationId);
    } catch (error) {
      if (error instanceof AzureWorkerError) {
        return this.#incident(allocationId, error.code, false);
      }
      throw error;
    }

    if (aggregate.attempt.outcome === "aborted") {
      return this.#incident(
        allocationId,
        aggregate.attempt.fatalAbort?.classification ?? "authoritative-state-invalid",
        false,
      );
    }
    if (aggregate.attempt.outcome === "unavailable") {
      const classification = aggregate.attempt.unavailable?.classification;
      if (
        classification === "management-plane-provisioning" ||
        classification === "readiness-timeout" ||
        classification === "zones-exhausted"
      ) {
        return { allocationId, classification, outcome: "unavailable" };
      }
      return { allocationId, outcome: "ignored", reason: "attempt-ended" };
    }

    if (aggregate.attempt.reservation.state !== "held") {
      return { allocationId, outcome: "ignored", reason: "no-held-attempt" };
    }

    const generation = aggregate.generation;
    if (generation === undefined) {
      if (aggregate.attempt.fatalAbortIntent !== null) {
        return this.#settleWithoutGeneration(aggregate);
      }
      if (this.#nowIso() >= readinessCutoffFor(aggregate.attempt)) {
        return this.#settleWithoutGeneration(aggregate);
      }
      return this.#addGeneration(aggregate);
    }
    if (generation.state === "fenced" || generation.state === "cleanup_pending") {
      return this.#continueCleanup(aggregate);
    }
    if (generation.state === "settled") return this.#finishCleanup(aggregate);
    if (aggregate.attempt.fatalAbortIntent !== null) return this.#beginCleanup(aggregate);
    if (aggregate.attempt.outcome === "succeeded") {
      return this.#reconcileSuccessfulAttempt(aggregate);
    }

    if (this.#nowIso() >= readinessCutoffFor(aggregate.attempt)) {
      return this.#beginCleanup(aggregate);
    }

    if (generation.vmResourceId === null) return this.#reconcileBaseDeployment(aggregate);
    if (generation.schedule?.status === "rejected") {
      return this.#beginFatalCleanup(aggregate, "schedule-rejected");
    }
    if (generation.schedule?.status === "failed") {
      return this.#beginFatalCleanup(aggregate, "schedule-failed");
    }
    if (generation.schedule?.status === "executed") {
      return this.#beginFatalCleanup(aggregate, "schedule-executed-before-assignment");
    }
    if (generation.schedule?.status !== "accepted") return this.#reconcileSchedule(aggregate);
    if (generation.launchPrerequisites === null) return this.#reconcilePrerequisites(aggregate);
    if (
      generation.managedRunCommand === null ||
      generation.managedRunCommand.launchConfirmedAt === null
    ) {
      return this.#reconcileLaunch(aggregate);
    }
    if (generation.managedRunCommand.deleteCompletedAt === null) {
      return this.#deleteRunCommand(aggregate);
    }
    if (generation.state !== "ready") return this.#reconcileReadiness(aggregate);
    return this.#markSuccessAndAssign(aggregate);
  }

  /**
   * General cleanup entry point for an already assigned generation. The outer
   * lifecycle reconciler decides why cleanup is due and retains ownership of
   * independently verified workload-terminal evidence and final settlement.
   */
  async reconcileAssignedCleanup(input: AzureAssignedCleanupRequest): Promise<AzureWorkerResult> {
    if (
      typeof input !== "object" ||
      input === null ||
      Object.getPrototypeOf(input) !== Object.prototype ||
      Object.keys(input).length !== 1 ||
      !/^sy1-[0-9a-f]{64}$/.test(input.allocationId)
    ) {
      throw new TypeError("assigned Azure cleanup request is invalid");
    }
    const aggregate = await this.#load(input.allocationId);
    if (
      aggregate.allocation.runnerAssignment?.provider !== "azure" ||
      aggregate.allocation.runnerAssignment.attemptOrdinal !== 1 ||
      aggregate.attempt.outcome !== "succeeded" ||
      aggregate.attempt.reservation.state !== "held"
    ) {
      return { allocationId: input.allocationId, outcome: "ignored", reason: "not-assigned-azure" };
    }
    if (aggregate.allocation.lifecycleState !== "cleanup_pending") {
      return {
        allocationId: input.allocationId,
        outcome: "ignored",
        reason: "allocation-cleanup-not-started",
      };
    }
    const generation = requiredGeneration(aggregate);
    if (generation.state === "settled") {
      return {
        allocationId: input.allocationId,
        outcome: "progress",
        stage: "resources-deleted",
      };
    }
    if (generation.state === "fenced" || generation.state === "cleanup_pending") {
      return this.#continueCleanup(aggregate);
    }
    return this.#beginCleanup(aggregate);
  }

  async #addGeneration(aggregate: AzureAggregate): Promise<AzureWorkerResult> {
    const vmSize = vmSizeForProfile(aggregate.allocation.acceptance.request.profile);
    const plan = validatePlan(
      aggregate.allocation.allocationId,
      await this.#planning.plan({
        allocation: aggregate.allocation,
        attempt: aggregate.attempt,
        generationNumber: 1,
        location: AZURE_PILOT_LOCATION,
        vmSize,
      }),
    );
    const current = await this.#load(aggregate.allocation.allocationId);
    if (current.generation !== undefined) {
      return {
        allocationId: current.allocation.allocationId,
        outcome: "progress",
        stage: "generation-exists",
      };
    }
    await this.#ledger.addPhysicalGeneration({
      allocationId: current.allocation.allocationId,
      attemptOrdinal: 1,
      availabilityZone: "1",
      baseDeploymentId: azureGenerationOneNames({
        allocationId: current.allocation.allocationId,
        subscriptionId: plan.subscriptionId,
      }).baseDeploymentIdByZone["1"],
      baseDeploymentName: plan.baseDeploymentNameByZone["1"],
      basePlan: planEvidence(plan),
      childDeploymentId: azureGenerationOneNames({
        allocationId: current.allocation.allocationId,
        subscriptionId: plan.subscriptionId,
      }).childDeploymentId,
      createdAt: this.#nowIso(),
      expectedAttemptRevision: current.attempt.revision,
      generationNumber: 1,
      location: AZURE_PILOT_LOCATION,
      reservedIncrementalCostUsdCents: 0,
      resourceGroupId: plan.resourceGroupId,
      resourceGroupName: plan.resourceGroupName,
      vmSize,
    });
    return {
      allocationId: current.allocation.allocationId,
      outcome: "progress",
      stage: "generation-added",
    };
  }

  async #settleWithoutGeneration(aggregate: AzureAggregate): Promise<AzureWorkerResult> {
    const plan = validatePlan(
      aggregate.allocation.allocationId,
      await this.#planning.plan({
        allocation: aggregate.allocation,
        attempt: aggregate.attempt,
        generationNumber: 1,
        location: AZURE_PILOT_LOCATION,
        vmSize: vmSizeForProfile(aggregate.allocation.acceptance.request.profile),
      }),
    );
    const names = azureGenerationOneNames({
      allocationId: aggregate.allocation.allocationId,
      subscriptionId: plan.subscriptionId,
    });
    const runnerLabel = azureRunnerLabelForAllocation(aggregate.allocation.allocationId);
    const cleanupStartedAt = latestIso(aggregate.allocation.updatedAt, aggregate.attempt.updatedAt);
    try {
      const compute = await this.#azure.fenceCompute({
        computeDeadline: aggregate.deadlines.computeDeadline,
        providerVmId: null,
        resourceGroupId: names.resourceGroupId,
        vmResourceId: null,
      });
      if (compute.outcome === "pending") {
        return {
          allocationId: aggregate.allocation.allocationId,
          outcome: "progress",
          stage: "provider-operation-in-flight",
        };
      }
      if (!isCleanupStepAtOrAfter(compute.settledAt, cleanupStartedAt, this.#nowIso())) {
        return this.#incident(aggregate.allocation.allocationId, "cleanup-failed", true);
      }
      const deploymentIds = AZURE_PILOT_ZONES.map((zone) => names.baseDeploymentIdByZone[zone]);
      const deployments = await this.#azure.settleDeployments({ deploymentIds });
      if (
        !isExactDeploymentSettlement(deployments, deploymentIds) ||
        !isCleanupStepAtOrAfter(deployments.settledAt, compute.settledAt, this.#nowIso())
      ) {
        return this.#incident(aggregate.allocation.allocationId, "cleanup-failed", true);
      }
      const deletion = await this.#azure.deleteResourceGroup({
        resourceGroupId: names.resourceGroupId,
      });
      if (!isCleanupStepAtOrAfter(deletion.requestedAt, deployments.settledAt, this.#nowIso())) {
        return this.#incident(aggregate.allocation.allocationId, "cleanup-failed", true);
      }
      const group = await this.#azure.resourceGroupAbsent({
        resourceGroupId: names.resourceGroupId,
      });
      const groupObservedAt = this.#nowIso();
      if (!isCleanupStepAtOrAfter(group.checkedAt, deletion.requestedAt, groupObservedAt)) {
        return this.#incident(aggregate.allocation.allocationId, "cleanup-failed", true);
      }
      const fenced = await this.#github.fenceRunner({
        runnerLabel,
        runnerRegistrationId: null,
      });
      if (
        fenced.allMatchingRegistrationsAbsent !== true ||
        fenced.runnerLabel !== runnerLabel ||
        !isCleanupStepAtOrAfter(fenced.settledAt, cleanupStartedAt, this.#nowIso())
      ) {
        return this.#incident(aggregate.allocation.allocationId, "cleanup-failed", true);
      }
      if (!group.absent) {
        return groupObservedAt >= aggregate.deadlines.absoluteExpiry
          ? this.#incident(aggregate.allocation.allocationId, "cleanup-failed", true)
          : {
              allocationId: aggregate.allocation.allocationId,
              outcome: "progress",
              stage: "resource-deletion-pending",
            };
      }
      const settledAt = latestIso(group.checkedAt, fenced.settledAt);
      const fatalAbort = aggregate.attempt.fatalAbortIntent;
      if (fatalAbort !== null) {
        await this.#ledger.settleFatalAzureAbort({
          allocationId: aggregate.allocation.allocationId,
          classification: fatalAbort.classification,
          cleanup: {
            phase: "settled",
            providerResourcesSettled: true,
            runnerRegistrationSettled: true,
            settledAt,
          },
          expectedAllocationRevision: aggregate.allocation.revision,
          expectedAttemptRevision: aggregate.attempt.revision,
          finalCostUsdCents: aggregate.attempt.reservation.reservedCostUsdCents,
          ordinal: 1,
          settledAt,
        });
        await this.#raise(aggregate.allocation.allocationId, fatalAbort.classification);
        return {
          allocationId: aggregate.allocation.allocationId,
          cleanupPending: false,
          code: fatalAbort.classification,
          outcome: "incident",
        };
      }
      await this.#ledger.settleUnavailableProviderAttempt({
        allocationId: aggregate.allocation.allocationId,
        classification: "readiness-timeout",
        cleanup: {
          phase: "settled",
          providerResourcesSettled: true,
          runnerRegistrationSettled: true,
          settledAt,
        },
        expectedAllocationRevision: aggregate.allocation.revision,
        expectedAttemptRevision: aggregate.attempt.revision,
        finalCostUsdCents: aggregate.attempt.reservation.reservedCostUsdCents,
        ordinal: 1,
        settledAt,
      });
      return {
        allocationId: aggregate.allocation.allocationId,
        classification: "readiness-timeout",
        outcome: "unavailable",
      };
    } catch {
      return this.#incident(aggregate.allocation.allocationId, "cleanup-failed", true);
    }
  }

  async #reconcileBaseDeployment(aggregate: AzureAggregate): Promise<AzureWorkerResult> {
    const generation = requiredGeneration(aggregate);
    const deployment = generation.zoneDeployments.at(-1);
    if (deployment === undefined) throw new AzureWorkerError("authoritative-state-invalid");
    if (deployment.outcome === "no-vm-created") {
      if (generation.zoneDeployments.length === AZURE_PILOT_ZONES.length) {
        return this.#beginCleanup(aggregate);
      }
      const nextZone = AZURE_PILOT_ZONES[generation.zoneDeployments.length];
      if (nextZone === undefined) throw new AzureWorkerError("authoritative-state-invalid");
      const plan = validatePlan(
        aggregate.allocation.allocationId,
        await this.#planning.plan({
          allocation: aggregate.allocation,
          attempt: aggregate.attempt,
          generationNumber: 1,
          location: AZURE_PILOT_LOCATION,
          persistedBasePlan: generation.basePlan,
          vmSize: generation.vmSize,
        }),
        generation.basePlan,
      );
      const current = await this.#load(aggregate.allocation.allocationId);
      const latest = requiredGeneration(current);
      if (latest.zoneDeployments.length !== generation.zoneDeployments.length) {
        return {
          allocationId: current.allocation.allocationId,
          outcome: "progress",
          stage: "zone-already-advanced",
        };
      }
      await this.#updateGeneration(current, {
        ...generationState(latest),
        state: "provisioning",
        zoneDeployments: [
          ...latest.zoneDeployments,
          {
            availabilityZone: nextZone,
            childDeploymentId: latest.zoneDeployments[0]?.childDeploymentId ?? "",
            completedAt: null,
            deploymentId: azureGenerationOneNames({
              allocationId: current.allocation.allocationId,
              subscriptionId: plan.subscriptionId,
            }).baseDeploymentIdByZone[nextZone],
            deploymentName: plan.baseDeploymentNameByZone[nextZone],
            outcome: "pending",
            requestedAt: this.#nowIso(),
            residualResourcesSettledAt: null,
            vmAbsenceVerifiedAt: null,
            vmResourceId: null,
          },
        ],
      });
      return {
        allocationId: aggregate.allocation.allocationId,
        outcome: "progress",
        stage: `zone-${nextZone}-planned`,
      };
    }
    if (deployment.outcome === "management-plane-unavailable") {
      return this.#beginCleanup(aggregate);
    }

    const plan = validatePlan(
      aggregate.allocation.allocationId,
      await this.#planning.plan({
        allocation: aggregate.allocation,
        attempt: aggregate.attempt,
        generationNumber: 1,
        location: AZURE_PILOT_LOCATION,
        persistedBasePlan: generation.basePlan,
        vmSize: generation.vmSize,
      }),
      generation.basePlan,
    );
    const claimed = await this.#claimOperation(aggregate, "base-deployment");
    if (claimed === undefined) {
      return {
        allocationId: aggregate.allocation.allocationId,
        outcome: "progress",
        stage: "base-deployment-fenced",
      };
    }
    const claimedGeneration = requiredGeneration(claimed);
    const claimedDeployment = claimedGeneration.zoneDeployments.at(-1);
    if (claimedDeployment?.deploymentId !== deployment.deploymentId) {
      throw new AzureWorkerError("authoritative-state-invalid");
    }
    let observed: AzureBaseDeploymentObservation;
    try {
      observed = await this.#azure.ensureBaseDeployment({
        allocation: claimed.allocation,
        attempt: claimed.attempt,
        availabilityZone: claimedDeployment.availabilityZone,
        deployment: claimedDeployment,
        plan,
        templatePath: AZURE_BASE_TEMPLATE_PATH,
      });
    } catch {
      return this.#incident(claimed.allocation.allocationId, "unknown-external-failure", true);
    }
    const current = await this.#load(aggregate.allocation.allocationId);
    const latest = requiredGeneration(current);
    const latestDeployment = latest.zoneDeployments.at(-1);
    if (
      latestDeployment?.deploymentId !== deployment.deploymentId ||
      latestDeployment.outcome !== "pending" ||
      latest.operationLease?.leaseId !== claimedGeneration.operationLease?.leaseId
    ) {
      return {
        allocationId: current.allocation.allocationId,
        outcome: "progress",
        stage: "deployment-observed-concurrently",
      };
    }
    if (observed.outcome === "pending") {
      await this.#updateGeneration(current, {
        ...generationState(latest),
        operationLease: null,
      });
      return {
        allocationId: current.allocation.allocationId,
        outcome: "progress",
        stage: `zone-${deployment.availabilityZone}-pending`,
      };
    }
    if (
      observed.deploymentId !== deployment.deploymentId ||
      observed.childDeploymentId !== deployment.childDeploymentId ||
      (observed.outcome === "vm-created" &&
        (observed.vmResourceId !==
          azureGenerationOneNames({
            allocationId: current.allocation.allocationId,
            subscriptionId: plan.subscriptionId,
          }).vmResourceId ||
          !isCanonicalProviderVmId(observed.providerVmId))) ||
      (observed.outcome !== "vm-created" &&
        (observed.vmAbsenceVerifiedAt < deployment.requestedAt ||
          observed.residualResourcesSettledAt < observed.vmAbsenceVerifiedAt))
    ) {
      return this.#beginFatalCleanup(
        await this.#releaseOperation(current),
        "malformed-provider-output",
      );
    }
    const completed: GenerationZoneDeployment =
      observed.outcome === "vm-created"
        ? {
            ...latestDeployment,
            completedAt: observed.completedAt,
            outcome: "vm-created",
            vmResourceId: observed.vmResourceId,
          }
        : {
            ...latestDeployment,
            completedAt: observed.completedAt,
            outcome: observed.outcome,
            residualResourcesSettledAt: observed.residualResourcesSettledAt,
            vmAbsenceVerifiedAt: observed.vmAbsenceVerifiedAt,
          };
    await this.#updateGeneration(
      current,
      {
        ...generationState(latest),
        providerVmId: observed.outcome === "vm-created" ? observed.providerVmId : null,
        operationLease: null,
        state: "provisioning",
        vmResourceId: observed.outcome === "vm-created" ? observed.vmResourceId : null,
        zoneDeployments: [...latest.zoneDeployments.slice(0, -1), completed],
      },
      observed.completedAt,
    );
    return {
      allocationId: current.allocation.allocationId,
      outcome: "progress",
      stage: observed.outcome,
    };
  }

  async #reconcileSchedule(aggregate: AzureAggregate): Promise<AzureWorkerResult> {
    const generation = requiredGeneration(aggregate);
    const vmResourceId = requiredString(generation.vmResourceId);
    const plan = validatePlan(
      aggregate.allocation.allocationId,
      await this.#planning.plan({
        allocation: aggregate.allocation,
        attempt: aggregate.attempt,
        generationNumber: 1,
        location: AZURE_PILOT_LOCATION,
        persistedBasePlan: generation.basePlan,
        vmSize: generation.vmSize,
      }),
      generation.basePlan,
    );
    const names = azureGenerationOneNames({
      allocationId: aggregate.allocation.allocationId,
      subscriptionId: plan.subscriptionId,
    });
    if (generation.schedule === null) {
      const requestedAt = this.#nowIso();
      await this.#updateGeneration(
        aggregate,
        {
          ...generationState(generation),
          schedule: {
            acceptedAt: null,
            deadlineType: "CompleteBy",
            lastCheckedAt: requestedAt,
            providerOperationId: null,
            requestCorrelationId: names.scheduleCorrelationId,
            requestedDeadline: aggregate.deadlines.computeDeadline,
            status: "requested",
            targetVmResourceId: vmResourceId,
          },
          state: "provisioning",
        },
        requestedAt,
      );
      return {
        allocationId: aggregate.allocation.allocationId,
        outcome: "progress",
        stage: "schedule-intent-recorded",
      };
    }
    const existing = requestedOrAcceptedSchedule(generation);
    if (existing.providerOperationId === null && generation.operationLease !== null) {
      if (generation.operationLease.kind !== "schedule-submit") {
        return this.#beginFatalCleanup(aggregate, "malformed-provider-output");
      }
      if (generation.operationLease.expiresAt > this.#nowIso()) {
        return {
          allocationId: aggregate.allocation.allocationId,
          outcome: "progress",
          stage: "schedule-fenced",
        };
      }
      return this.#beginFatalCleanup(
        await this.#releaseOperation(aggregate),
        "schedule-submission-unconfirmed",
      );
    }
    const claimed = await this.#claimOperation(aggregate, "schedule-submit");
    if (claimed === undefined) {
      return {
        allocationId: aggregate.allocation.allocationId,
        outcome: "progress",
        stage: "schedule-fenced",
      };
    }
    let observed: GenerationScheduleOperation;
    try {
      observed = await this.#schedule.ensureCompleteBy({
        correlationId: names.scheduleCorrelationId,
        existing,
        providerVmId: requiredString(generation.providerVmId),
        requestedDeadline: aggregate.deadlines.computeDeadline,
        targetVmResourceId: vmResourceId,
      });
    } catch {
      if (existing.providerOperationId === null) {
        const current = await this.#load(claimed.allocation.allocationId);
        const latestLease = requiredGeneration(current).operationLease;
        if (latestLease?.leaseId !== requiredGeneration(claimed).operationLease?.leaseId) {
          return this.#incident(
            current.allocation.allocationId,
            "authoritative-state-invalid",
            true,
          );
        }
        return this.#beginFatalCleanup(
          await this.#releaseOperation(current),
          "schedule-submission-unconfirmed",
        );
      }
      return this.#incident(claimed.allocation.allocationId, "unknown-external-failure", true);
    }
    const current = await this.#load(aggregate.allocation.allocationId);
    const latest = requiredGeneration(current);
    if (latest.operationLease?.leaseId !== requiredGeneration(claimed).operationLease?.leaseId) {
      return this.#incident(current.allocation.allocationId, "authoritative-state-invalid", true);
    }
    if (!sameScheduleIdentity(observed, existing)) {
      return this.#beginFatalCleanup(
        await this.#releaseOperation(current),
        "malformed-provider-output",
      );
    }
    const updated = await this.#updateGeneration(
      current,
      {
        ...generationState(latest),
        operationLease: null,
        schedule: observed,
        state: "provisioning",
      },
      observed.lastCheckedAt,
    );
    if (
      observed.status === "rejected" ||
      observed.status === "failed" ||
      observed.status === "executed"
    ) {
      return this.#beginFatalCleanup(
        updated,
        observed.status === "executed"
          ? "schedule-executed-before-assignment"
          : `schedule-${observed.status}`,
      );
    }
    return {
      allocationId: current.allocation.allocationId,
      outcome: "progress",
      stage: `schedule-${observed.status}`,
    };
  }

  async #reconcilePrerequisites(aggregate: AzureAggregate): Promise<AzureWorkerResult> {
    const generation = requiredGeneration(aggregate);
    await this.#load(aggregate.allocation.allocationId);
    const observed = await this.#azure.observeLaunchPrerequisites({
      providerVmId: requiredString(generation.providerVmId),
      vmResourceId: requiredString(generation.vmResourceId),
    });
    const current = await this.#load(aggregate.allocation.allocationId);
    if (observed.outcome === "pending") {
      return {
        allocationId: current.allocation.allocationId,
        outcome: "progress",
        stage: "bootstrap-pending",
      };
    }
    const latest = requiredGeneration(current);
    await this.#updateGeneration(
      current,
      {
        ...generationState(latest),
        launchPrerequisites: observed,
        state: "provisioning",
      },
      observed.checkedAt,
    );
    return {
      allocationId: current.allocation.allocationId,
      outcome: "progress",
      stage: "bootstrap-ready",
    };
  }

  async #reconcileLaunch(aggregate: AzureAggregate): Promise<AzureWorkerResult> {
    const generation = requiredGeneration(aggregate);
    const runnerLabel = azureRunnerLabelForAllocation(aggregate.allocation.allocationId);
    await this.#load(aggregate.allocation.allocationId);
    const priorLaunch = await this.#azure.observeJitLaunch({ generation });
    const afterObservation = await this.#load(aggregate.allocation.allocationId);
    const currentGeneration = requiredGeneration(afterObservation);
    const command = currentGeneration.managedRunCommand;
    if (command !== null) {
      if (priorLaunch.outcome === "absent") {
        return this.#beginFatalCleanup(afterObservation, "jit-launch-failed");
      }
      if (!sameLaunchIdentity(priorLaunch, command)) {
        return this.#beginFatalCleanup(afterObservation, "malformed-provider-output");
      }
      const updated = await this.#updateGeneration(
        afterObservation,
        {
          ...generationState(currentGeneration),
          managedRunCommand: { ...command, launchConfirmedAt: priorLaunch.launchConfirmedAt },
          state: "provisioning",
        },
        priorLaunch.launchConfirmedAt,
      );
      return this.#deleteRunCommand(updated);
    }
    if (priorLaunch.outcome === "launched") {
      return this.#beginFatalCleanup(afterObservation, "malformed-provider-output");
    }
    if (currentGeneration.jitMintIntent !== null) {
      return this.#beginFatalCleanup(afterObservation, "github-jit-failed");
    }
    const runner = await this.#github.observeExactRunner({ runnerLabel });
    const afterRunner = await this.#load(aggregate.allocation.allocationId);
    if (runner.outcome !== "absent") {
      return this.#beginFatalCleanup(
        afterRunner,
        runner.outcome === "ambiguous" ? "ambiguous-runner" : "github-jit-failed",
      );
    }
    const plan = validatePlan(
      aggregate.allocation.allocationId,
      await this.#planning.plan({
        allocation: afterRunner.allocation,
        attempt: afterRunner.attempt,
        generationNumber: 1,
        location: AZURE_PILOT_LOCATION,
        persistedBasePlan: requiredGeneration(afterRunner).basePlan,
        vmSize: requiredGeneration(afterRunner).vmSize,
      }),
      requiredGeneration(afterRunner).basePlan,
    );
    const names = azureGenerationOneNames({
      allocationId: aggregate.allocation.allocationId,
      subscriptionId: plan.subscriptionId,
    });
    const mintIntentAt = this.#nowIso();
    const mintLeaseId = randomUUID();
    const withMintLease = await this.#updateGeneration(
      afterRunner,
      {
        ...generationState(requiredGeneration(afterRunner)),
        jitMintIntent: {
          intentId: names.jitMintIntentId,
          jitDeploymentId: names.jitDeploymentId,
          requestedAt: mintIntentAt,
        },
        operationLease: {
          acquiredAt: mintIntentAt,
          expiresAt: new Date(Date.parse(mintIntentAt) + 120_000).toISOString(),
          kind: "jit-mint-launch",
          leaseId: mintLeaseId,
        },
        state: "provisioning",
      },
      mintIntentAt,
    );
    let minted: Awaited<ReturnType<AzureRunnerGitHubPort["mintJitConfiguration"]>>;
    try {
      minted = await this.#github.mintJitConfiguration({
        allocationId: aggregate.allocation.allocationId,
        runnerLabel,
      });
    } catch {
      return this.#beginFatalCleanup(
        await this.#releaseOperation(withMintLease),
        "github-jit-failed",
      );
    }
    if (
      !/^[1-9][0-9]*$/.test(minted.runnerRegistrationId) ||
      minted.encodedJitConfiguration.length === 0 ||
      minted.encodedJitConfiguration.length > 65_536
    ) {
      return this.#beginFatalCleanup(
        await this.#releaseOperation(withMintLease),
        "github-jit-failed",
      );
    }
    const beforeCommandIntent = await this.#load(aggregate.allocation.allocationId);
    const latestGeneration = requiredGeneration(beforeCommandIntent);
    if (
      latestGeneration.managedRunCommand !== null ||
      latestGeneration.runnerRegistrationId !== null ||
      latestGeneration.jitMintIntent?.intentId !== names.jitMintIntentId ||
      latestGeneration.operationLease?.leaseId !== mintLeaseId
    ) {
      return this.#beginFatalCleanup(
        await this.#releaseOperation(beforeCommandIntent),
        "github-jit-failed",
      );
    }
    const requestedAt = this.#nowIso();
    const managedRunCommandId = `${requiredString(latestGeneration.vmResourceId)}/runCommands/launch-jit-g1`;
    let withIntent: AzureAggregate;
    try {
      withIntent = await this.#updateGeneration(
        beforeCommandIntent,
        {
          ...generationState(latestGeneration),
          managedRunCommand: {
            boundVmResourceId: requiredString(latestGeneration.vmResourceId),
            deleteCompletedAt: null,
            deleteRequestedAt: null,
            launchConfirmedAt: null,
            managedRunCommandId,
            requestedAt,
          },
          runnerRegistrationId: minted.runnerRegistrationId,
          state: "provisioning",
        },
        requestedAt,
      );
    } catch {
      return this.#beginFatalCleanup(
        await this.#releaseOperation(await this.#load(aggregate.allocation.allocationId)),
        "github-jit-failed",
      );
    }
    let launched: Exclude<AzureLaunchObservation, { readonly outcome: "absent" }>;
    try {
      launched = await this.#azure.launchJit({
        acceptedSchedule: acceptedScheduleFor(requiredGeneration(withIntent)),
        encodedJitConfiguration: minted.encodedJitConfiguration,
        generation: requiredGeneration(withIntent),
        jitDeploymentName: names.jitDeploymentName,
        managedRunCommandId,
        templatePath: AZURE_JIT_LAUNCH_TEMPLATE_PATH,
      });
    } catch {
      return this.#beginFatalCleanup(
        await this.#releaseOperation(await this.#load(aggregate.allocation.allocationId)),
        "jit-launch-failed",
      );
    }
    const afterLaunch = await this.#load(aggregate.allocation.allocationId);
    const persistedCommand = requiredGeneration(afterLaunch).managedRunCommand;
    if (persistedCommand === null || !sameLaunchIdentity(launched, persistedCommand)) {
      return this.#beginFatalCleanup(
        await this.#releaseOperation(afterLaunch),
        "malformed-provider-output",
      );
    }
    const updated = await this.#updateGeneration(
      afterLaunch,
      {
        ...generationState(requiredGeneration(afterLaunch)),
        managedRunCommand: {
          ...persistedCommand,
          launchConfirmedAt: launched.launchConfirmedAt,
        },
        operationLease: null,
        state: "provisioning",
      },
      launched.launchConfirmedAt,
    );
    return this.#deleteRunCommand(updated);
  }

  async #deleteRunCommand(aggregate: AzureAggregate): Promise<AzureWorkerResult> {
    let generation = requiredGeneration(aggregate);
    let command = generation.managedRunCommand;
    if (command === null) throw new AzureWorkerError("authoritative-state-invalid");
    const claimed = await this.#claimOperation(aggregate, "run-command-delete");
    if (claimed === undefined) {
      return {
        allocationId: aggregate.allocation.allocationId,
        outcome: "progress",
        stage: "run-command-delete-fenced",
      };
    }
    let current = claimed;
    generation = requiredGeneration(current);
    command = generation.managedRunCommand;
    if (command === null) throw new AzureWorkerError("authoritative-state-invalid");
    const submitDelete = command.deleteRequestedAt === null;
    const deleteRequestedAt = command.deleteRequestedAt ?? this.#nowIso();
    if (submitDelete) {
      current = await this.#updateGeneration(
        current,
        {
          ...generationState(generation),
          managedRunCommand: {
            ...command,
            deleteRequestedAt,
          },
          state: "provisioning",
        },
        deleteRequestedAt,
      );
    }
    let rawDeletion: unknown;
    try {
      rawDeletion = await this.#azure.deleteManagedRunCommand({
        deleteRequestedAt,
        managedRunCommandId: command.managedRunCommandId,
        submitDelete,
      });
    } catch {
      return this.#incident(current.allocation.allocationId, "unknown-external-failure", true);
    }
    current = await this.#load(aggregate.allocation.allocationId);
    const deleted = parseRunCommandDeletionObservation(rawDeletion, deleteRequestedAt);
    if (deleted === null) {
      return this.#beginFatalCleanup(
        await this.#releaseOperation(current),
        "malformed-provider-output",
      );
    }
    const latest = requiredGeneration(current);
    const latestCommand = latest.managedRunCommand;
    if (latestCommand === null) throw new AzureWorkerError("authoritative-state-invalid");
    if (
      deleted.requestedAt !== deleteRequestedAt ||
      deleted.requestedAt < latestCommand.requestedAt ||
      (deleted.outcome === "deleted" && deleted.completedAt < deleted.requestedAt) ||
      (deleted.outcome === "pending" && deleted.checkedAt < deleted.requestedAt)
    ) {
      return this.#beginFatalCleanup(
        await this.#releaseOperation(current),
        "malformed-provider-output",
      );
    }
    if (deleted.outcome === "pending") {
      await this.#updateGeneration(
        current,
        {
          ...generationState(latest),
          managedRunCommand: {
            ...latestCommand,
            deleteRequestedAt,
          },
          operationLease: null,
          state: "provisioning",
        },
        deleted.checkedAt,
      );
      return {
        allocationId: current.allocation.allocationId,
        outcome: "progress",
        stage: "run-command-delete-pending",
      };
    }
    await this.#updateGeneration(
      current,
      {
        ...generationState(latest),
        managedRunCommand: {
          ...latestCommand,
          deleteCompletedAt: deleted.completedAt,
          deleteRequestedAt: deleted.requestedAt,
        },
        operationLease: null,
        state: "provisioning",
      },
      deleted.completedAt,
    );
    return {
      allocationId: current.allocation.allocationId,
      outcome: "progress",
      stage: "run-command-deleted",
    };
  }

  async #reconcileReadiness(aggregate: AzureAggregate): Promise<AzureWorkerResult> {
    const generation = requiredGeneration(aggregate);
    const schedule = acceptedScheduleFor(generation);
    const runnerLabel = azureRunnerLabelForAllocation(aggregate.allocation.allocationId);
    await this.#load(aggregate.allocation.allocationId);
    const runner = await this.#github.observeExactRunner({ runnerLabel });
    const afterRunner = await this.#load(aggregate.allocation.allocationId);
    if (runner.outcome === "ambiguous") {
      return this.#beginFatalCleanup(afterRunner, "ambiguous-runner");
    }
    if (runner.outcome !== "exact" || !runner.online || !runner.idle) {
      return {
        allocationId: afterRunner.allocation.allocationId,
        outcome: "progress",
        stage: "runner-pending",
      };
    }
    if (runner.runnerRegistrationId !== requiredGeneration(afterRunner).runnerRegistrationId) {
      return this.#beginFatalCleanup(afterRunner, "ambiguous-runner");
    }
    const plan = validatePlan(
      aggregate.allocation.allocationId,
      await this.#planning.plan({
        allocation: afterRunner.allocation,
        attempt: afterRunner.attempt,
        generationNumber: 1,
        location: AZURE_PILOT_LOCATION,
        persistedBasePlan: generation.basePlan,
        vmSize: generation.vmSize,
      }),
      generation.basePlan,
    );
    const names = azureGenerationOneNames({
      allocationId: aggregate.allocation.allocationId,
      subscriptionId: plan.subscriptionId,
    });
    const claimed = await this.#claimOperation(afterRunner, "schedule-submit");
    if (claimed === undefined) {
      return {
        allocationId: aggregate.allocation.allocationId,
        outcome: "progress",
        stage: "schedule-refresh-fenced",
      };
    }
    let refreshedSchedule: GenerationScheduleOperation;
    try {
      refreshedSchedule = await this.#schedule.ensureCompleteBy({
        correlationId: names.scheduleCorrelationId,
        existing: schedule,
        providerVmId: requiredString(generation.providerVmId),
        requestedDeadline: aggregate.deadlines.computeDeadline,
        targetVmResourceId: requiredString(generation.vmResourceId),
      });
    } catch {
      return this.#incident(claimed.allocation.allocationId, "unknown-external-failure", true);
    }
    const afterSchedule = await this.#load(aggregate.allocation.allocationId);
    if (!sameScheduleIdentity(refreshedSchedule, schedule)) {
      return this.#beginFatalCleanup(
        await this.#releaseOperation(afterSchedule),
        "malformed-provider-output",
      );
    }
    if (refreshedSchedule.status !== "accepted") {
      const latest = requiredGeneration(afterSchedule);
      const withFailure = await this.#updateGeneration(
        afterSchedule,
        {
          ...generationState(latest),
          operationLease: null,
          schedule: refreshedSchedule,
          state: "provisioning",
        },
        refreshedSchedule.lastCheckedAt,
      );
      return this.#beginFatalCleanup(
        withFailure,
        refreshedSchedule.status === "executed"
          ? "schedule-executed-before-assignment"
          : "schedule-failed",
      );
    }
    if (refreshedSchedule.lastCheckedAt < runner.checkedAt) {
      return this.#beginFatalCleanup(afterSchedule, "malformed-provider-output");
    }
    const withSchedule = await this.#updateGeneration(
      afterSchedule,
      {
        ...generationState(requiredGeneration(afterSchedule)),
        operationLease: null,
        schedule: refreshedSchedule,
        state: "provisioning",
      },
      refreshedSchedule.lastCheckedAt,
    );
    const current = await this.#load(withSchedule.allocation.allocationId);
    const latest = requiredGeneration(current);
    const readyAt = latestIso(this.#nowIso(), refreshedSchedule.lastCheckedAt, runner.checkedAt);
    if (readyAt >= readinessCutoffFor(current.attempt)) {
      return this.#beginCleanup(current);
    }
    await this.#updateGeneration(
      current,
      {
        ...generationState(latest),
        readyAt,
        runnerReadiness: { checkedAt: runner.checkedAt, idle: true, online: true },
        state: "ready",
      },
      readyAt,
    );
    return this.#markSuccessAndAssign(await this.#load(current.allocation.allocationId));
  }

  async #markSuccessAndAssign(aggregate: AzureAggregate): Promise<AzureWorkerResult> {
    requiredGeneration(aggregate);
    let current = aggregate;
    if (current.attempt.outcome === "pending") {
      const succeededAt = this.#nowIso();
      const allocation = await this.#ledger.markProviderAttemptSucceeded({
        allocationId: current.allocation.allocationId,
        expectedAllocationRevision: current.allocation.revision,
        expectedAttemptRevision: current.attempt.revision,
        ordinal: 1,
        succeededAt,
      });
      current = aggregateFrom(allocation);
    }
    if (this.#nowIso() >= readinessCutoffFor(current.attempt)) {
      return this.#beginFatalCleanup(current, "deadline-missed-after-success");
    }
    const runnerLabel = azureRunnerLabelForAllocation(current.allocation.allocationId);
    await this.#load(current.allocation.allocationId);
    const runner = await this.#github.observeExactRunner({ runnerLabel });
    const reloaded = await this.#load(current.allocation.allocationId);
    if (
      runner.outcome !== "exact" ||
      !runner.online ||
      !runner.idle ||
      runner.runnerRegistrationId !== requiredGeneration(reloaded).runnerRegistrationId
    ) {
      return this.#beginFatalCleanup(reloaded, "lost-runner-before-assignment");
    }
    const generation = requiredGeneration(reloaded);
    const schedule = acceptedScheduleFor(generation);
    const names = azureGenerationOneNames({
      allocationId: reloaded.allocation.allocationId,
      subscriptionId: generation.basePlan.subscriptionId,
    });
    let refreshedSchedule: GenerationScheduleOperation;
    try {
      refreshedSchedule = await this.#schedule.ensureCompleteBy({
        correlationId: names.scheduleCorrelationId,
        existing: schedule,
        providerVmId: requiredString(generation.providerVmId),
        requestedDeadline: reloaded.deadlines.computeDeadline,
        targetVmResourceId: requiredString(generation.vmResourceId),
      });
    } catch {
      return this.#incident(reloaded.allocation.allocationId, "unknown-external-failure", false);
    }
    const afterSchedule = await this.#load(reloaded.allocation.allocationId);
    if (!sameScheduleIdentity(refreshedSchedule, schedule)) {
      return this.#beginFatalCleanup(afterSchedule, "malformed-provider-output");
    }
    if (refreshedSchedule.status !== "accepted") {
      return this.#beginFatalCleanup(
        afterSchedule,
        refreshedSchedule.status === "executed"
          ? "schedule-executed-before-assignment"
          : "schedule-failed",
      );
    }
    if (refreshedSchedule.lastCheckedAt < runner.checkedAt) {
      return this.#beginFatalCleanup(afterSchedule, "malformed-provider-output");
    }
    const withSchedule = await this.#updateGeneration(
      afterSchedule,
      {
        ...generationState(requiredGeneration(afterSchedule)),
        schedule: refreshedSchedule,
        state: "ready",
      },
      refreshedSchedule.lastCheckedAt,
    );
    const assignedAt = latestIso(this.#nowIso(), runner.checkedAt, refreshedSchedule.lastCheckedAt);
    if (assignedAt >= readinessCutoffFor(withSchedule.attempt)) {
      return this.#beginFatalCleanup(withSchedule, "deadline-missed-after-success");
    }
    const assigned = await this.#ledger.assignRunner({
      allocationId: withSchedule.allocation.allocationId,
      assignment: {
        assignedAt,
        attemptOrdinal: 1,
        generationNumber: 1,
        provider: "azure",
        readinessCheckedAt: runner.checkedAt,
        runnerIdle: true,
        runnerRegistrationId: runner.runnerRegistrationId,
        runnerOnline: true,
        runnerLabel,
      },
      expectedAllocationRevision: withSchedule.allocation.revision,
    });
    return { allocationId: assigned.allocationId, outcome: "ready", runnerLabel };
  }

  async #reconcileSuccessfulAttempt(aggregate: AzureAggregate): Promise<AzureWorkerResult> {
    if (aggregate.allocation.runnerAssignment?.provider === "azure") {
      return {
        allocationId: aggregate.allocation.allocationId,
        outcome: "ready",
        runnerLabel: aggregate.allocation.runnerAssignment.runnerLabel,
      };
    }
    return this.#markSuccessAndAssign(aggregate);
  }

  async #beginFatalCleanup(
    aggregate: AzureAggregate,
    classification: FatalAzureAbortClassification,
  ): Promise<AzureWorkerResult> {
    let current = aggregate;
    const generation = requiredGeneration(current);
    if (generation.operationLease !== null) {
      if (generation.operationLease.expiresAt > this.#nowIso()) {
        return {
          allocationId: current.allocation.allocationId,
          outcome: "progress",
          stage: "provider-operation-in-flight",
        };
      }
      current = await this.#releaseOperation(current);
    }
    if (current.attempt.fatalAbortIntent === null) {
      const allocation = await this.#ledger.beginFatalAzureAbort({
        allocationId: current.allocation.allocationId,
        classification,
        expectedAllocationRevision: current.allocation.revision,
        expectedAttemptRevision: current.attempt.revision,
        ordinal: 1,
        recordedAt: this.#nowIso(),
      });
      current = aggregateFrom(allocation);
    } else if (current.attempt.fatalAbortIntent.classification !== classification) {
      return this.#incident(current.allocation.allocationId, "authoritative-state-invalid", false);
    }
    await this.#beginCleanup(current);
    await this.#raise(current.allocation.allocationId, classification);
    return {
      allocationId: current.allocation.allocationId,
      code: classification,
      cleanupPending: true,
      outcome: "incident",
    };
  }

  async #beginCleanup(aggregate: AzureAggregate): Promise<AzureWorkerResult> {
    const generation = requiredGeneration(aggregate);
    if (generation.operationLease !== null) {
      if (generation.operationLease.expiresAt <= this.#nowIso()) {
        await this.#releaseOperation(aggregate);
      }
      return {
        allocationId: aggregate.allocation.allocationId,
        outcome: "progress",
        stage: "provider-operation-in-flight",
      };
    }
    if (generation.state !== "fenced" && generation.state !== "cleanup_pending") {
      const current = await this.#load(aggregate.allocation.allocationId);
      const latest = requiredGeneration(current);
      const startedAt = this.#nowIso();
      await this.#updateGeneration(
        current,
        {
          ...generationState(latest),
          cleanup: { ...latest.cleanup, phase: "pending", startedAt },
          state: "cleanup_pending",
        },
        startedAt,
      );
    }
    return {
      allocationId: aggregate.allocation.allocationId,
      outcome: "progress",
      stage: "cleanup-started",
    };
  }

  async #continueCleanup(aggregate: AzureAggregate): Promise<AzureWorkerResult> {
    let current = aggregate;
    let generation = requiredGeneration(current);
    const runnerLabel = azureRunnerLabelForAllocation(current.allocation.allocationId);
    let cleanupFailed = false;
    let providerDeletionPending = false;
    let progressedStage: string | null = null;

    // Provider billing cleanup is deliberately independent of GitHub. A GitHub
    // or Doppler outage must never keep the VM, disk or public IP alive.
    if (!generation.cleanup.providerResourcesSettled) {
      const branchStartedAt = generation.cleanup.startedAt;
      if (branchStartedAt === null) {
        return this.#incident(current.allocation.allocationId, "authoritative-state-invalid", true);
      }
      try {
        current = await this.#resolveCleanupVm(current, branchStartedAt);
        generation = requiredGeneration(current);
        const compute = await this.#azure.fenceCompute({
          computeDeadline: current.deadlines.computeDeadline,
          providerVmId: generation.providerVmId,
          resourceGroupId: generation.resourceGroupId,
          vmResourceId: generation.vmResourceId,
        });
        if (compute.outcome === "pending") {
          providerDeletionPending = true;
        } else if (!isCleanupStepAtOrAfter(compute.settledAt, branchStartedAt, this.#nowIso())) {
          cleanupFailed = true;
        } else {
          const deploymentIds = [
            ...generation.zoneDeployments.map((entry) => entry.deploymentId),
            ...(generation.jitMintIntent === null
              ? []
              : [generation.jitMintIntent.jitDeploymentId]),
          ];
          const deployments = await this.#azure.settleDeployments({ deploymentIds });
          if (
            !isExactDeploymentSettlement(deployments, deploymentIds) ||
            !isCleanupStepAtOrAfter(deployments.settledAt, compute.settledAt, this.#nowIso())
          ) {
            cleanupFailed = true;
          } else {
            const deletion = await this.#azure.deleteResourceGroup({
              resourceGroupId: generation.resourceGroupId,
            });
            if (
              !isCleanupStepAtOrAfter(deletion.requestedAt, deployments.settledAt, this.#nowIso())
            ) {
              cleanupFailed = true;
            } else {
              const absent = await this.#azure.resourceGroupAbsent({
                resourceGroupId: generation.resourceGroupId,
              });
              const observedAt = this.#nowIso();
              if (!isCleanupStepAtOrAfter(absent.checkedAt, deletion.requestedAt, observedAt)) {
                cleanupFailed = true;
              } else if (!absent.absent) {
                if (observedAt >= current.deadlines.absoluteExpiry) {
                  cleanupFailed = true;
                } else {
                  providerDeletionPending = true;
                }
              } else {
                current = await this.#load(current.allocation.allocationId);
                generation = requiredGeneration(current);
                current = await this.#updateGeneration(
                  current,
                  {
                    ...generationState(generation),
                    cleanup: {
                      ...generation.cleanup,
                      phase: "pending",
                      providerResourcesSettled: true,
                    },
                    state: "cleanup_pending",
                  },
                  latestIso(absent.checkedAt, this.#nowIso()),
                );
                generation = requiredGeneration(current);
                progressedStage = "provider-resources-deleted";
              }
            }
          }
        }
      } catch {
        cleanupFailed = true;
      }
    }

    // Runner registration cleanup is retried independently. It may complete
    // before or after provider deletion, but both must be durable before final
    // settlement can release the reservation.
    if (!generation.cleanup.runnerRegistrationSettled) {
      const branchStartedAt = generation.cleanup.startedAt;
      if (branchStartedAt === null) {
        return this.#incident(current.allocation.allocationId, "authoritative-state-invalid", true);
      }
      try {
        const fenced = await this.#github.fenceRunner({
          runnerLabel,
          runnerRegistrationId: generation.runnerRegistrationId,
        });
        if (
          fenced.allMatchingRegistrationsAbsent !== true ||
          fenced.runnerLabel !== runnerLabel ||
          !isCleanupStepAtOrAfter(fenced.settledAt, branchStartedAt, this.#nowIso())
        ) {
          cleanupFailed = true;
        } else {
          current = await this.#load(current.allocation.allocationId);
          generation = requiredGeneration(current);
          current = await this.#updateGeneration(
            current,
            {
              ...generationState(generation),
              cleanup: {
                ...generation.cleanup,
                phase: "pending",
                runnerRegistrationSettled: true,
              },
              state: "cleanup_pending",
            },
            latestIso(fenced.settledAt, this.#nowIso()),
          );
          generation = requiredGeneration(current);
          progressedStage = progressedStage ?? "runner-registration-fenced";
        }
      } catch {
        cleanupFailed = true;
      }
    }

    if (
      generation.cleanup.providerResourcesSettled &&
      generation.cleanup.runnerRegistrationSettled
    ) {
      const settledAt = latestIso(this.#nowIso(), generation.updatedAt);
      current = await this.#updateGeneration(
        current,
        {
          ...generationState(generation),
          cleanup: { ...generation.cleanup, phase: "settled", settledAt },
          state: "settled",
        },
        settledAt,
      );
      return {
        allocationId: current.allocation.allocationId,
        outcome: "progress",
        stage: "resources-deleted",
      };
    }
    if (cleanupFailed) {
      return this.#incident(current.allocation.allocationId, "cleanup-failed", true);
    }
    return {
      allocationId: current.allocation.allocationId,
      outcome: "progress",
      stage:
        progressedStage ??
        (providerDeletionPending ? "resource-deletion-pending" : "cleanup-pending"),
    };
  }

  async #resolveCleanupVm(
    aggregate: AzureAggregate,
    branchStartedAt: string,
  ): Promise<AzureAggregate> {
    const generation = requiredGeneration(aggregate);
    if (generation.providerVmId !== null && generation.vmResourceId !== null) return aggregate;
    if (generation.providerVmId !== null || generation.vmResourceId !== null) {
      throw new AzureWorkerError("authoritative-state-invalid");
    }
    const names = azureGenerationOneNames({
      allocationId: aggregate.allocation.allocationId,
      subscriptionId: generation.basePlan.subscriptionId,
    });
    const observed = await this.#azure.observeCleanupVm({
      resourceGroupId: generation.resourceGroupId,
      vmResourceId: names.vmResourceId,
    });
    if (!isCleanupStepAtOrAfter(observed.checkedAt, branchStartedAt, this.#nowIso())) {
      throw new AzureWorkerError("cleanup-failed");
    }
    if (observed.outcome === "absent") return aggregate;
    if (
      observed.vmResourceId !== names.vmResourceId ||
      !isCanonicalProviderVmId(observed.providerVmId)
    ) {
      throw new AzureWorkerError("cleanup-failed");
    }
    // A live VM discovered only after cleanup starts is not sufficient proof
    // that it is the VM created by the original fenced deployment operation.
    // Retain the reservation and require operator recovery rather than adopting
    // or deleting it from current tags alone.
    throw new AzureWorkerError("cleanup-failed");
  }

  async #finishCleanup(aggregate: AzureAggregate): Promise<AzureWorkerResult> {
    const generation = requiredGeneration(aggregate);
    const settledAt = generation.cleanup.settledAt;
    if (settledAt === null) throw new AzureWorkerError("authoritative-state-invalid");
    const current = await this.#load(aggregate.allocation.allocationId);
    const latestAttempt = current.attempt;
    const fatal = latestAttempt.fatalAbortIntent;
    if (fatal !== null) {
      await this.#ledger.settleFatalAzureAbort({
        allocationId: current.allocation.allocationId,
        classification: fatal.classification,
        cleanup: {
          phase: "settled",
          providerResourcesSettled: true,
          runnerRegistrationSettled: true,
          settledAt,
        },
        expectedAllocationRevision: current.allocation.revision,
        expectedAttemptRevision: latestAttempt.revision,
        finalCostUsdCents: latestAttempt.reservation.reservedCostUsdCents,
        ordinal: 1,
        settledAt,
      });
      return this.#incident(current.allocation.allocationId, fatal.classification, false);
    }
    if (latestAttempt.outcome !== "pending" || current.allocation.runnerAssignment !== null) {
      return this.#incident(current.allocation.allocationId, "authoritative-state-invalid", false);
    }
    const classification = generation.zoneDeployments.some(
      (entry) => entry.outcome === "management-plane-unavailable",
    )
      ? "management-plane-provisioning"
      : generation.zoneDeployments.length === 3 &&
          generation.zoneDeployments.every((entry) => entry.outcome === "no-vm-created")
        ? "zones-exhausted"
        : "readiness-timeout";
    await this.#ledger.settleUnavailableProviderAttempt({
      allocationId: current.allocation.allocationId,
      classification,
      cleanup: {
        phase: "settled",
        providerResourcesSettled: true,
        runnerRegistrationSettled: true,
        settledAt,
      },
      expectedAllocationRevision: current.allocation.revision,
      expectedAttemptRevision: latestAttempt.revision,
      finalCostUsdCents: latestAttempt.reservation.reservedCostUsdCents,
      ordinal: 1,
      settledAt,
    });
    return {
      allocationId: current.allocation.allocationId,
      classification,
      outcome: "unavailable",
    };
  }

  async #updateGeneration(
    aggregate: AzureAggregate,
    state: PhysicalGenerationState,
    updatedAt = this.#nowIso(),
  ): Promise<AzureAggregate> {
    const generation = requiredGeneration(aggregate);
    const allocation = await this.#ledger.updatePhysicalGenerationFenced({
      allocationId: aggregate.allocation.allocationId,
      attemptOrdinal: 1,
      expectedAllocationRevision: aggregate.allocation.revision,
      expectedAttemptRevision: aggregate.attempt.revision,
      expectedRevision: generation.revision,
      generationNumber: 1,
      state,
      updatedAt,
    });
    return aggregateFrom(allocation);
  }

  async #claimOperation(
    aggregate: AzureAggregate,
    kind: GenerationOperationKind,
  ): Promise<AzureAggregate | undefined> {
    const current = await this.#load(aggregate.allocation.allocationId);
    const generation = requiredGeneration(current);
    const now = this.#nowIso();
    if (
      current.attempt.fatalAbortIntent !== null ||
      generation.state === "fenced" ||
      generation.state === "cleanup_pending" ||
      generation.state === "settled" ||
      now >= readinessCutoffFor(current.attempt)
    ) {
      return undefined;
    }
    if (generation.operationLease !== null) {
      if (generation.operationLease.expiresAt > now) return undefined;
      await this.#updateGeneration(
        current,
        { ...generationState(generation), operationLease: null },
        now,
      );
      return undefined;
    }
    return this.#updateGeneration(
      current,
      {
        ...generationState(generation),
        operationLease: {
          acquiredAt: now,
          expiresAt: new Date(Date.parse(now) + 120_000).toISOString(),
          kind,
          leaseId: randomUUID(),
        },
      },
      now,
    );
  }

  async #releaseOperation(aggregate: AzureAggregate): Promise<AzureAggregate> {
    const current = await this.#load(aggregate.allocation.allocationId);
    const generation = requiredGeneration(current);
    if (generation.operationLease === null) return current;
    return this.#updateGeneration(current, {
      ...generationState(generation),
      operationLease: null,
    });
  }

  async #load(allocationId: string): Promise<AzureAggregate> {
    const allocation = await this.#ledger.getAllocation(allocationId);
    if (allocation === undefined) throw new AzureWorkerError("authoritative-state-invalid");
    return aggregateFrom(allocation);
  }

  async #incident(
    allocationId: string,
    code: AzureWorkerIncidentCode,
    cleanupPending: boolean,
  ): Promise<AzureWorkerResult> {
    await this.#raise(allocationId, code);
    return { allocationId, code, cleanupPending, outcome: "incident" };
  }

  async #raise(allocationId: string, code: AzureWorkerIncidentCode): Promise<void> {
    try {
      await this.#alerts.raise({ allocationId, code, generationNumber: 1 });
    } catch {
      // Alert delivery never blocks cleanup. The caller receives the incident
      // result so the outer reconciler can retry alert delivery independently.
    }
  }

  #nowIso(): string {
    const now = this.#now();
    if (!(now instanceof Date) || !Number.isFinite(now.valueOf())) {
      throw new AzureWorkerError("authoritative-state-invalid");
    }
    return now.toISOString();
  }
}

interface AzureAggregate {
  readonly allocation: AllocationRecord;
  readonly attempt: ProviderAttempt;
  readonly deadlines: NonNullable<ProviderAttempt["deadlines"]>;
  readonly generation: PhysicalGeneration | undefined;
}

class AzureWorkerError extends Error {
  readonly code: AzureWorkerIncidentCode;
  constructor(code: AzureWorkerIncidentCode) {
    super("Azure generation-one state is unavailable");
    this.name = "AzureWorkerError";
    this.code = code;
  }
}

function aggregateFrom(allocation: AllocationRecord): AzureAggregate {
  const attempt = allocation.attempts[0];
  if (
    attempt === undefined ||
    attempt.ordinal !== 1 ||
    attempt.provider !== "azure" ||
    attempt.deadlines === null ||
    attempt.physicalGenerations.length > 1
  ) {
    throw new AzureWorkerError("authoritative-state-invalid");
  }
  return {
    allocation,
    attempt,
    deadlines: attempt.deadlines,
    generation: attempt.physicalGenerations[0],
  };
}

function requiredGeneration(aggregate: AzureAggregate): PhysicalGeneration {
  if (aggregate.generation === undefined || aggregate.generation.generationNumber !== 1) {
    throw new AzureWorkerError("authoritative-state-invalid");
  }
  return aggregate.generation;
}

function generationState(generation: PhysicalGeneration): PhysicalGenerationState {
  return {
    cleanup: generation.cleanup,
    jitMintIntent: generation.jitMintIntent,
    launchPrerequisites: generation.launchPrerequisites,
    managedRunCommand: generation.managedRunCommand,
    operationLease: generation.operationLease,
    providerVmId: generation.providerVmId,
    readyAt: generation.readyAt,
    runnerReadiness: generation.runnerReadiness,
    runnerRegistrationId: generation.runnerRegistrationId,
    schedule: generation.schedule,
    state: generation.state,
    vmResourceId: generation.vmResourceId,
    zoneDeployments: generation.zoneDeployments,
  };
}

function acceptedScheduleFor(
  generation: PhysicalGeneration,
): GenerationScheduleOperation & { readonly status: "accepted" } {
  const schedule = generation.schedule;
  if (schedule?.status !== "accepted") {
    throw new AzureWorkerError("authoritative-state-invalid");
  }
  return { ...schedule, status: "accepted" };
}

function requestedOrAcceptedSchedule(
  generation: PhysicalGeneration,
): GenerationScheduleOperation & { readonly status: "requested" | "accepted" } {
  const schedule = generation.schedule;
  if (schedule?.status !== "requested" && schedule?.status !== "accepted") {
    throw new AzureWorkerError("authoritative-state-invalid");
  }
  return { ...schedule, status: schedule.status };
}

function sameScheduleIdentity(
  observed: GenerationScheduleOperation,
  expected: GenerationScheduleOperation,
): boolean {
  return (
    observed.requestCorrelationId === expected.requestCorrelationId &&
    observed.deadlineType === "CompleteBy" &&
    observed.providerOperationId !== null &&
    (expected.providerOperationId === null ||
      observed.providerOperationId === expected.providerOperationId) &&
    observed.requestedDeadline === expected.requestedDeadline &&
    observed.targetVmResourceId === expected.targetVmResourceId &&
    observed.lastCheckedAt >= expected.lastCheckedAt &&
    (expected.status !== "accepted" || observed.acceptedAt === expected.acceptedAt)
  );
}

function sameLaunchIdentity(
  observed: Exclude<AzureLaunchObservation, { readonly outcome: "absent" }>,
  expected: GenerationManagedRunCommand,
): boolean {
  return (
    observed.managedRunCommandId === expected.managedRunCommandId &&
    observed.requestedAt === expected.requestedAt &&
    observed.launchConfirmedAt >= expected.requestedAt
  );
}

function latestIso(...values: readonly string[]): string {
  return [...values].sort().at(-1) ?? "";
}

function isExactDeploymentSettlement(
  proof: {
    readonly allTerminalOrAbsent: boolean;
    readonly deploymentIds: readonly string[];
    readonly settledAt: string;
  },
  expectedIds: readonly string[],
): boolean {
  if (
    proof === null ||
    typeof proof !== "object" ||
    proof.allTerminalOrAbsent !== true ||
    !Array.isArray(proof.deploymentIds) ||
    proof.deploymentIds.length !== expectedIds.length ||
    !isCanonicalUtcInstant(proof.settledAt)
  ) {
    return false;
  }
  const expected = new Set(expectedIds);
  return (
    expected.size === expectedIds.length &&
    proof.deploymentIds.every(
      (deploymentId) => typeof deploymentId === "string" && expected.delete(deploymentId),
    ) &&
    expected.size === 0
  );
}

function isCanonicalUtcInstant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function parseRunCommandDeletionObservation(
  value: unknown,
  expectedRequestedAt: string,
): AzureManagedRunCommandDeletionObservation | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.requestedAt !== expectedRequestedAt) return null;
  if (candidate.outcome === "pending") {
    if (
      Object.keys(candidate).sort().join(",") !== "checkedAt,outcome,requestedAt" ||
      !isCanonicalUtcInstant(candidate.checkedAt) ||
      candidate.checkedAt < expectedRequestedAt
    ) {
      return null;
    }
    return {
      checkedAt: candidate.checkedAt,
      outcome: "pending",
      requestedAt: expectedRequestedAt,
    };
  }
  if (candidate.outcome === "deleted") {
    if (
      Object.keys(candidate).sort().join(",") !== "completedAt,outcome,requestedAt" ||
      !isCanonicalUtcInstant(candidate.completedAt) ||
      candidate.completedAt < expectedRequestedAt
    ) {
      return null;
    }
    return {
      completedAt: candidate.completedAt,
      outcome: "deleted",
      requestedAt: expectedRequestedAt,
    };
  }
  return null;
}

function isCleanupStepAtOrAfter(
  value: unknown,
  lowerBound: unknown,
  observedAt: unknown,
): value is string {
  return (
    isCanonicalUtcInstant(value) &&
    isCanonicalUtcInstant(lowerBound) &&
    isCanonicalUtcInstant(observedAt) &&
    value >= lowerBound &&
    value <= observedAt
  );
}

export function readinessCutoffFor(attempt: ProviderAttempt): string {
  if (attempt.provider !== "azure" || attempt.deadlines === null) {
    throw new AzureWorkerError("authoritative-state-invalid");
  }
  return attempt.deadlines.latestSafeStart;
}

function vmSizeForProfile(profile: string): AzurePilotVmSize {
  if (profile === "linux-x64-standard") return "Standard_D4ds_v6";
  if (profile === "linux-x64-large") return "Standard_D8ds_v6";
  throw new AzureWorkerError("authoritative-state-invalid");
}

function validatePlan(
  allocationId: string,
  plan: AzureGenerationPlan,
  expectedEvidence?: PhysicalGeneration["basePlan"],
): AzureGenerationPlan {
  const expected = azureGenerationOneNames({ allocationId, subscriptionId: plan.subscriptionId });
  if (
    plan.resourceGroupId !== expected.resourceGroupId ||
    plan.resourceGroupName !== expected.resourceGroupName ||
    AZURE_PILOT_ZONES.some(
      (zone) => plan.baseDeploymentNameByZone[zone] !== expected.baseDeploymentNameByZone[zone],
    ) ||
    plan.imageVersion === "latest" ||
    plan.imageVersion.length < 5 ||
    plan.adminSshPublicKey.length < 32 ||
    plan.nonSecretBootstrapCustomData.length < 1 ||
    plan.sharedRunnerSubnetId.length < 20 ||
    !/^[a-f0-9]{64}$/.test(plan.baseTemplateSha256) ||
    AZURE_PILOT_ZONES.some(
      (zone) => !/^[A-Za-z0-9_.()-]{1,64}$/.test(plan.baseDeploymentNameByZone[zone]),
    )
  ) {
    throw new AzureWorkerError("authoritative-state-invalid");
  }
  if (expectedEvidence !== undefined && !samePlanEvidence(planEvidence(plan), expectedEvidence)) {
    throw new AzureWorkerError("authoritative-state-invalid");
  }
  return Object.freeze(structuredClone(plan));
}

function planEvidence(plan: AzureGenerationPlan): PhysicalGeneration["basePlan"] {
  return {
    adminSshPublicKey: plan.adminSshPublicKey,
    adminSshPublicKeySha256: sha256(plan.adminSshPublicKey),
    baseTemplateSha256: plan.baseTemplateSha256,
    imageVersion: plan.imageVersion,
    nonSecretBootstrapSha256: sha256(plan.nonSecretBootstrapCustomData),
    sharedRunnerSubnetId: plan.sharedRunnerSubnetId,
    subscriptionId: plan.subscriptionId,
  };
}

function samePlanEvidence(
  left: PhysicalGeneration["basePlan"],
  right: PhysicalGeneration["basePlan"],
): boolean {
  return (Object.keys(left) as (keyof PhysicalGeneration["basePlan"])[]).every(
    (key) => left[key] === right[key],
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requiredString(value: string | null): string {
  if (value === null || value.length === 0)
    throw new AzureWorkerError("authoritative-state-invalid");
  return value;
}

function isCanonicalProviderVmId(value: string): boolean {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 128 && value === value.trim()
  );
}

function parseQueueMessage(value: unknown): AzureProvisioningQueueMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Azure provisioning queue message must be an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "allocation_id,ordinal,provider") {
    throw new TypeError("Azure provisioning queue message has unknown or missing fields");
  }
  if (
    typeof record.allocation_id !== "string" ||
    !/^sy1-[a-f0-9]{64}$/.test(record.allocation_id) ||
    record.ordinal !== 1 ||
    record.provider !== "azure"
  ) {
    throw new TypeError("Azure provisioning queue message is not canonical");
  }
  return {
    allocation_id: record.allocation_id,
    ordinal: 1,
    provider: "azure",
  };
}

export function isOptimisticWorkerConflict(error: unknown): boolean {
  return error instanceof AllocationLedgerError && error.code === "optimistic-concurrency-conflict";
}
