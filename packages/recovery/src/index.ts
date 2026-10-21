import { createHash } from "node:crypto";

import { azureGenerationOneNames, azureRunnerLabelForAllocation } from "@switchyard/core";

const LOCATION = "uksouth" as const;
const PAGE_LIMIT = 10;
const RESOURCE_LIMIT = 100;

export interface RecoveryHttpResponse {
  readonly body: unknown;
  readonly status: number;
}

export interface AzureRecoveryTransport {
  request(input: {
    readonly method: "DELETE" | "GET" | "POST";
    readonly path: string;
  }): Promise<RecoveryHttpResponse>;
}

export interface GitHubRecoveryPort {
  fenceExactRunnerLabel(input: { readonly runnerLabel: string }): Promise<{
    readonly registrationsDeleted: number;
    readonly runnerLabel: string;
  }>;
}

export interface AzureRecoveryRequest {
  readonly allocationId: string;
  readonly confirmation?: string;
  readonly execute: boolean;
  readonly expectedPlanHash?: string;
  readonly expectedProviderVmId?: string;
  readonly subscriptionId: string;
}

export interface AzureRecoveryPlan {
  readonly allocationId: string;
  readonly execute: boolean;
  readonly ledger_settlement_required: true;
  readonly location: typeof LOCATION;
  readonly planHash: string;
  readonly providerVmId: string | null;
  readonly resourceGroupId: string;
  readonly resourceGroupName: string;
  readonly resources: readonly RecoveryResource[];
  readonly runnerLabel: string;
  readonly status: "absent" | "deleted" | "dry-run";
  readonly unexpectedResources: readonly RecoveryResource[];
  readonly vmResourceId: string;
}

interface RecoveryResource {
  readonly id: string;
  readonly type: string;
}

interface RecoveryInventory {
  readonly resources: readonly RecoveryResource[];
  readonly unexpectedResources: readonly RecoveryResource[];
}

export class RecoverySafetyError extends Error {
  override readonly name = "RecoverySafetyError";
}

/**
 * Ledger-independent recovery for one exact allocation group. The function
 * re-proves the complete plan before each Azure mutation and never changes the
 * authoritative Switchyard ledger.
 */
