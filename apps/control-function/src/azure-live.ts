import { createHash, generateKeyPairSync } from "node:crypto";

import {
  AZURE_BASE_TEMPLATE_PATH,
  type AzureComputeSchedulePort,
  type AzureGenerationPlan,
  type AzureGenerationPlanningPort,
  type AzureResourcePort,
} from "@switchyard/azure-worker";
import {
  type AllocationControlLedger,
  type AllocationRecord,
  AZURE_PILOT_LOCATION,
  type AzurePilotVmSize,
  azureGenerationOneNames,
  type GenerationScheduleOperation,
  type PhysicalGeneration,
  type ProviderAttempt,
} from "@switchyard/core";

const AZURE_MANAGEMENT_SCOPE = "https://management.azure.com/.default";
const COMPUTE_SCHEDULE_API_VERSION = "2025-05-01";
const MAX_AZURE_RESPONSE_BYTES = 1024 * 1024;

export interface AzureTokenCredential {
  getToken(
    scope: string,
  ): Promise<{ readonly expiresOnTimestamp: number; readonly token: string } | null>;
}

export interface AzureRuntimeTransportOptions {
  readonly credential: AzureTokenCredential;
  readonly fetch?: typeof globalThis.fetch;
  readonly subscriptionId: string;
}

export interface AzureScheduleTargetOwnershipPort {
  assertScheduleTargetOwned(vmResourceId: string, providerVmId: string): Promise<void>;
}

/** Bounded ARM transport. Mutating callers deliberately own all retry decisions. */
export class AzureRuntimeTransport {
  readonly #credential: AzureTokenCredential;
  readonly #fetch: typeof globalThis.fetch;
  readonly #subscriptionId: string;

  constructor(options: AzureRuntimeTransportOptions) {
    this.#credential = options.credential;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#subscriptionId = azureSubscriptionId(options.subscriptionId);
  }

  get subscriptionId(): string {
    return this.#subscriptionId;
  }

  async json(input: {
    readonly body?: unknown;
    readonly expectedStatuses: readonly number[];
    readonly method: "GET" | "POST" | "PUT";
    readonly path: string;
    readonly retrySafeGet?: boolean;
    readonly timeoutMilliseconds?: number;
  }): Promise<unknown> {
    const response = await this.request(input);
    return readBoundedJson(response, MAX_AZURE_RESPONSE_BYTES);
  }

  async request(input: {
    readonly body?: unknown;
    readonly expectedStatuses: readonly number[];
    readonly method: "DELETE" | "GET" | "POST" | "PUT";
    readonly path: string;
    readonly retrySafeGet?: boolean;
    readonly timeoutMilliseconds?: number;
  }): Promise<Response> {
    if (!input.path.startsWith(`/subscriptions/${this.#subscriptionId}/`)) {
      throw new AzureRuntimeError("azure-target-outside-pilot-subscription");
    }
    const attempts = input.method === "GET" && input.retrySafeGet === true ? 2 : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let response: Response;
      let token: { readonly expiresOnTimestamp: number; readonly token: string } | null = null;
      try {
        token = await this.#credential.getToken(AZURE_MANAGEMENT_SCOPE);
        if (token === null || typeof token.token !== "string" || token.token.length < 1) {
          throw new AzureRuntimeError("managed-identity-token-unavailable");
        }
        response = await this.#fetch(`https://management.azure.com${input.path}`, {
          ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
          headers: {
            accept: "application/json",
            authorization: `Bearer ${token.token}`,
            ...(input.body === undefined ? {} : { "content-type": "application/json" }),
          },
          method: input.method,
          redirect: "error",
          signal: AbortSignal.timeout(input.timeoutMilliseconds ?? 10_000),
        });
      } catch (error) {
        if (error instanceof AzureRuntimeError) throw error;
        if (attempt < attempts) continue;
        throw new AzureRuntimeError("azure-network-unavailable");
      } finally {
        token = null;
      }
      if (!input.expectedStatuses.includes(response.status)) {
        if (attempt < attempts && (response.status === 429 || response.status >= 500)) continue;
        throw new AzureRuntimeError("azure-status-unexpected");
      }
      return response;
    }
    throw new AzureRuntimeError("azure-network-unavailable");
  }
}

export class LiveAzureComputeSchedule implements AzureComputeSchedulePort {
  readonly #now: () => Date;
  readonly #ownership: AzureScheduleTargetOwnershipPort;
  readonly #transport: AzureRuntimeTransport;

  constructor(options: {
    readonly now?: () => Date;
    readonly ownership: AzureScheduleTargetOwnershipPort;
    readonly transport: AzureRuntimeTransport;
  }) {
    this.#now = options.now ?? (() => new Date());
    this.#ownership = options.ownership;
    this.#transport = options.transport;
  }

  async ensureCompleteBy(input: {
    readonly existing: GenerationScheduleOperation & {
      readonly status: "accepted" | "requested";
    };
    readonly correlationId: string;
    readonly providerVmId: string;
    readonly requestedDeadline: string;
    readonly targetVmResourceId: string;
  }): Promise<GenerationScheduleOperation> {
    const checkedAt = canonicalNow(this.#now);
    const target = exactVmTarget(
      input.targetVmResourceId,
      this.#transport.subscriptionId,
      input.existing.requestCorrelationId,
    );
    if (
      input.correlationId !== input.existing.requestCorrelationId ||
      input.requestedDeadline !== input.existing.requestedDeadline ||
      !sameArmId(input.existing.targetVmResourceId, target.vmResourceId)
    ) {
      throw new AzureRuntimeError("schedule-request-identity-mismatch");
    }
    await this.#ownership.assertScheduleTargetOwned(
      target.vmResourceId,
      canonicalProviderVmId(input.providerVmId, "providerVmId"),
    );
    const endpoint = `/subscriptions/${this.#transport.subscriptionId}/providers/Microsoft.ComputeSchedule/locations/${AZURE_PILOT_LOCATION}`;
    const response =
      input.existing.providerOperationId === null
        ? await this.#transport.json({
            body: {
              correlationid: input.correlationId,
              executionParameters: {
                optimizationPreference: "Cost",
                retryPolicy: { retryCount: 0, retryWindowInMinutes: 0 },
              },
              resources: { ids: [target.vmResourceId] },
              schedule: {
                deadline: input.requestedDeadline,
                deadlineType: "CompleteBy",
                timezone: "UTC",
              },
            },
            expectedStatuses: [200],
            method: "POST",
            path: `${endpoint}/virtualMachinesSubmitDeallocate?api-version=${COMPUTE_SCHEDULE_API_VERSION}`,
          })
        : await this.#transport.json({
            body: {
              correlationid: input.correlationId,
              operationIds: [input.existing.providerOperationId],
            },
            expectedStatuses: [200],
            method: "POST",
            path: `${endpoint}/virtualMachinesGetOperationStatus?api-version=${COMPUTE_SCHEDULE_API_VERSION}`,
          });
    const observed = parseScheduleResult(response, {
      deadline: input.requestedDeadline,
      expectedProviderOperationId: input.existing.providerOperationId,
      subscriptionId: this.#transport.subscriptionId,
      vmResourceId: target.vmResourceId,
    });
    const status = scheduleStatus(observed.state);
    return {
      acceptedAt:
        status === "accepted" || status === "executed"
          ? (input.existing.acceptedAt ?? checkedAt)
          : status === "failed"
            ? input.existing.acceptedAt
            : null,
      deadlineType: "CompleteBy",
      lastCheckedAt: checkedAt,
      providerOperationId: observed.providerOperationId,
      requestCorrelationId: input.correlationId,
      requestedDeadline: input.requestedDeadline,
      status,
      targetVmResourceId: target.vmResourceId,
    };
  }
}

