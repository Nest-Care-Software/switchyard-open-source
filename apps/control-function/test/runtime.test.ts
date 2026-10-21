import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import type { AzureGenerationOneWorker, AzureGenerationPlan } from "@switchyard/azure-worker";
import {
  type AllocationControlLedger,
  type AllocationIdentity,
  type AllocationRecord,
  azureGenerationOneNames,
  type PhysicalGeneration,
  type ProviderAttempt,
} from "@switchyard/core";
import type { GitHubOperationClientFactory } from "@switchyard/github";

import {
  AzureRuntimeTransport,
  assertOwnedAzureGeneration,
  LiveAzureComputeSchedule,
  LiveAzureGenerationPlanner,
  LiveAzureResourcePort,
} from "../src/azure-live.js";
import { parseAdmissionRuntimeConfig, parseSafetyRuntimeConfig } from "../src/config.js";
import { DeferredGitHubSafetyGateway } from "../src/github-gateway.js";
import { LiveGitHubRunnerRegistration } from "../src/github-live.js";
import { QueueDrivenSafetyRuntime, SplitControlFunctionRuntime } from "../src/runtime.js";

const SUBSCRIPTION = "11111111-2222-3333-4444-555555555555";
const ALLOCATION_ID = `sy1-${"ab".repeat(32)}`;
const NAMES = azureGenerationOneNames({
  allocationId: ALLOCATION_ID,
  subscriptionId: SUBSCRIPTION,
});
const NOW = "2026-08-25T00:05:00.000Z";
const DEADLINE = "2026-08-25T00:40:00.000Z";

describe("live Compute Schedule adapter", () => {
  it("adopts Azure's operation ID once and polls with both durable IDs", async () => {
    const requests: Array<{ body: Record<string, unknown>; url: string }> = [];
    const responses = [
      scheduleResponse("provider-operation-42", "PendingScheduling"),
      scheduleResponse("provider-operation-42", "Scheduled"),
    ];
    const transport = new AzureRuntimeTransport({
      credential: tokenCredential(),
      fetch: async (url, init) => {
        requests.push({
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
          url: String(url),
        });
        return Response.json(responses.shift(), { status: 200 });
      },
      subscriptionId: SUBSCRIPTION,
    });
    const schedule = new LiveAzureComputeSchedule({
      now: () => new Date(NOW),
      ownership: ownedScheduleTarget(),
      transport,
    });
    const intent = scheduleIntent(null);
    const requested = await schedule.ensureCompleteBy({
      correlationId: NAMES.scheduleCorrelationId,
      existing: intent,
      providerVmId: "provider-vm-1",
      requestedDeadline: DEADLINE,
      targetVmResourceId: NAMES.vmResourceId,
    });
    assert.equal(requested.providerOperationId, "provider-operation-42");
    assert.equal(requested.status, "requested");
    const accepted = await schedule.ensureCompleteBy({
      correlationId: NAMES.scheduleCorrelationId,
      existing: requested as typeof intent & { providerOperationId: string },
      providerVmId: "provider-vm-1",
      requestedDeadline: DEADLINE,
      targetVmResourceId: NAMES.vmResourceId,
    });
    assert.equal(accepted.providerOperationId, "provider-operation-42");
    assert.equal(accepted.status, "accepted");
    assert.match(requests[0]?.url ?? "", /virtualMachinesSubmitDeallocate/);
    assert.deepEqual(requests[1]?.body, {
      correlationid: NAMES.scheduleCorrelationId,
      operationIds: ["provider-operation-42"],
    });
  });

  it("rejects multiple results and a conflicting provider ID without another submit", async () => {
    let calls = 0;
    const transport = new AzureRuntimeTransport({
      credential: tokenCredential(),
      fetch: async () => {
        calls += 1;
        return Response.json({
          results: [
            scheduleResponse("one", "Scheduled").results[0],
            scheduleResponse("two", "Scheduled").results[0],
          ],
        });
      },
      subscriptionId: SUBSCRIPTION,
    });
    const schedule = new LiveAzureComputeSchedule({ ownership: ownedScheduleTarget(), transport });
    await assert.rejects(
      schedule.ensureCompleteBy({
        correlationId: NAMES.scheduleCorrelationId,
        existing: scheduleIntent(null),
        providerVmId: "provider-vm-1",
        requestedDeadline: DEADLINE,
        targetVmResourceId: NAMES.vmResourceId,
      }),
      /Azure runtime operation failed/,
    );
    assert.equal(calls, 1);
  });

  for (const providerState of ["Executing", "Succeeded"] as const) {
    it(`does not report ${providerState} as readiness protection`, async () => {
      const transport = new AzureRuntimeTransport({
        credential: tokenCredential(),
        fetch: async () => Response.json(scheduleResponse("provider-operation-42", providerState)),
        subscriptionId: SUBSCRIPTION,
      });
      const schedule = new LiveAzureComputeSchedule({
        now: () => new Date(NOW),
        ownership: ownedScheduleTarget(),
        transport,
      });
      const observed = await schedule.ensureCompleteBy({
        correlationId: NAMES.scheduleCorrelationId,
        existing: {
          ...scheduleIntent("provider-operation-42"),
          acceptedAt: "2026-08-25T00:04:00.000Z",
          status: "accepted",
        },
        providerVmId: "provider-vm-1",
        requestedDeadline: DEADLINE,
        targetVmResourceId: NAMES.vmResourceId,
      });
      assert.equal(observed.status, "executed");
      assert.equal(observed.acceptedAt, "2026-08-25T00:04:00.000Z");
    });
  }

  it("proves the exact live VM before either schedule submit or poll", async () => {
    let armCalls = 0;
    const transport = new AzureRuntimeTransport({
      credential: tokenCredential(),
      fetch: async () => {
        armCalls += 1;
        return Response.json(scheduleResponse("provider-operation-42", "Scheduled"));
      },
      subscriptionId: SUBSCRIPTION,
    });
    const schedule = new LiveAzureComputeSchedule({
      ownership: {
        assertScheduleTargetOwned: async () => {
          throw new Error("live VM ownership mismatch");
        },
      },
      transport,
    });
    await assert.rejects(
      schedule.ensureCompleteBy({
        correlationId: NAMES.scheduleCorrelationId,
        existing: scheduleIntent(null),
        providerVmId: "provider-vm-1",
        requestedDeadline: DEADLINE,
        targetVmResourceId: NAMES.vmResourceId,
      }),
      /ownership mismatch/,
    );
    await assert.rejects(
      schedule.ensureCompleteBy({
        correlationId: NAMES.scheduleCorrelationId,
        existing: {
          ...scheduleIntent("provider-operation-42"),
          acceptedAt: "2026-08-25T00:04:00.000Z",
          status: "accepted",
        },
        providerVmId: "provider-vm-1",
        requestedDeadline: DEADLINE,
        targetVmResourceId: NAMES.vmResourceId,
      }),
      /ownership mismatch/,
    );
    assert.equal(armCalls, 0);
  });
});

