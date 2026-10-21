import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type AzureComputeSchedulePort,
  AzureGenerationOneWorker,
  type AzureGenerationPlanningPort,
  type AzureResourcePort,
  type AzureRunnerGitHubPort,
  type AzureWorkerAlertPort,
  type AzureWorkerResult,
} from "@switchyard/azure-worker";
import type {
  AcceptAllocationRequest,
  AllocationRecord,
  PhysicalGeneration,
  PhysicalGenerationState,
  ReconcilerHeartbeatStore,
} from "@switchyard/core";
import {
  AllocationLedgerError,
  azureGenerationOneNames,
  azureRunnerLabelForAllocation,
} from "@switchyard/core";
import {
  createInitialisedInMemoryLedgerStore,
  IN_MEMORY_LEDGER_SCHEMA_VERSION,
  InMemoryAllocationLedger,
} from "@switchyard/core/testing";

import {
  AllocationReconciler,
  type AzureReconciliationPort,
  type GitHubJobObservation,
  type GitHubRunObservation,
  type GitHubWorkloadObservationPort,
  type LifecycleVisibilityPort,
  RECONCILER_MAX_SCAN_PAGES,
  type ReconcilerIncidentPort,
} from "../src/index.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const REUSABLE_SHA = "89abcdef0123456789abcdef0123456789abcdef";

