import assert from "node:assert/strict";
import test from "node:test";

import {
  type AzureRecoveryTransport,
  type GitHubRecoveryPort,
  recoverAzureAllocation,
  RecoverySafetyError,
} from "../src/index.js";

const subscriptionId = "11111111-1111-4111-8111-111111111111";
const allocationId = `sy1-${"a".repeat(64)}`;
const resourceGroupName = `rg-switchyard-allocation-${"a".repeat(24)}`;
const resourceGroupId = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}`;
const vmName = `swy-${"a".repeat(20)}-g1`;
const vmResourceId = `${resourceGroupId}/providers/Microsoft.Compute/virtualMachines/${vmName}`;
const providerVmId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

test("dry-run creates a deterministic ledger-independent plan and performs no mutation", async () => {
  const azure = new FakeAzure();
  const github = new FakeGitHub();
  const first = await recoverAzureAllocation(request(false), azure, github);
  const second = await recoverAzureAllocation(request(false), new FakeAzure(), new FakeGitHub());
  assert.equal(first.status, "dry-run");
  assert.equal(first.planHash, second.planHash);
  assert.equal(first.ledger_settlement_required, true);
  assert.equal(first.providerVmId, providerVmId);
  assert.equal(first.runnerLabel, `switchyard-${allocationId}`);
  assert.deepEqual(azure.mutations, []);
  assert.equal(github.calls, 0);
});

test("execute revalidates, deallocates, fences GitHub, deletes and proves absence", async () => {
  const dryRun = await recoverAzureAllocation(request(false), new FakeAzure(), new FakeGitHub());
  const azure = new FakeAzure();
  const github = new FakeGitHub();
  const result = await recoverAzureAllocation(
    request(true, { expectedPlanHash: dryRun.planHash }),
    azure,
    github,
    { wait: async () => {} },
  );
  assert.equal(result.status, "deleted");
  assert.deepEqual(azure.mutations, ["deallocate", "delete-group"]);
  assert.equal(azure.groupReadsBeforeDelete, 3);
  assert.equal(github.calls, 1);
  assert.equal(result.ledger_settlement_required, true);
});

test("execute requires the fresh plan hash, literal confirmation and provider VM ID", async () => {
  for (const override of [
    { expectedPlanHash: undefined },
    { expectedPlanHash: "0".repeat(64) },
    { expectedProviderVmId: undefined },
    { confirmation: allocationId },
  ]) {
    const azure = new FakeAzure();
    await assert.rejects(
      recoverAzureAllocation(request(true, override), azure, new FakeGitHub()),
      RecoverySafetyError,
    );
    assert.deepEqual(azure.mutations, []);
  }
});

test("changed provider VM identity fails before deallocation", async () => {
  const dryRun = await recoverAzureAllocation(request(false), new FakeAzure(), new FakeGitHub());
  const azure = new FakeAzure({
    providerVmIdByInspection: [providerVmId, "ffffffff-1111-4222-8333-444444444444"],
  });
  await assert.rejects(
    recoverAzureAllocation(
      request(true, { expectedPlanHash: dryRun.planHash }),
      azure,
      new FakeGitHub(),
    ),
    /Azure recovery branch did not settle/,
  );
  assert.deepEqual(azure.mutations, []);
});

test("wrong tags, region, deadline arithmetic or deterministic target fail closed", async () => {
  for (const mutate of [
    (group: Record<string, unknown>) =>
      ((group.tags as Record<string, string>).managedBy = "other"),
    (group: Record<string, unknown>) => (group.location = "ukwest"),
    (group: Record<string, unknown>) =>
      ((group.tags as Record<string, string>).latestSafeStart = "2026-08-25T10:11:00.000Z"),
    (group: Record<string, unknown>) => (group.name = "rg-switchyard-example-control"),
  ]) {
    const azure = new FakeAzure({ mutateGroup: mutate });
    await assert.rejects(recoverAzureAllocation(request(false), azure, new FakeGitHub()));
    assert.deepEqual(azure.mutations, []);
  }
});

test("unknown inventory fences compute and runner but refuses resource-group deletion", async () => {
  const dryAzure = new FakeAzure({ includeUnknown: true });
  const plan = await recoverAzureAllocation(request(false), dryAzure, new FakeGitHub());
  assert.equal(plan.unexpectedResources.length, 1);
  const azure = new FakeAzure({ includeUnknown: true });
  const github = new FakeGitHub();
  await assert.rejects(
    recoverAzureAllocation(request(true, { expectedPlanHash: plan.planHash }), azure, github),
    /Azure recovery branch did not settle/,
  );
  assert.deepEqual(azure.mutations, ["deallocate"]);
  assert.equal(github.calls, 1);
});

test("the exact generation deployment and Run Command inventory is recognised", async () => {
  const plan = await recoverAzureAllocation(
    request(false),
    new FakeAzure({ includeExpectedChildren: true }),
    new FakeGitHub(),
  );
  assert.equal(plan.unexpectedResources.length, 0);
  assert.equal(plan.resources.length, 4);
});

test("Azure inventory pagination is bounded to the exact allocation group", async () => {
  const plan = await recoverAzureAllocation(
    request(false),
    new FakeAzure({ inventoryPages: "valid" }),
    new FakeGitHub(),
  );
  assert.equal(plan.resources.length, 2);
  for (const inventoryPages of ["escaped", "duplicate"] as const) {
    await assert.rejects(
      recoverAzureAllocation(request(false), new FakeAzure({ inventoryPages }), new FakeGitHub()),
      RecoverySafetyError,
    );
  }
});

test("GitHub outage cannot prevent deallocation or resource-group deletion", async () => {
  const plan = await recoverAzureAllocation(request(false), new FakeAzure(), new FakeGitHub());
  const azure = new FakeAzure();
  await assert.rejects(
    recoverAzureAllocation(
      request(true, { expectedPlanHash: plan.planHash }),
      azure,
      new FakeGitHub(true),
      { wait: async () => {} },
    ),
    /GitHub recovery branch did not settle/,
  );
  assert.deepEqual(azure.mutations, ["deallocate", "delete-group"]);
});

test("Azure deallocation failure cannot prevent independent GitHub fencing", async () => {
  const plan = await recoverAzureAllocation(request(false), new FakeAzure(), new FakeGitHub());
  const azure = new FakeAzure({ failDeallocate: true });
  const github = new FakeGitHub();
  await assert.rejects(
    recoverAzureAllocation(request(true, { expectedPlanHash: plan.planHash }), azure, github),
    /Azure recovery branch did not settle/,
  );
  assert.equal(github.calls, 1);
  assert.deepEqual(azure.mutations, ["deallocate"]);
});

test("an already absent allocation group still requires the independent GitHub fence", async () => {
  const plan = await recoverAzureAllocation(
    request(false),
    new FakeAzure({ initiallyAbsent: true }),
    new FakeGitHub(),
  );
  assert.equal(plan.status, "absent");
  const github = new FakeGitHub();
  const result = await recoverAzureAllocation(
    request(true, {
      expectedPlanHash: plan.planHash,
      expectedProviderVmId: undefined,
    }),
    new FakeAzure({ initiallyAbsent: true }),
    github,
  );
  assert.equal(result.status, "absent");
  assert.equal(github.calls, 1);
});

class FakeAzure implements AzureRecoveryTransport {
  deleted = false;
  groupReadsBeforeDelete = 0;
  readonly mutations: string[] = [];
  readonly #includeUnknown: boolean;
  readonly #includeExpectedChildren: boolean;
  readonly #failDeallocate: boolean;
  readonly #mutateGroup: ((group: Record<string, unknown>) => void) | undefined;
  readonly #initiallyAbsent: boolean;
  readonly #inventoryPages: "duplicate" | "escaped" | "none" | "valid";
  readonly #providerVmIdByInspection: readonly string[];
  #vmReads = 0;

  constructor(
    options: {
      readonly includeUnknown?: boolean;
      readonly includeExpectedChildren?: boolean;
      readonly failDeallocate?: boolean;
      readonly mutateGroup?: (group: Record<string, unknown>) => void;
      readonly initiallyAbsent?: boolean;
      readonly inventoryPages?: "duplicate" | "escaped" | "valid";
      readonly providerVmIdByInspection?: readonly string[];
    } = {},
  ) {
    this.#includeUnknown = options.includeUnknown ?? false;
    this.#includeExpectedChildren = options.includeExpectedChildren ?? false;
    this.#failDeallocate = options.failDeallocate ?? false;
    this.#initiallyAbsent = options.initiallyAbsent ?? false;
    this.#inventoryPages = options.inventoryPages ?? "none";
    this.#mutateGroup = options.mutateGroup;
    this.#providerVmIdByInspection = options.providerVmIdByInspection ?? [providerVmId];
  }

  async request(input: { readonly method: "DELETE" | "GET" | "POST"; readonly path: string }) {
    if (input.method === "POST") {
      assert.equal(input.path, `${vmResourceId}/deallocate?api-version=2025-04-01`);
      this.mutations.push("deallocate");
      return { body: null, status: this.#failDeallocate ? 500 : 202 };
    }
    if (input.method === "DELETE") {
      assert.equal(input.path, `${resourceGroupId}?api-version=2025-04-01`);
      this.mutations.push("delete-group");
      this.deleted = true;
      return { body: null, status: 202 };
    }
    if (input.path === `${resourceGroupId}?api-version=2025-04-01`) {
      if (this.deleted || this.#initiallyAbsent) return { body: null, status: 404 };
      this.groupReadsBeforeDelete += 1;
      const group = envelope(
        resourceGroupId,
        resourceGroupName,
        "Microsoft.Resources/resourceGroups",
        false,
      );
      this.#mutateGroup?.(group);
      return { body: group, status: 200 };
    }
    if (input.path === `${vmResourceId}?api-version=2025-04-01`) {
      const selected =
        this.#providerVmIdByInspection[
          Math.min(this.#vmReads, this.#providerVmIdByInspection.length - 1)
        ];
      this.#vmReads += 1;
      return {
        body: {
          ...envelope(vmResourceId, vmName, "Microsoft.Compute/virtualMachines", true),
          properties: { vmId: selected },
        },
        status: 200,
      };
    }
    if (input.path === `${vmResourceId}/instanceView?api-version=2025-04-01`) {
      return { body: { statuses: [{ code: "PowerState/deallocated" }] }, status: 200 };
    }
    if (input.path === `${resourceGroupId}/resources?api-version=2021-04-01`) {
      const resources: Record<string, unknown>[] = [
        envelope(vmResourceId, vmName, "Microsoft.Compute/virtualMachines", true),
      ];
      if (this.#includeExpectedChildren) {
        resources.push(
          {
            id: `${resourceGroupId}/providers/Microsoft.Resources/deployments/switchyard-allocation-${"a".repeat(20)}-g1`,
            name: `switchyard-allocation-${"a".repeat(20)}-g1`,
            type: "Microsoft.Resources/deployments",
          },
          {
            id: `${resourceGroupId}/providers/Microsoft.Resources/deployments/sy-${"a".repeat(24)}-g1-jit`,
            name: `sy-${"a".repeat(24)}-g1-jit`,
            type: "Microsoft.Resources/deployments",
          },
          envelope(
            `${vmResourceId}/runCommands/launch-jit-g1`,
            "launch-jit-g1",
            "Microsoft.Compute/virtualMachines/runCommands",
            true,
          ),
        );
      }
      if (this.#includeUnknown) {
        resources.push({
          id: `${resourceGroupId}/providers/Microsoft.Storage/storageAccounts/unexpected`,
          name: "unexpected",
          type: "Microsoft.Storage/storageAccounts",
        });
      }
      return {
        body: {
          ...(this.#inventoryPages === "none"
            ? {}
            : {
                nextLink:
                  this.#inventoryPages === "escaped"
                    ? "https://management.azure.com/subscriptions/other/resourceGroups/other/resources?page=2"
                    : `https://management.azure.com${resourceGroupId}/resources?api-version=2021-04-01&page=2`,
              }),
          value: resources,
        },
        status: 200,
      };
    }
    if (input.path === `${resourceGroupId}/resources?api-version=2021-04-01&page=2`) {
      return {
        body: {
          value: [
            this.#inventoryPages === "duplicate"
              ? envelope(vmResourceId, vmName, "Microsoft.Compute/virtualMachines", true)
              : {
                  id: `${resourceGroupId}/providers/Microsoft.Compute/disks/osdisk-${vmName}`,
                  location: "uksouth",
                  name: `osdisk-${vmName}`,
                  type: "Microsoft.Compute/disks",
                },
          ],
        },
        status: 200,
      };
    }
    throw new Error(`unexpected fake Azure request ${input.method} ${input.path}`);
  }
}