export interface AzureGenerationPlannerOptions {
  readonly baseTemplateSha256: string;
  readonly imageVersion: string;
  readonly nonSecretBootstrapCustomData: string;
  readonly sharedRunnerSubnetId: string;
  readonly subscriptionId: string;
}

/** Generates one disposable SSH key before the durable generation row exists. */
export class LiveAzureGenerationPlanner implements AzureGenerationPlanningPort {
  readonly #options: AzureGenerationPlannerOptions;

  constructor(options: AzureGenerationPlannerOptions) {
    this.#options = {
      baseTemplateSha256: sha256(options.baseTemplateSha256, "baseTemplateSha256"),
      imageVersion: bounded(options.imageVersion, "imageVersion", 256),
      nonSecretBootstrapCustomData: bounded(
        options.nonSecretBootstrapCustomData,
        "nonSecretBootstrapCustomData",
        256 * 1024,
      ),
      sharedRunnerSubnetId: exactSubnetId(options.sharedRunnerSubnetId, options.subscriptionId),
      subscriptionId: azureSubscriptionId(options.subscriptionId),
    };
  }

  async plan(input: {
    readonly allocation: { readonly allocationId: string };
    readonly generationNumber: 1;
    readonly location: typeof AZURE_PILOT_LOCATION;
    readonly persistedBasePlan?: PhysicalGeneration["basePlan"];
    readonly vmSize: AzurePilotVmSize;
  }): Promise<AzureGenerationPlan> {
    if (input.generationNumber !== 1 || input.location !== AZURE_PILOT_LOCATION) {
      throw new TypeError("only generation one in UK South is supported");
    }
    const names = azureGenerationOneNames({
      allocationId: input.allocation.allocationId,
      subscriptionId: this.#options.subscriptionId,
    });
    const adminSshPublicKey =
      input.persistedBasePlan?.adminSshPublicKey ?? generateDisposableOpenSshPublicKey();
    const plan = {
      adminSshPublicKey,
      baseDeploymentNameByZone: names.baseDeploymentNameByZone,
      baseTemplateSha256: this.#options.baseTemplateSha256,
      imageVersion: this.#options.imageVersion,
      nonSecretBootstrapCustomData: this.#options.nonSecretBootstrapCustomData,
      resourceGroupId: names.resourceGroupId,
      resourceGroupName: names.resourceGroupName,
      sharedRunnerSubnetId: this.#options.sharedRunnerSubnetId,
      subscriptionId: this.#options.subscriptionId,
    } satisfies AzureGenerationPlan;
    if (input.persistedBasePlan !== undefined) {
      const expectedHash = createHash("sha256").update(adminSshPublicKey).digest("hex");
      if (
        input.persistedBasePlan.adminSshPublicKeySha256 !== expectedHash ||
        input.persistedBasePlan.baseTemplateSha256 !== plan.baseTemplateSha256 ||
        input.persistedBasePlan.imageVersion !== plan.imageVersion ||
        input.persistedBasePlan.sharedRunnerSubnetId !== plan.sharedRunnerSubnetId ||
        input.persistedBasePlan.subscriptionId !== plan.subscriptionId
      ) {
        throw new AzureRuntimeError("persisted-generation-plan-mismatch");
      }
    }
    return Object.freeze(plan);
  }
}

interface OwnedGeneration {
  readonly allocation: AllocationRecord;
  readonly attempt: ProviderAttempt;
  readonly generation: PhysicalGeneration | null;
  readonly names: ReturnType<typeof azureGenerationOneNames>;
}

/**
 * Live ARM adapter with an authoritative lookup before every read or mutation.
 * It never accepts a persisted resource ID as proof that the resource is owned.
 */
export class LiveAzureResourcePort implements AzureResourcePort {
  readonly #baseTemplate: unknown;
  readonly #baseTemplateSha256: string;
  readonly #bootstrapSha256: string;
  readonly #imageVersion: string;
  readonly #jitTemplate: unknown;
  readonly #ledger: AllocationControlLedger;
  readonly #now: () => Date;
  readonly #runnerSubnetId: string;
  readonly #transport: AzureRuntimeTransport;

  constructor(options: {
    readonly baseTemplate: unknown;
    readonly baseTemplateSha256: string;
    readonly bootstrapSha256: string;
    readonly imageVersion: string;
    readonly jitTemplate: unknown;
    readonly ledger: AllocationControlLedger;
    readonly now?: () => Date;
    readonly runnerSubnetId: string;
    readonly transport: AzureRuntimeTransport;
  }) {
    this.#baseTemplate = record(options.baseTemplate, "baseTemplate");
    this.#baseTemplateSha256 = sha256(options.baseTemplateSha256, "baseTemplateSha256");
    this.#bootstrapSha256 = sha256(options.bootstrapSha256, "bootstrapSha256");
    this.#imageVersion = bounded(options.imageVersion, "imageVersion", 256);
    this.#jitTemplate = record(options.jitTemplate, "jitTemplate");
    this.#ledger = options.ledger;
    this.#now = options.now ?? (() => new Date());
    this.#runnerSubnetId = exactSubnetId(options.runnerSubnetId, options.transport.subscriptionId);
    this.#transport = options.transport;
  }