describe("bounded allocation reconciler", () => {
  it("records a fresh completion heartbeat after an empty complete scan", async () => {
    const ledger = initialisedLedger(1);
    let clockAt = "2026-08-25T12:00:00.000Z";
    const advancingLedger = new Proxy(ledger, {
      get(target, property) {
        if (property === "listOpenAllocations") {
          return async (
            request: Parameters<InMemoryAllocationLedger["listOpenAllocations"]>[0],
          ) => {
            const page = await ledger.listOpenAllocations(request);
            clockAt = "2026-08-25T12:00:05.000Z";
            return page;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const fixture = reconcilerFixture(advancingLedger, { now: () => new Date(clockAt) });

    const result = await fixture.reconciler.runCycle();

    assert.deepEqual(result, {
      completeScan: true,
      heartbeatRecorded: true,
      lifecycleFailures: 0,
      processedAllocations: 0,
      visibilityFailures: 0,
    });
    assert.equal(
      (await ledger.getReconcilerHeartbeat())?.lastSucceededAt,
      "2026-08-25T12:00:05.000Z",
    );
  });

  it("withholds the heartbeat when the authoritative scan exceeds its page bound", async () => {
    const ledger = initialisedLedger(101);
    let page = 0;
    const incompleteLedger = new Proxy(ledger, {
      get(target, property) {
        if (property === "listOpenAllocations") {
          return async () => ({
            allocations: [],
            continuationToken: `more-${++page}`,
          });
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const fixture = reconcilerFixture(incompleteLedger, {
      now: constantClock("2026-08-25T12:00:00.000Z"),
    });

    const result = await fixture.reconciler.runCycle();

    assert.equal(page, RECONCILER_MAX_SCAN_PAGES);
    assert.equal(result.completeScan, false);
    assert.equal(result.heartbeatRecorded, false);
    assert.equal(await ledger.getReconcilerHeartbeat(), null);
    assert.deepEqual(fixture.incidents.calls, [
      { allocationId: null, classification: "authoritative-scan-incomplete" },
    ]);
  });

  it("continues later allocations after one safety reconciliation fails", async () => {
    const ledger = initialisedLedger(102);
    const failing = await assignedBlacksmith(ledger, 102);
    const later = (await ledger.acceptAllocation(acceptance(103))).allocation;
    const fixture = reconcilerFixture(ledger, {
      githubFailureRunId: failing.identity.run_id,
      now: constantClock("2026-08-25T00:06:00.000Z"),
    });

    const result = await fixture.reconciler.runCycle();

    assert.equal(result.completeScan, true);
    assert.equal(result.lifecycleFailures, 1);
    assert.equal(result.processedAllocations, 2);
    assert.equal(result.heartbeatRecorded, false);
    assert.deepEqual(
      fixture.visibility.calls.toSorted(),
      [failing.allocationId, later.allocationId].toSorted(),
    );
  });

  it("rejects an allocation repeated across authoritative pages", async () => {
    const ledger = initialisedLedger(104);
    const accepted = (await ledger.acceptAllocation(acceptance(104))).allocation;
    const duplicateLedger = new Proxy(ledger, {
      get(target, property) {
        if (property === "listOpenAllocations") {
          return async (request: { readonly continuationToken?: string }) => ({
            allocations: [structuredClone(accepted)],
            continuationToken: request.continuationToken === undefined ? "next" : null,
          });
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const fixture = reconcilerFixture(duplicateLedger, {
      now: constantClock("2026-08-25T00:01:00.000Z"),
    });

    const result = await fixture.reconciler.runCycle();

    assert.equal(result.completeScan, false);
    assert.equal(result.lifecycleFailures, 1);
    assert.equal(result.processedAllocations, 1);
    assert.equal(result.heartbeatRecorded, false);
  });

  it("rejects a repeated authoritative continuation token", async () => {
    const ledger = initialisedLedger(105);
    let calls = 0;
    const repeatedTokenLedger = new Proxy(ledger, {
      get(target, property) {
        if (property === "listOpenAllocations") {
          return async () => {
            calls += 1;
            return { allocations: [], continuationToken: "same-token" };
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const fixture = reconcilerFixture(repeatedTokenLedger);

    const result = await fixture.reconciler.runCycle();

    assert.equal(calls, 2);
    assert.equal(result.completeScan, false);
    assert.equal(result.lifecycleFailures, 1);
    assert.equal(result.heartbeatRecorded, false);
  });

  it("repairs obtained work but withholds heartbeat after a later storage page fails", async () => {
    const ledger = initialisedLedger(106);
    const accepted = (await ledger.acceptAllocation(acceptance(106))).allocation;
    let calls = 0;
    const failingLedger = new Proxy(ledger, {
      get(target, property) {
        if (property === "listOpenAllocations") {
          return async () => {
            calls += 1;
            if (calls === 2) throw new Error("injected page failure");
            return { allocations: [structuredClone(accepted)], continuationToken: "next" };
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const fixture = reconcilerFixture(failingLedger, {
      now: constantClock("2026-08-25T00:01:00.000Z"),
    });

    const result = await fixture.reconciler.runCycle();

    assert.equal(result.completeScan, false);
    assert.equal(result.processedAllocations, 1);
    assert.equal(result.heartbeatRecorded, false);
    assert.deepEqual(fixture.visibility.calls, [accepted.allocationId]);
  });

  it("re-reads and retries an optimistic allocation mutation race", async () => {
    const ledger = initialisedLedger(107);
    const accepted = (await ledger.acceptAllocation(acceptance(107))).allocation;
    let abandonmentCalls = 0;
    const racingLedger = new Proxy(ledger, {
      get(target, property) {
        if (property === "abandonUnassignedAllocation") {
          return async (
            request: Parameters<InMemoryAllocationLedger["abandonUnassignedAllocation"]>[0],
          ) => {
            abandonmentCalls += 1;
            if (abandonmentCalls === 1) {
              throw new AllocationLedgerError("optimistic-concurrency-conflict", "injected race");
            }
            return ledger.abandonUnassignedAllocation(request);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const fixture = reconcilerFixture(racingLedger, {
      now: constantClock("2026-08-25T00:15:00.000Z"),
    });

    const result = await fixture.reconciler.runCycle();
    const abandoned = await requiredAllocation(ledger, accepted.allocationId);

    assert.equal(abandonmentCalls, 2);
    assert.equal(result.heartbeatRecorded, true);
    assert.equal(abandoned.abandonment?.reason, "controller-progress-timeout");
  });

  it("durably abandons stale never-returned work but keeps it visible for Check Run repair", async () => {
    const ledger = initialisedLedger(2);
    const accepted = (await ledger.acceptAllocation(acceptance(2))).allocation;
    const fixture = reconcilerFixture(ledger, {
      now: constantClock("2026-08-25T00:15:00.000Z"),
    });

    const result = await fixture.reconciler.runCycle();
    const abandoned = await requiredAllocation(ledger, accepted.allocationId);

    assert.equal(result.heartbeatRecorded, true);
    assert.equal(abandoned.lifecycleState, "ended");
    assert.equal(abandoned.abandonment?.reason, "controller-progress-timeout");
    assert.equal(abandoned.cleanup.terminalEvidence?.source, "allocation-never-returned");
    assert.deepEqual(fixture.visibility.calls, [accepted.allocationId]);
    const stillOpen = await ledger.listOpenAllocations({ pageSize: 50 });
    assert.deepEqual(
      stillOpen.allocations.map((entry) => entry.allocationId),
      [accepted.allocationId],
    );
  });

  it("repairs a lost Blacksmith response and never releases its hold merely with elapsed time", async () => {
    const ledger = initialisedLedger(3);
    const allocation = await heldBlacksmithAttempt(ledger, 3);
    const fixture = reconcilerFixture(ledger, {
      now: constantClock("2026-08-25T00:20:00.000Z"),
      run: activeRun(allocation),
    });

    const result = await fixture.reconciler.runCycle();
    const repaired = await requiredAllocation(ledger, allocation.allocationId);

    assert.equal(result.heartbeatRecorded, true);
    assert.equal(repaired.runnerAssignment?.provider, "blacksmith");
    assert.equal(repaired.workloadBinding.state, "awaiting-correlation");
    assert.equal(repaired.attempts[1]?.reservation.state, "held");
    assert.equal(repaired.lifecycleState, "assigned");
  });

  it("settles repaired Blacksmith work only after exact whole-run terminal evidence", async () => {
    const ledger = initialisedLedger(4);
    const allocation = await heldBlacksmithAttempt(ledger, 4);
    const fixture = reconcilerFixture(ledger, {
      now: constantClock("2026-08-25T00:04:00.000Z"),
      run: terminalRun(allocation, "cancelled", "2026-08-25T00:03:59.000Z"),
    });

    const result = await fixture.reconciler.runCycle();
    const ended = await requiredAllocation(ledger, allocation.allocationId);

    assert.equal(result.heartbeatRecorded, false);
    assert.equal(result.lifecycleFailures, 1);
    assert.equal(ended.lifecycleState, "ended");
    assert.equal(ended.workloadBinding.state, "binding-failed");
    assert.equal(ended.cleanup.terminalEvidence?.source, "github-workflow-run");
    assert.equal(ended.attempts[1]?.reservation.state, "settled");
  });

  it("settles Blacksmith from the exact bound job terminal evidence", async () => {
    const ledger = initialisedLedger(8);
    const allocation = await assignedBlacksmith(ledger, 8);
    const fixture = reconcilerFixture(ledger, {
      jobs: [
        terminalJob(
          allocation,
          "55008",
          "2026-08-25T00:03:10.000Z",
          "2026-08-25T00:03:59.000Z",
          "succeeded",
        ),
      ],
      now: constantClock("2026-08-25T00:04:00.000Z"),
      run: activeRun(allocation),
    });

    const result = await fixture.reconciler.runCycle();
    const ended = await requiredAllocation(ledger, allocation.allocationId);

    assert.equal(result.heartbeatRecorded, true);
    assert.equal(ended.lifecycleState, "ended");
    assert.deepEqual(ended.workloadBinding, { githubJobId: "55008", state: "bound" });
    assert.equal(ended.cleanup.terminalEvidence?.source, "github-job");
    assert.equal(ended.attempts[1]?.reservation.state, "settled");
  });

  it("maps an unfamiliar genuine GitHub terminal result to failed and cleans up", async () => {
    const ledger = initialisedLedger(5);
    const allocation = await heldBlacksmithAttempt(ledger, 5);
    const run = {
      ...terminalRun(allocation, "failed", "2026-08-25T00:03:59.000Z"),
      conclusion: "skipped-by-platform",
    };
    const fixture = reconcilerFixture(ledger, {
      now: constantClock("2026-08-25T00:04:00.000Z"),
      run,
    });

    await fixture.reconciler.runCycle();
    const ended = await requiredAllocation(ledger, allocation.allocationId);
    assert.equal(ended.cleanup.terminalEvidence?.conclusion, "failed");
    assert.equal(ended.attempts[1]?.reservation.state, "settled");
  });

  it("rejects duplicate paginated job IDs and suppresses the successful heartbeat", async () => {
    const ledger = initialisedLedger(6);
    const allocation = await assignedBlacksmith(ledger, 6);
    const duplicate = queuedJob(allocation, "55001");
    const fixture = reconcilerFixture(ledger, {
      jobs: [duplicate, duplicate],
      now: constantClock("2026-08-25T00:06:00.000Z"),
      run: activeRun(allocation),
    });

    const result = await fixture.reconciler.runCycle();

    assert.equal(result.heartbeatRecorded, false);
    assert.equal(result.lifecycleFailures, 1);
    assert.equal(
      (await requiredAllocation(ledger, allocation.allocationId)).attempts[1]?.reservation.state,
      "held",
    );
  });

  it("rejects a GitHub job timestamp later than its local observation", async () => {
    const ledger = initialisedLedger(61);
    const allocation = await assignedBlacksmith(ledger, 61);
    const fixture = reconcilerFixture(ledger, {
      jobs: [runningJob(allocation, "55002", "2026-08-25T00:06:00.001Z")],
      now: constantClock("2026-08-25T00:06:00.000Z"),
      run: activeRun(allocation),
    });

    const result = await fixture.reconciler.runCycle();

    assert.equal(result.heartbeatRecorded, false);
    assert.equal(result.lifecycleFailures, 1);
    assert.equal(
      (await requiredAllocation(ledger, allocation.allocationId)).workloadBinding.state,
      "awaiting-correlation",
    );
  });

  it("finds the exact managed job on a later bounded GitHub page", async () => {
    const ledger = initialisedLedger(7);
    const allocation = await assignedBlacksmith(ledger, 7);
    const unrelated = Array.from(
      { length: 50 },
      (_, index): GitHubJobObservation => ({
        concludedAt: null,
        conclusion: null,
        githubJobId: String(60_000 + index),
        jobName: `Unrelated ${index}`,
        runnerLabels: ["ubuntu-latest"],
        startedAt: null,
        state: "queued",
      }),
    );
    const fixture = reconcilerFixture(ledger, {
      jobs: [...unrelated, queuedJob(allocation, "65001")],
      now: constantClock("2026-08-25T00:06:00.000Z"),
      run: activeRun(allocation),
    });

    const result = await fixture.reconciler.runCycle();
    const bound = await requiredAllocation(ledger, allocation.allocationId);

    assert.equal(result.heartbeatRecorded, true);
    assert.deepEqual(bound.workloadBinding, { githubJobId: "65001", state: "bound" });
    assert.equal(bound.attempts[1]?.reservation.state, "held");
  });

  for (const scenario of [
    { cleanup: false, name: "one millisecond before", now: "2026-08-25T00:09:59.999Z" },
    { cleanup: true, name: "at exact equality", now: "2026-08-25T00:10:00.000Z" },
    { cleanup: true, name: "one millisecond after", now: "2026-08-25T00:10:00.001Z" },
  ] as const) {
    it(`applies latest-safe-start queued-job cleanup ${scenario.name}`, async () => {
      const ledger = initialisedLedger(20 + scenario.name.length);
      const allocation = await assignedAzure(ledger, 20 + scenario.name.length);
      const azure = new FakeAzure();
      const fixture = reconcilerFixture(ledger, {
        azure,
        jobs: [queuedJob(allocation, "551001")],
        now: constantClock(scenario.now),
        run: activeRun(allocation),
      });

      await fixture.reconciler.runCycle();
      assert.equal(azure.assignedCleanupCalls, scenario.cleanup ? 1 : 0);
    });
  }

  it("accepts only a job whose canonical start is no later than latest-safe-start", async () => {
    for (const [startedAt, cleanup] of [
      ["2026-08-25T00:10:00.000Z", false],
      ["2026-08-25T00:10:00.001Z", true],
    ] as const) {
      const ledger = initialisedLedger(40 + (cleanup ? 1 : 0));
      const allocation = await assignedAzure(ledger, 40 + (cleanup ? 1 : 0));
      const azure = new FakeAzure();
      const fixture = reconcilerFixture(ledger, {
        azure,
        jobs: [runningJob(allocation, "551001", startedAt)],
        now: constantClock("2026-08-25T00:10:03.000Z"),
        run: activeRun(allocation),
      });
      await fixture.reconciler.runCycle();
      assert.equal(azure.assignedCleanupCalls, cleanup ? 1 : 0);
    }
  });

  for (const scenario of [
    { cleanup: false, name: "one millisecond before", now: "2026-08-25T00:44:59.999Z" },
    { cleanup: true, name: "at exact equality", now: "2026-08-25T00:45:00.000Z" },
    { cleanup: true, name: "one millisecond after", now: "2026-08-25T00:45:02.001Z" },
  ] as const) {
    it(`applies absolute-expiry cleanup ${scenario.name}`, async () => {
      const sequence = 50 + scenario.name.length;
      const ledger = initialisedLedger(sequence);
      const allocation = await assignedAzure(ledger, sequence);
      const azure = new FakeAzure();
      const fixture = reconcilerFixture(ledger, {
        azure,
        jobs: [runningJob(allocation, "551001", "2026-08-25T00:09:59.999Z")],
        now: constantClock(scenario.now),
        run: activeRun(allocation),
      });

      await fixture.reconciler.runCycle();
      assert.equal(azure.assignedCleanupCalls, scenario.cleanup ? 1 : 0);
      const current = await requiredAllocation(ledger, allocation.allocationId);
      assert.equal(current.lifecycleState, scenario.cleanup ? "cleanup_pending" : "assigned");
      assert.equal(current.attempts[0]?.reservation.state, "held");
      assert.equal(current.cleanup.terminalEvidence, null);
    });
  }

  it("persists ambiguous Azure binding failure, starts cleanup and withholds heartbeat", async () => {
    const ledger = initialisedLedger(51);
    const allocation = await assignedAzure(ledger, 51);
    const azure = new FakeAzure();
    const fixture = reconcilerFixture(ledger, {
      azure,
      jobs: [queuedJob(allocation, "551001"), queuedJob(allocation, "551002")],
      now: constantClock("2026-08-25T00:05:00.000Z"),
      run: activeRun(allocation),
    });

    const result = await fixture.reconciler.runCycle();
    const failed = await requiredAllocation(ledger, allocation.allocationId);
    assert.equal(result.heartbeatRecorded, false);
    assert.equal(failed.workloadBinding.state, "binding-failed");
    assert.equal(failed.lifecycleState, "cleanup_pending");
    assert.equal(azure.assignedCleanupCalls, 1);
  });

  it("durably cleans an Azure assignment whose already-bound job disappears", async () => {
    const ledger = initialisedLedger(57);
    const allocation = await assignedAzure(ledger, 57);
    const bindingFixture = reconcilerFixture(ledger, {
      jobs: [queuedJob(allocation, "551001")],
      now: constantClock("2026-08-25T00:04:00.000Z"),
      run: activeRun(allocation),
    });
    await bindingFixture.reconciler.runCycle();
    assert.deepEqual((await requiredAllocation(ledger, allocation.allocationId)).workloadBinding, {
      githubJobId: "551001",
      state: "bound",
    });

    const azure = new FakeAzure();
    const missingFixture = reconcilerFixture(ledger, {
      azure,
      jobs: [],
      now: constantClock("2026-08-25T00:05:00.000Z"),
      run: activeRun(allocation),
    });
    const result = await missingFixture.reconciler.runCycle();
    const pending = await requiredAllocation(ledger, allocation.allocationId);

    assert.equal(result.heartbeatRecorded, false);
    assert.equal(azure.assignedCleanupCalls, 1);
    assert.equal(pending.lifecycleState, "cleanup_pending");
    assert.deepEqual(pending.workloadBinding, { githubJobId: "551001", state: "bound" });
  });

  it("does not provision new Azure resources when GitHub observation is unavailable", async () => {
    const ledger = initialisedLedger(52);
    const allocation = await heldAzureAttempt(ledger, 52);
    const azure = new FakeAzure();
    const fixture = reconcilerFixture(ledger, {
      azure,
      githubFailure: true,
      now: constantClock("2026-08-25T00:05:00.000Z"),
    });

    const result = await fixture.reconciler.runCycle();
    assert.equal(result.heartbeatRecorded, false);
    assert.equal(azure.provisioningCalls, 0);
    assert.equal(
      (await requiredAllocation(ledger, allocation.allocationId)).attempts[0]?.reservation.state,
      "held",
    );
  });

  it("starts a non-fallback Azure abort at cutoff when job start cannot be verified", async () => {
    const ledger = initialisedLedger(55);
    const allocation = await heldAzureAttempt(ledger, 55);
    const azure = new FakeAzure();
    const fixture = reconcilerFixture(ledger, {
      azure,
      githubFailure: true,
      now: constantClock("2026-08-25T00:10:00.000Z"),
    });

    const result = await fixture.reconciler.runCycle();
    const aborting = await requiredAllocation(ledger, allocation.allocationId);

    assert.equal(result.heartbeatRecorded, false);
    assert.equal(azure.provisioningCalls, 1);
    assert.equal(
      aborting.attempts[0]?.fatalAbortIntent?.classification,
      "workload-start-unverified-at-cutoff",
    );
    assert.equal(aborting.attempts[0]?.physicalGenerations.length, 0);
  });

  it("cleans an assigned Azure runner at cutoff when job start cannot be verified", async () => {
    const ledger = initialisedLedger(56);
    const allocation = await assignedAzure(ledger, 56);
    const azure = new FakeAzure();
    const fixture = reconcilerFixture(ledger, {
      azure,
      githubFailure: true,
      now: constantClock("2026-08-25T00:10:00.000Z"),
    });

    const result = await fixture.reconciler.runCycle();
    const pending = await requiredAllocation(ledger, allocation.allocationId);

    assert.equal(result.heartbeatRecorded, false);
    assert.equal(azure.assignedCleanupCalls, 1);
    assert.equal(pending.lifecycleState, "cleanup_pending");
    assert.equal(pending.attempts[0]?.reservation.state, "held");
  });

  it("continues assigned Azure cleanup at expiry when GitHub is unavailable", async () => {
    const ledger = initialisedLedger(54);
    const allocation = await assignedAzure(ledger, 54);
    const azure = new FakeAzure();
    const fixture = reconcilerFixture(ledger, {
      azure,
      githubFailure: true,
      now: constantClock("2026-08-25T00:45:00.000Z"),
    });

    const result = await fixture.reconciler.runCycle();
    const pending = await requiredAllocation(ledger, allocation.allocationId);

    assert.equal(result.heartbeatRecorded, false);
    assert.equal(azure.assignedCleanupCalls, 1);
    assert.equal(pending.lifecycleState, "cleanup_pending");
    assert.equal(pending.attempts[0]?.reservation.state, "held");
  });

  it("keeps Check Run delivery best-effort without suppressing a healthy safety heartbeat", async () => {
    const ledger = initialisedLedger(53);
    await ledger.acceptAllocation(acceptance(53));
    const fixture = reconcilerFixture(ledger, {
      now: constantClock("2026-08-25T00:01:00.000Z"),
    });
    fixture.visibility.fail = true;

    const result = await fixture.reconciler.runCycle();

    assert.equal(result.heartbeatRecorded, true);
    assert.equal(result.lifecycleFailures, 0);
    assert.equal(result.visibilityFailures, 1);
  });

  it("fails the lifecycle on strict Azure worker incidents and identity drift", async () => {
    for (const [sequence, workerResult] of [
      [
        70,
        {
          allocationId: "sy1-ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          outcome: "progress",
          stage: "generation-added",
        } satisfies AzureWorkerResult,
      ],
      [
        71,
        {
          allocationId: "placeholder",
          cleanupPending: true,
          code: "cleanup-failed",
          outcome: "incident",
        } satisfies AzureWorkerResult,
      ],
    ] as const) {
      const ledger = initialisedLedger(sequence);
      const allocation = await heldAzureAttempt(ledger, sequence);
      const azure = new FakeAzure();
      azure.provisioningResults.push(
        workerResult.outcome === "incident"
          ? { ...workerResult, allocationId: allocation.allocationId }
          : workerResult,
      );
      const fixture = reconcilerFixture(ledger, {
        azure,
        now: constantClock("2026-08-25T00:01:00.000Z"),
        run: activeRun(allocation),
      });

      const result = await fixture.reconciler.runCycle();

      assert.equal(result.lifecycleFailures, 1);
      assert.equal(result.heartbeatRecorded, false);
      assert.equal(azure.provisioningCalls, 1);
    }
  });

  it("rejects schedule failures disguised as speculative progress stages", async () => {
    const ledger = initialisedLedger(79);
    const allocation = await heldAzureAttempt(ledger, 79);
    const azure = new FakeAzure();
    azure.provisioningResults.push({
      allocationId: allocation.allocationId,
      outcome: "progress",
      stage: "schedule-rejected",
    } satisfies AzureWorkerResult);
    const fixture = reconcilerFixture(ledger, {
      azure,
      now: constantClock("2026-08-25T00:01:00.000Z"),
      run: activeRun(allocation),
    });

    const result = await fixture.reconciler.runCycle();

    assert.equal(result.lifecycleFailures, 1);
    assert.equal(result.heartbeatRecorded, false);
  });

  for (const scenario of [
    { cutoff: false, name: "one millisecond before", now: "2026-08-25T00:09:59.999Z" },
    { cutoff: true, name: "at exact equality", now: "2026-08-25T00:10:00.000Z" },
    { cutoff: true, name: "one millisecond after", now: "2026-08-25T00:10:00.001Z" },
  ] as const) {
    it(`keeps a healthy unassigned Azure cutoff provider-unavailable ${scenario.name}`, async () => {
      const sequence = 80 + scenario.name.length;
      const ledger = initialisedLedger(sequence);
      const allocation = await heldAzureAttempt(ledger, sequence);
      const azure = new FakeAzure();
      if (scenario.cutoff) {
        azure.provisioningResults.push({
          allocationId: allocation.allocationId,
          classification: "readiness-timeout",
          outcome: "unavailable",
        } satisfies AzureWorkerResult);
      }
      const fixture = reconcilerFixture(ledger, {
        azure,
        now: constantClock(scenario.now),
        run: activeRun(allocation),
      });

      const result = await fixture.reconciler.runCycle();
      const current = await requiredAllocation(ledger, allocation.allocationId);

      assert.equal(current.attempts[0]?.fatalAbortIntent, null);
      assert.equal(current.attempts[0]?.physicalGenerations.length, 0);
      assert.equal(azure.provisioningCalls, 1);
      assert.equal(result.heartbeatRecorded, true);
    });
  }

  it("drives the real Azure worker cleanup when cutoff crosses at the worker seam", async () => {
    const ledger = initialisedLedger(91);
    let allocation = await heldAzureAttempt(ledger, 91);
    const attempt = allocation.attempts[0];
    assert.ok(attempt);
    const added = await ledger.addPhysicalGeneration(
      generationRequest(allocation, attempt.revision),
    );
    assert.equal(added.outcome, "added");
    if (added.outcome !== "added") return;
    allocation = added.allocation;
    let clockAt = "2026-08-25T00:09:59.999Z";
    let deleteCalls = 0;
    const azureResources: AzureResourcePort = {
      deleteManagedRunCommand: async () => {
        throw new Error("not reached");
      },
      deleteResourceGroup: async () => {
        deleteCalls += 1;
        return { requestedAt: clockAt };
      },
      ensureBaseDeployment: async () => {
        throw new Error("not reached");
      },
      fenceCompute: async () => ({ outcome: "settled", settledAt: clockAt }),
      launchJit: async () => {
        throw new Error("not reached");
      },
      observeJitLaunch: async () => {
        throw new Error("not reached");
      },
      observeCleanupVm: async () => ({ checkedAt: clockAt, outcome: "absent" }),
      observeLaunchPrerequisites: async () => {
        throw new Error("not reached");
      },
      resourceGroupAbsent: async () => ({ absent: true, checkedAt: clockAt }),
      settleDeployments: async ({ deploymentIds }) => ({
        allTerminalOrAbsent: true,
        deploymentIds,
        settledAt: clockAt,
      }),
    };
    const githubRunner: AzureRunnerGitHubPort = {
      fenceRunner: async ({ runnerLabel }) => ({
        allMatchingRegistrationsAbsent: true,
        runnerLabel,
        settledAt: clockAt,
      }),
      mintJitConfiguration: async () => {
        throw new Error("not reached");
      },
      observeExactRunner: async () => {
        throw new Error("not reached");
      },
    };
    const planning: AzureGenerationPlanningPort = {
      plan: async () => {
        throw new Error("not reached");
      },
    };
    const schedule: AzureComputeSchedulePort = {
      ensureCompleteBy: async () => {
        throw new Error("not reached");
      },
    };
    const alerts: AzureWorkerAlertPort = { raise: async () => undefined };
    const worker = new AzureGenerationOneWorker({
      alerts,
      azure: azureResources,
      github: githubRunner,
      ledger,
      now: () => new Date(clockAt),
      planning,
      schedule,
    });
    const crossingPort: AzureReconciliationPort = {
      reconcile: async (input) => {
        clockAt = "2026-08-25T00:10:00.000Z";
        return worker.reconcile(input);
      },
      reconcileAssignedCleanup: async (input) => worker.reconcileAssignedCleanup(input),
    };
    const visibility = new FakeVisibility();
    const incidents = new FakeIncidents();
    const reconciler = new AllocationReconciler({
      azure: crossingPort,
      github: new FakeGitHub({
        failure: false,
        failureRunId: null,
        jobs: [],
        run: activeRun(allocation),
      }),
      heartbeat: ledger,
      incidents,
      ledger,
      now: () => new Date(clockAt),
      visibility,
    });

    const result = await reconciler.runCycle();
    const settled = await requiredAllocation(ledger, allocation.allocationId);

    assert.equal(result.heartbeatRecorded, true);
    assert.equal(deleteCalls, 1);
    assert.equal(settled.attempts[0]?.outcome, "unavailable");
    assert.equal(settled.attempts[0]?.unavailable?.classification, "readiness-timeout");
    assert.equal(settled.attempts[0]?.fatalAbort, null);
    assert.equal(settled.attempts[0]?.reservation.state, "settled");
  });

  it("drives assigned cleanup through durable progress in the same expiry cycle", async () => {
    const ledger = initialisedLedger(72);
    const allocation = await assignedAzure(ledger, 72);
    const azure = new FakeAzure();
    azure.assignedCleanupResults.push(
      {
        allocationId: allocation.allocationId,
        outcome: "progress",
        stage: "cleanup-started",
      } satisfies AzureWorkerResult,
      {
        allocationId: allocation.allocationId,
        outcome: "progress",
        stage: "provider-resources-deleted",
      } satisfies AzureWorkerResult,
      {
        allocationId: allocation.allocationId,
        outcome: "progress",
        stage: "runner-registration-fenced",
      } satisfies AzureWorkerResult,
      {
        allocationId: allocation.allocationId,
        outcome: "progress",
        stage: "resources-deleted",
      } satisfies AzureWorkerResult,
    );
    const fixture = reconcilerFixture(ledger, {
      azure,
      jobs: [runningJob(allocation, "551001", "2026-08-25T00:09:00.000Z")],
      now: constantClock("2026-08-25T00:45:00.000Z"),
      run: activeRun(allocation),
    });

    const result = await fixture.reconciler.runCycle();

    assert.equal(azure.assignedCleanupCalls, 4);
    assert.equal(result.lifecycleFailures, 0);
    assert.equal(result.heartbeatRecorded, true);
  });

  it("stops a no-progress Azure cleanup loop and suppresses the heartbeat", async () => {
    const ledger = initialisedLedger(73);
    const allocation = await assignedAzure(ledger, 73);
    const azure = new FakeAzure();
    const repeated = {
      allocationId: allocation.allocationId,
      outcome: "progress",
      stage: "cleanup-started",
    } satisfies AzureWorkerResult;
    azure.assignedCleanupResults.push(repeated, repeated);
    const fixture = reconcilerFixture(ledger, {
      azure,
      jobs: [queuedJob(allocation, "551001")],
      now: constantClock("2026-08-25T00:10:00.000Z"),
      run: activeRun(allocation),
    });

    const result = await fixture.reconciler.runCycle();

    assert.equal(azure.assignedCleanupCalls, 2);
    assert.equal(result.lifecycleFailures, 1);
    assert.equal(result.heartbeatRecorded, false);
  });

  it("suppresses the heartbeat when Azure cleanup exhausts its strict step ceiling", async () => {
    const ledger = initialisedLedger(77);
    const allocation = await assignedAzure(ledger, 77);
    const azure = new FakeAzure();
    for (const stage of [
      "cleanup-started",
      "provider-resources-deleted",
      "runner-registration-fenced",
      "cleanup-pending",
    ] as const) {
      azure.assignedCleanupResults.push({
        allocationId: allocation.allocationId,
        outcome: "progress",
        stage,
      } satisfies AzureWorkerResult);
    }
    const fixture = reconcilerFixture(ledger, {
      azure,
      jobs: [queuedJob(allocation, "551001")],
      now: constantClock("2026-08-25T00:10:00.000Z"),
      run: activeRun(allocation),
    });

    const result = await fixture.reconciler.runCycle();

    assert.equal(azure.assignedCleanupCalls, 4);
    assert.equal(result.lifecycleFailures, 1);
    assert.equal(result.heartbeatRecorded, false);
  });

  it("uses a post-observation clock and begins cleanup when expiry crosses mid-cycle", async () => {
    const ledger = initialisedLedger(74);
    const allocation = await assignedAzure(ledger, 74);
    const azure = new FakeAzure();
    const fixture = reconcilerFixture(ledger, {
      azure,
      jobs: [runningJob(allocation, "551001", "2026-08-25T00:09:00.000Z")],
      now: sequenceClock([
        "2026-08-25T00:44:59.999Z",
        "2026-08-25T00:44:59.999Z",
        "2026-08-25T00:44:59.999Z",
        "2026-08-25T00:44:59.999Z",
        "2026-08-25T00:45:00.000Z",
        "2026-08-25T00:45:00.000Z",
        "2026-08-25T00:45:02.001Z",
      ]),
      run: activeRun(allocation),
    });

    const result = await fixture.reconciler.runCycle();

    assert.equal(azure.assignedCleanupCalls, 2);
    assert.equal(result.heartbeatRecorded, true);
    assert.equal(
      (await ledger.getReconcilerHeartbeat())?.lastSucceededAt,
      "2026-08-25T00:45:02.001Z",
    );
  });

  it("sweeps an early cutoff crossing caused by a slower later allocation before heartbeat", async () => {
    const ledger = initialisedLedger(92);
    const early = await heldAzureAttempt(ledger, 92);
    const later = (await ledger.acceptAllocation(acceptance(93))).allocation;
    const clock = hookedClock("2026-08-25T00:09:59.999Z");
    let laterReads = 0;
    const orderedLedger = new Proxy(ledger, {
      get(target, property) {
        if (property === "listOpenAllocations") {
          return async () => ({
            allocations: [structuredClone(early), structuredClone(later)],
            continuationToken: null,
          });
        }
        if (property === "getAllocation") {
          return async (allocationId: string) => {
            if (allocationId === later.allocationId && ++laterReads === 1) {
              clock.afterCalls(1, "2026-08-25T00:10:00.000Z");
            }
            return ledger.getAllocation(allocationId);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const azure = new FakeAzure();
    azure.provisioningResults.push(
      {
        allocationId: early.allocationId,
        outcome: "progress",
        stage: "generation-added",
      } satisfies AzureWorkerResult,
      {
        allocationId: early.allocationId,
        outcome: "progress",
        stage: "cleanup-started",
      } satisfies AzureWorkerResult,
      {
        allocationId: early.allocationId,
        outcome: "progress",
        stage: "resource-deletion-pending",
      } satisfies AzureWorkerResult,
    );
    const fixture = reconcilerFixture(orderedLedger, {
      azure,
      now: () => clock.now(),
      run: activeRun(early),
    });

    const result = await fixture.reconciler.runCycle();

    assert.equal(result.heartbeatRecorded, true);
    assert.equal(azure.provisioningCalls, 3);
    assert.equal(
      (await ledger.getReconcilerHeartbeat())?.lastSucceededAt,
      "2026-08-25T00:10:00.000Z",
    );
  });

  it("suppresses heartbeat when deadline crossings exceed the final sweep bound", async () => {
    const ledger = initialisedLedger(94);
    const first = (await ledger.acceptAllocation(acceptance(94, "2026-08-25T00:00:00.000Z")))
      .allocation;
    const second = (await ledger.acceptAllocation(acceptance(95, "2026-08-25T00:10:00.000Z")))
      .allocation;
    const third = (await ledger.acceptAllocation(acceptance(96, "2026-08-25T00:20:00.000Z")))
      .allocation;
    const clock = hookedClock("2026-08-25T00:14:59.999Z");
    let thirdReads = 0;
    const orderedLedger = new Proxy(ledger, {
      get(target, property) {
        if (property === "listOpenAllocations") {
          return async () => ({
            allocations: [structuredClone(first), structuredClone(second), structuredClone(third)],
            continuationToken: null,
          });
        }
        if (property === "getAllocation") {
          return async (allocationId: string) => {
            if (allocationId === third.allocationId) {
              thirdReads += 1;
              if (thirdReads === 1) clock.afterCalls(1, "2026-08-25T00:15:00.000Z");
              if (thirdReads === 2) clock.afterCalls(1, "2026-08-25T00:25:00.000Z");
              if (thirdReads === 3) clock.afterCalls(1, "2026-08-25T00:35:00.000Z");
            }
            return ledger.getAllocation(allocationId);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const fixture = reconcilerFixture(orderedLedger, { now: () => clock.now() });

    const result = await fixture.reconciler.runCycle();

    assert.equal(result.heartbeatRecorded, false);
    assert.equal(result.lifecycleFailures, 1);
    assert.equal((await requiredAllocation(ledger, first.allocationId)).lifecycleState, "ended");
    assert.equal((await requiredAllocation(ledger, second.allocationId)).lifecycleState, "ended");
    assert.equal((await requiredAllocation(ledger, third.allocationId)).lifecycleState, "accepted");
    assert.deepEqual(fixture.incidents.calls.at(-1), {
      allocationId: third.allocationId,
      classification: "allocation-reconciliation-failed",
    });
  });

  it("never lets hung visibility delay later cleanup or the safety heartbeat", async () => {
    const ledger = initialisedLedger(75);
    let first = (await ledger.acceptAllocation(acceptance(75))).allocation;
    first = await ledger.abandonUnassignedAllocation({
      abandonedAt: "2026-08-25T00:15:00.000Z",
      allocationId: first.allocationId,
      expectedRevision: first.revision,
      reason: "controller-progress-timeout",
    });
    const later = await assignedAzure(ledger, 76);
    const azure = new FakeAzure();
    const fixture = reconcilerFixture(ledger, {
      azure,
      jobs: [runningJob(later, "551001", "2026-08-25T00:09:00.000Z")],
      now: constantClock("2026-08-25T00:45:00.000Z"),
      run: activeRun(later),
      visibilityPerCallTimeoutMilliseconds: 5,
      visibilityTotalTimeoutMilliseconds: 20,
    });
    fixture.visibility.hangingAllocationIds.add(first.allocationId);

    const result = await fixture.reconciler.runCycle();

    assert.equal(azure.assignedCleanupCalls, 1);
    assert.equal(result.heartbeatRecorded, true);
    assert.equal(result.visibilityFailures, 1);
    assert.ok(await ledger.getReconcilerHeartbeat());
  });
});

class FakeAzure implements AzureReconciliationPort {
  assignedCleanupCalls = 0;
  readonly assignedCleanupResults: unknown[] = [];
  provisioningCalls = 0;
  readonly provisioningResults: unknown[] = [];
  async reconcile(input: {
    readonly allocation_id: string;
    readonly ordinal: 1;
    readonly provider: "azure";
  }): Promise<unknown> {
    this.provisioningCalls += 1;
    return (
      this.provisioningResults.shift() ??
      ({
        allocationId: input.allocation_id,
        outcome: "progress",
        stage: "generation-added",
      } satisfies AzureWorkerResult)
    );
  }
  async reconcileAssignedCleanup(input: { readonly allocationId: string }): Promise<unknown> {
    this.assignedCleanupCalls += 1;
    return (
      this.assignedCleanupResults.shift() ??
      ({
        allocationId: input.allocationId,
        outcome: "progress",
        stage: "resource-deletion-pending",
      } satisfies AzureWorkerResult)
    );
  }
}

class FakeGitHub implements GitHubWorkloadObservationPort {
  readonly #failure: boolean;
  readonly #failureRunId: string | null;
  readonly #jobs: readonly GitHubJobObservation[];
  readonly #run: unknown;
  constructor(input: {
    readonly failure: boolean;
    readonly failureRunId: string | null;
    readonly jobs: readonly GitHubJobObservation[];
    readonly run: unknown;
  }) {
    this.#failure = input.failure;
    this.#failureRunId = input.failureRunId;
    this.#jobs = input.jobs;
    this.#run = input.run;
  }
  async getRun(identity: AllocationRecord["identity"]): Promise<unknown> {
    if (this.#failure || identity.run_id === this.#failureRunId) {
      throw new Error("injected GitHub outage");
    }
    return structuredClone(this.#run);
  }
  async listJobs(input: {
    readonly continuationToken?: string;
    readonly identity: AllocationRecord["identity"];
    readonly pageSize: number;
  }): Promise<unknown> {
    if (this.#failure) throw new Error("injected GitHub outage");
    const offset = input.continuationToken === undefined ? 0 : Number(input.continuationToken);
    const jobs = this.#jobs.slice(offset, offset + input.pageSize);
    const next = offset + jobs.length;
    return {
      continuationToken: next < this.#jobs.length ? String(next) : null,
      jobs: structuredClone(jobs),
      repositoryId: input.identity.repository_id,
      runAttempt: input.identity.run_attempt,
      runId: input.identity.run_id,
    };
  }
}

class FakeVisibility implements LifecycleVisibilityPort {
  readonly calls: string[] = [];
  fail = false;
  readonly hangingAllocationIds = new Set<string>();
  async reconcile(allocationId: string, _options: { readonly signal: AbortSignal }): Promise<void> {
    this.calls.push(allocationId);
    if (this.hangingAllocationIds.has(allocationId)) {
      return new Promise<void>(() => undefined);
    }
    if (this.fail) throw new Error("injected visibility failure");
  }
}

class FakeIncidents implements ReconcilerIncidentPort {
  readonly calls: Parameters<ReconcilerIncidentPort["raise"]>[0][] = [];
  async raise(input: Parameters<ReconcilerIncidentPort["raise"]>[0]): Promise<void> {
    this.calls.push(input);
  }
}

function reconcilerFixture(
  ledger: InMemoryAllocationLedger,
  options: {
    readonly azure?: FakeAzure;
    readonly githubFailure?: boolean;
    readonly githubFailureRunId?: string;
    readonly jobs?: readonly GitHubJobObservation[];
    readonly now?: () => Date;
    readonly run?: unknown;
    readonly visibilityPerCallTimeoutMilliseconds?: number;
    readonly visibilityTotalTimeoutMilliseconds?: number;
  } = {},
) {
  const azure = options.azure ?? new FakeAzure();
  const visibility = new FakeVisibility();
  const incidents = new FakeIncidents();
  const github = new FakeGitHub({
    failure: options.githubFailure ?? false,
    failureRunId: options.githubFailureRunId ?? null,
    jobs: options.jobs ?? [],
    run: options.run ?? {
      concludedAt: null,
      conclusion: null,
      repositoryId: "900000002",
      runAttempt: 1,
      runId: "1",
      state: "active",
    },
  });
  return {
    azure,
    incidents,
    reconciler: new AllocationReconciler({
      azure,
      github,
      heartbeat: ledger as ReconcilerHeartbeatStore,
      incidents,
      ledger,
      now: options.now ?? constantClock("2026-08-25T00:00:00.000Z"),
      visibility,
      ...(options.visibilityPerCallTimeoutMilliseconds === undefined
        ? {}
        : {
            visibilityPerCallTimeoutMilliseconds: options.visibilityPerCallTimeoutMilliseconds,
          }),
      ...(options.visibilityTotalTimeoutMilliseconds === undefined
        ? {}
        : { visibilityTotalTimeoutMilliseconds: options.visibilityTotalTimeoutMilliseconds }),
    }),
    visibility,
  };
}

function initialisedLedger(sequence: number): InMemoryAllocationLedger {
  const evidence = {
    initialisedAt: "2026-08-25T00:00:00.000Z",
    ledgerInstanceId: `reconciler-test-${sequence}`,
    schemaVersion: IN_MEMORY_LEDGER_SCHEMA_VERSION,
    utcDay: "2026-08-25",
  } as const;
  return new InMemoryAllocationLedger(createInitialisedInMemoryLedgerStore(evidence), evidence);
}

function acceptance(
  sequence: number,
  acceptedAt = "2026-08-25T00:00:00.000Z",
): AcceptAllocationRequest {
  const runId = String(80_000 + sequence);
  const checkRunId = String(90_000 + sequence);
  const identity = {
    allocator_check_run_id: checkRunId,
    repository_id: "900000002",
    run_attempt: 1,
    run_id: runId,
  } as const;
  return {
    acceptedAt,
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
          checkName: "Allocate example-build / allocate",
          checkRunId,
          jobId: String(100_000 + sequence),
          jobKey: "allocate-example-build",
          reusableWorkflow: {
            commitSha: REUSABLE_SHA,
            path: ".github/workflows/allocate.yml",
            repository: { name: "switchyard", owner: "example-org" },
          },
        },
        identity,
        mappingPointer: "example-workload/example-build",
        ownerActorId: "900000001",
        repository: { id: "900000002", name: "example-workload", owner: "example-org" },
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

async function acceptedWithCheckRun(ledger: InMemoryAllocationLedger, sequence: number) {
  const accepted = (await ledger.acceptAllocation(acceptance(sequence))).allocation;
  const lease = await ledger.acquireCheckRunCreationLease({
    ...accepted.checkRunCreation.key,
    acquiredAt: "2026-08-25T00:00:01.000Z",
    leaseExpiresAt: "2026-08-25T00:02:01.000Z",
    leaseOwner: "reconciler-test",
  });
  if (lease.outcome !== "acquired") throw new Error("Check Run lease was not acquired");
  return ledger.completeCheckRunCreation({
    allocationId: accepted.allocationId,
    checkRunId: String(70_000 + sequence),
    completedAt: "2026-08-25T00:00:01.000Z",
    leaseOwner: lease.leaseOwner,
    leaseRevision: lease.leaseRevision,
  });
}

async function heldAzureAttempt(ledger: InMemoryAllocationLedger, sequence: number) {
  const allocation = await acceptedWithCheckRun(ledger, sequence);
  const reserved = await ledger.reserveProviderAttempt({
    allocationId: allocation.allocationId,
    attemptedAt: "2026-08-25T00:00:02.000Z",
    deadlines: {
      absoluteExpiry: "2026-08-25T00:45:00.000Z",
      computeDeadline: "2026-08-25T00:40:00.000Z",
      latestSafeStart: "2026-08-25T00:10:00.000Z",
    },
    expectedAllocationRevision: allocation.revision,
    ordinal: 1,
    provider: "azure",
    worstCaseCostUsdCents: 100,
  });
  if (reserved.outcome !== "reserved") throw new Error("Azure reservation failed");
  return reserved.allocation;
}

async function heldBlacksmithAttempt(ledger: InMemoryAllocationLedger, sequence: number) {
  let allocation = await heldAzureAttempt(ledger, sequence);
  const azure = allocation.attempts[0];
  if (azure === undefined) throw new Error("Azure attempt missing");
  allocation = await ledger.settleUnavailableProviderAttempt({
    allocationId: allocation.allocationId,
    classification: "readiness-timeout",
    cleanup: settledAttemptCleanup("2026-08-25T00:01:00.000Z"),
    expectedAllocationRevision: allocation.revision,
    expectedAttemptRevision: azure.revision,
    finalCostUsdCents: 10,
    ordinal: 1,
    settledAt: "2026-08-25T00:01:00.000Z",
  });
  const blacksmith = await ledger.reserveProviderAttempt({
    allocationId: allocation.allocationId,
    attemptedAt: "2026-08-25T00:02:00.000Z",
    deadlines: null,
    expectedAllocationRevision: allocation.revision,
    ordinal: 2,
    provider: "blacksmith",
    worstCaseCostUsdCents: 100,
  });
  if (blacksmith.outcome !== "reserved") throw new Error("Blacksmith reservation failed");
  return blacksmith.allocation;
}

async function assignedBlacksmith(ledger: InMemoryAllocationLedger, sequence: number) {
  let allocation = await heldBlacksmithAttempt(ledger, sequence);
  const attempt = allocation.attempts[1];
  if (attempt === undefined) throw new Error("Blacksmith attempt missing");
  allocation = await ledger.markProviderAttemptSucceeded({
    allocationId: allocation.allocationId,
    expectedAllocationRevision: allocation.revision,
    expectedAttemptRevision: attempt.revision,
    ordinal: 2,
    succeededAt: "2026-08-25T00:03:00.000Z",
  });
  return ledger.assignRunner({
    allocationId: allocation.allocationId,
    assignment: {
      assignedAt: "2026-08-25T00:03:01.000Z",
      attemptOrdinal: 2,
      provider: "blacksmith",
      runnerLabel: "blacksmith-4vcpu-ubuntu-2404",
    },
    expectedAllocationRevision: allocation.revision,
  });
}

async function assignedAzure(ledger: InMemoryAllocationLedger, sequence: number) {
  let allocation = await heldAzureAttempt(ledger, sequence);
  const attempt = allocation.attempts[0];
  if (attempt === undefined) throw new Error("Azure attempt missing");
  const added = await ledger.addPhysicalGeneration(generationRequest(allocation, attempt.revision));
  if (added.outcome !== "added") throw new Error("generation not added");
  allocation = await ledger.updatePhysicalGeneration({
    allocationId: allocation.allocationId,
    attemptOrdinal: 1,
    expectedRevision: added.generation.revision,
    generationNumber: 1,
    state: readyGenerationState(added.generation, allocation.allocationId),
    updatedAt: "2026-08-25T00:03:00.000Z",
  });
  const readyAttempt = allocation.attempts[0];
  if (readyAttempt === undefined) throw new Error("ready attempt missing");
  allocation = await ledger.markProviderAttemptSucceeded({
    allocationId: allocation.allocationId,
    expectedAllocationRevision: allocation.revision,
    expectedAttemptRevision: readyAttempt.revision,
    ordinal: 1,
    succeededAt: "2026-08-25T00:03:01.000Z",
  });
  const generation = allocation.attempts[0]?.physicalGenerations[0];
  if (generation?.schedule === null || generation === undefined)
    throw new Error("ready generation missing");
  allocation = await ledger.updatePhysicalGeneration({
    allocationId: allocation.allocationId,
    attemptOrdinal: 1,
    expectedRevision: generation.revision,
    generationNumber: 1,
    state: {
      ...generationState(generation),
      schedule: { ...generation.schedule, lastCheckedAt: "2026-08-25T00:03:02.000Z" },
    },
    updatedAt: "2026-08-25T00:03:02.000Z",
  });
  return ledger.assignRunner({
    allocationId: allocation.allocationId,
    assignment: {
      assignedAt: "2026-08-25T00:03:02.000Z",
      attemptOrdinal: 1,
      generationNumber: 1,
      provider: "azure",
      readinessCheckedAt: "2026-08-25T00:03:02.000Z",
      runnerIdle: true,
      runnerLabel: azureRunnerLabelForAllocation(allocation.allocationId),
      runnerOnline: true,
      runnerRegistrationId: "551001",
    },
    expectedAllocationRevision: allocation.revision,
  });
}

function generationRequest(allocation: AllocationRecord, expectedAttemptRevision: string) {
  const names = azureGenerationOneNames({
    allocationId: allocation.allocationId,
    subscriptionId: "test",
  });
  return {
    allocationId: allocation.allocationId,
    attemptOrdinal: 1,
    availabilityZone: "1",
    baseDeploymentId: names.baseDeploymentIdByZone["1"],
    baseDeploymentName: names.baseDeploymentNameByZone["1"],
    basePlan: {
      adminSshPublicKey: `ssh-ed25519 ${"a".repeat(48)}`,
      adminSshPublicKeySha256: "f2b7db403b34ef24e878691bac65a944989966981ab8331e21fed3fa662defb2",
      baseTemplateSha256: "b".repeat(64),
      imageVersion: "24.04.202608250",
      nonSecretBootstrapSha256: "c".repeat(64),
      sharedRunnerSubnetId:
        "/subscriptions/test/resourceGroups/control/providers/Microsoft.Network/virtualNetworks/vnet/subnets/runners",
      subscriptionId: "test",
    },
    childDeploymentId: names.childDeploymentId,
    createdAt: "2026-08-25T00:02:30.000Z",
    expectedAttemptRevision,
    generationNumber: 1,
    location: "uksouth",
    reservedIncrementalCostUsdCents: 0,
    resourceGroupId: names.resourceGroupId,
    resourceGroupName: names.resourceGroupName,
    vmSize: "Standard_D8ds_v6",
  } as const;
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

function readyGenerationState(
  generation: PhysicalGeneration,
  allocationId: string,
): PhysicalGenerationState {
  const readyAt = "2026-08-25T00:03:00.000Z";
  const names = azureGenerationOneNames({ allocationId, subscriptionId: "test" });
  const vmResourceId = names.vmResourceId;
  const initialZone = generation.zoneDeployments[0];
  if (initialZone === undefined) throw new Error("initial zone missing");
  return {
    ...generationState(generation),
    jitMintIntent: {
      intentId: names.jitMintIntentId,
      jitDeploymentId: names.jitDeploymentId,
      requestedAt: readyAt,
    },
    launchPrerequisites: {
      bootstrapSucceeded: true,
      checkedAt: readyAt,
      dockerHealthy: true,
      localNvmeMounted: true,
    },
    managedRunCommand: {
      boundVmResourceId: vmResourceId,
      deleteCompletedAt: readyAt,
      deleteRequestedAt: readyAt,
      launchConfirmedAt: readyAt,
      managedRunCommandId: `${vmResourceId}/runCommands/launch-jit-g1`,
      requestedAt: readyAt,
    },
    providerVmId: "provider-vm-1",
    readyAt,
    runnerReadiness: { checkedAt: readyAt, idle: true, online: true },
    runnerRegistrationId: "551001",
    schedule: {
      acceptedAt: readyAt,
      requestCorrelationId: names.scheduleCorrelationId,
      deadlineType: "CompleteBy",
      lastCheckedAt: readyAt,
      providerOperationId: "azure-schedule-operation-1",
      requestedDeadline: "2026-08-25T00:40:00.000Z",
      status: "accepted",
      targetVmResourceId: vmResourceId,
    },
    state: "ready",
    vmResourceId,
    zoneDeployments: [
      { ...initialZone, completedAt: readyAt, outcome: "vm-created", vmResourceId },
    ],
  };
}

function activeRun(allocation: AllocationRecord): GitHubRunObservation {
  return {
    concludedAt: null,
    conclusion: null,
    repositoryId: allocation.identity.repository_id,
    runAttempt: allocation.identity.run_attempt,
    runId: allocation.identity.run_id,
    state: "active",
  };
}

function terminalRun(
  allocation: AllocationRecord,
  conclusion: "cancelled" | "failed" | "succeeded" | "timed_out",
  concludedAt: string,
): GitHubRunObservation {
  return { ...activeRun(allocation), concludedAt, conclusion, state: "terminal" };
}

function queuedJob(allocation: AllocationRecord, githubJobId: string): GitHubJobObservation {
  return {
    concludedAt: null,
    conclusion: null,
    githubJobId,
    jobName: allocation.acceptance.trust.workload.jobName,
    runnerLabels: [allocation.runnerAssignment?.runnerLabel ?? "missing"],
    startedAt: null,
    state: "queued",
  };
}

function runningJob(
  allocation: AllocationRecord,
  githubJobId: string,
  startedAt: string,
): GitHubJobObservation {
  return { ...queuedJob(allocation, githubJobId), startedAt, state: "in_progress" };
}

function terminalJob(
  allocation: AllocationRecord,
  githubJobId: string,
  startedAt: string,
  concludedAt: string,
  conclusion: "cancelled" | "failed" | "succeeded" | "timed_out",
): GitHubJobObservation {
  return {
    ...queuedJob(allocation, githubJobId),
    concludedAt,
    conclusion,
    startedAt,
    state: "terminal",
  };
}

function settledAttemptCleanup(settledAt: string) {
  return {
    phase: "settled",
    providerResourcesSettled: true,
    runnerRegistrationSettled: true,
    settledAt,
  } as const;
}

function constantClock(instant: string): () => Date {
  return () => new Date(instant);
}

function sequenceClock(instants: readonly string[]): () => Date {
  let index = 0;
  return () => new Date(instants[Math.min(index++, instants.length - 1)] ?? "invalid");
}

function hookedClock(initial: string) {
  let current = initial;
  let pending: { remainingCalls: number; then: string } | null = null;
  return {
    afterCalls(remainingCalls: number, then: string) {
      pending = { remainingCalls, then };
    },
    now() {
      const result = new Date(current);
      if (pending !== null) {
        pending.remainingCalls -= 1;
        if (pending.remainingCalls === 0) {
          current = pending.then;
          pending = null;
        }
      }
      return result;
    },
  };
}

async function requiredAllocation(ledger: InMemoryAllocationLedger, allocationId: string) {
  const allocation = await ledger.getAllocation(allocationId);
  if (allocation === undefined) throw new Error("allocation missing");
  return allocation;
}