describe("strict runtime configuration", () => {
  it("parses schema 10 safety and explicit admission independently", () => {
    const environment = validEnvironment();
    assert.equal(parseSafetyRuntimeConfig(environment).ledger.partitionKey, "control-v10");
    assert.equal(parseAdmissionRuntimeConfig(environment).costs.azureLarge, 40);
  });

  it("rejects unknown and secret-bearing Switchyard variables", () => {
    assert.throws(
      () => parseSafetyRuntimeConfig({ ...validEnvironment(), SWITCHYARD_UNKNOWN: "x" }),
      /unknown Switchyard/,
    );
    assert.throws(
      () =>
        parseSafetyRuntimeConfig({
          ...validEnvironment(),
          SWITCHYARD_GITHUB_APP_PRIVATE_KEY: "forbidden",
        }),
      /secret-bearing/,
    );
    assert.throws(
      () => parseSafetyRuntimeConfig({ ...validEnvironment(), AZURE_CLIENT_SECRET: "forbidden" }),
      /secret-bearing/,
    );
  });
});

describe("split safety and admission runtime", () => {
  it("returns 503 for failed admission while safety still provisions and reconciles", async () => {
    let provisioned = 0;
    let reconciled = 0;
    const runtime = new SplitControlFunctionRuntime({
      admission: async () => {
        throw new Error("admission unavailable");
      },
      safety: {
        poison: async () => ({ allocationId: null }),
        provision: async () => {
          provisioned += 1;
          return { allocationId: ALLOCATION_ID, outcome: "ignored", reason: "attempt-ended" };
        },
        reconcile: async () => {
          reconciled += 1;
          return {
            completeScan: true,
            heartbeatRecorded: true,
            lifecycleFailures: 0,
            processedAllocations: 0,
            visibilityFailures: 0,
          };
        },
      },
    });
    const response = await runtime.allocate(httpRequest());
    assert.equal(response.status, 503);
    await runtime.provision(queueMessage());
    await runtime.reconcile();
    assert.equal(provisioned, 1);
    assert.equal(reconciled, 1);
  });

  it("requeues canonical progress only after the durable worker result", async () => {
    const dispatched: unknown[] = [];
    const worker = {
      reconcile: async () => ({
        allocationId: ALLOCATION_ID,
        outcome: "progress" as const,
        stage: "schedule-requested",
      }),
    } as unknown as AzureGenerationOneWorker;
    const runtime = new QueueDrivenSafetyRuntime({
      queue: {
        dispatch: async (message, delay) => {
          dispatched.push({ delay, message });
        },
      },
      reconcile: async () => ({
        completeScan: true,
        heartbeatRecorded: true,
        lifecycleFailures: 0,
        processedAllocations: 0,
        visibilityFailures: 0,
      }),
      worker,
    });
    await runtime.provision(JSON.stringify(queueMessage()));
    assert.deepEqual(dispatched, [{ delay: 5, message: queueMessage() }]);
    assert.equal((await runtime.poison("not-json")).allocationId, null);
  });
});