  async ensureBaseDeployment(
    input: Parameters<AzureResourcePort["ensureBaseDeployment"]>[0],
  ): ReturnType<AzureResourcePort["ensureBaseDeployment"]> {
    const owned = await this.#owned(input.deployment.deploymentId);
    if (
      owned.allocation.allocationId !== input.allocation.allocationId ||
      owned.attempt.ordinal !== input.attempt.ordinal ||
      owned.generation === null ||
      owned.generation.basePlan.baseTemplateSha256 !== input.plan.baseTemplateSha256 ||
      input.templatePath !== AZURE_BASE_TEMPLATE_PATH ||
      input.plan.subscriptionId !== this.#transport.subscriptionId ||
      input.plan.resourceGroupId !== owned.names.resourceGroupId ||
      input.plan.resourceGroupName !== owned.names.resourceGroupName ||
      input.deployment.deploymentName !==
        owned.names.baseDeploymentNameByZone[input.availabilityZone]
    ) {
      throw new AzureRuntimeError("azure-base-deployment-contract-mismatch");
    }
    const deadlines = requiredAzureDeadlines(owned.attempt);
    const tags = expectedTags(owned);
    const body = {
      location: AZURE_PILOT_LOCATION,
      properties: {
        mode: "Incremental",
        parameters: armParameters({
          adminSshPublicKey: input.plan.adminSshPublicKey,
          allocationAcceptedAt: owned.allocation.createdAt,
          allocationId: owned.allocation.allocationId,
          allocationLifetimeMinutes: 45,
          allocationResourceGroupName: owned.names.resourceGroupName,
          availabilityZone: input.availabilityZone,
          deletionTarget: deadlines.absoluteExpiry,
          githubRunId: owned.allocation.identity.run_id,
          imageVersion: input.plan.imageVersion,
          location: AZURE_PILOT_LOCATION,
          mappedJobTimeoutMinutes: owned.allocation.acceptance.trust.workload.timeoutMinutes,
          nonSecretBootstrapCustomData: input.plan.nonSecretBootstrapCustomData,
          originalCompleteBy: deadlines.computeDeadline,
          physicalGeneration: 1,
          providerStopMarginMinutes: 5,
          sharedRunnerSubnetId: input.plan.sharedRunnerSubnetId,
          tags,
          vmSize: owned.generation.vmSize,
        }),
        template: this.#baseTemplate,
      },
    };
    await this.#resourceAbsentOrOwned(owned, owned.names.resourceGroupId, false);
    await this.#resourceAbsentOrOwned(owned, owned.names.vmResourceId, true);
    await this.#deploymentAbsentOrMatches(
      owned,
      input.deployment.deploymentId,
      body.properties.parameters,
      new Set(["nonSecretBootstrapCustomData"]),
    );
    const deployment = await this.#transport.json({
      body,
      expectedStatuses: [200, 201],
      method: "PUT",
      path: `${input.deployment.deploymentId}?api-version=2025-04-01`,
    });
    const properties = record(record(deployment, "deployment").properties, "deployment.properties");
    const provisioning = string(properties.provisioningState, "deployment.provisioningState");
    if (provisioning === "Accepted" || provisioning === "Running") return { outcome: "pending" };
    if (provisioning !== "Succeeded") {
      throw new AzureRuntimeError("azure-base-deployment-failed-unclassified");
    }
    const vm = await this.#taggedResource(owned, owned.names.vmResourceId, "2025-04-01", true);
    const vmProperties = record(
      record(vm, "virtualMachine").properties,
      "virtualMachine.properties",
    );
    return {
      childDeploymentId: owned.names.childDeploymentId,
      completedAt: canonicalNow(this.#now),
      deploymentId: input.deployment.deploymentId,
      outcome: "vm-created",
      providerVmId: canonicalProviderVmId(vmProperties.vmId, "virtualMachine.vmId"),
      vmResourceId: owned.names.vmResourceId,
    };
  }

  async observeLaunchPrerequisites(
    input: Parameters<AzureResourcePort["observeLaunchPrerequisites"]>[0],
  ): ReturnType<AzureResourcePort["observeLaunchPrerequisites"]> {
    const owned = await this.#owned(input.vmResourceId);
    const providerVmId = this.#expectedProviderVmId(owned, input.providerVmId);
    await this.#taggedResource(owned, input.vmResourceId, "2025-04-01", true, providerVmId);
    const response = await this.#transport.json({
      body: {
        commandId: "RunShellScript",
        script: ["set -eu", "/usr/local/sbin/switchyard-runner-readiness >/dev/null"],
      },
      expectedStatuses: [200],
      method: "POST",
      path: `${input.vmResourceId}/runCommand?api-version=2025-04-01`,
      timeoutMilliseconds: 10_000,
    });
    const envelope = record(response, "readinessProbe");
    if (!Array.isArray(envelope.value)) throw new AzureRuntimeError("readiness-probe-invalid");
    const succeeded = envelope.value.some((entry) => {
      const status = record(entry, "readinessProbe.status");
      return status.code === "ProvisioningState/succeeded";
    });
    if (!succeeded) return { outcome: "pending" };
    return {
      bootstrapSucceeded: true,
      checkedAt: canonicalNow(this.#now),
      dockerHealthy: true,
      localNvmeMounted: true,
      outcome: "ready",
    };
  }

  async observeCleanupVm(
    input: Parameters<AzureResourcePort["observeCleanupVm"]>[0],
  ): ReturnType<AzureResourcePort["observeCleanupVm"]> {
    const owned = await this.#owned(input.resourceGroupId);
    if (!sameArmId(input.vmResourceId, owned.names.vmResourceId)) {
      throw new AzureRuntimeError("cleanup-vm-target-mismatch");
    }
    const response = await this.#transport.request({
      expectedStatuses: [200, 404],
      method: "GET",
      path: `${input.vmResourceId}?api-version=2025-04-01`,
      retrySafeGet: true,
      timeoutMilliseconds: 5_000,
    });
    const checkedAt = canonicalNow(this.#now);
    if (response.status === 404) return { checkedAt, outcome: "absent" };
    const value = await readBoundedJson(response, MAX_AZURE_RESPONSE_BYTES);
    assertResourceEnvelope(value, input.vmResourceId, expectedTags(owned), true);
    return {
      checkedAt,
      outcome: "exact",
      providerVmId: providerVmIdFromEnvelope(value),
      vmResourceId: input.vmResourceId,
    };
  }

  async observeJitLaunch(
    input: Parameters<AzureResourcePort["observeJitLaunch"]>[0],
  ): ReturnType<AzureResourcePort["observeJitLaunch"]> {
    const commandId = input.generation.managedRunCommand?.managedRunCommandId;
    if (commandId === undefined) return { outcome: "absent" };
    const owned = await this.#owned(commandId);
    const providerVmId = this.#expectedProviderVmId(owned, input.generation.providerVmId);
    await this.#taggedResource(owned, owned.names.vmResourceId, "2025-04-01", true, providerVmId);
    const response = await this.#transport.request({
      expectedStatuses: [200, 404],
      method: "GET",
      path: `${commandId}?api-version=2025-04-01`,
      retrySafeGet: true,
      timeoutMilliseconds: 5_000,
    });
    if (response.status === 404) return { outcome: "absent" };
    const command = await readBoundedJson(response, MAX_AZURE_RESPONSE_BYTES);
    assertResourceEnvelope(command, commandId, expectedTags(owned), true);
    const properties = record(record(command, "runCommand").properties, "runCommand.properties");
    if (properties.provisioningState !== "Succeeded") return { outcome: "absent" };
    const persisted = input.generation.managedRunCommand;
    if (persisted === null) return { outcome: "absent" };
    return {
      launchConfirmedAt: persisted.launchConfirmedAt ?? canonicalNow(this.#now),
      managedRunCommandId: commandId,
      outcome: "launched",
      requestedAt: persisted.requestedAt,
    };
  }

  async launchJit(
    input: Parameters<AzureResourcePort["launchJit"]>[0],
  ): ReturnType<AzureResourcePort["launchJit"]> {
    const owned = await this.#owned(input.managedRunCommandId);
    const providerVmId = this.#expectedProviderVmId(owned, input.generation.providerVmId);
    if (
      owned.generation === null ||
      input.generation.revision !== owned.generation.revision ||
      input.managedRunCommandId !== `${owned.names.vmResourceId}/runCommands/launch-jit-g1` ||
      input.jitDeploymentName !== owned.names.jitDeploymentName ||
      input.acceptedSchedule.providerOperationId === null ||
      input.templatePath !== "infra/templates/azure-allocation/jit-launch.json" ||
      owned.generation.schedule?.providerOperationId !==
        input.acceptedSchedule.providerOperationId ||
      owned.generation.schedule.requestCorrelationId !==
        input.acceptedSchedule.requestCorrelationId ||
      owned.generation.schedule.requestedDeadline !== input.acceptedSchedule.requestedDeadline
    ) {
      throw new AzureRuntimeError("azure-jit-launch-contract-mismatch");
    }
    const body = {
      properties: {
        mode: "Incremental",
        parameters: armParameters({
          acceptedScheduleOperationId: input.acceptedSchedule.providerOperationId,
          launchPrerequisitesCheckedAt: requiredLaunchPrerequisites(owned.generation).checkedAt,
          latestSafeStart: requiredAzureDeadlines(owned.attempt).latestSafeStart,
          location: AZURE_PILOT_LOCATION,
          reducedEncodedJitConfiguration: input.encodedJitConfiguration,
          scheduleAcceptedAt: requiredString(
            input.acceptedSchedule.acceptedAt,
            "schedule.acceptedAt",
          ),
          tags: expectedTags(owned),
          virtualMachineName: owned.names.vmName,
        }),
        template: this.#jitTemplate,
      },
    };
    await this.#taggedResource(owned, owned.names.vmResourceId, "2025-04-01", true, providerVmId);
    await this.#resourceAbsentOrOwned(owned, input.managedRunCommandId, true);
    await this.#deploymentAbsentOrMatches(
      owned,
      owned.names.jitDeploymentId,
      body.properties.parameters,
      new Set(["reducedEncodedJitConfiguration"]),
    );
    const response = await this.#transport.json({
      body,
      expectedStatuses: [200, 201],
      method: "PUT",
      path: `${owned.names.jitDeploymentId}?api-version=2025-04-01`,
    });
    const properties = record(
      record(response, "jitDeployment").properties,
      "jitDeployment.properties",
    );
    if (properties.provisioningState !== "Succeeded") {
      throw new AzureRuntimeError("jit-deployment-not-confirmed");
    }
    return {
      launchConfirmedAt: canonicalNow(this.#now),
      managedRunCommandId: input.managedRunCommandId,
      outcome: "launched",
      requestedAt: requiredManagedCommand(owned.generation).requestedAt,
    };
  }

  async deleteManagedRunCommand(
    input: Parameters<AzureResourcePort["deleteManagedRunCommand"]>[0],
  ): ReturnType<AzureResourcePort["deleteManagedRunCommand"]> {
    const owned = await this.#owned(input.managedRunCommandId);
    const providerVmId = this.#expectedProviderVmId(owned, owned.generation?.providerVmId ?? null);
    await this.#taggedResource(owned, owned.names.vmResourceId, "2025-04-01", true, providerVmId);
    const observed = await this.#transport.request({
      expectedStatuses: [200, 404],
      method: "GET",
      path: `${input.managedRunCommandId}?api-version=2025-04-01`,
      retrySafeGet: true,
      timeoutMilliseconds: 5_000,
    });
    if (observed.status === 404) {
      return {
        completedAt: canonicalNow(this.#now),
        outcome: "deleted",
        requestedAt: input.deleteRequestedAt,
      };
    }
    assertResourceEnvelope(
      await readBoundedJson(observed, MAX_AZURE_RESPONSE_BYTES),
      input.managedRunCommandId,
      expectedTags(owned),
      true,
    );
    if (!input.submitDelete) {
      return {
        checkedAt: canonicalNow(this.#now),
        outcome: "pending",
        requestedAt: input.deleteRequestedAt,
      };
    }
    const response = await this.#transport.request({
      expectedStatuses: [200, 202, 204, 404],
      method: "DELETE",
      path: `${input.managedRunCommandId}?api-version=2025-04-01`,
    });
    if (response.status === 202) {
      // Azure's Location is deliberately not followed. It is neither an
      // ownership proof nor required to poll the exact deterministic resource.
      return {
        checkedAt: canonicalNow(this.#now),
        outcome: "pending",
        requestedAt: input.deleteRequestedAt,
      };
    }
    return {
      completedAt: canonicalNow(this.#now),
      outcome: "deleted",
      requestedAt: input.deleteRequestedAt,
    };
  }

  async assertScheduleTargetOwned(vmResourceId: string, providerVmId: string): Promise<void> {
    const owned = await this.#owned(vmResourceId);
    if (!sameArmId(vmResourceId, owned.names.vmResourceId)) {
      throw new AzureRuntimeError("schedule-target-identity-mismatch");
    }
    const expectedProviderVmId = this.#expectedProviderVmId(owned, providerVmId);
    await this.#taggedResource(owned, vmResourceId, "2025-04-01", true, expectedProviderVmId);
  }

  async fenceCompute(
    input: Parameters<AzureResourcePort["fenceCompute"]>[0],
  ): ReturnType<AzureResourcePort["fenceCompute"]> {
    const owned = await this.#owned(input.resourceGroupId);
    const deadlines = requiredAzureDeadlines(owned.attempt);
    if (input.computeDeadline !== deadlines.computeDeadline) {
      throw new AzureRuntimeError("compute-deadline-mismatch");
    }
    if (input.vmResourceId === null) {
      if (input.providerVmId !== null) {
        throw new AzureRuntimeError("compute-provider-vm-identity-mismatch");
      }
      return { outcome: "settled", settledAt: canonicalNow(this.#now) };
    }
    if (!sameArmId(input.vmResourceId, owned.names.vmResourceId)) {
      throw new AzureRuntimeError("compute-target-mismatch");
    }
    const providerVmId = this.#expectedProviderVmId(owned, input.providerVmId);
    await this.#taggedResource(owned, input.vmResourceId, "2025-04-01", true, providerVmId);
    await this.#transport.request({
      expectedStatuses: [200, 202, 204],
      method: "POST",
      path: `${input.vmResourceId}/deallocate?api-version=2025-04-01&hibernate=false`,
    });
    const view = await this.#transport.json({
      expectedStatuses: [200],
      method: "GET",
      path: `${input.vmResourceId}/instanceView?api-version=2025-04-01`,
      retrySafeGet: true,
      timeoutMilliseconds: 5_000,
    });
    const statuses = record(view, "instanceView").statuses;
    if (!Array.isArray(statuses)) throw new AzureRuntimeError("instance-view-invalid");
    const deallocated = statuses.some(
      (status) => record(status, "instanceView.status").code === "PowerState/deallocated",
    );
    return deallocated
      ? { outcome: "settled", settledAt: canonicalNow(this.#now) }
      : { outcome: "pending" };
  }

  async settleDeployments(
    input: Parameters<AzureResourcePort["settleDeployments"]>[0],
  ): ReturnType<AzureResourcePort["settleDeployments"]> {
    for (const deploymentId of input.deploymentIds) {
      const owned = await this.#owned(deploymentId);
      const deployment = await this.#transport.request({
        expectedStatuses: [200, 404],
        method: "GET",
        path: `${deploymentId}?api-version=2025-04-01`,
        retrySafeGet: true,
        timeoutMilliseconds: 5_000,
      });
      if (deployment.status === 404) continue;
      const value = await readBoundedJson(deployment, MAX_AZURE_RESPONSE_BYTES);
      assertDeploymentEnvelope(
        value,
        deploymentId,
        expectedTags(owned),
        deploymentId === owned.names.jitDeploymentId,
      );
      const state = record(
        record(value, "deployment").properties,
        "deployment.properties",
      ).provisioningState;
      if (state !== "Succeeded" && state !== "Failed" && state !== "Canceled") {
        return {
          allTerminalOrAbsent: false,
          deploymentIds: input.deploymentIds,
          settledAt: canonicalNow(this.#now),
        };
      }
    }
    return {
      allTerminalOrAbsent: true,
      deploymentIds: input.deploymentIds,
      settledAt: canonicalNow(this.#now),
    };
  }

  async deleteResourceGroup(
    input: Parameters<AzureResourcePort["deleteResourceGroup"]>[0],
  ): ReturnType<AzureResourcePort["deleteResourceGroup"]> {
    const owned = await this.#owned(input.resourceGroupId);
    const resource = await this.#transport.request({
      expectedStatuses: [200, 404],
      method: "GET",
      path: `${input.resourceGroupId}?api-version=2025-04-01`,
      retrySafeGet: true,
      timeoutMilliseconds: 5_000,
    });
    const requestedAt = canonicalNow(this.#now);
    if (resource.status === 404) return { requestedAt };
    assertResourceEnvelope(
      await readBoundedJson(resource, MAX_AZURE_RESPONSE_BYTES),
      input.resourceGroupId,
      expectedTags(owned),
      false,
    );
    await this.#assertPersistedVmOwnedOrAbsent(owned);
    await this.#transport.request({
      expectedStatuses: [200, 202, 204, 404],
      method: "DELETE",
      path: `${input.resourceGroupId}?api-version=2025-04-01&forceDeletionTypes=Microsoft.Compute%2FvirtualMachines%2CMicrosoft.Compute%2FvirtualMachineScaleSets`,
    });
    return { requestedAt };
  }

  async resourceGroupAbsent(
    input: Parameters<AzureResourcePort["resourceGroupAbsent"]>[0],
  ): ReturnType<AzureResourcePort["resourceGroupAbsent"]> {
    const owned = await this.#owned(input.resourceGroupId);
    const response = await this.#transport.request({
      expectedStatuses: [200, 404],
      method: "GET",
      path: `${input.resourceGroupId}?api-version=2025-04-01`,
      retrySafeGet: true,
      timeoutMilliseconds: 5_000,
    });
    if (response.status === 200) {
      assertResourceEnvelope(
        await readBoundedJson(response, MAX_AZURE_RESPONSE_BYTES),
        input.resourceGroupId,
        expectedTags(owned),
        false,
      );
    }
    return { absent: response.status === 404, checkedAt: canonicalNow(this.#now) };
  }

  async #taggedResource(
    owned: OwnedGeneration,
    resourceId: string,
    apiVersion: string,
    generationTags: boolean,
    expectedProviderVmId?: string,
  ): Promise<unknown> {
    const response = await this.#transport.json({
      expectedStatuses: [200],
      method: "GET",
      path: `${resourceId}?api-version=${apiVersion}`,
      retrySafeGet: true,
      timeoutMilliseconds: 5_000,
    });
    assertResourceEnvelope(response, resourceId, expectedTags(owned), generationTags);
    if (sameArmId(resourceId, owned.names.vmResourceId)) {
      const persistedProviderVmId = owned.generation?.providerVmId;
      const expected =
        expectedProviderVmId ??
        (persistedProviderVmId === null || persistedProviderVmId === undefined
          ? undefined
          : canonicalProviderVmId(persistedProviderVmId, "generation.providerVmId"));
      const observed = providerVmIdFromEnvelope(response);
      if (expected !== undefined && observed !== expected) {
        throw new AzureRuntimeError("azure-provider-vm-identity-mismatch");
      }
    }
    return response;
  }

  async #resourceAbsentOrOwned(
    owned: OwnedGeneration,
    resourceId: string,
    generationTags: boolean,
  ): Promise<"absent" | "owned"> {
    const response = await this.#transport.request({
      expectedStatuses: [200, 404],
      method: "GET",
      path: `${resourceId}?api-version=2025-04-01`,
      retrySafeGet: true,
      timeoutMilliseconds: 5_000,
    });
    if (response.status === 404) return "absent";
    const value = await readBoundedJson(response, MAX_AZURE_RESPONSE_BYTES);
    assertResourceEnvelope(value, resourceId, expectedTags(owned), generationTags);
    if (sameArmId(resourceId, owned.names.vmResourceId)) {
      const persistedProviderVmId = owned.generation?.providerVmId;
      const observedProviderVmId = providerVmIdFromEnvelope(value);
      if (
        persistedProviderVmId !== null &&
        persistedProviderVmId !== undefined &&
        observedProviderVmId !==
          canonicalProviderVmId(persistedProviderVmId, "generation.providerVmId")
      ) {
        throw new AzureRuntimeError("azure-provider-vm-identity-mismatch");
      }
    }
    return "owned";
  }

  #expectedProviderVmId(owned: OwnedGeneration, value: string | null): string {
    const expected = canonicalProviderVmId(value, "providerVmId");
    const persisted = canonicalProviderVmId(
      owned.generation?.providerVmId ?? null,
      "generation.providerVmId",
    );
    if (expected !== persisted) {
      throw new AzureRuntimeError("azure-provider-vm-identity-mismatch");
    }
    return expected;
  }

  async #assertPersistedVmOwnedOrAbsent(owned: OwnedGeneration): Promise<void> {
    const persisted = owned.generation?.providerVmId;
    const response = await this.#transport.request({
      expectedStatuses: [200, 404],
      method: "GET",
      path: `${owned.names.vmResourceId}?api-version=2025-04-01`,
      retrySafeGet: true,
      timeoutMilliseconds: 5_000,
    });
    if (response.status === 404) return;
    const value = await readBoundedJson(response, MAX_AZURE_RESPONSE_BYTES);
    assertResourceEnvelope(value, owned.names.vmResourceId, expectedTags(owned), true);
    if (persisted === null || persisted === undefined) {
      throw new AzureRuntimeError("azure-provider-vm-identity-unpersisted");
    }
    if (
      providerVmIdFromEnvelope(value) !==
      canonicalProviderVmId(persisted, "generation.providerVmId")
    ) {
      throw new AzureRuntimeError("azure-provider-vm-identity-mismatch");
    }
  }

  async #deploymentAbsentOrMatches(
    owned: OwnedGeneration,
    deploymentId: string,
    expectedParameters: Readonly<Record<string, { readonly value: unknown }>>,
    protectedParameterNames: ReadonlySet<string>,
  ): Promise<void> {
    const response = await this.#transport.request({
      expectedStatuses: [200, 404],
      method: "GET",
      path: `${deploymentId}?api-version=2025-04-01`,
      retrySafeGet: true,
      timeoutMilliseconds: 5_000,
    });
    if (response.status === 404) return;
    const deployment = record(
      await readBoundedJson(response, MAX_AZURE_RESPONSE_BYTES),
      "deployment",
    );
    if (
      !sameArmId(string(deployment.id, "deployment.id"), deploymentId) ||
      string(deployment.location, "deployment.location").toLowerCase() !== AZURE_PILOT_LOCATION ||
      string(deployment.type, "deployment.type").toLowerCase() !== "microsoft.resources/deployments"
    ) {
      throw new AzureRuntimeError("azure-deployment-identity-mismatch");
    }
    const properties = record(deployment.properties, "deployment.properties");
    if (properties.mode !== "Incremental") {
      throw new AzureRuntimeError("azure-deployment-mode-mismatch");
    }
    const observedParameters = record(properties.parameters, "deployment.parameters");
    for (const name of Object.keys(observedParameters)) {
      if (!Object.hasOwn(expectedParameters, name)) {
        throw new AzureRuntimeError("azure-deployment-parameter-mismatch");
      }
    }
    for (const [name, expected] of Object.entries(expectedParameters)) {
      if (protectedParameterNames.has(name)) continue;
      const observed = record(observedParameters[name], `deployment.parameters.${name}`);
      if (stableJson(observed.value) !== stableJson(expected.value)) {
        throw new AzureRuntimeError("azure-deployment-parameter-mismatch");
      }
    }
    const observedTags = record(
      record(observedParameters.tags, "deployment.parameters.tags").value,
      "deployment.parameters.tags.value",
    );
    assertTags(observedTags, expectedTags(owned), deploymentId === owned.names.jitDeploymentId);
  }

  async #owned(resourceId: string): Promise<OwnedGeneration> {
    let continuationToken: string | undefined;
    const matches: OwnedGeneration[] = [];
    for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
      const page = await this.#ledger.listOpenAllocations({
        ...(continuationToken === undefined ? {} : { continuationToken }),
        pageSize: 50,
      });
      for (const allocation of page.allocations) {
        for (const attempt of allocation.attempts) {
          if (attempt.provider !== "azure") continue;
          const subscriptionId =
            attempt.physicalGenerations[0]?.basePlan.subscriptionId ??
            this.#transport.subscriptionId;
          if (subscriptionId !== this.#transport.subscriptionId) continue;
          const names = azureGenerationOneNames({
            allocationId: allocation.allocationId,
            subscriptionId,
          });
          const generation = attempt.physicalGenerations[0] ?? null;
          if (ownedResourceIds(names).some((candidate) => sameArmId(candidate, resourceId))) {
            if (generation !== null) {
              assertOwnedAzureGeneration({
                allocationId: allocation.allocationId,
                baseTemplateSha256: this.#baseTemplateSha256,
                bootstrapSha256: this.#bootstrapSha256,
                generation,
                imageVersion: this.#imageVersion,
                resourceId,
                runnerSubnetId: this.#runnerSubnetId,
                subscriptionId,
              });
            }
            matches.push({ allocation, attempt, generation, names });
          }
        }
      }
      if (page.continuationToken === null) break;
      continuationToken = page.continuationToken;
      if (pageNumber === 19) throw new AzureRuntimeError("authoritative-ownership-scan-exhausted");
    }
    if (matches.length !== 1) throw new AzureRuntimeError("azure-resource-ownership-ambiguous");
    const match = matches[0];
    if (match === undefined) throw new AzureRuntimeError("azure-resource-ownership-ambiguous");
    return match;
  }
}