class FakeGitHub implements GitHubRecoveryPort {
  calls = 0;
  readonly #fail: boolean;

  constructor(fail = false) {
    this.#fail = fail;
  }

  async fenceExactRunnerLabel(input: { readonly runnerLabel: string }) {
    this.calls += 1;
    if (this.#fail) throw new Error("github unavailable");
    return { registrationsDeleted: 1, runnerLabel: input.runnerLabel };
  }
}

function request(execute: boolean, overrides: Record<string, unknown> = {}) {
  return {
    allocationId,
    ...(execute
      ? {
          confirmation: `DELETE ${resourceGroupName}`,
          expectedPlanHash: "f".repeat(64),
          expectedProviderVmId: providerVmId,
        }
      : {}),
    execute,
    subscriptionId,
    ...overrides,
  };
}

function envelope(
  id: string,
  name: string,
  type: string,
  generation: boolean,
): Record<string, unknown> {
  return {
    id,
    location: "uksouth",
    name,
    tags: {
      allocationAcceptedAt: "2026-08-25T10:00:00.000Z",
      allocationId,
      allocationLifetimeMinutes: "45",
      deletionTarget: "2026-08-25T10:45:00.000Z",
      latestSafeStart: "2026-08-25T10:10:00.000Z",
      managedBy: "switchyard-controller",
      mappedJobTimeoutMinutes: "25",
      originalCompleteBy: "2026-08-25T10:40:00.000Z",
      providerStopMarginMinutes: "5",
      system: "switchyard",
      ...(generation
        ? {
            deadlineContractValidated: "true",
            physicalGeneration: "1",
            physicalGenerationId: `${allocationId}:g1`,
          }
        : {}),
    },
    type,
  };
}
