import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type AcceptAllocationRequest,
  type AllocationRecord,
  azureGenerationOneNames,
  type GenerationScheduleOperation,
} from "@switchyard/core";
import {
  createInitialisedInMemoryLedgerStore,
  IN_MEMORY_LEDGER_SCHEMA_VERSION,
  InMemoryAllocationLedger,
} from "@switchyard/core/testing";

import {
  type AzureComputeSchedulePort,
  AzureGenerationOneWorker,
  type AzureGenerationPlan,
  type AzureGenerationPlanningPort,
  type AzureResourcePort,
  type AzureRunnerGitHubPort,
  type AzureWorkerAlertPort,
  type AzureWorkerResult,
  readinessCutoffFor,
} from "../src/index.js";

const SHA = "abcdef0123456789abcdef0123456789abcdef01";
const REUSABLE_SHA = "123456789abcdef0123456789abcdef012345678";
const SUBSCRIPTION_ID = "sub-test";

describe("production-disabled Azure generation-one worker", () => {
  it("accepts only the exact controller Azure queue envelope", async () => {
    const fixture = await workerFixture(30);
    for (const malformed of [
      { allocationId: fixture.allocationId },
      { ...queueMessage(fixture.allocationId), ordinal: 2 },
      { ...queueMessage(fixture.allocationId), provider: "blacksmith" },
      { ...queueMessage(fixture.allocationId), extra: true },
    ]) {
      await assert.rejects(() => fixture.worker.reconcile(malformed), TypeError);
    }
    assert.equal(fixture.azure.deploymentZones.length, 0);
  });

  it("uses the immutable allocation-derived latest safe start", async () => {
    const fixture = await workerFixture(31);
    const attempt = (await fixture.requiredAllocation()).attempts[0];
    assert.ok(attempt?.deadlines);
    assert.equal(
      readinessCutoffFor({
        ...attempt,
        deadlines: { ...attempt.deadlines, latestSafeStart: "2026-08-25T00:20:00.000Z" },
      }),
      "2026-08-25T00:20:00.000Z",
    );
  });

  for (const drift of ["image", "subscription"] as const) {
    it(`fails closed before deployment when the persisted base plan drifts in ${drift}`, async () => {
      const fixture = await workerFixture(40 + drift.length, { planDrift: drift });
      await fixture.worker.reconcile(queueMessage(fixture.allocationId));
      await assert.rejects(() => fixture.worker.reconcile(queueMessage(fixture.allocationId)));
      assert.equal(fixture.azure.deploymentZones.length, 0);
      const generation = (await fixture.requiredAllocation()).attempts[0]?.physicalGenerations[0];
      assert.equal(generation?.basePlan.subscriptionId, SUBSCRIPTION_ID);
    });
  }

  it("runs the happy path once and replays the ready assignment without side effects", async () => {
    const fixture = await workerFixture(1);
    const results = await drive(fixture, (result) => result.outcome === "ready");

    assert.equal(results.at(-1)?.outcome, "ready");
    assert.deepEqual(fixture.azure.deploymentZones, ["1"]);
    assert.equal(
      fixture.schedule.calls,
      3,
      "submission recovery, readiness and final assignment checks are distinct",
    );
    assert.equal(fixture.github.mintCalls, 1);
    assert.equal(fixture.azure.launchCalls, 1);
    assert.equal(fixture.azure.deleteRunCommandCalls, 1);
    const beforeReplay = fixture.sideEffectSnapshot();
    assert.equal(
      (await fixture.worker.reconcile(queueMessage(fixture.allocationId))).outcome,
      "ready",
    );
    assert.deepEqual(fixture.sideEffectSnapshot(), beforeReplay);

    const allocation = await fixture.requiredAllocation();
    assert.equal(allocation.runnerAssignment?.provider, "azure");
    assert.equal(
      allocation.attempts[0]?.physicalGenerations[0]?.managedRunCommand?.deleteCompletedAt !== null,
      true,
    );
  });

  it("persists a 202 Run Command deletion intent and does not become ready until absence", async () => {
    const fixture = await workerFixture(168, { runCommandDeletePendingOnce: true });
    const results = await drive(fixture, (result) => result.outcome === "ready", 25);

    assert.equal(fixture.azure.deleteRunCommandCalls, 2);
    assert.equal(
      results.some(
        (result) => result.outcome === "progress" && result.stage === "run-command-delete-pending",
      ),
      true,
    );
    const command = (await fixture.requiredAllocation()).attempts[0]?.physicalGenerations[0]
      ?.managedRunCommand;
    assert.ok(command?.deleteRequestedAt);
    assert.ok(command.deleteCompletedAt);
    assert.ok(command.deleteCompletedAt >= command.deleteRequestedAt);
  });

  it("fails closed on a malformed Run Command deletion observation", async () => {
    const fixture = await workerFixture(170, { malformedRunCommandDelete: true });
    await drive(
      fixture,
      (result) =>
        result.outcome === "incident" &&
        result.code === "malformed-provider-output" &&
        result.cleanupPending,
      25,
    );
    assert.equal((await fixture.requiredAllocation()).runnerAssignment, null);
  });

  it("reuses the persisted per-allocation SSH public key after a cold planner restart", async () => {
    const fixture = await workerFixture(166, { rotateGeneratedSshKey: true });
    await drive(fixture, (result) => result.outcome === "ready");

    const generation = (await fixture.requiredAllocation()).attempts[0]?.physicalGenerations[0];
    assert.equal(generation?.basePlan.adminSshPublicKey, `ssh-ed25519 ${"a".repeat(48)}`);
    assert.equal(generation?.basePlan.adminSshPublicKeySha256, sha256FixturePublicKey("a"));
  });

  it("tries UK South zones in fixed order only after durable no-VM evidence", async () => {
    const fixture = await workerFixture(2, {
      deploymentOutcomes: ["no-vm-created", "no-vm-created", "no-vm-created"],
    });
    const results = await drive(fixture, (result) => result.outcome === "unavailable", 30);

    assert.equal(results.at(-1)?.outcome, "unavailable");
    assert.deepEqual(fixture.azure.deploymentZones, ["1", "2", "3"]);
    const allocation = await fixture.requiredAllocation();
    const deployments = allocation.attempts[0]?.physicalGenerations[0]?.zoneDeployments ?? [];
    assert.equal(new Set(deployments.map((entry) => entry.deploymentName)).size, 3);
    assert.equal(
      deployments.every((entry) => entry.vmAbsenceVerifiedAt !== null),
      true,
    );
    assert.equal(allocation.attempts[0]?.unavailable?.classification, "zones-exhausted");
  });

  it("uses only the allowlisted management-plane failure as provisioning unavailable", async () => {
    const fixture = await workerFixture(52, {
      deploymentOutcomes: ["management-plane-unavailable"],
    });
    const results = await drive(fixture, (result) => result.outcome === "unavailable", 15);
    assert.deepEqual(results.at(-1), {
      allocationId: fixture.allocationId,
      classification: "management-plane-provisioning",
      outcome: "unavailable",
    });
    const attempt = (await fixture.requiredAllocation()).attempts[0];
    assert.equal(attempt?.fatalAbort, null);
    assert.equal(attempt?.reservation.state, "settled");
  });

  it("fatally aborts a wrong schedule identity and never calls it provider unavailable", async () => {
    const fixture = await workerFixture(3, { wrongScheduleTarget: true });
    await drive(fixture, (result) => result.outcome === "incident" && result.cleanupPending, 15);
    await drive(fixture, (result) => result.outcome === "incident" && !result.cleanupPending, 15);

    const allocation = await fixture.requiredAllocation();
    assert.equal(allocation.attempts[0]?.outcome, "aborted");
    assert.equal(allocation.attempts[0]?.fatalAbort?.classification, "malformed-provider-output");
    assert.equal(allocation.attempts[0]?.unavailable, null);
  });

  it("alerts and fatally aborts a rejected Compute Schedule operation", async () => {
    const fixture = await workerFixture(4, { scheduleStatus: "rejected" });
    await drive(fixture, (result) => result.outcome === "incident" && result.cleanupPending, 15);
    await drive(fixture, (result) => result.outcome === "incident" && !result.cleanupPending, 15);

    const allocation = await fixture.requiredAllocation();
    assert.equal(allocation.attempts[0]?.fatalAbort?.classification, "schedule-rejected");
    assert.equal(fixture.alerts.codes.includes("schedule-rejected"), true);
  });

  for (const [scheduleCheck, call] of [
    ["readiness", 2],
    ["final assignment", 3],
  ] as const) {
    it(`never assigns when the ${scheduleCheck} check says deallocation is executing`, async () => {
      const fixture = await workerFixture(169 + call, { scheduleExecutesOnCall: call });
      await drive(
        fixture,
        (result) =>
          result.outcome === "incident" &&
          result.code === "schedule-executed-before-assignment" &&
          result.cleanupPending,
        25,
      );

      const allocation = await fixture.requiredAllocation();
      assert.equal(allocation.runnerAssignment, null);
      assert.equal(
        allocation.attempts[0]?.fatalAbortIntent?.classification,
        "schedule-executed-before-assignment",
      );
      assert.equal(
        allocation.attempts[0]?.physicalGenerations[0]?.schedule?.status,
        call === 2 ? "executed" : "accepted",
      );
    });
  }

  it("adopts Azure's generated schedule operation ID exactly once", async () => {
    const fixture = await workerFixture(163);
    await drive(fixture, (result) => result.outcome === "ready");

    const schedule = (await fixture.requiredAllocation()).attempts[0]?.physicalGenerations[0]
      ?.schedule;
    assert.equal(schedule?.requestCorrelationId.endsWith("-completeby"), true);
    assert.equal(schedule?.providerOperationId, "azure-operation-1");
    assert.equal(fixture.schedule.calls, 3);
  });

  it("never resubmits after an unconfirmed Compute Schedule submission", async () => {
    const fixture = await workerFixture(164, { scheduleSubmissionResponseLost: true });
    await drive(
      fixture,
      (result) =>
        result.outcome === "incident" &&
        result.code === "schedule-submission-unconfirmed" &&
        result.cleanupPending,
      15,
    );
    await drive(fixture, (result) => result.outcome === "incident" && !result.cleanupPending, 15);

    assert.equal(fixture.schedule.calls, 1);
    const attempt = (await fixture.requiredAllocation()).attempts[0];
    assert.equal(attempt?.fatalAbort?.classification, "schedule-submission-unconfirmed");
    assert.equal(attempt?.outcome, "aborted");
  });

  it("rejects a different Azure schedule operation ID after adoption", async () => {
    const fixture = await workerFixture(165, { scheduleOperationIdChanges: true });
    await drive(
      fixture,
      (result) =>
        result.outcome === "incident" &&
        result.code === "malformed-provider-output" &&
        result.cleanupPending,
      20,
    );

    assert.equal(fixture.schedule.calls >= 2, true);
    assert.equal(
      (await fixture.requiredAllocation()).attempts[0]?.fatalAbortIntent?.classification,
      "malformed-provider-output",
    );
  });

  it("treats the latest-safe-start edge as readiness timeout, not a fatal provider error", async () => {
    const fixture = await workerFixture(5);
    await fixture.worker.reconcile(queueMessage(fixture.allocationId));
    fixture.clock.set("2026-08-25T00:10:00.001Z");
    await drive(fixture, (result) => result.outcome === "unavailable", 12);

    const allocation = await fixture.requiredAllocation();
    assert.equal(allocation.attempts[0]?.unavailable?.classification, "readiness-timeout");
    assert.equal(allocation.attempts[0]?.fatalAbort, null);
  });

  for (const scenario of [
    { cutoff: false, name: "one millisecond before", now: "2026-08-25T00:09:59.999Z" },
    { cutoff: true, name: "at exact equality", now: "2026-08-25T00:10:00.000Z" },
    { cutoff: true, name: "one millisecond after", now: "2026-08-25T00:10:00.001Z" },
  ] as const) {
    it(`applies a zero-generation readiness cutoff ${scenario.name}`, async () => {
      const fixture = await workerFixture(51 + scenario.name.length);
      fixture.clock.set(scenario.now);
      fixture.clock.setTick(0);
      const result = await fixture.worker.reconcile(queueMessage(fixture.allocationId));
      const allocation = await fixture.requiredAllocation();

      if (scenario.cutoff) {
        assert.deepEqual(result, {
          allocationId: fixture.allocationId,
          classification: "readiness-timeout",
          outcome: "unavailable",
        });
        assert.equal(allocation.attempts[0]?.physicalGenerations.length, 0);
        assert.equal(allocation.attempts[0]?.reservation.state, "settled");
        assert.equal(fixture.github.registrations.size, 0);
        assert.equal(fixture.azure.settleDeploymentCalls, 1);
      } else {
        assert.equal(result.outcome, "progress");
        assert.equal(allocation.attempts[0]?.physicalGenerations.length, 1);
        assert.equal(allocation.attempts[0]?.reservation.state, "held");
      }
    });
  }

  for (const step of ["compute", "deployments", "fence", "delete", "absence"] as const) {
    for (const kind of ["noncanonical", "stale", "future", "out-of-order"] as const) {
      it(`keeps a zero-generation reservation open for ${kind} ${step} evidence`, async () => {
        const fixture = await workerFixture(120 + step.length + kind.length, {
          cleanupTimestampFault: { kind, step },
        });
        fixture.clock.set("2026-08-25T00:10:00.001Z");
        const result = await fixture.worker.reconcile(queueMessage(fixture.allocationId));
        const crossBranchOrderingOnly = step === "fence" && kind === "out-of-order";
        assert.equal(result.outcome, crossBranchOrderingOnly ? "unavailable" : "incident");
        if (crossBranchOrderingOnly) return;
        if (result.outcome === "incident") {
          assert.equal(result.code, "cleanup-failed");
          assert.equal(result.cleanupPending, true);
        }
        const allocation = await fixture.requiredAllocation();
        assert.equal(allocation.attempts[0]?.physicalGenerations.length, 0);
        assert.equal(allocation.attempts[0]?.reservation.state, "held");
        assert.equal(allocation.attempts[0]?.outcome, "pending");
      });
    }
  }

  it("never returns a runner before Run Command deletion and aborts a mismatched runner", async () => {
    const fixture = await workerFixture(6, { runnerIdAfterLaunch: "72002" });
    const results = await drive(
      fixture,
      (result) => result.outcome === "incident" && result.cleanupPending,
      15,
    );

    assert.equal(
      results.some((result) => result.outcome === "ready"),
      false,
    );
    assert.equal(fixture.azure.deleteRunCommandCalls, 1);
    const allocation = await fixture.requiredAllocation();
    assert.equal(allocation.attempts[0]?.fatalAbortIntent?.classification, "ambiguous-runner");
  });

  it("aborts when the exact runner is lost after provider success but before assignment", async () => {
    const fixture = await workerFixture(7, { loseRunnerOnAssignmentCheck: true });
    await drive(
      fixture,
      (result) => result.outcome === "incident" && result.code === "lost-runner-before-assignment",
      15,
    );

    const allocation = await fixture.requiredAllocation();
    assert.equal(allocation.attempts[0]?.outcome, "succeeded");
    assert.equal(allocation.runnerAssignment, null);
    assert.equal(
      allocation.attempts[0]?.fatalAbortIntent?.classification,
      "lost-runner-before-assignment",
    );
  });

  it("keeps partial cleanup open and accepts an already-absent resource group on retry", async () => {
    const fixture = await workerFixture(8, { cleanupAbsence: [false, true] });
    await fixture.worker.reconcile(queueMessage(fixture.allocationId));
    fixture.clock.set("2026-08-25T00:10:00.001Z");
    const results = await drive(fixture, (result) => result.outcome === "unavailable", 16);

    assert.equal(
      results.some((result) => result.outcome === "incident" && result.code === "cleanup-failed"),
      false,
    );
    assert.equal(fixture.azure.deleteResourceGroupCalls >= 2, true);
    assert.equal((await fixture.requiredAllocation()).attempts[0]?.reservation.state, "settled");
  });

  it("retains a lost-response live VM whose provider identity was never persisted", async () => {
    const fixture = await workerFixture(171, { deploymentResponseLost: true });
    await fixture.worker.reconcile(queueMessage(fixture.allocationId));
    const lost = await fixture.worker.reconcile(queueMessage(fixture.allocationId));
    assert.equal(lost.outcome, "incident");

    fixture.clock.set("2026-08-25T00:10:01.000Z");
    const results = await drive(
      fixture,
      (result) => result.outcome === "incident" && result.code === "cleanup-failed",
      8,
    );
    assert.equal(results.at(-1)?.outcome, "incident");
    assert.equal(fixture.azure.deleteResourceGroupCalls, 0);
    const allocation = await fixture.requiredAllocation();
    const attempt = allocation.attempts[0];
    const generation = attempt?.physicalGenerations[0];
    assert.equal(generation?.providerVmId, null);
    assert.equal(generation?.vmResourceId, null);
    assert.equal(generation?.cleanup.phase, "pending");
    assert.equal(attempt?.reservation.state, "held");
  });

  it("raises an incident when Azure resources remain after the deletion target", async () => {
    const fixture = await workerFixture(72, { cleanupAbsence: [false] });
    await drive(fixture, (result) => result.outcome === "ready");
    const assigned = await fixture.requiredAllocation();
    await fixture.ledger.updateAllocationState({
      allocationId: fixture.allocationId,
      expectedRevision: assigned.revision,
      patch: {
        cleanup: { ...assigned.cleanup, phase: "pending" },
        lifecycleState: "cleanup_pending",
      },
      updatedAt: "2026-08-25T00:04:00.000Z",
    });
    fixture.clock.set("2026-08-25T00:45:03.000Z");

    await fixture.worker.reconcileAssignedCleanup({ allocationId: fixture.allocationId });
    const result = await fixture.worker.reconcileAssignedCleanup({
      allocationId: fixture.allocationId,
    });

    assert.deepEqual(result, {
      allocationId: fixture.allocationId,
      cleanupPending: true,
      code: "cleanup-failed",
      outcome: "incident",
    });
    assert.equal((await fixture.requiredAllocation()).attempts[0]?.reservation.state, "held");
  });

  it("never deletes or settles a resource group while its deterministic deployment is in flight", async () => {
    const fixture = await workerFixture(53, { deploymentSettlementBlocked: true });
    await fixture.worker.reconcile(queueMessage(fixture.allocationId));
    fixture.clock.set("2026-08-25T00:10:00.001Z");
    const results = await drive(
      fixture,
      (result) => result.outcome === "incident" && result.code === "cleanup-failed",
      10,
    );
    assert.equal(results.at(-1)?.outcome, "incident");
    assert.equal(fixture.azure.deleteResourceGroupCalls, 0);
    assert.equal((await fixture.requiredAllocation()).attempts[0]?.reservation.state, "held");
  });

  it("waits for the exact JIT deployment after a lost launch response before deleting", async () => {
    const fixture = await workerFixture(54, {
      jitDeploymentSettlementBlockedOnce: true,
      launchResponseLost: true,
      registrationAppearsDuringJitSettlement: true,
    });
    await drive(
      fixture,
      (result) => result.outcome === "incident" && result.code === "cleanup-failed",
      20,
    );
    const names = azureGenerationOneNames({
      allocationId: fixture.allocationId,
      subscriptionId: SUBSCRIPTION_ID,
    });
    assert.equal(fixture.azure.launchCalls, 1);
    assert.equal(fixture.azure.deleteResourceGroupCalls, 0);
    assert.equal(
      fixture.azure.settledDeploymentIds.some(
        (ids) =>
          ids.includes(names.baseDeploymentIdByZone["1"]) && ids.includes(names.jitDeploymentId),
      ),
      true,
    );
    assert.equal((await fixture.requiredAllocation()).attempts[0]?.reservation.state, "held");

    await drive(fixture, (result) => result.outcome === "incident" && !result.cleanupPending, 12);
    assert.equal(fixture.azure.deleteResourceGroupCalls > 0, true);
    assert.equal(fixture.azure.registrationAppearedDuringSettlement, true);
    assert.equal(fixture.github.registrations.size, 0);
    assert.equal(fixture.github.fenceCalls > fixture.azure.fenceCallsAtJitSettlement, true);
    assert.equal((await fixture.requiredAllocation()).attempts[0]?.outcome, "aborted");
  });

  for (const step of ["compute", "deployments", "fence", "delete", "absence"] as const) {
    for (const kind of ["noncanonical", "stale", "future", "out-of-order"] as const) {
      it(`keeps cleanup and reservations open for ${kind} ${step} evidence`, async () => {
        const fixture = await workerFixture(90 + step.length + kind.length, {
          cleanupTimestampFault: { kind, step },
          launchResponseLost: true,
        });
        await drive(
          fixture,
          (result) => result.outcome === "incident" && result.code === "cleanup-failed",
          20,
        );
        const allocation = await fixture.requiredAllocation();
        const generation = allocation.attempts[0]?.physicalGenerations[0];
        assert.equal(allocation.runnerAssignment, null);
        assert.equal(allocation.attempts[0]?.reservation.state, "held");
        assert.equal(generation?.cleanup.phase, "pending");
        assert.equal(generation?.cleanup.providerResourcesSettled, step === "fence");
        assert.equal(generation?.cleanup.runnerRegistrationSettled, step !== "fence");
      });
    }
  }

  it("never creates a generation after terminal-before-assignment abort is durable", async () => {
    const fixture = await workerFixture(160);
    let allocation = await fixture.requiredAllocation();
    const attempt = allocation.attempts[0];
    assert.ok(attempt);
    allocation = await fixture.ledger.beginFatalAzureAbort({
      allocationId: allocation.allocationId,
      classification: "workload-terminal-before-assignment",
      expectedAllocationRevision: allocation.revision,
      expectedAttemptRevision: attempt.revision,
      ordinal: 1,
      recordedAt: "2026-08-25T00:00:04.000Z",
    });

    await drive(
      fixture,
      (result) => result.outcome === "incident" && result.cleanupPending === false,
      4,
    );

    const settled = await fixture.requiredAllocation();
    assert.equal(fixture.azure.deploymentZones.length, 0);
    assert.equal(settled.attempts[0]?.physicalGenerations.length, 0);
    assert.equal(settled.attempts[0]?.outcome, "aborted");
    assert.equal(
      settled.attempts[0]?.fatalAbort?.classification,
      "workload-terminal-before-assignment",
    );
  });

  it("persists Azure deletion while GitHub fencing fails, then settles on retry", async () => {
    const fixture = await workerFixture(161, {
      fenceFailureOnce: true,
      launchResponseLost: true,
    });
    await drive(
      fixture,
      (result) => result.outcome === "incident" && result.code === "cleanup-failed",
      20,
    );
    let generation = (await fixture.requiredAllocation()).attempts[0]?.physicalGenerations[0];
    assert.equal(generation?.cleanup.providerResourcesSettled, true);
    assert.equal(generation?.cleanup.runnerRegistrationSettled, false);

    await drive(fixture, (result) => result.outcome === "incident" && !result.cleanupPending, 12);
    generation = (await fixture.requiredAllocation()).attempts[0]?.physicalGenerations[0];
    assert.equal(generation?.cleanup.phase, "settled");
  });

  it("persists GitHub fencing while Azure deletion fails, then settles on retry", async () => {
    const fixture = await workerFixture(162, {
      deleteFailureOnce: true,
      launchResponseLost: true,
    });
    await drive(
      fixture,
      (result) => result.outcome === "incident" && result.code === "cleanup-failed",
      20,
    );
    let generation = (await fixture.requiredAllocation()).attempts[0]?.physicalGenerations[0];
    assert.equal(generation?.cleanup.providerResourcesSettled, false);
    assert.equal(generation?.cleanup.runnerRegistrationSettled, true);

    await drive(fixture, (result) => result.outcome === "incident" && !result.cleanupPending, 12);
    generation = (await fixture.requiredAllocation()).attempts[0]?.physicalGenerations[0];
    assert.equal(generation?.cleanup.phase, "settled");
  });

  for (const scenario of [
    {
      classification: "deadline-missed-after-success",
      name: "the final runner observation crosses the readiness cutoff",
      options: { slowFinalRunnerPastCutoff: true },
    },
    {
      classification: "malformed-provider-output",
      name: "the final schedule check is older than the final runner observation",
      options: { staleFinalSchedule: true },
    },
  ] as const) {
    it(`never assigns when ${scenario.name}`, async () => {
      const fixture = await workerFixture(60 + scenario.name.length, scenario.options);
      await drive(
        fixture,
        (result) => result.outcome === "incident" && result.code === scenario.classification,
        20,
      );
      const allocation = await fixture.requiredAllocation();
      assert.equal(allocation.runnerAssignment, null);
      assert.equal(
        allocation.attempts[0]?.fatalAbortIntent?.classification,
        scenario.classification,
      );
    });
  }

  for (const scenario of [
    { name: "a lost mint response", options: { mintResponseLost: true, mintVisible: true } },
    { name: "runner-ID persistence failure", options: { failRunnerIdPersistence: true } },
    {
      name: "ordinary runner observation remaining absent after a lost mint response",
      options: { mintResponseLost: true },
    },
  ] as const) {
    it(`never remints after ${scenario.name} and requires the injected fence proof`, async () => {
      const fixture = await workerFixture(20 + scenario.name.length, scenario.options);
      await drive(fixture, (result) => result.outcome === "incident" && !result.cleanupPending, 25);

      const allocation = await fixture.requiredAllocation();
      assert.equal(fixture.github.mintCalls, 1);
      assert.equal(fixture.github.registrations.size, 0);
      assert.equal(allocation.runnerAssignment, null);
      assert.equal(allocation.attempts[0]?.outcome, "aborted");
      assert.equal(allocation.attempts[0]?.fatalAbort?.classification, "github-jit-failed");
    });
  }
});