export async function recoverAzureAllocation(
  request: AzureRecoveryRequest,
  azure: AzureRecoveryTransport,
  github: GitHubRecoveryPort,
  options: { readonly wait?: (milliseconds: number) => Promise<void> } = {},
): Promise<AzureRecoveryPlan> {
  const subscriptionId = canonicalSubscriptionId(request.subscriptionId);
  const names = azureGenerationOneNames({ allocationId: request.allocationId, subscriptionId });
  const literalConfirmation = `DELETE ${names.resourceGroupName}`;
  if (request.execute && request.confirmation !== literalConfirmation) {
    throw new RecoverySafetyError(
      `execute requires the literal confirmation ${literalConfirmation}`,
    );
  }
  if (!request.execute && request.confirmation !== undefined) {
    throw new RecoverySafetyError("confirmation is accepted only with execute");
  }
  const expectedProviderVmId = optionalProviderVmId(request.expectedProviderVmId);
  const initial = await inspectAzureRecovery(request.allocationId, subscriptionId, azure);
  if (initial.status === "absent") {
    if (expectedProviderVmId !== null) {
      throw new RecoverySafetyError("provider VM ID was supplied for an absent allocation group");
    }
    if (!request.execute) return initial;
  }
  if (!request.execute) return initial;
  if (!/^[a-f0-9]{64}$/.test(request.expectedPlanHash ?? "")) {
    throw new RecoverySafetyError("execute requires the exact dry-run plan hash");
  }
  if (request.expectedPlanHash !== initial.planHash) {
    throw new RecoverySafetyError("the confirmed recovery plan no longer matches Azure");
  }
  if (initial.providerVmId !== null && expectedProviderVmId === null) {
    throw new RecoverySafetyError(
      `execute must pin the observed provider VM ID ${initial.providerVmId} from the dry run`,
    );
  }
  if (expectedProviderVmId !== initial.providerVmId) {
    throw new RecoverySafetyError("live provider VM ID differs from the confirmed VM");
  }

  const wait =
    options.wait ??
    ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let azureFailure: RecoverySafetyError | null = null;
  if (initial.status === "dry-run") {
    try {
      const beforeDeallocate = await inspectAzureRecovery(
        request.allocationId,
        subscriptionId,
        azure,
      );
      requireSamePlan(initial, beforeDeallocate);
      if (initial.providerVmId !== null) {
        const response = await azure.request({
          method: "POST",
          path: `${names.vmResourceId}/deallocate?api-version=2025-04-01`,
        });
        expectOneOf(response.status, [200, 202, 204], "VM deallocation");
        await proveVmDeallocated(azure, names.vmResourceId, wait);
      }
    } catch {
      azureFailure = new RecoverySafetyError("Azure compute deallocation could not be proved");
    }
  }

  let githubFailure: RecoverySafetyError | null = null;
  try {
    const fence = await github.fenceExactRunnerLabel({ runnerLabel: initial.runnerLabel });
    if (
      fence.runnerLabel !== initial.runnerLabel ||
      !Number.isSafeInteger(fence.registrationsDeleted) ||
      fence.registrationsDeleted < 0
    ) {
      throw new RecoverySafetyError("GitHub runner fence returned invalid evidence");
    }
  } catch {
    githubFailure = new RecoverySafetyError("GitHub runner absence could not be proved");
  }

  if (
    initial.status === "dry-run" &&
    azureFailure === null &&
    initial.unexpectedResources.length === 0
  ) {
    try {
      const beforeDelete = await inspectAzureRecovery(request.allocationId, subscriptionId, azure);
      requireSamePlan(initial, beforeDelete);
      const deletion = await azure.request({
        method: "DELETE",
        path: `${names.resourceGroupId}?api-version=2025-04-01`,
      });
      expectOneOf(deletion.status, [200, 202, 204, 404], "resource-group deletion");
      if (deletion.status !== 404) {
        let absent = false;
        for (let attempt = 0; attempt < 10; attempt += 1) {
          await wait(2_000);
          const observation = await azure.request({
            method: "GET",
            path: `${names.resourceGroupId}?api-version=2025-04-01`,
          });
          if (observation.status === 404) {
            absent = true;
            break;
          }
          expectOneOf(observation.status, [200], "resource-group deletion poll");
          validateGroup(observation.body, request.allocationId, names);
        }
        if (!absent) {
          throw new RecoverySafetyError(
            "resource-group deletion remains pending; rerun recovery and keep ledger reservations held",
          );
        }
      }
    } catch {
      azureFailure = new RecoverySafetyError("Azure resource-group deletion could not be proved");
    }
  } else if (initial.unexpectedResources.length > 0) {
    azureFailure = new RecoverySafetyError("unexpected resources prevent resource-group deletion");
  }

  if (azureFailure !== null || githubFailure !== null) {
    const branches = [
      azureFailure === null ? null : "Azure",
      githubFailure === null ? null : "GitHub",
    ]
      .filter((branch): branch is string => branch !== null)
      .join(" and ");
    throw new RecoverySafetyError(
      `${branches} recovery branch did not settle; rerun recovery and keep ledger reservations held`,
    );
  }
  return Object.freeze({
    ...initial,
    execute: true,
    status: initial.status === "absent" ? "absent" : "deleted",
  });
}

async function proveVmDeallocated(
  azure: AzureRecoveryTransport,
  vmResourceId: string,
  wait: (milliseconds: number) => Promise<void>,
): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const observation = await azure.request({
      method: "GET",
      path: `${vmResourceId}/instanceView?api-version=2025-04-01`,
    });
    if (observation.status === 404) return;
    expectOneOf(observation.status, [200], "VM deallocation observation");
    const statuses = asRecord(observation.body).statuses;
    if (!Array.isArray(statuses) || statuses.length > 64) {
      throw new RecoverySafetyError("VM deallocation observation is malformed");
    }
    const powerStates = statuses
      .map((entry) => string(asRecord(entry).code, "VM power state"))
      .filter((code) => code.startsWith("PowerState/"));
    if (powerStates.length !== 1) {
      throw new RecoverySafetyError("VM deallocation observation is ambiguous");
    }
    if (powerStates[0] === "PowerState/deallocated") return;
    await wait(2_000);
  }
  throw new RecoverySafetyError("VM deallocation did not complete within the bounded poll");
}