describe("Azure generation ownership and public key planning", () => {
  it("rejects the control group, wrong allocation digest and wrong generation", () => {
    const generation = generationFixture();
    assert.doesNotThrow(() =>
      assertOwnedAzureGeneration({
        allocationId: ALLOCATION_ID,
        baseTemplateSha256: "1".repeat(64),
        bootstrapSha256: "3".repeat(64),
        generation,
        imageVersion: "24.04.202608250",
        resourceId: NAMES.vmResourceId,
        runnerSubnetId: generation.basePlan.sharedRunnerSubnetId,
        subscriptionId: SUBSCRIPTION,
      }),
    );
    for (const resourceId of [
      `/subscriptions/${SUBSCRIPTION}/resourceGroups/rg-switchyard-example-control`,
      NAMES.vmResourceId.replace("abab", "cdcd"),
    ]) {
      assert.throws(() =>
        assertOwnedAzureGeneration({
          allocationId: ALLOCATION_ID,
          baseTemplateSha256: "1".repeat(64),
          bootstrapSha256: "3".repeat(64),
          generation,
          imageVersion: "24.04.202608250",
          resourceId,
          runnerSubnetId: generation.basePlan.sharedRunnerSubnetId,
          subscriptionId: SUBSCRIPTION,
        }),
      );
    }
    assert.throws(() =>
      assertOwnedAzureGeneration({
        allocationId: ALLOCATION_ID,
        baseTemplateSha256: "1".repeat(64),
        bootstrapSha256: "3".repeat(64),
        generation: { ...generation, generationNumber: 2 },
        imageVersion: "24.04.202608250",
        resourceId: NAMES.vmResourceId,
        runnerSubnetId: generation.basePlan.sharedRunnerSubnetId,
        subscriptionId: SUBSCRIPTION,
      }),
    );
    assert.throws(() =>
      assertOwnedAzureGeneration({
        allocationId: ALLOCATION_ID,
        baseTemplateSha256: "9".repeat(64),
        bootstrapSha256: "3".repeat(64),
        generation,
        imageVersion: "24.04.202608250",
        resourceId: NAMES.vmResourceId,
        runnerSubnetId: generation.basePlan.sharedRunnerSubnetId,
        subscriptionId: SUBSCRIPTION,
      }),
    );
  });

  it("generates race candidates once and reuses the persisted winner after restart", async () => {
    const options = {
      baseTemplateSha256: "1".repeat(64),
      imageVersion: "24.04.202608250",
      nonSecretBootstrapCustomData: "#!/bin/sh\nexit 0\n",
      sharedRunnerSubnetId: `/subscriptions/${SUBSCRIPTION}/resourceGroups/rg-network/providers/Microsoft.Network/virtualNetworks/vnet/subnets/runners`,
      subscriptionId: SUBSCRIPTION,
    };
    const first = await new LiveAzureGenerationPlanner(options).plan(planningInput());
    const racing = await new LiveAzureGenerationPlanner(options).plan(planningInput());
    assert.notEqual(first.adminSshPublicKey, racing.adminSshPublicKey);
    const persistedBasePlan = {
      adminSshPublicKey: first.adminSshPublicKey,
      adminSshPublicKeySha256: sha256(first.adminSshPublicKey),
      baseTemplateSha256: first.baseTemplateSha256,
      imageVersion: first.imageVersion,
      nonSecretBootstrapSha256: sha256(options.nonSecretBootstrapCustomData),
      sharedRunnerSubnetId: first.sharedRunnerSubnetId,
      subscriptionId: first.subscriptionId,
    };
    const restart = await new LiveAzureGenerationPlanner(options).plan({
      ...planningInput(),
      persistedBasePlan,
    });
    assert.equal(restart.adminSshPublicKey, first.adminSshPublicKey);
  });
});