function assertResourceEnvelope(
  value: unknown,
  resourceId: string,
  tags: Readonly<Record<string, string>>,
  generationTags: boolean,
): void {
  const resource = record(value, "azureResource");
  const expectedType = resourceTypeFromId(resourceId);
  if (
    !sameArmId(string(resource.id, "azureResource.id"), resourceId) ||
    string(resource.location, "azureResource.location").toLowerCase() !== AZURE_PILOT_LOCATION ||
    string(resource.type, "azureResource.type").toLowerCase() !== expectedType.toLowerCase()
  ) {
    throw new AzureRuntimeError("azure-resource-identity-mismatch");
  }
  assertTags(resource.tags, tags, generationTags);
}

function assertDeploymentEnvelope(
  value: unknown,
  deploymentId: string,
  tags: Readonly<Record<string, string>>,
  generationTags: boolean,
): void {
  const deployment = record(value, "deployment");
  if (
    !sameArmId(string(deployment.id, "deployment.id"), deploymentId) ||
    string(deployment.location, "deployment.location").toLowerCase() !== AZURE_PILOT_LOCATION ||
    string(deployment.type, "deployment.type").toLowerCase() !== "microsoft.resources/deployments"
  ) {
    throw new AzureRuntimeError("azure-deployment-identity-mismatch");
  }
  const parameters = record(
    record(deployment.properties, "deployment.properties").parameters,
    "deployment.parameters",
  );
  assertTags(
    record(record(parameters.tags, "deployment.parameters.tags").value, "deployment tags"),
    tags,
    generationTags,
  );
}