type CleanupProofStep = "absence" | "compute" | "delete" | "deployments" | "fence";
type CleanupTimestampFault = {
  readonly kind: "future" | "noncanonical" | "out-of-order" | "stale";
  readonly step: CleanupProofStep;
};

interface FixtureOptions {
  readonly cleanupAbsence?: readonly boolean[];
  readonly cleanupTimestampFault?: CleanupTimestampFault;
  readonly deploymentOutcomes?: readonly (
    | "management-plane-unavailable"
    | "no-vm-created"
    | "vm-created"
  )[];
  readonly deploymentResponseLost?: boolean;
  readonly deploymentSettlementBlocked?: boolean;
  readonly deleteFailureOnce?: boolean;
  readonly failRunnerIdPersistence?: boolean;
  readonly fenceFailureOnce?: boolean;
  readonly loseRunnerOnAssignmentCheck?: boolean;
  readonly jitDeploymentSettlementBlockedOnce?: boolean;
  readonly launchResponseLost?: boolean;
  readonly malformedRunCommandDelete?: boolean;
  readonly mintResponseLost?: boolean;
  readonly mintVisible?: boolean;
  readonly planDrift?: "image" | "subscription";
  readonly registrationAppearsDuringJitSettlement?: boolean;
  readonly rotateGeneratedSshKey?: boolean;
  readonly runCommandDeletePendingOnce?: boolean;
  readonly runnerIdAfterLaunch?: string;
  readonly scheduleOperationIdChanges?: boolean;
  readonly scheduleExecutesOnCall?: number;
  readonly scheduleStatus?: "accepted" | "rejected";
  readonly scheduleSubmissionResponseLost?: boolean;
  readonly slowFinalRunnerPastCutoff?: boolean;
  readonly staleFinalSchedule?: boolean;
  readonly wrongScheduleTarget?: boolean;
}