describe("live Azure mutation ownership and asynchronous Run Command deletion", () => {
  it("binds every live VM read to the original provider VM identity", async () => {
    const generation = generationFixtureWithCommand(
      `${NAMES.vmResourceId}/runCommands/launch-jit-g1`,
    );
    const allocation = allocationFixture(generation);
    const matching = liveAzureResources(allocation, async () =>
      Response.json({
        ...resourceEnvelope(NAMES.vmResourceId, true),
        properties: { vmId: "provider-vm-1" },
      }),
    );
    await assert.doesNotReject(
      matching.assertScheduleTargetOwned(NAMES.vmResourceId, "provider-vm-1"),
    );

    for (const properties of [{}, { vmId: "provider-vm-replacement" }]) {
      const replaced = liveAzureResources(allocation, async () =>
        Response.json({
          ...resourceEnvelope(NAMES.vmResourceId, true),
          properties,
        }),
      );
      await assert.rejects(
        replaced.assertScheduleTargetOwned(NAMES.vmResourceId, "provider-vm-1"),
        /Azure runtime operation failed/,
      );
    }
  });

  it("does not delete an allocation group containing a replacement VM", async () => {
    const generation = generationFixtureWithCommand(
      `${NAMES.vmResourceId}/runCommands/launch-jit-g1`,
    );
    let deleteCalls = 0;
    const resources = liveAzureResources(allocationFixture(generation), async (url, init) => {
      if (init?.method === "DELETE") {
        deleteCalls += 1;
        return new Response(null, { status: 202 });
      }
      return new URL(String(url)).pathname
        .toLowerCase()
        .endsWith(`/virtualmachines/${NAMES.vmName}`.toLowerCase())
        ? Response.json(virtualMachineEnvelope("provider-vm-replacement"))
        : Response.json(resourceEnvelope(NAMES.resourceGroupId, false));
    });
    await assert.rejects(
      resources.deleteResourceGroup({ resourceGroupId: NAMES.resourceGroupId }),
      /Azure runtime operation failed/,
    );
    assert.equal(deleteCalls, 0);
  });

  it("never deletes a live VM whose provider identity was not durably observed", async () => {
    const generation = generationFixtureWithDeployment();
    for (const properties of [{}, { vmId: "provider-vm-from-lost-response" }]) {
      let deleteCalls = 0;
      const resources = liveAzureResources(allocationFixture(generation), async (url, init) => {
        if (init?.method === "DELETE") {
          deleteCalls += 1;
          return new Response(null, { status: 202 });
        }
        return new URL(String(url)).pathname
          .toLowerCase()
          .endsWith(`/virtualmachines/${NAMES.vmName}`.toLowerCase())
          ? Response.json({
              ...resourceEnvelope(NAMES.vmResourceId, true),
              properties,
            })
          : Response.json(resourceEnvelope(NAMES.resourceGroupId, false));
      });
      await assert.rejects(
        resources.deleteResourceGroup({ resourceGroupId: NAMES.resourceGroupId }),
        /Azure runtime operation failed/,
      );
      await assert.rejects(
        resources.deleteResourceGroup({ resourceGroupId: NAMES.resourceGroupId }),
        /Azure runtime operation failed/,
      );
      assert.equal(deleteCalls, 0);
    }
  });

  it("deletes an exact owned group only after proving its unpersisted VM is absent", async () => {
    const generation = generationFixtureWithDeployment();
    let deleteCalls = 0;
    const resources = liveAzureResources(allocationFixture(generation), async (url, init) => {
      if (init?.method === "DELETE") {
        deleteCalls += 1;
        return new Response(null, { status: 202 });
      }
      return new URL(String(url)).pathname
        .toLowerCase()
        .endsWith(`/virtualmachines/${NAMES.vmName}`.toLowerCase())
        ? new Response(null, { status: 404 })
        : Response.json(resourceEnvelope(NAMES.resourceGroupId, false));
    });
    await assert.doesNotReject(
      resources.deleteResourceGroup({ resourceGroupId: NAMES.resourceGroupId }),
    );
    assert.equal(deleteCalls, 1);
  });

  it("recovers a matching base deployment and rejects a colliding tag before PUT", async () => {
    const generation = generationFixtureWithDeployment();
    const allocation = allocationFixture(generation);
    let putCalls = 0;
    const exact = liveAzureResources(allocation, async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (init?.method === "PUT") {
        putCalls += 1;
        return Response.json({ properties: { provisioningState: "Succeeded" } });
      }
      if (path.toLowerCase().endsWith(`/resourcegroups/${NAMES.resourceGroupName}`.toLowerCase())) {
        return Response.json(resourceEnvelope(NAMES.resourceGroupId, false));
      }
      if (path.toLowerCase().endsWith(`/virtualmachines/${NAMES.vmName}`.toLowerCase())) {
        return Response.json({
          ...resourceEnvelope(NAMES.vmResourceId, true),
          properties: { vmId: "provider-vm-1" },
        });
      }
      if (path.toLowerCase().includes("/providers/microsoft.resources/deployments/")) {
        return Response.json(baseDeploymentEnvelope(generation));
      }
      throw new Error(`unexpected Azure path ${path}`);
    });
    const result = await exact.ensureBaseDeployment(baseDeploymentInput(generation));
    assert.equal(result.outcome, "vm-created");
    assert.equal(putCalls, 1);

    const collisions = [
      {
        ...resourceEnvelope(NAMES.resourceGroupId, false),
        tags: { ...allocationTags(), allocationId: `sy1-${"cd".repeat(32)}` },
      },
      {
        ...resourceEnvelope(NAMES.resourceGroupId, false),
        tags: Object.fromEntries(
          Object.entries(allocationTags()).filter(([name]) => name !== "baseTemplateSha256"),
        ),
      },
      {
        ...resourceEnvelope(NAMES.resourceGroupId, false),
        id: NAMES.resourceGroupId.replace("abab", "cdcd"),
      },
    ];
    for (const collisionEnvelope of collisions) {
      let collisionPutCalls = 0;
      const collision = liveAzureResources(allocation, async (_url, init) => {
        if (init?.method === "PUT") collisionPutCalls += 1;
        return Response.json(collisionEnvelope);
      });
      await assert.rejects(
        collision.ensureBaseDeployment(baseDeploymentInput(generation)),
        /Azure runtime operation failed/,
      );
      assert.equal(collisionPutCalls, 0);
    }
  });

  it("keeps DELETE 202 pending, ignores its Location and completes only after exact 404", async () => {
    const commandId = `${NAMES.vmResourceId}/runCommands/launch-jit-g1`;
    const allocation = allocationFixture(generationFixtureWithCommand(commandId));
    const requests: Array<{ method: string; url: string }> = [];
    const gets = [
      new Response(JSON.stringify(resourceEnvelope(commandId, true)), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
      new Response(JSON.stringify(resourceEnvelope(commandId, true)), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
      new Response(null, { status: 404 }),
    ];
    const resources = liveAzureResources(allocation, async (url, init) => {
      requests.push({ method: String(init?.method), url: String(url) });
      if (init?.method === "GET") {
        if (
          new URL(String(url)).pathname
            .toLowerCase()
            .endsWith(`/virtualmachines/${NAMES.vmName}`.toLowerCase())
        ) {
          return Response.json(virtualMachineEnvelope("provider-vm-1"));
        }
        const next = gets.shift();
        if (next === undefined) throw new Error("unexpected GET");
        return next;
      }
      return new Response(null, {
        headers: {
          location: "https://attacker.invalid/not-an-azure-resource",
          "retry-after": "999999",
        },
        status: 202,
      });
    });
    const first = await resources.deleteManagedRunCommand({
      deleteRequestedAt: NOW,
      managedRunCommandId: commandId,
      submitDelete: true,
    });
    assert.equal(first.outcome, "pending");
    const stillPresent = await resources.deleteManagedRunCommand({
      deleteRequestedAt: NOW,
      managedRunCommandId: commandId,
      submitDelete: false,
    });
    assert.equal(stillPresent.outcome, "pending");
    const absent = await resources.deleteManagedRunCommand({
      deleteRequestedAt: NOW,
      managedRunCommandId: commandId,
      submitDelete: false,
    });
    assert.equal(absent.outcome, "deleted");
    assert.equal(requests.filter(({ method }) => method === "DELETE").length, 1);
    assert.equal(
      requests.some(({ url }) => url.includes("attacker.invalid")),
      false,
    );
  });

  for (const deleteStatus of [200, 204] as const) {
    it(`accepts synchronous Run Command DELETE ${deleteStatus} as completed`, async () => {
      const commandId = `${NAMES.vmResourceId}/runCommands/launch-jit-g1`;
      const allocation = allocationFixture(generationFixtureWithCommand(commandId));
      const resources = liveAzureResources(allocation, async (url, init) => {
        if (init?.method !== "GET") return new Response(null, { status: deleteStatus });
        return new URL(String(url)).pathname
          .toLowerCase()
          .endsWith(`/virtualmachines/${NAMES.vmName}`.toLowerCase())
          ? Response.json(virtualMachineEnvelope("provider-vm-1"))
          : Response.json(resourceEnvelope(commandId, true));
      });
      const deleted = await resources.deleteManagedRunCommand({
        deleteRequestedAt: NOW,
        managedRunCommandId: commandId,
        submitDelete: true,
      });
      assert.equal(deleted.outcome, "deleted");
    });
  }

  it("retries only the exact GET after a lost DELETE response and a polling timeout", async () => {
    const commandId = `${NAMES.vmResourceId}/runCommands/launch-jit-g1`;
    const allocation = allocationFixture(generationFixtureWithCommand(commandId));
    let deleteCalls = 0;
    let getCalls = 0;
    const resources = liveAzureResources(allocation, async (url, init) => {
      if (init?.method === "DELETE") {
        deleteCalls += 1;
        throw new Error("lost accepted response");
      }
      if (
        new URL(String(url)).pathname
          .toLowerCase()
          .endsWith(`/virtualmachines/${NAMES.vmName}`.toLowerCase())
      ) {
        return Response.json(virtualMachineEnvelope("provider-vm-1"));
      }
      getCalls += 1;
      if (getCalls === 1) return Response.json(resourceEnvelope(commandId, true));
      if (getCalls === 2 || getCalls === 3) throw new Error("poll timed out");
      return new Response(null, { status: 404 });
    });
    await assert.rejects(
      resources.deleteManagedRunCommand({
        deleteRequestedAt: NOW,
        managedRunCommandId: commandId,
        submitDelete: true,
      }),
      /Azure runtime operation failed/,
    );
    await assert.rejects(
      resources.deleteManagedRunCommand({
        deleteRequestedAt: NOW,
        managedRunCommandId: commandId,
        submitDelete: false,
      }),
      /Azure runtime operation failed/,
    );
    const recovered = await resources.deleteManagedRunCommand({
      deleteRequestedAt: NOW,
      managedRunCommandId: commandId,
      submitDelete: false,
    });
    assert.equal(recovered.outcome, "deleted");
    assert.equal(deleteCalls, 1);
  });
});

describe("lazy GitHub safety capability recovery", () => {
  it("rehydrates timer safety without an HTTP admission call and retries loader outage", async () => {
    let loads = 0;
    let fences = 0;
    let reports = 0;
    const gateway = new DeferredGitHubSafetyGateway(async () => {
      loads += 1;
      if (loads === 1) throw new Error("Doppler unavailable");
      return {
        runner: {
          fenceRunner: async (input) => {
            fences += 1;
            return {
              allMatchingRegistrationsAbsent: true as const,
              runnerLabel: input.runnerLabel,
              settledAt: NOW,
            };
          },
          mintJitConfiguration: async () => {
            throw new Error("not used");
          },
          observeExactRunner: async () => ({ checkedAt: NOW, outcome: "absent" as const }),
        },
        visibility: {
          reconcile: async () => {
            reports += 1;
          },
        },
        workload: {
          getRun: async () => ({ state: "active" }),
          listJobs: async () => ({ jobs: [] }),
        },
      };
    });
    await assert.rejects(
      gateway.getRun(allocationIdentity(), { signal: AbortSignal.timeout(1_000) }),
      /unavailable/,
    );
    await gateway.fenceRunner({
      runnerLabel: `switchyard-${ALLOCATION_ID}`,
      runnerRegistrationId: "42",
    });
    await gateway.reconcile(ALLOCATION_ID, { signal: AbortSignal.timeout(1_000) });
    assert.equal(loads, 2);
    assert.equal(fences, 1);
    assert.equal(reports, 1);
  });
});

describe("live GitHub runner fencing", () => {
  it("requires two complete paged absence scans after deletion", async () => {
    let listCalls = 0;
    let deleteCalls = 0;
    const clients = {
      withOrganisationRunnerToken: async (operation: (token: string) => Promise<unknown>) =>
        operation("token"),
    } as unknown as GitHubOperationClientFactory;
    const adapter = new LiveGitHubRunnerRegistration({
      clients,
      fetch: async (_url, init) => {
        if (init?.method === "DELETE") {
          deleteCalls += 1;
          return new Response(null, { status: 204 });
        }
        listCalls += 1;
        return Response.json({
          runners:
            listCalls === 1
              ? [
                  {
                    busy: false,
                    id: 42,
                    labels: [{ name: `switchyard-${ALLOCATION_ID}` }],
                    status: "offline",
                  },
                ]
              : [],
        });
      },
      organisation: "example-org",
      runnerGroupId: 7,
      wait: async () => undefined,
    });
    const result = await adapter.fenceRunner({
      runnerLabel: `switchyard-${ALLOCATION_ID}`,
      runnerRegistrationId: "42",
    });
    assert.equal(result.allMatchingRegistrationsAbsent, true);
    assert.equal(deleteCalls, 1);
    assert.equal(listCalls, 3);
  });

  it("does not settle when a registration appears between separated absence scans", async () => {
    let listCalls = 0;
    let deleteCalls = 0;
    let registrationVisible = false;
    const adapter = new LiveGitHubRunnerRegistration({
      clients: organisationRunnerClients(),
      fetch: async (_url, init) => {
        if (init?.method === "DELETE") {
          deleteCalls += 1;
          registrationVisible = false;
          return new Response(null, { status: 204 });
        }
        listCalls += 1;
        return Response.json({
          runners: registrationVisible ? [runnerEnvelope(42, [`switchyard-${ALLOCATION_ID}`])] : [],
        });
      },
      organisation: "example-org",
      runnerGroupId: 7,
      wait: async () => {
        if (listCalls === 1) registrationVisible = true;
      },
    });
    const result = await adapter.fenceRunner({
      runnerLabel: `switchyard-${ALLOCATION_ID}`,
      runnerRegistrationId: "42",
    });
    assert.equal(result.allMatchingRegistrationsAbsent, true);
    assert.equal(deleteCalls, 1);
    assert.equal(listCalls, 4);
  });

  it("allows reviewed default labels but rejects every ambiguous Switchyard label set", async () => {
    const expected = `switchyard-${ALLOCATION_ID}`;
    const adapter = (labels: readonly string[]) =>
      new LiveGitHubRunnerRegistration({
        clients: organisationRunnerClients(),
        fetch: async () =>
          Response.json(
            {
              encoded_jit_config: "reduced-jit-material",
              runner: runnerEnvelope(42, labels),
            },
            { status: 201 },
          ),
        organisation: "example-org",
        runnerGroupId: 7,
      });
    assert.deepEqual(
      await adapter(["self-hosted", "Linux", "X64", expected.toUpperCase()]).mintJitConfiguration({
        allocationId: ALLOCATION_ID,
        runnerLabel: expected,
      }),
      { encodedJitConfiguration: "reduced-jit-material", runnerRegistrationId: "42" },
    );
    for (const labels of [
      ["self-hosted", expected, expected],
      [expected, `switchyard-sy1-${"cd".repeat(32)}`],
      ["switchyard-not-an-allocation"],
      ["switchyard_sy1-malformed"],
    ]) {
      await assert.rejects(
        adapter(labels).mintJitConfiguration({
          allocationId: ALLOCATION_ID,
          runnerLabel: expected,
        }),
        /GitHub request failed/,
      );
    }
  });

  it("rejects a paged runner observation carrying a second Switchyard allocation label", async () => {
    const adapter = new LiveGitHubRunnerRegistration({
      clients: organisationRunnerClients(),
      fetch: async () =>
        Response.json({
          runners: [
            runnerEnvelope(42, [
              `switchyard-${ALLOCATION_ID}`,
              `switchyard-sy1-${"cd".repeat(32)}`,
            ]),
          ],
        }),
      organisation: "example-org",
      runnerGroupId: 7,
    });
    await assert.rejects(
      adapter.observeExactRunner({ runnerLabel: `switchyard-${ALLOCATION_ID}` }),
      /GitHub request failed/,
    );
  });
});

function scheduleIntent(providerOperationId: string | null) {
  return {
    acceptedAt: null,
    deadlineType: "CompleteBy" as const,
    lastCheckedAt: NOW,
    providerOperationId,
    requestCorrelationId: NAMES.scheduleCorrelationId,
    requestedDeadline: DEADLINE,
    status: "requested" as const,
    targetVmResourceId: NAMES.vmResourceId,
  };
}

function scheduleResponse(operationId: string, state: string) {
  return {
    results: [
      {
        operation: {
          deadline: DEADLINE,
          deadlineType: "CompleteBy",
          opType: "Deallocate",
          operationId,
          resourceId: NAMES.vmResourceId,
          state,
          subscriptionId: SUBSCRIPTION,
        },
        resourceId: NAMES.vmResourceId,
      },
    ],
  };
}

function tokenCredential() {
  return {
    getToken: async () => ({ expiresOnTimestamp: Date.now() + 60_000, token: "token" }),
  };
}

function ownedScheduleTarget() {
  return { assertScheduleTargetOwned: async () => undefined };
}

function queueMessage() {
  return { allocation_id: ALLOCATION_ID, ordinal: 1 as const, provider: "azure" as const };
}

function httpRequest() {
  return {
    body: null,
    headers: [] as readonly (readonly [string, string])[],
    method: "POST",
    url: "https://switchyard.invalid/api/v1/allocations",
  };
}

function generationFixture(): PhysicalGeneration {
  return {
    basePlan: {
      adminSshPublicKey: `ssh-ed25519 ${"a".repeat(48)}`,
      adminSshPublicKeySha256: "2".repeat(64),
      baseTemplateSha256: "1".repeat(64),
      imageVersion: "24.04.202608250",
      nonSecretBootstrapSha256: "3".repeat(64),
      sharedRunnerSubnetId: `/subscriptions/${SUBSCRIPTION}/resourceGroups/rg-network/providers/Microsoft.Network/virtualNetworks/vnet/subnets/runners`,
      subscriptionId: SUBSCRIPTION,
    },
    cleanup: {
      phase: "not-started",
      providerResourcesSettled: false,
      runnerRegistrationSettled: false,
      settledAt: null,
      startedAt: null,
    },
    createdAt: NOW,
    generationNumber: 1,
    jitMintIntent: null,
    launchPrerequisites: null,
    location: "uksouth",
    managedRunCommand: null,
    operationLease: null,
    providerVmId: null,
    readyAt: null,
    reservedIncrementalCostUsdCents: 0,
    resourceGroupId: NAMES.resourceGroupId,
    resourceGroupName: NAMES.resourceGroupName,
    revision: "r1",
    runnerReadiness: null,
    runnerRegistrationId: null,
    schedule: null,
    state: "planned",
    updatedAt: NOW,
    vmResourceId: NAMES.vmResourceId,
    vmSize: "Standard_D8ds_v6",
    zoneDeployments: [],
  };
}

function planningInput() {
  return {
    allocation: { allocationId: ALLOCATION_ID },
    generationNumber: 1 as const,
    location: "uksouth" as const,
    vmSize: "Standard_D8ds_v6" as const,
  };
}

function allocationIdentity(): AllocationIdentity {
  return {
    allocator_check_run_id: "456",
    repository_id: "900000002",
    run_attempt: 1,
    run_id: "123",
  };
}

function organisationRunnerClients(): GitHubOperationClientFactory {
  return {
    withOrganisationRunnerToken: async (operation: (token: string) => Promise<unknown>) =>
      operation("reduced-runner-token"),
  } as unknown as GitHubOperationClientFactory;
}

function runnerEnvelope(id: number, labels: readonly string[]) {
  return {
    busy: false,
    id,
    labels: labels.map((name) => ({ name })),
    status: "offline",
  };
}

function allocationFixture(generation: PhysicalGeneration): AllocationRecord {
  const attempt = {
    attemptedAt: "2026-08-25T00:00:01.000Z",
    deadlines: {
      absoluteExpiry: "2026-08-25T00:45:00.000Z",
      computeDeadline: DEADLINE,
      latestSafeStart: "2026-08-25T00:10:00.000Z",
    },
    ordinal: 1,
    physicalGenerations: [generation],
    provider: "azure",
  } as unknown as ProviderAttempt;
  return {
    acceptance: { trust: { workload: { timeoutMinutes: 25 } } },
    allocationId: ALLOCATION_ID,
    attempts: [attempt],
    createdAt: "2026-08-25T00:00:00.000Z",
    identity: allocationIdentity(),
  } as unknown as AllocationRecord;
}

function generationFixtureWithDeployment(): PhysicalGeneration {
  const generation = generationFixture();
  return {
    ...generation,
    zoneDeployments: [
      {
        availabilityZone: "1",
        childDeploymentId: NAMES.childDeploymentId,
        completedAt: null,
        deploymentId: NAMES.baseDeploymentIdByZone["1"],
        deploymentName: NAMES.baseDeploymentNameByZone["1"],
        outcome: "pending",
        requestedAt: NOW,
        residualResourcesSettledAt: null,
        vmAbsenceVerifiedAt: null,
        vmResourceId: null,
      },
    ],
  };
}

function generationFixtureWithCommand(commandId: string): PhysicalGeneration {
  return {
    ...generationFixture(),
    managedRunCommand: {
      boundVmResourceId: NAMES.vmResourceId,
      deleteCompletedAt: null,
      deleteRequestedAt: null,
      launchConfirmedAt: NOW,
      managedRunCommandId: commandId,
      requestedAt: NOW,
    },
    providerVmId: "provider-vm-1",
    vmResourceId: NAMES.vmResourceId,
  };
}

function liveAzureResources(
  allocation: AllocationRecord,
  fetch: typeof globalThis.fetch,
): LiveAzureResourcePort {
  const ledger = {
    listOpenAllocations: async () => ({ allocations: [allocation], continuationToken: null }),
  } as unknown as AllocationControlLedger;
  return new LiveAzureResourcePort({
    baseTemplate: {},
    baseTemplateSha256: "1".repeat(64),
    bootstrapSha256: "3".repeat(64),
    imageVersion: "24.04.202608250",
    jitTemplate: {},
    ledger,
    now: () => new Date(NOW),
    runnerSubnetId: generationFixture().basePlan.sharedRunnerSubnetId,
    transport: new AzureRuntimeTransport({
      credential: tokenCredential(),
      fetch,
      subscriptionId: SUBSCRIPTION,
    }),
  });
}

function baseDeploymentInput(generation: PhysicalGeneration) {
  const allocation = allocationFixture(generation);
  const deployment = generation.zoneDeployments[0];
  if (deployment === undefined) throw new TypeError("deployment fixture missing");
  const plan = {
    adminSshPublicKey: generation.basePlan.adminSshPublicKey,
    baseDeploymentNameByZone: NAMES.baseDeploymentNameByZone,
    baseTemplateSha256: generation.basePlan.baseTemplateSha256,
    imageVersion: generation.basePlan.imageVersion,
    nonSecretBootstrapCustomData: "#!/bin/sh\nexit 0\n",
    resourceGroupId: generation.resourceGroupId,
    resourceGroupName: generation.resourceGroupName,
    sharedRunnerSubnetId: generation.basePlan.sharedRunnerSubnetId,
    subscriptionId: generation.basePlan.subscriptionId,
  } satisfies AzureGenerationPlan;
  return {
    allocation,
    attempt: allocation.attempts[0] as ProviderAttempt,
    availabilityZone: "1" as const,
    deployment,
    generation,
    plan,
    templatePath: "infra/templates/azure-allocation/main.json" as const,
  };
}

function allocationTags(): Record<string, string> {
  return {
    allocationAcceptedAt: "2026-08-25T00:00:00.000Z",
    allocationId: ALLOCATION_ID,
    allocationLifetimeMinutes: "45",
    baseTemplateSha256: "1".repeat(64),
    deletionTarget: "2026-08-25T00:45:00.000Z",
    githubRunId: "123",
    latestSafeStart: "2026-08-25T00:10:00.000Z",
    managedBy: "switchyard-controller",
    nonSecretBootstrapSha256: "3".repeat(64),
    originalCompleteBy: DEADLINE,
    system: "switchyard",
  };
}

function generationTags(): Record<string, string> {
  return {
    ...allocationTags(),
    deadlineContractValidated: "true",
    physicalGeneration: "1",
    physicalGenerationId: `${ALLOCATION_ID}:g1`,
  };
}

function resourceEnvelope(resourceId: string, generation: boolean) {
  const providerMarker = resourceId.toLowerCase().indexOf("/providers/");
  let type = "Microsoft.Resources/resourceGroups";
  if (providerMarker >= 0) {
    const segments = resourceId.slice(providerMarker + "/providers/".length).split("/");
    type = `${segments[0]}/${segments.filter((_value, index) => index % 2 === 1).join("/")}`;
  }
  return {
    id: resourceId,
    location: "uksouth",
    tags: generation ? generationTags() : allocationTags(),
    type,
  };
}

function virtualMachineEnvelope(providerVmId: string) {
  return {
    ...resourceEnvelope(NAMES.vmResourceId, true),
    properties: { vmId: providerVmId },
  };
}

function baseDeploymentEnvelope(generation: PhysicalGeneration) {
  const input = baseDeploymentInput(generation);
  return {
    ...resourceEnvelope(input.deployment.deploymentId, false),
    properties: {
      mode: "Incremental",
      parameters: Object.fromEntries(
        Object.entries(baseDeploymentParameters(generation)).map(([name, value]) => [
          name,
          { value },
        ]),
      ),
      provisioningState: "Succeeded",
    },
  };
}

function baseDeploymentParameters(generation: PhysicalGeneration): Record<string, unknown> {
  return {
    adminSshPublicKey: generation.basePlan.adminSshPublicKey,
    allocationAcceptedAt: "2026-08-25T00:00:00.000Z",
    allocationId: ALLOCATION_ID,
    allocationLifetimeMinutes: 45,
    allocationResourceGroupName: NAMES.resourceGroupName,
    availabilityZone: "1",
    deletionTarget: "2026-08-25T00:45:00.000Z",
    githubRunId: "123",
    imageVersion: generation.basePlan.imageVersion,
    location: "uksouth",
    mappedJobTimeoutMinutes: 25,
    originalCompleteBy: DEADLINE,
    physicalGeneration: 1,
    providerStopMarginMinutes: 5,
    sharedRunnerSubnetId: generation.basePlan.sharedRunnerSubnetId,
    tags: allocationTags(),
    vmSize: generation.vmSize,
  };
}

function validEnvironment(): Record<string, string> {
  const sha = "a".repeat(64);
  return {
    SWITCHYARD_AZURE_IMAGE_VERSION: "24.04.202608250",
    SWITCHYARD_AZURE_LARGE_COST_CENTS: "40",
    SWITCHYARD_AZURE_STANDARD_COST_CENTS: "20",
    SWITCHYARD_AZURE_SUBSCRIPTION_ID: SUBSCRIPTION,
    SWITCHYARD_BLACKSMITH_LARGE_COST_CENTS: "30",
    SWITCHYARD_BLACKSMITH_STANDARD_COST_CENTS: "15",
    SWITCHYARD_BOOTSTRAP_SHA256: sha,
    SWITCHYARD_CHECK_RUN_APP_SLUG: "switchyard",
    SWITCHYARD_DOPPLER_CONFIG: "prd",
    SWITCHYARD_DOPPLER_GITHUB_PRIVATE_KEY_NAME: "GITHUB_APP_PRIVATE_KEY",
    SWITCHYARD_DOPPLER_OIDC_AUDIENCE: "api://doppler",
    SWITCHYARD_DOPPLER_PROJECT: "switchyard",
    SWITCHYARD_ENTRA_ANCILLARY_CLAIMS_JSON: JSON.stringify(ancillaryClaims()),
    SWITCHYARD_ENTRA_API_AUDIENCE: "api://switchyard",
    SWITCHYARD_ENTRA_CLIENT_APPLICATION_ID: SUBSCRIPTION,
    SWITCHYARD_ENTRA_DEDICATED_ROLE: "allocate",
    SWITCHYARD_ENTRA_EXPECTED_AUTHENTICATION_TYPE: "aad",
    SWITCHYARD_ENTRA_EXPECTED_IDENTITY_TYPE: "app",
    SWITCHYARD_ENTRA_EXPECTED_ISSUER: `https://sts.windows.net/${SUBSCRIPTION}/`,
    SWITCHYARD_ENTRA_EXPECTED_NAME_CLAIM_TYPE: "name",
    SWITCHYARD_ENTRA_SECURITY_CLAIMS_JSON: JSON.stringify(securityClaims()),
    SWITCHYARD_ENTRA_TENANT_ID: SUBSCRIPTION,
    SWITCHYARD_ENTRA_TOKEN_VERSION: "1.0",
    SWITCHYARD_FUNCTION_ARTIFACT_SHA256: sha,
    SWITCHYARD_GITHUB_ACTOR_LOGIN: "the owner",
    SWITCHYARD_GITHUB_APP_CLIENT_ID: "Iv1.switchyard",
    SWITCHYARD_GITHUB_APP_INSTALLATION_ID: "123",
    SWITCHYARD_GITHUB_APP_SLUG: "switchyard",
    SWITCHYARD_GITHUB_ORGANISATION: "example-org",
    SWITCHYARD_GITHUB_ORGANISATION_ID: "12345678",
    SWITCHYARD_GITHUB_PROOF_AUDIENCE: "api://switchyard-proof",
    SWITCHYARD_GITHUB_REUSABLE_WORKFLOW_SHA: "b".repeat(40),
    SWITCHYARD_GITHUB_RUNNER_GROUP_ID: "7",
    SWITCHYARD_GITHUB_SWITCHYARD_REPOSITORY_ID: "987654321",
    SWITCHYARD_LEDGER_ACCOUNT_NAME: "switchyardledger",
    SWITCHYARD_LEDGER_INSTANCE_ID: "pilot-v1",
    SWITCHYARD_LEDGER_PARTITION_KEY: "control-v10",
    SWITCHYARD_LEDGER_SCHEMA_VERSION: "10",
    SWITCHYARD_LEDGER_TABLE_NAME: "SwitchyardControl",
    SWITCHYARD_MANAGED_IDENTITY_CLIENT_ID: SUBSCRIPTION,
    SWITCHYARD_PROVISIONING_POISON_QUEUE: "provisioning-poison",
    SWITCHYARD_PROVISIONING_QUEUE: "provisioning",
    SWITCHYARD_RUNNER_SUBNET_ID: `/subscriptions/${SUBSCRIPTION}/resourceGroups/rg-network/providers/Microsoft.Network/virtualNetworks/vnet/subnets/runners`,
    SWITCHYARD_RUNTIME_INSTANCE_ID: "runtime-1",
    SWITCHYARD_TEMPLATE_SHA256: sha,
  };
}

function ancillaryClaims() {
  return Object.fromEntries(
    [
      "authenticationInfo",
      "clientAuthenticationMethod",
      "expiresAt",
      "issuedAt",
      "issuer",
      "notBefore",
      "objectId",
      "refreshTokenHash",
      "subject",
      "tokenIdentifier",
    ].map((key) => [key, key]),
  );
}

function securityClaims() {
  return Object.fromEntries(
    [
      "apiAudience",
      "clientApplicationIdV1",
      "clientApplicationIdV2",
      "identityType",
      "roles",
      "scopes",
      "tenantId",
      "tokenVersion",
    ].map((key) => [key, key]),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