function resourceTypeFromId(resourceId: string): string {
  const marker = "/providers/";
  const providerOffset = resourceId.toLowerCase().indexOf(marker);
  if (providerOffset < 0) return "Microsoft.Resources/resourceGroups";
  const segments = resourceId.slice(providerOffset + marker.length).split("/");
  if (segments.length < 3 || segments.length % 2 !== 1) {
    throw new AzureRuntimeError("azure-resource-type-invalid");
  }
  const providerNamespace = segments[0];
  if (providerNamespace === undefined) throw new AzureRuntimeError("azure-resource-type-invalid");
  const typeSegments: string[] = [];
  for (let index = 1; index < segments.length; index += 2) {
    const type = segments[index];
    if (type === undefined || type.length < 1) {
      throw new AzureRuntimeError("azure-resource-type-invalid");
    }
    typeSegments.push(type);
  }
  return `${providerNamespace}/${typeSegments.join("/")}`;
}

export function assertOwnedAzureGeneration(input: {
  readonly allocationId: string;
  readonly baseTemplateSha256: string;
  readonly bootstrapSha256: string;
  readonly generation: PhysicalGeneration;
  readonly imageVersion: string;
  readonly resourceId: string;
  readonly runnerSubnetId: string;
  readonly subscriptionId: string;
}): void {
  const subscriptionId = azureSubscriptionId(input.subscriptionId);
  const names = azureGenerationOneNames({ allocationId: input.allocationId, subscriptionId });
  if (
    input.generation.generationNumber !== 1 ||
    input.generation.location !== AZURE_PILOT_LOCATION ||
    input.generation.basePlan.subscriptionId !== subscriptionId ||
    input.generation.resourceGroupName !== names.resourceGroupName ||
    input.generation.resourceGroupId !== names.resourceGroupId ||
    input.generation.basePlan.baseTemplateSha256 !== sha256(input.baseTemplateSha256, "template") ||
    input.generation.basePlan.nonSecretBootstrapSha256 !==
      sha256(input.bootstrapSha256, "bootstrap") ||
    input.generation.basePlan.imageVersion !== bounded(input.imageVersion, "imageVersion", 256) ||
    input.generation.basePlan.sharedRunnerSubnetId !==
      exactSubnetId(input.runnerSubnetId, subscriptionId) ||
    (input.generation.vmResourceId !== null &&
      !sameArmId(input.generation.vmResourceId, names.vmResourceId)) ||
    input.generation.zoneDeployments.some(
      (deployment) =>
        deployment.deploymentName !== names.baseDeploymentNameByZone[deployment.availabilityZone] ||
        !sameArmId(
          deployment.deploymentId,
          names.baseDeploymentIdByZone[deployment.availabilityZone],
        ) ||
        !sameArmId(deployment.childDeploymentId, names.childDeploymentId) ||
        (deployment.vmResourceId !== null &&
          !sameArmId(deployment.vmResourceId, names.vmResourceId)),
    ) ||
    (input.generation.managedRunCommand !== null &&
      (!sameArmId(input.generation.managedRunCommand.boundVmResourceId, names.vmResourceId) ||
        !sameArmId(
          input.generation.managedRunCommand.managedRunCommandId,
          `${names.vmResourceId}/runCommands/launch-jit-g1`,
        ))) ||
    (input.generation.jitMintIntent !== null &&
      (input.generation.jitMintIntent.intentId !== names.jitMintIntentId ||
        !sameArmId(input.generation.jitMintIntent.jitDeploymentId, names.jitDeploymentId))) ||
    (input.generation.schedule !== null &&
      (input.generation.schedule.requestCorrelationId !== names.scheduleCorrelationId ||
        !sameArmId(input.generation.schedule.targetVmResourceId, names.vmResourceId))) ||
    !ownedResourceIds(names).some((candidate) => sameArmId(candidate, input.resourceId))
  ) {
    throw new AzureRuntimeError("azure-owned-generation-contract-mismatch");
  }
}