/** Deterministic plan/hash construction over validated, already-fetched evidence. */
export function planAzureRecovery(input: Omit<AzureRecoveryPlan, "planHash">): AzureRecoveryPlan {
  const resources = Object.freeze([...input.resources].sort(compareRecoveryResources));
  const unexpectedResources = Object.freeze(
    [...input.unexpectedResources].sort(compareRecoveryResources),
  );
  const hashInput = JSON.stringify({
    allocationId: input.allocationId,
    ledger_settlement_required: input.ledger_settlement_required,
    location: input.location,
    providerVmId: input.providerVmId,
    resourceGroupId: input.resourceGroupId,
    resources,
    runnerLabel: input.runnerLabel,
    status: input.status,
    unexpectedResources,
    vmResourceId: input.vmResourceId,
  });
  return Object.freeze({
    ...input,
    planHash: createHash("sha256").update(hashInput).digest("hex"),
    resources,
    unexpectedResources,
  });
}

function compareRecoveryResources(left: RecoveryResource, right: RecoveryResource): number {
  return `${left.type}\0${left.id}`.localeCompare(`${right.type}\0${right.id}`);
}

async function inspectAzureRecovery(
  allocationId: string,
  subscriptionId: string,
  transport: AzureRecoveryTransport,
): Promise<AzureRecoveryPlan> {
  const names = azureGenerationOneNames({ allocationId, subscriptionId });
  const runnerLabel = azureRunnerLabelForAllocation(allocationId);
  const groupResponse = await transport.request({
    method: "GET",
    path: `${names.resourceGroupId}?api-version=2025-04-01`,
  });
  if (groupResponse.status === 404) {
    return planAzureRecovery({
      allocationId,
      execute: false,
      ledger_settlement_required: true,
      location: LOCATION,
      providerVmId: null,
      resourceGroupId: names.resourceGroupId,
      resourceGroupName: names.resourceGroupName,
      resources: Object.freeze([]),
      runnerLabel,
      status: "absent",
      unexpectedResources: Object.freeze([]),
      vmResourceId: names.vmResourceId,
    });
  }
  expectOneOf(groupResponse.status, [200], "resource-group lookup");
  validateGroup(groupResponse.body, allocationId, names);

  const vmResponse = await transport.request({
    method: "GET",
    path: `${names.vmResourceId}?api-version=2025-04-01`,
  });
  let providerVmId: string | null = null;
  if (vmResponse.status === 200) {
    const vm = ownedEnvelope(vmResponse.body, {
      allocationId,
      expectedId: names.vmResourceId,
      expectedName: names.vmName,
      generation: true,
      type: "Microsoft.Compute/virtualMachines",
    });
    validateDeadlineTags(vm.tags);
    providerVmId = requiredProviderVmId(asRecord(asRecord(vmResponse.body).properties).vmId);
  } else if (vmResponse.status !== 404) {
    throw new RecoverySafetyError(`VM lookup returned unexpected HTTP ${vmResponse.status}`);
  }
  const inventory = await enumerateResources(transport, { allocationId, names });
  return planAzureRecovery({
    allocationId,
    execute: false,
    ledger_settlement_required: true,
    location: LOCATION,
    providerVmId,
    resourceGroupId: names.resourceGroupId,
    resourceGroupName: names.resourceGroupName,
    resources: inventory.resources,
    runnerLabel,
    status: "dry-run",
    unexpectedResources: inventory.unexpectedResources,
    vmResourceId: names.vmResourceId,
  });
}

async function enumerateResources(
  transport: AzureRecoveryTransport,
  input: {
    readonly allocationId: string;
    readonly names: ReturnType<typeof azureGenerationOneNames>;
  },
): Promise<RecoveryInventory> {
  const resources: RecoveryResource[] = [];
  const unexpectedResources: RecoveryResource[] = [];
  const seen = new Set<string>();
  let path: string | null = `${input.names.resourceGroupId}/resources?api-version=2021-04-01`;
  for (let page = 0; path !== null; page += 1) {
    if (page >= PAGE_LIMIT || seen.has(path)) {
      throw new RecoverySafetyError("resource enumeration exceeded its safe bound");
    }
    seen.add(path);
    const response = await transport.request({ method: "GET", path });
    expectOneOf(response.status, [200], "resource enumeration");
    const envelope = asRecord(response.body);
    if (!Array.isArray(envelope.value) || envelope.value.length > RESOURCE_LIMIT) {
      throw new RecoverySafetyError("resource enumeration returned an invalid page");
    }
    for (const value of envelope.value) {
      const resource = asRecord(value);
      const candidate = Object.freeze({
        id: canonicalArmId(resource.id),
        type: string(resource.type, "resource type"),
      });
      if (
        [...resources, ...unexpectedResources].some(
          (existing) => existing.id.toLowerCase() === candidate.id.toLowerCase(),
        )
      ) {
        throw new RecoverySafetyError("resource enumeration returned a duplicate resource");
      }
      if (validateExpectedChild(input.names, input.allocationId, resource, candidate)) {
        resources.push(candidate);
      } else {
        ensureResourceInsideGroup(input.names.resourceGroupId, resource, candidate);
        unexpectedResources.push(candidate);
      }
      if (resources.length + unexpectedResources.length > RESOURCE_LIMIT) {
        throw new RecoverySafetyError("resource enumeration exceeded its allocation bound");
      }
    }
    const nextLink = envelope.nextLink;
    if (nextLink === undefined || nextLink === null) {
      path = null;
    } else {
      const link = string(nextLink, "nextLink");
      const prefix = "https://management.azure.com";
      if (!link.startsWith(prefix))
        throw new RecoverySafetyError("resource nextLink escaped Azure");
      path = link.slice(prefix.length);
      if (!path.startsWith(`${input.names.resourceGroupId}/resources?`)) {
        throw new RecoverySafetyError("resource nextLink escaped the allocation group");
      }
    }
  }
  return {
    resources: Object.freeze(resources),
    unexpectedResources: Object.freeze(unexpectedResources),
  };
}