async function workerFixture(sequence: number, options: FixtureOptions = {}) {
  const clock = new FakeClock("2026-08-25T00:00:03.000Z");
  const ledger = initialisedLedger(sequence);
  const allocation = await acceptedAzureAttempt(ledger, sequence);
  const names = azureGenerationOneNames({
    allocationId: allocation.allocationId,
    subscriptionId: SUBSCRIPTION_ID,
  });
  let planCalls = 0;
  const planning: AzureGenerationPlanningPort = {
    async plan(input): Promise<AzureGenerationPlan> {
      planCalls += 1;
      const generatedKeyCharacter = options.rotateGeneratedSshKey && planCalls > 1 ? "b" : "a";
      return {
        adminSshPublicKey:
          input.persistedBasePlan?.adminSshPublicKey ??
          `ssh-ed25519 ${generatedKeyCharacter.repeat(48)}`,
        baseTemplateSha256: "d".repeat(64),
        baseDeploymentNameByZone: names.baseDeploymentNameByZone,
        imageVersion:
          options.planDrift === "image" && planCalls > 1 ? "24.04.202608020" : "24.04.202608010",
        nonSecretBootstrapCustomData: "pinned-bootstrap-v1",
        resourceGroupId: names.resourceGroupId,
        resourceGroupName: names.resourceGroupName,
        sharedRunnerSubnetId:
          "/subscriptions/sub-test/resourceGroups/control/providers/Microsoft.Network/virtualNetworks/control/subnets/runners",
        subscriptionId:
          options.planDrift === "subscription" && planCalls > 1 ? "sub-drift" : SUBSCRIPTION_ID,
      };
    },
  };
  const github = new FakeGitHub(clock, options);
  const azure = new FakeAzure(clock, github, options);
  const schedule = new FakeSchedule(clock, options);
  const alerts = new FakeAlerts();
  const workerLedger = options.failRunnerIdPersistence
    ? new Proxy(ledger, {
        get(target, property) {
          if (property === "updatePhysicalGenerationFenced") {
            return async (request: Parameters<typeof ledger.updatePhysicalGenerationFenced>[0]) => {
              if (request.state.runnerRegistrationId !== null) {
                throw new Error("injected runner-ID persistence failure");
              }
              return ledger.updatePhysicalGenerationFenced(request);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      })
    : ledger;
  const worker = new AzureGenerationOneWorker({
    alerts,
    azure,
    github,
    ledger: workerLedger,
    now: () => clock.date(),
    planning,
    schedule,
  });
  return {
    alerts,
    allocationId: allocation.allocationId,
    azure,
    clock,
    github,
    ledger,
    requiredAllocation: async () => {
      const current = await ledger.getAllocation(allocation.allocationId);
      assert.ok(current);
      return current;
    },
    schedule,
    sideEffectSnapshot: () => ({
      deleteResourceGroupCalls: azure.deleteResourceGroupCalls,
      deleteRunCommandCalls: azure.deleteRunCommandCalls,
      deployments: azure.deploymentZones.length,
      fences: github.fenceCalls,
      launches: azure.launchCalls,
      mints: github.mintCalls,
      schedule: schedule.calls,
    }),
    worker,
  };
}

class FakeClock {
  #milliseconds: number;
  #tickMilliseconds = 1_000;
  constructor(instant: string) {
    this.#milliseconds = Date.parse(instant);
  }
  date(): Date {
    const value = new Date(this.#milliseconds);
    this.#milliseconds += this.#tickMilliseconds;
    return value;
  }
  set(instant: string): void {
    this.#milliseconds = Date.parse(instant);
  }
  setTick(milliseconds: number): void {
    this.#tickMilliseconds = milliseconds;
  }
  stamp(): string {
    return this.date().toISOString();
  }
}

class FakeAlerts implements AzureWorkerAlertPort {
  readonly codes: string[] = [];
  async raise(input: { readonly code: string }): Promise<void> {
    this.codes.push(input.code);
  }
}

class FakeGitHub implements AzureRunnerGitHubPort {
  fenceCalls = 0;
  mintCalls = 0;
  runnerId = "71001";
  runnerOnline = false;
  readonly registrations = new Set<string>();
  readonly #clock: FakeClock;
  readonly #options: FixtureOptions;
  #onlineObservations = 0;
  #fenceFailed = false;

  constructor(clock: FakeClock, options: FixtureOptions) {
    this.#clock = clock;
    this.#options = options;
  }

  async fenceRunner(input: { readonly runnerLabel: string }) {
    this.fenceCalls += 1;
    if (this.#options.fenceFailureOnce && !this.#fenceFailed) {
      this.#fenceFailed = true;
      throw new Error("injected GitHub fence failure");
    }
    this.runnerOnline = false;
    this.registrations.clear();
    return {
      allMatchingRegistrationsAbsent: true,
      runnerLabel: input.runnerLabel,
      settledAt: cleanupProofTimestamp(this.#options, "fence", this.#clock.stamp()),
    } as const;
  }

  async mintJitConfiguration() {
    this.mintCalls += 1;
    this.registrations.add(this.runnerId);
    if (this.#options.mintResponseLost) {
      this.runnerOnline = this.#options.mintVisible ?? false;
      throw new Error("injected lost mint response");
    }
    return { encodedJitConfiguration: "reduced-jit-material", runnerRegistrationId: this.runnerId };
  }

  async observeExactRunner() {
    if (
      this.runnerOnline &&
      this.#options.slowFinalRunnerPastCutoff &&
      this.#onlineObservations >= 1
    ) {
      this.#clock.set("2026-08-25T00:10:00.001Z");
    }
    const checkedAt = this.#clock.stamp();
    if (!this.runnerOnline) return { checkedAt, outcome: "absent" } as const;
    this.#onlineObservations += 1;
    if (this.#options.loseRunnerOnAssignmentCheck && this.#onlineObservations >= 2) {
      this.runnerOnline = false;
      return { checkedAt, outcome: "absent" } as const;
    }
    return {
      checkedAt,
      idle: true,
      online: true,
      outcome: "exact",
      runnerRegistrationId: this.#options.runnerIdAfterLaunch ?? this.runnerId,
    } as const;
  }
}

class FakeAzure implements AzureResourcePort {
  deleteResourceGroupCalls = 0;
  deleteRunCommandCalls = 0;
  readonly deploymentZones: string[] = [];
  launchCalls = 0;
  settleDeploymentCalls = 0;
  readonly settledDeploymentIds: string[][] = [];
  fenceCallsAtJitSettlement = 0;
  registrationAppearedDuringSettlement = false;
  readonly #absence: boolean[];
  readonly #clock: FakeClock;
  readonly #github: FakeGitHub;
  readonly #options: FixtureOptions;
  readonly #outcomes: ("management-plane-unavailable" | "no-vm-created" | "vm-created")[];
  #launch:
    | {
        readonly launchConfirmedAt: string;
        readonly managedRunCommandId: string;
        readonly outcome: "launched";
        readonly requestedAt: string;
      }
    | undefined;
  #jitDeploymentSettlementBlocked = false;
  #registrationInjectedDuringSettlement = false;
  #deleteFailed = false;
  #deploymentResponseLost = false;
  #runCommandDeletePending = false;

  constructor(clock: FakeClock, github: FakeGitHub, options: FixtureOptions) {
    this.#clock = clock;
    this.#github = github;
    this.#options = options;
    this.#absence = [...(options.cleanupAbsence ?? [true])];
    this.#outcomes = [...(options.deploymentOutcomes ?? ["vm-created"])];
  }

  async deleteManagedRunCommand(
    input: Parameters<AzureResourcePort["deleteManagedRunCommand"]>[0],
  ) {
    this.deleteRunCommandCalls += 1;
    if (this.#options.malformedRunCommandDelete) {
      return { outcome: "unexpected", requestedAt: input.deleteRequestedAt } as never;
    }
    if (this.#options.runCommandDeletePendingOnce && !this.#runCommandDeletePending) {
      this.#runCommandDeletePending = true;
      return {
        checkedAt: this.#clock.stamp(),
        outcome: "pending" as const,
        requestedAt: input.deleteRequestedAt,
      };
    }
    return {
      completedAt: this.#clock.stamp(),
      outcome: "deleted" as const,
      requestedAt: input.deleteRequestedAt,
    };
  }

  async deleteResourceGroup() {
    this.deleteResourceGroupCalls += 1;
    if (this.#options.deleteFailureOnce && !this.#deleteFailed) {
      this.#deleteFailed = true;
      throw new Error("injected Azure deletion failure");
    }
    return {
      requestedAt: cleanupProofTimestamp(this.#options, "delete", this.#clock.stamp()),
    };
  }

  async ensureBaseDeployment(input: Parameters<AzureResourcePort["ensureBaseDeployment"]>[0]) {
    this.deploymentZones.push(input.availabilityZone);
    const outcome = this.#outcomes.shift() ?? "vm-created";
    const completedAt = this.#clock.stamp();
    if (outcome !== "vm-created") {
      return {
        childDeploymentId: input.deployment.childDeploymentId,
        completedAt,
        deploymentId: input.deployment.deploymentId,
        outcome,
        residualResourcesSettledAt: completedAt,
        vmAbsenceVerifiedAt: completedAt,
      } as const;
    }
    if (this.#options.deploymentResponseLost && !this.#deploymentResponseLost) {
      this.#deploymentResponseLost = true;
      throw new Error("injected lost deployment response");
    }
    return {
      childDeploymentId: input.deployment.childDeploymentId,
      completedAt,
      deploymentId: input.deployment.deploymentId,
      outcome,
      providerVmId: `provider-vm-${input.availabilityZone}`,
      vmResourceId: azureGenerationOneNames({
        allocationId: input.allocation.allocationId,
        subscriptionId: input.plan.subscriptionId,
      }).vmResourceId,
    } as const;
  }

  async fenceCompute() {
    return {
      outcome: "settled" as const,
      settledAt: cleanupProofTimestamp(this.#options, "compute", this.#clock.stamp()),
    };
  }

  async launchJit(input: Parameters<AzureResourcePort["launchJit"]>[0]) {
    this.launchCalls += 1;
    const command = input.generation.managedRunCommand;
    assert.ok(command);
    this.#launch = {
      launchConfirmedAt: this.#clock.stamp(),
      managedRunCommandId: input.managedRunCommandId,
      outcome: "launched",
      requestedAt: command.requestedAt,
    };
    this.#github.runnerOnline = true;
    if (this.#options.launchResponseLost) {
      throw new Error("injected lost launch response");
    }
    return this.#launch;
  }

  async observeJitLaunch() {
    return this.#launch ?? ({ outcome: "absent" } as const);
  }

  async observeCleanupVm(input: Parameters<AzureResourcePort["observeCleanupVm"]>[0]) {
    const checkedAt = this.#clock.stamp();
    if (!this.#options.deploymentResponseLost) return { checkedAt, outcome: "absent" as const };
    return {
      checkedAt,
      outcome: "exact" as const,
      providerVmId: "provider-vm-1",
      vmResourceId: input.vmResourceId,
    };
  }

  async observeLaunchPrerequisites() {
    return {
      bootstrapSucceeded: true,
      checkedAt: this.#clock.stamp(),
      dockerHealthy: true,
      localNvmeMounted: true,
      outcome: "ready",
    } as const;
  }

  async resourceGroupAbsent() {
    return {
      absent: this.#absence.shift() ?? true,
      checkedAt: cleanupProofTimestamp(this.#options, "absence", this.#clock.stamp()),
    };
  }

  async settleDeployments(input: Parameters<AzureResourcePort["settleDeployments"]>[0]) {
    this.settleDeploymentCalls += 1;
    this.settledDeploymentIds.push([...input.deploymentIds]);
    if (
      this.#options.registrationAppearsDuringJitSettlement &&
      !this.#registrationInjectedDuringSettlement &&
      input.deploymentIds.some((deploymentId) => deploymentId.endsWith("-jit"))
    ) {
      this.#registrationInjectedDuringSettlement = true;
      this.registrationAppearedDuringSettlement = true;
      this.fenceCallsAtJitSettlement = this.#github.fenceCalls;
      this.#github.registrations.add(this.#github.runnerId);
      this.#github.runnerOnline = true;
    }
    if (this.#options.deploymentSettlementBlocked) {
      return {
        allTerminalOrAbsent: false,
        deploymentIds: input.deploymentIds,
        settledAt: cleanupProofTimestamp(this.#options, "deployments", this.#clock.stamp()),
      } as const;
    }
    if (
      this.#options.jitDeploymentSettlementBlockedOnce &&
      !this.#jitDeploymentSettlementBlocked &&
      input.deploymentIds.some((deploymentId) => deploymentId.endsWith("-jit"))
    ) {
      this.#jitDeploymentSettlementBlocked = true;
      return {
        allTerminalOrAbsent: false,
        deploymentIds: input.deploymentIds,
        settledAt: cleanupProofTimestamp(this.#options, "deployments", this.#clock.stamp()),
      } as const;
    }
    return {
      allTerminalOrAbsent: true,
      deploymentIds: input.deploymentIds,
      settledAt: cleanupProofTimestamp(this.#options, "deployments", this.#clock.stamp()),
    } as const;
  }
}

class FakeSchedule implements AzureComputeSchedulePort {
  calls = 0;
  readonly #clock: FakeClock;
  readonly #options: FixtureOptions;
  constructor(clock: FakeClock, options: FixtureOptions) {
    this.#clock = clock;
    this.#options = options;
  }
  async ensureCompleteBy(
    input: Parameters<AzureComputeSchedulePort["ensureCompleteBy"]>[0],
  ): Promise<GenerationScheduleOperation> {
    this.calls += 1;
    if (this.#options.scheduleSubmissionResponseLost && this.calls === 1) {
      throw new Error("injected lost schedule submission response");
    }
    const lastCheckedAt = this.#clock.stamp();
    if (this.#options.staleFinalSchedule && this.calls >= 3) {
      return { ...input.existing, lastCheckedAt: input.existing.lastCheckedAt };
    }
    const status =
      this.#options.scheduleExecutesOnCall === this.calls
        ? "executed"
        : (this.#options.scheduleStatus ?? "accepted");
    return {
      acceptedAt:
        status === "accepted" || status === "executed"
          ? input.existing.status === "accepted"
            ? input.existing.acceptedAt
            : lastCheckedAt
          : null,
      requestCorrelationId: input.correlationId,
      deadlineType: "CompleteBy",
      lastCheckedAt,
      providerOperationId:
        this.#options.scheduleOperationIdChanges && this.calls > 1
          ? `changed-azure-operation-${this.calls}`
          : (input.existing.providerOperationId ?? `azure-operation-${this.calls}`),
      requestedDeadline: input.requestedDeadline,
      status,
      targetVmResourceId: this.#options.wrongScheduleTarget
        ? `${input.targetVmResourceId}-wrong`
        : input.targetVmResourceId,
    };
  }
}

async function drive(
  fixture: Awaited<ReturnType<typeof workerFixture>>,
  done: (result: AzureWorkerResult) => boolean,
  limit = 20,
): Promise<AzureWorkerResult[]> {
  const results: AzureWorkerResult[] = [];
  for (let index = 0; index < limit; index += 1) {
    const result = await fixture.worker.reconcile(queueMessage(fixture.allocationId));
    results.push(result);
    if (done(result)) return results;
  }
  assert.fail(`worker did not reach the expected state: ${JSON.stringify(results)}`);
}

function initialisedLedger(sequence: number): InMemoryAllocationLedger {
  const evidence = {
    initialisedAt: "2026-08-25T00:00:00.000Z",
    ledgerInstanceId: `azure-worker-test-${sequence}`,
    schemaVersion: IN_MEMORY_LEDGER_SCHEMA_VERSION,
    utcDay: "2026-08-25",
  } as const;
  return new InMemoryAllocationLedger(createInitialisedInMemoryLedgerStore(evidence), evidence);
}

function queueMessage(allocationId: string) {
  return { allocation_id: allocationId, ordinal: 1, provider: "azure" } as const;
}

function sha256FixturePublicKey(character: string): string {
  assert.equal(character, "a");
  return "f2b7db403b34ef24e878691bac65a944989966981ab8331e21fed3fa662defb2";
}

function cleanupProofTimestamp(
  options: FixtureOptions,
  step: CleanupProofStep,
  ordinary: string,
): string {
  const fault = options.cleanupTimestampFault;
  if (fault?.step !== step) return ordinary;
  if (fault.kind === "noncanonical") return ordinary.replace(/\.\d{3}Z$/, "Z");
  if (fault.kind === "stale") return "2026-08-24T23:59:59.000Z";
  if (fault.kind === "future") return new Date(Date.parse(ordinary) + 60 * 60_000).toISOString();
  if (step === "compute") return "2026-08-24T23:59:59.000Z";
  return new Date(Date.parse(ordinary) - 60_000).toISOString();
}

async function acceptedAzureAttempt(
  ledger: InMemoryAllocationLedger,
  sequence: number,
): Promise<AllocationRecord> {
  const accepted = (await ledger.acceptAllocation(acceptance(sequence))).allocation;
  const lease = await ledger.acquireCheckRunCreationLease({
    ...accepted.checkRunCreation.key,
    acquiredAt: "2026-08-25T00:00:01.000Z",
    leaseExpiresAt: "2026-08-25T00:02:01.000Z",
    leaseOwner: "azure-worker-test",
  });
  assert.equal(lease.outcome, "acquired");
  if (lease.outcome !== "acquired") throw new Error("Check Run lease was not acquired");
  const withCheckRun = await ledger.completeCheckRunCreation({
    allocationId: accepted.allocationId,
    checkRunId: String(70_000 + sequence),
    completedAt: "2026-08-25T00:00:01.000Z",
    leaseOwner: lease.leaseOwner,
    leaseRevision: lease.leaseRevision,
  });
  const reserved = await ledger.reserveProviderAttempt({
    allocationId: withCheckRun.allocationId,
    attemptedAt: "2026-08-25T00:00:03.000Z",
    deadlines: {
      absoluteExpiry: "2026-08-25T00:45:00.000Z",
      computeDeadline: "2026-08-25T00:40:00.000Z",
      latestSafeStart: "2026-08-25T00:10:00.000Z",
    },
    expectedAllocationRevision: withCheckRun.revision,
    ordinal: 1,
    provider: "azure",
    worstCaseCostUsdCents: 100,
  });
  assert.equal(reserved.outcome, "reserved");
  if (reserved.outcome !== "reserved") throw new Error("Azure attempt was not reserved");
  return reserved.allocation;
}

function acceptance(sequence: number): AcceptAllocationRequest {
  const runId = String(80_000 + sequence);
  const allocatorCheckRunId = String(90_000 + sequence);
  const identity = {
    allocator_check_run_id: allocatorCheckRunId,
    repository_id: "900000002",
    run_attempt: 1,
    run_id: runId,
  } as const;
  return {
    acceptedAt: "2026-08-25T00:00:00.000Z",
    checkRunAppSlug: "switchyard",
    evidence: {
      request: { backupChoice: "Keep going", profile: "linux-x64-large" },
      trust: {
        approvedBranch: {
          approvedRunAttempt: 1,
          commitSha: SHA,
          kind: "approved-branch-evidence",
          ref: "refs/heads/main",
          repositoryId: identity.repository_id,
          runId,
        },
        allocator: {
          checkName: "Allocate example runner / allocate",
          checkRunId: allocatorCheckRunId,
          jobId: String(100_000 + sequence),
          jobKey: "allocate-example-build",
          reusableWorkflow: {
            commitSha: REUSABLE_SHA,
            path: ".github/workflows/allocate-runner.yml",
            repository: { name: "switchyard", owner: "example-org" },
          },
        },
        identity,
        mappingPointer: "example-workload/example-build",
        ownerActorId: "900000001",
        repository: {
          id: identity.repository_id,
          name: "example-workload",
          owner: "example-org",
        },
        workload: {
          backupChoice: "Keep going",
          blacksmithRunnerLabel: "blacksmith-4vcpu-ubuntu-2404",
          jobKey: "example-build",
          jobName: "Example approved build",
          production: true,
          profile: "linux-x64-large",
          timeoutMinutes: 25,
        },
        workflow: { commitSha: SHA, path: ".github/workflows/ci.yml" },
      },
    },
  };
}