function ownedResourceIds(names: ReturnType<typeof azureGenerationOneNames>): readonly string[] {
  return [
    names.resourceGroupId,
    names.vmResourceId,
    names.childDeploymentId,
    names.jitDeploymentId,
    ...Object.values(names.baseDeploymentIdByZone),
    `${names.vmResourceId}/runCommands/launch-jit-g1`,
  ];
}

function armParameters(
  values: Readonly<Record<string, unknown>>,
): Record<string, { value: unknown }> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }]));
}

function requiredAzureDeadlines(attempt: ProviderAttempt) {
  if (attempt.provider !== "azure" || attempt.deadlines === null) {
    throw new AzureRuntimeError("azure-attempt-deadlines-missing");
  }
  return attempt.deadlines;
}

function requiredLaunchPrerequisites(generation: PhysicalGeneration) {
  if (generation.launchPrerequisites === null) {
    throw new AzureRuntimeError("launch-prerequisites-missing");
  }
  return generation.launchPrerequisites;
}

function requiredManagedCommand(generation: PhysicalGeneration) {
  if (generation.managedRunCommand === null) {
    throw new AzureRuntimeError("managed-run-command-missing");
  }
  return generation.managedRunCommand;
}

function requiredString(value: string | null, path: string): string {
  if (value === null) throw new AzureRuntimeError(`${path}-missing`);
  return value;
}