function validateExpectedChild(
  names: ReturnType<typeof azureGenerationOneNames>,
  allocationId: string,
  resource: Record<string, unknown>,
  candidate: RecoveryResource,
): boolean {
  const expected = new Map<string, readonly string[]>([
    ["Microsoft.Compute/virtualMachines", [names.vmResourceId]],
    [
      "Microsoft.Compute/virtualMachines/runCommands",
      [`${names.vmResourceId}/runCommands/launch-jit-g1`],
    ],
    [
      "Microsoft.Compute/disks",
      [`${names.resourceGroupId}/providers/Microsoft.Compute/disks/osdisk-${names.vmName}`],
    ],
    [
      "Microsoft.Network/networkInterfaces",
      [
        `${names.resourceGroupId}/providers/Microsoft.Network/networkInterfaces/nic-${names.vmName}`,
      ],
    ],
    [
      "Microsoft.Network/networkSecurityGroups",
      [
        `${names.resourceGroupId}/providers/Microsoft.Network/networkSecurityGroups/nsg-${names.vmName}`,
      ],
    ],
    [
      "Microsoft.Network/publicIPAddresses",
      [
        `${names.resourceGroupId}/providers/Microsoft.Network/publicIPAddresses/pip-${names.vmName}`,
      ],
    ],
    ["Microsoft.Resources/deployments", [names.childDeploymentId, names.jitDeploymentId]],
  ]);
  const expectedIds = expected.get(candidate.type);
  if (
    expectedIds === undefined ||
    !expectedIds.some((expectedId) => expectedId.toLowerCase() === candidate.id.toLowerCase())
  ) {
    return false;
  }
  if (candidate.type === "Microsoft.Resources/deployments") {
    if (resource.location !== undefined) ensureUkSouth(resource);
    return true;
  }
  ensureUkSouth(resource);
  if (candidate.type !== "Microsoft.Compute/disks") {
    const tags = requiredTags(resource.tags);
    validateGenerationTags(tags, allocationId);
    validateDeadlineTags(tags);
  }
  return true;
}

function ensureResourceInsideGroup(
  resourceGroupId: string,
  resource: Record<string, unknown>,
  candidate: RecoveryResource,
): void {
  if (!candidate.id.toLowerCase().startsWith(`${resourceGroupId.toLowerCase()}/providers/`)) {
    throw new RecoverySafetyError("resource enumeration escaped the allocation group");
  }
  // An unexpected child can itself have a foreign or absent location. Keep it
  // in the plan so the proved VM can still be deallocated, but never delete
  // the group while any such child remains.
  void resource;
}

function validateGroup(
  value: unknown,
  allocationId: string,
  names: ReturnType<typeof azureGenerationOneNames>,
): void {
  const group = ownedEnvelope(value, {
    allocationId,
    expectedId: names.resourceGroupId,
    expectedName: names.resourceGroupName,
    generation: false,
    type: "Microsoft.Resources/resourceGroups",
  });
  validateDeadlineTags(group.tags);
}