function expectedTags(owned: OwnedGeneration): Readonly<Record<string, string>> {
  const deadlines = requiredAzureDeadlines(owned.attempt);
  const base = owned.generation?.basePlan;
  return {
    allocationAcceptedAt: owned.allocation.createdAt,
    allocationId: owned.allocation.allocationId,
    allocationLifetimeMinutes: "45",
    ...(base === undefined
      ? {}
      : {
          baseTemplateSha256: base.baseTemplateSha256,
          nonSecretBootstrapSha256: base.nonSecretBootstrapSha256,
        }),
    deletionTarget: deadlines.absoluteExpiry,
    githubRunId: owned.allocation.identity.run_id,
    latestSafeStart: deadlines.latestSafeStart,
    managedBy: "switchyard-controller",
    originalCompleteBy: deadlines.computeDeadline,
    system: "switchyard",
  };
}

function assertTags(
  value: unknown,
  expected: Readonly<Record<string, string>>,
  generation: boolean,
): void {
  const tags = record(value, "resource.tags");
  const exactExpected = generation
    ? {
        ...expected,
        deadlineContractValidated: "true",
        physicalGeneration: "1",
        physicalGenerationId: `${expected.allocationId}:g1`,
      }
    : expected;
  if (Reflect.ownKeys(tags).length !== Object.keys(exactExpected).length) {
    throw new AzureRuntimeError("azure-resource-tag-mismatch");
  }
  for (const [key, expectedValue] of Object.entries(exactExpected)) {
    if (tags[key] !== expectedValue) throw new AzureRuntimeError("azure-resource-tag-mismatch");
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = record(value, "canonicalJson");
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}

function parseScheduleResult(
  value: unknown,
  expected: {
    readonly deadline: string;
    readonly expectedProviderOperationId: string | null;
    readonly subscriptionId: string;
    readonly vmResourceId: string;
  },
): { readonly providerOperationId: string; readonly state: string } {
  const envelope = record(value, "scheduleResponse");
  if (!Array.isArray(envelope.results) || envelope.results.length !== 1) {
    throw new AzureRuntimeError("schedule-result-count-invalid");
  }
  const result = record(envelope.results[0], "scheduleResult");
  if (
    !sameArmId(string(result.resourceId, "scheduleResult.resourceId"), expected.vmResourceId) ||
    (result.errorCode !== undefined && result.errorCode !== null && result.errorCode !== "") ||
    (result.errorDetails !== undefined &&
      result.errorDetails !== null &&
      result.errorDetails !== "")
  ) {
    throw new AzureRuntimeError("schedule-resource-result-invalid");
  }
  const operation = record(result.operation, "scheduleResult.operation");
  const operationId = bounded(operation.operationId, "operationId", 256);
  if (
    (expected.expectedProviderOperationId !== null &&
      operationId !== expected.expectedProviderOperationId) ||
    !sameArmId(string(operation.resourceId, "operation.resourceId"), expected.vmResourceId) ||
    string(operation.opType, "operation.opType") !== "Deallocate" ||
    string(operation.deadlineType, "operation.deadlineType") !== "CompleteBy" ||
    canonicalInstant(operation.deadline, "operation.deadline") !== expected.deadline ||
    string(operation.subscriptionId, "operation.subscriptionId").toLowerCase() !==
      expected.subscriptionId.toLowerCase() ||
    (operation.resourceOperationError !== undefined && operation.resourceOperationError !== null)
  ) {
    throw new AzureRuntimeError("schedule-operation-identity-invalid");
  }
  return { providerOperationId: operationId, state: string(operation.state, "operation.state") };
}

function scheduleStatus(state: string): "accepted" | "executed" | "failed" | "requested" {
  if (state === "PendingScheduling") return "requested";
  if (state === "Scheduled" || state === "PendingExecution") return "accepted";
  if (state === "Executing" || state === "Succeeded") return "executed";
  if (state === "Failed" || state === "Cancelled" || state === "Blocked" || state === "Unknown") {
    return "failed";
  }
  throw new AzureRuntimeError("schedule-operation-state-invalid");
}

function exactVmTarget(value: string, subscriptionId: string, correlationId: string) {
  const match = /^sy-([a-f0-9]{24})-g1-completeby$/.exec(correlationId);
  if (match === null) throw new AzureRuntimeError("schedule-correlation-id-invalid");
  const digest = match[1];
  if (digest === undefined) throw new AzureRuntimeError("schedule-correlation-id-invalid");
  const expected = `/subscriptions/${subscriptionId}/resourceGroups/rg-switchyard-allocation-${digest}/providers/Microsoft.Compute/virtualMachines/swy-${digest.slice(0, 20)}-g1`;
  if (!sameArmId(value, expected)) throw new AzureRuntimeError("schedule-vm-target-invalid");
  return { vmResourceId: expected };
}

function generateDisposableOpenSshPublicKey(): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" });
  const raw = der.subarray(der.length - 32);
  const algorithm = Buffer.from("ssh-ed25519", "ascii");
  const wire = Buffer.concat([uint32(algorithm.length), algorithm, uint32(raw.length), raw]);
  return `ssh-ed25519 ${wire.toString("base64")}`;
}