function ownedEnvelope(
  value: unknown,
  expected: {
    readonly allocationId: string;
    readonly expectedId: string;
    readonly expectedName: string;
    readonly generation: boolean;
    readonly type: string;
  },
): { readonly tags: Record<string, string> } {
  const record = asRecord(value);
  if (
    canonicalArmId(record.id).toLowerCase() !== expected.expectedId.toLowerCase() ||
    string(record.name, "resource name") !== expected.expectedName ||
    string(record.type, "resource type").toLowerCase() !== expected.type.toLowerCase()
  ) {
    throw new RecoverySafetyError("Azure resource identity does not match the recovery target");
  }
  ensureUkSouth(record);
  const tags = requiredTags(record.tags);
  validateAllocationTags(tags, expected.allocationId);
  if (expected.generation) validateGenerationTags(tags, expected.allocationId);
  return { tags };
}

function validateAllocationTags(tags: Record<string, string>, allocationId: string): void {
  if (
    tags.allocationId !== allocationId ||
    tags.managedBy !== "switchyard-controller" ||
    tags.system !== "switchyard" ||
    tags.allocationLifetimeMinutes !== "45"
  ) {
    throw new RecoverySafetyError("mandatory allocation recovery tags do not match");
  }
}

function validateGenerationTags(tags: Record<string, string>, allocationId: string): void {
  validateAllocationTags(tags, allocationId);
  if (
    tags.physicalGeneration !== "1" ||
    tags.physicalGenerationId !== `${allocationId}:g1` ||
    tags.deadlineContractValidated !== "true"
  ) {
    throw new RecoverySafetyError("mandatory generation recovery tags do not match");
  }
}

function validateDeadlineTags(tags: Record<string, string>): void {
  const accepted = canonicalTimestamp(tags.allocationAcceptedAt);
  const compute = canonicalTimestamp(tags.originalCompleteBy);
  const deletion = canonicalTimestamp(tags.deletionTarget);
  const latest = canonicalTimestamp(tags.latestSafeStart);
  const timeout = tags.mappedJobTimeoutMinutes;
  const margin = tags.providerStopMarginMinutes;
  if (
    timeout !== "25" ||
    margin !== "5" ||
    Date.parse(compute) !== Date.parse(accepted) + 40 * 60_000 ||
    Date.parse(deletion) !== Date.parse(accepted) + 45 * 60_000 ||
    Date.parse(latest) !== Date.parse(compute) - (Number(timeout) + Number(margin)) * 60_000
  ) {
    throw new RecoverySafetyError("immutable deadline recovery tags are inconsistent");
  }
}

function requireSamePlan(expected: AzureRecoveryPlan, actual: AzureRecoveryPlan): void {
  if (actual.planHash !== expected.planHash || actual.status !== "dry-run") {
    throw new RecoverySafetyError("Azure recovery target changed before mutation");
  }
}

function requiredTags(value: unknown): Record<string, string> {
  const tags = asRecord(value);
  const parsed: Record<string, string> = {};
  const names = new Set<string>();
  for (const [key, entry] of Object.entries(tags)) {
    if (typeof entry !== "string" || key.length > 128 || entry.length > 256) {
      throw new RecoverySafetyError("Azure resource has malformed tags");
    }
    const normalisedName = key.toLowerCase();
    if (names.has(normalisedName)) {
      throw new RecoverySafetyError("Azure resource has ambiguous tag names");
    }
    names.add(normalisedName);
    parsed[key] = entry;
  }
  return parsed;
}

function ensureUkSouth(resource: Record<string, unknown>): void {
  if (
    string(resource.location, "resource location").replaceAll(" ", "").toLowerCase() !== LOCATION
  ) {
    throw new RecoverySafetyError("recovery resource is outside UK South");
  }
}

function canonicalSubscriptionId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
    throw new RecoverySafetyError("subscription ID must be a canonical lowercase UUID");
  }
  return value;
}

function optionalProviderVmId(value: string | undefined): string | null {
  return value === undefined ? null : requiredProviderVmId(value);
}

function requiredProviderVmId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-fA-F-]{8,128}$/.test(value)) {
    throw new RecoverySafetyError("provider VM ID is not canonical");
  }
  return value.toLowerCase();
}

function canonicalTimestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new RecoverySafetyError("recovery timestamp is not canonical UTC");
  }
  return value;
}

function canonicalArmId(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/subscriptions/") || value.length > 1024) {
    throw new RecoverySafetyError("Azure resource ID is invalid");
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RecoverySafetyError("provider returned an invalid object");
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 2048) {
    throw new RecoverySafetyError(`${name} is invalid`);
  }
  return value;
}

function expectOneOf(actual: number, expected: readonly number[], operation: string): void {
  if (!expected.includes(actual)) {
    throw new RecoverySafetyError(`${operation} returned unexpected HTTP ${actual}`);
  }
}