function uint32(value: number): Buffer {
  const result = Buffer.alloc(4);
  result.writeUInt32BE(value);
  return result;
}

async function readBoundedJson(response: Response, limit: number): Promise<unknown> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > limit) throw new AzureRuntimeError("azure-response-too-large");
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new AzureRuntimeError("azure-response-json-invalid");
  }
}

function exactSubnetId(value: string, subscriptionId: string): string {
  const canonicalSubscription = azureSubscriptionId(subscriptionId);
  const prefix = `/subscriptions/${canonicalSubscription}/resourceGroups/`;
  if (
    typeof value !== "string" ||
    !value.startsWith(prefix) ||
    !/\/providers\/Microsoft\.Network\/virtualNetworks\/[^/]+\/subnets\/[^/]+$/.test(value)
  ) {
    throw new TypeError("sharedRunnerSubnetId is invalid");
  }
  return value;
}

function azureSubscriptionId(value: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new TypeError("subscriptionId is invalid");
  }
  return value.toLowerCase();
}

function sameArmId(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function canonicalNow(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
    throw new AzureRuntimeError("runtime-clock-invalid");
  }
  return value.toISOString();
}

function canonicalInstant(value: unknown, path: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new AzureRuntimeError(`${path}-invalid`);
  }
  const canonical = new Date(value).toISOString();
  if (canonical !== value) throw new AzureRuntimeError(`${path}-noncanonical`);
  return canonical;
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AzureRuntimeError(`${path}-invalid`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length < 1) throw new AzureRuntimeError(`${path}-invalid`);
  return value;
}

function bounded(value: unknown, path: string, maximum: number): string {
  const candidate = string(value, path);
  if (candidate.length > maximum) throw new TypeError(`${path} is too long`);
  return candidate;
}

function canonicalProviderVmId(value: unknown, path: string): string {
  const candidate = bounded(value, path, 128);
  if (candidate !== candidate.trim()) {
    throw new AzureRuntimeError(`${path}-noncanonical`);
  }
  return candidate;
}

function providerVmIdFromEnvelope(value: unknown): string {
  const resource = record(value, "virtualMachine");
  const properties = record(resource.properties, "virtualMachine.properties");
  return canonicalProviderVmId(properties.vmId, "virtualMachine.vmId");
}

function sha256(value: unknown, path: string): string {
  const candidate = string(value, path);
  if (!/^[a-f0-9]{64}$/.test(candidate)) throw new TypeError(`${path} is not a sha256 digest`);
  return candidate;
}

export class AzureRuntimeError extends Error {
  readonly code: string;

  constructor(code: string) {
    super("Azure runtime operation failed");
    this.name = "AzureRuntimeError";
    this.code = code;
  }
}

export const REVIEWED_BASE_TEMPLATE_PATH = AZURE_BASE_TEMPLATE_PATH;
