import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type AcceptAllocationRequest,
  type AllocationRecord,
  AllocationLedgerError,
  azureRunnerLabelForAllocation,
  ContractValidationError,
  lifecycleCheckRunSnapshot,
  type PhysicalGeneration,
  type PhysicalGenerationState,
  type ReserveProviderAttemptRequest,
  type TerminalEvidence,
} from "../src/index.js";
import {
  createInitialisedInMemoryLedgerStore,
  InMemoryAllocationLedger,
  IN_MEMORY_LEDGER_SCHEMA_VERSION,
} from "../src/testing/index.js";

const DAY_ONE = "2026-08-25T00:00:00.000Z";
const FOUNDATION = {
  initialisedAt: DAY_ONE,
  ledgerInstanceId: "switchyard-ledger-test-instance",
  schemaVersion: IN_MEMORY_LEDGER_SCHEMA_VERSION,
  utcDay: "2026-08-25",
} as const;
const SHA = "0123456789abcdef0123456789abcdef01234567";
const REUSABLE_SHA = "89abcdef0123456789abcdef0123456789abcdef";

describe("in-memory ordered allocation ledger", () => {
  it("accepts provider-neutral immutable evidence exactly once without reserving a provider", async () => {
    const ledger = initialisedLedger();
    const request = acceptance(1);
    const results = await Promise.all(
      Array.from({ length: 12 }, () => ledger.acceptAllocation(structuredClone(request))),
    );

    assert.equal(new Set(results.map((result) => result.allocation.allocationId)).size, 1);
    assert.equal(results.filter((result) => result.acceptance === "created").length, 1);
    assert.equal(results.filter((result) => result.acceptance === "exact-retry").length, 11);
    assert.deepEqual(ledger.getCounterSnapshot("azure", "2026-08-25"), {
      activeReservations: 0,
      accountedDailyCostUsdCents: 0,
    });
    assert.deepEqual(results[0]?.allocation.attempts, []);
    assert.equal(results[0]?.allocation.runnerAssignment, null);
    const laterTransportRetry = await ledger.acceptAllocation({
      ...request,
      acceptedAt: "2026-08-25T00:00:10.000Z",
    });
    assert.equal(laterTransportRetry.acceptance, "exact-retry");
    assert.equal(laterTransportRetry.allocation.createdAt, DAY_ONE);
  });

  it("fails conflicting identity reuse and recovers a lost acceptance response", async () => {
    const ledger = initialisedLedger();
    const request = acceptance(1);
    ledger.failAfterNextCommit();
    const recovered = await ledger.acceptAllocation(request);
    assert.equal(recovered.acceptance, "exact-retry");

    await assert.rejects(
      () =>
        ledger.acceptAllocation({
          ...request,
          evidence: {
            ...request.evidence,
            request: { ...request.evidence.request, backupChoice: "Save money" },
            trust: {
              ...request.evidence.trust,
              workload: {
                ...request.evidence.trust.workload,
                backupChoice: "Save money",
              },
            },
          },
        }),
      hasCode("allocation-conflict"),
    );
  });

  it("requires durable Check Run creation before Azure attempt 1", async () => {
    const ledger = initialisedLedger();
    const allocation = (await ledger.acceptAllocation(acceptance(1))).allocation;

    await assert.rejects(
      () => ledger.reserveProviderAttempt(azureAttempt(allocation)),
      hasCode("precondition-failed"),
    );
    assert.equal(ledger.getCounterSnapshot("azure", "2026-08-25").activeReservations, 0);
  });

  it("coordinates Check Run creation with lease takeover, revision fencing and persisted ID", async () => {
    const ledger = initialisedLedger();
    const allocation = (await ledger.acceptAllocation(acceptance(1))).allocation;
    const key = allocation.checkRunCreation.key;
    const acquisition = {
      ...key,
      acquiredAt: "2026-08-25T00:00:01.000Z",
      leaseExpiresAt: "2026-08-25T00:02:01.000Z",
      leaseOwner: "worker-1",
    } as const;
    ledger.failAfterNextCommit();
    const first = await ledger.acquireCheckRunCreationLease(acquisition);
    assert.equal(first.outcome, "acquired");
    if (first.outcome !== "acquired") return;
    assert.deepEqual(await ledger.acquireCheckRunCreationLease(acquisition), first);

    ledger.failAfterNextCommit();
    const renewed = await ledger.renewCheckRunCreationLease({
      allocationId: allocation.allocationId,
      leaseExpiresAt: "2026-08-25T00:03:01.000Z",
      leaseOwner: "worker-1",
      leaseRevision: first.leaseRevision,
      renewedAt: "2026-08-25T00:01:01.000Z",
    });
    assert.equal(renewed.leaseRevision, first.leaseRevision + 1);
    const exactRenewal = await ledger.renewCheckRunCreationLease({
      allocationId: allocation.allocationId,
      leaseExpiresAt: "2026-08-25T00:03:01.000Z",
      leaseOwner: "worker-1",
      leaseRevision: first.leaseRevision,
      renewedAt: "2026-08-25T00:01:01.000Z",
    });
    assert.deepEqual(exactRenewal, renewed);

    const busy = await ledger.acquireCheckRunCreationLease({
      ...key,
      acquiredAt: "2026-08-25T00:03:01.000Z",
      leaseExpiresAt: "2026-08-25T00:05:01.000Z",
      leaseOwner: "worker-2",
    });
    assert.equal(busy.outcome, "busy");
    const takeover = await ledger.acquireCheckRunCreationLease({
      ...key,
      acquiredAt: "2026-08-25T00:03:01.001Z",
      leaseExpiresAt: "2026-08-25T00:05:01.001Z",
      leaseOwner: "worker-2",
    });
    assert.equal(takeover.outcome, "acquired");
    if (takeover.outcome !== "acquired") return;
    assert.equal(takeover.leaseRevision, renewed.leaseRevision + 1);

    await assert.rejects(
      () =>
        ledger.completeCheckRunCreation({
          allocationId: allocation.allocationId,
          checkRunId: "7001",
          completedAt: "2026-08-25T00:03:02.000Z",
          leaseOwner: "worker-1",
          leaseRevision: first.leaseRevision,
        }),
      hasCode("optimistic-concurrency-conflict"),
    );
    const completed = await ledger.completeCheckRunCreation({
      allocationId: allocation.allocationId,
      checkRunId: "7001",
      completedAt: "2026-08-25T00:03:02.000Z",
      leaseOwner: "worker-2",
      leaseRevision: takeover.leaseRevision,
    });
    assert.equal(completed.checkRunCreation.delivery.lifecycle.phase, "in-progress");
    assert.equal(completed.checkRunCreation.leaseOwner, null);
    const exact = await ledger.completeCheckRunCreation({
      allocationId: allocation.allocationId,
      checkRunId: "7001",
      completedAt: "2026-08-25T00:03:03.000Z",
      leaseOwner: "worker-2",
      leaseRevision: takeover.leaseRevision,
    });
    assert.equal(exact.revision, completed.revision);
  });

  it("persists four bounded Check Run creation deliveries then exhausts", async () => {
    const ledger = initialisedLedger();
    let allocation = (await ledger.acceptAllocation(acceptance(20))).allocation;
    let acquiredAt = "2026-08-25T00:00:01.000Z";
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const lease = await ledger.acquireCheckRunCreationLease({
        ...allocation.checkRunCreation.key,
        acquiredAt,
        leaseExpiresAt: nextInstant(acquiredAt, 60_000),
        leaseOwner: "worker-1",
      });
      assert.equal(lease.outcome, "acquired");
      if (lease.outcome !== "acquired") throw new Error("lease was not acquired");
      allocation = await ledger.failCheckRunCreation({
        allocationId: allocation.allocationId,
        failedAt: acquiredAt,
        failure: {
          classification: "github-api-failure",
          code: "github-api-status",
          requestId: null,
          retryable: true,
          status: 503,
        },
        leaseOwner: lease.leaseOwner,
        leaseRevision: lease.leaseRevision,
      });
      assert.equal(allocation.checkRunCreation.delivery.retry?.attempt, attempt);
      acquiredAt = allocation.checkRunCreation.delivery.retry?.notBefore ?? acquiredAt;
    }
    assert.equal(
      (
        await ledger.acquireCheckRunCreationLease({
          ...allocation.checkRunCreation.key,
          acquiredAt,
          leaseExpiresAt: nextInstant(acquiredAt, 60_000),
          leaseOwner: "worker-2",
        })
      ).outcome,
      "exhausted",
    );
  });

  it("runs only Azure attempt 1 then Blacksmith attempt 2 after safe classified unavailability", async () => {
    const ledger = initialisedLedger();
    let allocation = await acceptedWithCheckRun(ledger, acceptance(1));
    const azure = await ledger.reserveProviderAttempt(
      azureAttempt(allocation, { attemptedAt: "2026-08-25T00:00:02.000Z", cost: 200 }),
    );
    assert.equal(azure.outcome, "reserved");
    if (azure.outcome !== "reserved") return;
    allocation = azure.allocation;
    assert.deepEqual(ledger.getCounterSnapshot("azure", "2026-08-25"), {
      activeReservations: 1,
      accountedDailyCostUsdCents: 200,
    });

    allocation = await ledger.settleUnavailableProviderAttempt({
      allocationId: allocation.allocationId,
      classification: "management-plane-provisioning",
      cleanup: settledAttemptCleanup("2026-08-25T00:03:00.000Z"),
      expectedAllocationRevision: allocation.revision,
      expectedAttemptRevision: azure.attempt.revision,
      finalCostUsdCents: 25,
      ordinal: 1,
      settledAt: "2026-08-25T00:03:00.000Z",
    });
    assert.deepEqual(ledger.getCounterSnapshot("azure", "2026-08-25"), {
      activeReservations: 0,
      accountedDailyCostUsdCents: 25,
    });

    const fallbackRequest = blacksmithAttempt(allocation);
    ledger.failAfterNextCommit();
    const fallback = await ledger.reserveProviderAttempt(fallbackRequest);
    assert.equal(fallback.outcome, "reserved");
    if (fallback.outcome !== "reserved") return;
    assert.equal(fallback.reservation, "exact-retry");
    assert.deepEqual(
      fallback.allocation.attempts.map(({ ordinal, provider }) => ({ ordinal, provider })),
      [
        { ordinal: 1, provider: "azure" },
        { ordinal: 2, provider: "blacksmith" },
      ],
    );
    const repeated = await Promise.all(
      Array.from({ length: 10 }, () =>
        ledger.reserveProviderAttempt(structuredClone(fallbackRequest)),
      ),
    );
    assert.equal(
      repeated.every((result) => result.outcome === "reserved"),
      true,
    );
    assert.deepEqual(ledger.getCounterSnapshot("blacksmith", "2026-08-25"), {
      activeReservations: 1,
      accountedDailyCostUsdCents: 100,
    });
  });

  it("records final Blacksmith capacity refusal exactly once and stops all providers unavailable", async () => {
    const ledger = initialisedLedger();
    let allocation = await azureUnavailableAllocation(ledger, 21);
    ledger.unsafeSetCounterState("blacksmith", "2026-08-25", {
      activeReservations: 3,
      accountedDailyCostUsdCents: 400,
    });
    const request = blacksmithAttempt(allocation);
    ledger.failAfterNextCommit();
    const refused = await ledger.reserveProviderAttempt(request);
    assert.equal(refused.outcome, "capacity-unavailable");
    if (refused.outcome !== "capacity-unavailable") return;
    assert.equal(refused.constraint, "concurrency-limit");
    assert.equal(refused.reservation, "exact-retry");
    assert.equal(refused.attempt.provider, "blacksmith");
    assert.equal(refused.attempt.ordinal, 2);
    assert.equal(refused.attempt.reservation.state, "not-held");
    assert.equal(refused.attempt.cleanup.phase, "settled");

    const exact = await Promise.all(
      Array.from({ length: 8 }, () => ledger.reserveProviderAttempt(structuredClone(request))),
    );
    assert.equal(
      exact.every(
        (result) =>
          result.outcome === "capacity-unavailable" && result.reservation === "exact-retry",
      ),
      true,
    );
    assert.deepEqual(ledger.getCounterSnapshot("blacksmith", "2026-08-25"), {
      activeReservations: 3,
      accountedDailyCostUsdCents: 400,
    });
    allocation = refused.allocation;
    const stopRequest = {
      allocationId: allocation.allocationId,
      expectedRevision: allocation.revision,
      reason: "all-providers-unavailable",
      stoppedAt: "2026-08-25T00:04:01.000Z",
    } as const;
    const stopped = await ledger.stopAllocation(stopRequest);
    assert.equal(stopped.lifecycleState, "ended");
    assert.equal(stopped.stop?.reason, "all-providers-unavailable");
    assert.equal((await ledger.stopAllocation(stopRequest)).revision, stopped.revision);
    const delayedRefusalRetry = await ledger.reserveProviderAttempt(request);
    assert.equal(delayedRefusalRetry.outcome, "capacity-unavailable");
    assert.equal(delayedRefusalRetry.reservation, "exact-retry");
    assert.equal(delayedRefusalRetry.allocation.revision, stopped.revision);
    assert.deepEqual(ledger.getCounterSnapshot("blacksmith", "2026-08-25"), {
      activeReservations: 3,
      accountedDailyCostUsdCents: 400,
    });

    const boundaryLedger = initialisedLedger();
    const boundaryAllocation = await azureUnavailableAllocation(boundaryLedger, 22);
    boundaryLedger.unsafeSetCounterState("blacksmith", "2026-08-25", {
      activeReservations: 2,
      accountedDailyCostUsdCents: 400,
    });
    const boundary = await boundaryLedger.reserveProviderAttempt(
      blacksmithAttempt(boundaryAllocation),
    );
    assert.equal(boundary.outcome, "reserved");
    assert.deepEqual(boundaryLedger.getCounterSnapshot("blacksmith", "2026-08-25"), {
      activeReservations: 3,
      accountedDailyCostUsdCents: 500,
    });
  });

  it("stops Save money after Azure unavailability and rejects every other order", async () => {
    const ledger = initialisedLedger();
    let allocation = await acceptedWithCheckRun(ledger, acceptance(1, "Save money"));
    const azure = await ledger.reserveProviderAttempt(azureAttempt(allocation));
    assert.equal(azure.outcome, "reserved");
    if (azure.outcome !== "reserved") return;
    allocation = await ledger.settleUnavailableProviderAttempt({
      allocationId: allocation.allocationId,
      classification: "zones-exhausted",
      cleanup: settledAttemptCleanup("2026-08-25T00:03:00.000Z"),
      expectedAllocationRevision: azure.allocation.revision,
      expectedAttemptRevision: azure.attempt.revision,
      finalCostUsdCents: 0,
      ordinal: 1,
      settledAt: "2026-08-25T00:03:00.000Z",
    });
    await assert.rejects(
      () => ledger.reserveProviderAttempt(blacksmithAttempt(allocation)),
      hasCode("precondition-failed"),
    );
    await assert.rejects(
      () =>
        ledger.reserveProviderAttempt({
          ...blacksmithAttempt(allocation),
          ordinal: 3,
        }),
      hasCode("precondition-failed"),
    );
    const stopped = await ledger.stopAllocation({
      allocationId: allocation.allocationId,
      expectedRevision: allocation.revision,
      reason: "save-money",
      stoppedAt: "2026-08-25T00:04:00.000Z",
    });
    assert.equal(stopped.lifecycleState, "ended");
    assert.equal(stopped.cleanup.terminalEvidence?.source, "allocation-never-returned");
  });

  it("writes a provider-discriminated assignment once and fails conflicting replay closed", async () => {
    const ledger = initialisedLedger();
    let allocation = await blacksmithReadyAllocation(ledger, 1);
    const assignment = {
      assignedAt: "2026-08-25T00:05:00.000Z",
      attemptOrdinal: 2,
      provider: "blacksmith",
      runnerLabel: "blacksmith-4vcpu-ubuntu-2404",
    } as const;
    allocation = await ledger.assignRunner({
      allocationId: allocation.allocationId,
      assignment,
      expectedAllocationRevision: allocation.revision,
    });
    const exact = await ledger.assignRunner({
      allocationId: allocation.allocationId,
      assignment,
      expectedAllocationRevision: "stale-is-ignored-for-exact-assignment",
    });
    assert.deepEqual(exact.runnerAssignment, assignment);
    assert.deepEqual(ledger.getCounterSnapshot("blacksmith", "2026-08-25"), {
      activeReservations: 1,
      accountedDailyCostUsdCents: 100,
    });
    await assert.rejects(
      () =>
        ledger.assignRunner({
          allocationId: allocation.allocationId,
          assignment: { ...assignment, runnerLabel: "blacksmith-2vcpu-ubuntu-2404" },
          expectedAllocationRevision: allocation.revision,
        }),
      hasCode("allocation-conflict"),
    );
  });

  it("rejects premature Check Run conclusion before any active provider-hold write", async () => {
    for (const provider of ["azure", "blacksmith"] as const) {
      const ledger = initialisedLedger();
      let allocation: AllocationRecord;
      if (provider === "azure") {
        const accepted = await acceptedWithCheckRun(ledger, acceptance(40));
        const reserved = await ledger.reserveProviderAttempt(azureAttempt(accepted));
        assert.equal(reserved.outcome, "reserved");
        if (reserved.outcome !== "reserved") throw new Error("Azure was not reserved");
        allocation = reserved.allocation;
      } else {
        allocation = await blacksmithReadyAllocation(ledger, 41);
      }
      const before = await ledger.getAllocation(allocation.allocationId);
      assert.ok(before);
      const counters = ledger.getCounterSnapshot(provider, "2026-08-25");
      const premature = {
        allocationId: allocation.allocationId,
        expectedRevision: allocation.revision,
        patch: { checkRunDelivery: concludedCheckRunDelivery(allocation) },
        updatedAt: nextInstant(allocation.updatedAt, 1_000),
      } as const;

      ledger.failAfterNextCommit();
      await assert.rejects(
        () => ledger.updateAllocationState(premature),
        hasCode("authoritative-state-corrupt"),
      );
      await assert.rejects(
        () =>
          ledger.updateAllocationState({
            ...premature,
            expectedRevision: "stale-conflicting-revision",
          }),
        hasCode("optimistic-concurrency-conflict"),
      );
      assert.deepEqual(await ledger.getAllocation(allocation.allocationId), before);
      assert.deepEqual(ledger.getCounterSnapshot(provider, "2026-08-25"), counters);

      const valid = {
        allocationId: allocation.allocationId,
        expectedRevision: allocation.revision,
        patch: { checkRunDelivery: inProgressCheckRunDelivery(allocation) },
        updatedAt: nextInstant(allocation.updatedAt, 1_000),
      } as const;
      const recovered = await ledger.updateAllocationState(valid);
      const exact = await ledger.updateAllocationState(valid);
      assert.equal(recovered.revision, exact.revision);
      assert.equal(exact.checkRunCreation.delivery.lifecycle.phase, "in-progress");
      assert.deepEqual(ledger.getCounterSnapshot(provider, "2026-08-25"), counters);

      const authoritative = exact.checkRunCreation.delivery;
      const lifecycle = authoritative.lifecycle;
      if (lifecycle.phase !== "in-progress") throw new Error("Check Run was not in progress");
      const invalidDeliveries = [
        {
          lifecycle: { ...lifecycle, publishedRevision: 0, stage: "accepted" },
          retry: null,
        },
        {
          lifecycle: { ...lifecycle, stage: "workload-running" },
          retry: null,
        },
        {
          lifecycle: {
            ...lifecycle,
            publishedRevision: lifecycle.publishedRevision + 1,
            stage: "provider-selected",
          },
          retry: null,
        },
        {
          lifecycle,
          retry: {
            alertRequired: false,
            attempt: 2,
            failure: {
              classification: "github-api-failure",
              code: "github-api-503",
              requestId: null,
              retryable: true,
              status: 503,
            },
            notBefore: "2026-08-25T00:06:00.000Z",
            operation: "update",
          },
        },
      ] as const;
      const authoritativeState = await ledger.getAllocation(exact.allocationId);
      for (const delivery of invalidDeliveries) {
        await assert.rejects(
          () =>
            ledger.updateAllocationState({
              allocationId: exact.allocationId,
              expectedRevision: exact.revision,
              patch: { checkRunDelivery: delivery },
              updatedAt: nextInstant(exact.updatedAt, 2_000),
            }),
          hasCode("precondition-failed"),
        );
      }
      assert.deepEqual(await ledger.getAllocation(exact.allocationId), authoritativeState);
      assert.deepEqual(ledger.getCounterSnapshot(provider, "2026-08-25"), counters);
    }

    const corruptLedger = initialisedLedger();
    const corruptAllocation = await blacksmithReadyAllocation(corruptLedger, 42);
    corruptLedger.unsafeMutateAllocation(corruptAllocation.allocationId, (current) => ({
      ...current,
      checkRunCreation: {
        ...current.checkRunCreation,
        delivery: concludedCheckRunDelivery(current),
      },
    }));
    await assert.rejects(
      () => corruptLedger.getAllocation(corruptAllocation.allocationId),
      hasCode("authoritative-state-corrupt"),
    );
    await assert.rejects(
      () => corruptLedger.acceptAllocation(acceptance(42)),
      hasCode("authoritative-state-corrupt"),
    );
  });

  it("matches delayed reservation retries only to immutable attempt admission data", async () => {
    const stoppedLedger = initialisedLedger();
    let stoppedAllocation = await acceptedWithCheckRun(stoppedLedger, acceptance(43, "Save money"));
    const stoppedRequest = azureAttempt(stoppedAllocation);
    const azure = await stoppedLedger.reserveProviderAttempt(stoppedRequest);
    assert.equal(azure.outcome, "reserved");
    if (azure.outcome !== "reserved") throw new Error("Azure was not reserved");
    stoppedAllocation = await stoppedLedger.settleUnavailableProviderAttempt({
      allocationId: stoppedAllocation.allocationId,
      classification: "zones-exhausted",
      cleanup: settledAttemptCleanup("2026-08-25T00:03:00.000Z"),
      expectedAllocationRevision: azure.allocation.revision,
      expectedAttemptRevision: azure.attempt.revision,
      finalCostUsdCents: 0,
      ordinal: 1,
      settledAt: "2026-08-25T00:03:00.000Z",
    });
    stoppedAllocation = await stoppedLedger.stopAllocation({
      allocationId: stoppedAllocation.allocationId,
      expectedRevision: stoppedAllocation.revision,
      reason: "save-money",
      stoppedAt: "2026-08-25T00:04:00.000Z",
    });
    const stoppedCounters = stoppedLedger.getCounterSnapshot("azure", "2026-08-25");
    const stoppedRetry = await stoppedLedger.reserveProviderAttempt(stoppedRequest);
    assert.equal(stoppedRetry.outcome, "reserved");
    assert.equal(stoppedRetry.reservation, "exact-retry");
    assert.equal(stoppedRetry.allocation.revision, stoppedAllocation.revision);
    assert.deepEqual(stoppedLedger.getCounterSnapshot("azure", "2026-08-25"), stoppedCounters);
    const conclusionRequest = {
      allocationId: stoppedAllocation.allocationId,
      expectedRevision: stoppedAllocation.revision,
      patch: { checkRunDelivery: concludedCheckRunDelivery(stoppedAllocation) },
      updatedAt: "2026-08-25T00:04:01.000Z",
    } as const;
    stoppedLedger.failAfterNextCommit();
    const concluded = await stoppedLedger.updateAllocationState(conclusionRequest);
    const exactConclusion = await stoppedLedger.updateAllocationState(conclusionRequest);
    assert.equal(concluded.revision, exactConclusion.revision);
    assert.equal(exactConclusion.lifecycleState, "ended");
    assert.equal(exactConclusion.checkRunCreation.delivery.lifecycle.phase, "concluded");
    assert.equal(exactConclusion.updatedAt, stoppedAllocation.updatedAt);
    assert.deepEqual(stoppedLedger.getCounterSnapshot("azure", "2026-08-25"), stoppedCounters);
    const concludedAllocation = await stoppedLedger.getAllocation(exactConclusion.allocationId);
    const concludedLifecycle = exactConclusion.checkRunCreation.delivery.lifecycle;
    if (concludedLifecycle.phase !== "concluded") throw new Error("Check Run was not concluded");
    await assert.rejects(
      () =>
        stoppedLedger.updateAllocationState({
          allocationId: exactConclusion.allocationId,
          expectedRevision: exactConclusion.revision,
          patch: {
            checkRunDelivery: {
              lifecycle: {
                ...concludedLifecycle,
                phase: "in-progress",
                publishedRevision: concludedLifecycle.publishedRevision + 1,
                stage: "workload-running",
              },
              retry: null,
            },
          },
          updatedAt: "2026-08-25T00:04:02.000Z",
        }),
      hasCode("precondition-failed"),
    );
    assert.deepEqual(
      await stoppedLedger.getAllocation(exactConclusion.allocationId),
      concludedAllocation,
    );
    assert.deepEqual(stoppedLedger.getCounterSnapshot("azure", "2026-08-25"), stoppedCounters);

    const assignedLedger = initialisedLedger();
    let assigned = await azureUnavailableAllocation(assignedLedger, 44);
    const blacksmithRequest = blacksmithAttempt(assigned);
    const blacksmith = await assignedLedger.reserveProviderAttempt(blacksmithRequest);
    assert.equal(blacksmith.outcome, "reserved");
    if (blacksmith.outcome !== "reserved") throw new Error("Blacksmith was not reserved");
    assigned = await assignedLedger.markProviderAttemptSucceeded({
      allocationId: assigned.allocationId,
      expectedAllocationRevision: blacksmith.allocation.revision,
      expectedAttemptRevision: blacksmith.attempt.revision,
      ordinal: 2,
      succeededAt: "2026-08-25T00:04:30.000Z",
    });
    assigned = await assignedLedger.assignRunner({
      allocationId: assigned.allocationId,
      assignment: {
        assignedAt: "2026-08-25T00:05:00.000Z",
        attemptOrdinal: 2,
        provider: "blacksmith",
        runnerLabel: "blacksmith-4vcpu-ubuntu-2404",
      },
      expectedAllocationRevision: assigned.revision,
    });
    const assignedCounters = assignedLedger.getCounterSnapshot("blacksmith", "2026-08-25");
    const assignedRetry = await assignedLedger.reserveProviderAttempt(blacksmithRequest);
    assert.equal(assignedRetry.outcome, "reserved");
    assert.equal(assignedRetry.reservation, "exact-retry");
    assert.equal(assignedRetry.allocation.revision, assigned.revision);
    assert.deepEqual(
      assignedLedger.getCounterSnapshot("blacksmith", "2026-08-25"),
      assignedCounters,
    );

    assigned = await assignedLedger.updateAllocationState({
      allocationId: assigned.allocationId,
      expectedRevision: assigned.revision,
      patch: {
        lifecycleState: "cleanup_pending",
        cleanup: settledAllocationCleanup({
          concludedAt: "2026-08-25T00:07:00.000Z",
          conclusion: "succeeded",
          repositoryId: assigned.identity.repository_id,
          runAttempt: assigned.identity.run_attempt,
          runId: assigned.identity.run_id,
          source: "github-workflow-run",
        }),
      },
      updatedAt: "2026-08-25T00:07:00.000Z",
    });
    const finalAttempt = assigned.attempts[1];
    assert.ok(finalAttempt);
    assigned = await assignedLedger.settleFinalProviderAttempt({
      allocationId: assigned.allocationId,
      cleanup: finalAttempt.cleanup,
      expectedAllocationRevision: assigned.revision,
      expectedAttemptRevision: finalAttempt.revision,
      finalCostUsdCents: 75,
      ordinal: 2,
      settledAt: "2026-08-25T00:07:01.000Z",
    });
    const settledCounters = assignedLedger.getCounterSnapshot("blacksmith", "2026-08-25");
    const settledRetry = await assignedLedger.reserveProviderAttempt(blacksmithRequest);
    assert.equal(settledRetry.outcome, "reserved");
    assert.equal(settledRetry.reservation, "exact-retry");
    assert.equal(settledRetry.allocation.revision, assigned.revision);
    assert.deepEqual(
      assignedLedger.getCounterSnapshot("blacksmith", "2026-08-25"),
      settledCounters,
    );

    for (const changed of changedAttemptAdmissions(blacksmithRequest)) {
      await assert.rejects(
        () => assignedLedger.reserveProviderAttempt(changed),
        hasCode("allocation-conflict"),
      );
    }
    assert.deepEqual(
      assignedLedger.getCounterSnapshot("blacksmith", "2026-08-25"),
      settledCounters,
    );
  });

  it("holds Blacksmith until mapped job or whole workflow terminal, never elapsed label time", async () => {
    const ledger = initialisedLedger();
    let allocation = await blacksmithReadyAllocation(ledger, 1);
    allocation = await ledger.assignRunner({
      allocationId: allocation.allocationId,
      assignment: {
        assignedAt: "2026-08-25T00:05:00.000Z",
        attemptOrdinal: 2,
        provider: "blacksmith",
        runnerLabel: "blacksmith-4vcpu-ubuntu-2404",
      },
      expectedAllocationRevision: allocation.revision,
    });
    const attempt = allocation.attempts[1];
    assert.ok(attempt);
    await assert.rejects(
      () =>
        ledger.settleFinalProviderAttempt({
          allocationId: allocation.allocationId,
          cleanup: attempt.cleanup,
          expectedAllocationRevision: allocation.revision,
          expectedAttemptRevision: attempt.revision,
          finalCostUsdCents: 75,
          ordinal: 2,
          settledAt: "2026-08-26T00:00:00.000Z",
        }),
      hasCode("precondition-failed"),
    );
    assert.equal(ledger.getCounterSnapshot("blacksmith", "2026-08-25").activeReservations, 1);

    await assert.rejects(
      () =>
        ledger.updateAllocationState({
          allocationId: allocation.allocationId,
          expectedRevision: allocation.revision,
          patch: {
            lifecycleState: "cleanup_pending",
            cleanup: settledAllocationCleanup({
              concludedAt: "2026-08-26T00:00:00.000Z",
              conclusion: "cancelled",
              githubJobId: "551100",
              source: "github-job",
            }),
          },
          updatedAt: "2026-08-26T00:00:00.000Z",
        }),
      hasCode("precondition-failed"),
    );
    await assert.rejects(
      () =>
        ledger.updateAllocationState({
          allocationId: allocation.allocationId,
          expectedRevision: allocation.revision,
          patch: {
            lifecycleState: "cleanup_pending",
            cleanup: settledAllocationCleanup({
              concludedAt: "2026-08-26T00:00:00.000Z",
              conclusion: "cancelled",
              repositoryId: allocation.identity.repository_id,
              runAttempt: allocation.identity.run_attempt,
              runId: "999999",
              source: "github-workflow-run",
            }),
          },
          updatedAt: "2026-08-26T00:00:00.000Z",
        }),
      hasCode("precondition-failed"),
    );

    allocation = await ledger.updateAllocationState({
      allocationId: allocation.allocationId,
      expectedRevision: allocation.revision,
      patch: {
        lifecycleState: "cleanup_pending",
        cleanup: {
          phase: "settled",
          providerResourcesSettled: true,
          runnerRegistrationSettled: true,
          settledAt: "2026-08-26T00:00:00.000Z",
          terminalEvidence: {
            concludedAt: "2026-08-26T00:00:00.000Z",
            conclusion: "cancelled",
            repositoryId: allocation.identity.repository_id,
            runAttempt: allocation.identity.run_attempt,
            runId: allocation.identity.run_id,
            source: "github-workflow-run",
          },
        },
      },
      updatedAt: "2026-08-26T00:00:00.000Z",
    });
    const settledAttempt = allocation.attempts[1];
    assert.ok(settledAttempt);
    const ended = await ledger.settleFinalProviderAttempt({
      allocationId: allocation.allocationId,
      cleanup: settledAttempt.cleanup,
      expectedAllocationRevision: allocation.revision,
      expectedAttemptRevision: settledAttempt.revision,
      finalCostUsdCents: 75,
      ordinal: 2,
      settledAt: "2026-08-26T00:00:01.000Z",
    });
    assert.equal(ended.lifecycleState, "ended");
    assert.equal(ledger.getCounterSnapshot("blacksmith", "2026-08-25").activeReservations, 0);
  });

  it("settles job evidence only for the identical bound job and whole-run evidence for failed correlation", async () => {
    const boundLedger = initialisedLedger();
    let bound = await assignedBlacksmithAllocation(boundLedger, 23);
    bound = await boundLedger.updateAllocationState({
      allocationId: bound.allocationId,
      expectedRevision: bound.revision,
      patch: { workloadBinding: { githubJobId: "551100", state: "bound" } },
      updatedAt: "2026-08-25T00:06:00.000Z",
    });
    await assert.rejects(
      () =>
        boundLedger.updateAllocationState({
          allocationId: bound.allocationId,
          expectedRevision: bound.revision,
          patch: {
            lifecycleState: "cleanup_pending",
            cleanup: settledAllocationCleanup({
              concludedAt: "2026-08-25T00:07:00.000Z",
              conclusion: "succeeded",
              githubJobId: "551101",
              source: "github-job",
            }),
          },
          updatedAt: "2026-08-25T00:07:00.000Z",
        }),
      hasCode("precondition-failed"),
    );
    const jobTerminal = await boundLedger.updateAllocationState({
      allocationId: bound.allocationId,
      expectedRevision: bound.revision,
      patch: {
        lifecycleState: "cleanup_pending",
        cleanup: settledAllocationCleanup({
          concludedAt: "2026-08-25T00:07:00.000Z",
          conclusion: "succeeded",
          githubJobId: "551100",
          source: "github-job",
        }),
      },
      updatedAt: "2026-08-25T00:07:00.000Z",
    });
    assert.equal(jobTerminal.cleanup.terminalEvidence?.source, "github-job");

    const failedLedger = initialisedLedger();
    let failed = await assignedBlacksmithAllocation(failedLedger, 24);
    failed = await failedLedger.updateAllocationState({
      allocationId: failed.allocationId,
      expectedRevision: failed.revision,
      patch: {
        workloadBinding: { reason: "expected-job-missing", state: "binding-failed" },
      },
      updatedAt: "2026-08-25T00:06:00.000Z",
    });
    await assert.rejects(
      () =>
        failedLedger.updateAllocationState({
          allocationId: failed.allocationId,
          expectedRevision: failed.revision,
          patch: {
            lifecycleState: "cleanup_pending",
            cleanup: settledAllocationCleanup({
              concludedAt: "2026-08-25T00:07:00.000Z",
              conclusion: "cancelled",
              githubJobId: "551100",
              source: "github-job",
            }),
          },
          updatedAt: "2026-08-25T00:07:00.000Z",
        }),
      hasCode("precondition-failed"),
    );
    const runTerminal = await failedLedger.updateAllocationState({
      allocationId: failed.allocationId,
      expectedRevision: failed.revision,
      patch: {
        lifecycleState: "cleanup_pending",
        cleanup: settledAllocationCleanup({
          concludedAt: "2026-08-25T00:07:00.000Z",
          conclusion: "cancelled",
          repositoryId: failed.identity.repository_id,
          runAttempt: failed.identity.run_attempt,
          runId: failed.identity.run_id,
          source: "github-workflow-run",
        }),
      },
      updatedAt: "2026-08-25T00:07:00.000Z",
    });
    assert.equal(runTerminal.cleanup.terminalEvidence?.source, "github-workflow-run");
  });

  it("treats corrupt counters and controller-like errors as failures, never fallback evidence", async () => {
    for (const counters of [
      { activeReservations: -1, accountedDailyCostUsdCents: 0 },
      { activeReservations: 4, accountedDailyCostUsdCents: 0 },
      { activeReservations: 0, accountedDailyCostUsdCents: 501 },
    ]) {
      const ledger = initialisedLedger();
      const allocation = await acceptedWithCheckRun(ledger, acceptance(1));
      ledger.unsafeSetCounterState("azure", "2026-08-25", counters);
      await assert.rejects(
        () => ledger.reserveProviderAttempt(azureAttempt(allocation)),
        hasCode("authoritative-state-corrupt"),
      );
      assert.equal((await ledger.getAllocation(allocation.allocationId))?.attempts.length, 0);
    }

    const ledger = initialisedLedger();
    const allocation = (await ledger.acceptAllocation(acceptance(19))).allocation;
    ledger.unsafeMutateAllocation(allocation.allocationId, (current) => ({
      ...current,
      lifecycleState: "assigned",
    }));
    await assert.rejects(
      () => ledger.getAllocation(allocation.allocationId),
      hasCode("authoritative-state-corrupt"),
    );
  });

  it("rejects non-exact nested schema-10 objects and malformed persisted enums", async () => {
    const mutations: Array<(value: AllocationRecord) => AllocationRecord> = [
      (value) => ({ ...value, unexpected: true }) as AllocationRecord,
      (value) => {
        const attempt = value.attempts[0];
        assert.ok(attempt);
        const { outcome: _missing, ...withoutOutcome } = attempt;
        return { ...value, attempts: [withoutOutcome as typeof attempt] };
      },
      (value) => {
        const attempt = value.attempts[0];
        assert.ok(attempt);
        return {
          ...value,
          attempts: [
            {
              ...attempt,
              reservation: { ...attempt.reservation, unexpected: true },
            },
          ],
        };
      },
      (value) => {
        const attempt = value.attempts[0];
        const generation = attempt?.physicalGenerations[0];
        assert.ok(attempt && generation);
        return {
          ...value,
          attempts: [
            {
              ...attempt,
              physicalGenerations: [{ ...generation, state: "unknown" as never }],
            },
          ],
        };
      },
      (value) => {
        const attempt = value.attempts[0];
        const generation = attempt?.physicalGenerations[0];
        assert.ok(attempt && generation?.schedule);
        const { requestCorrelationId: _missing, ...withoutOperation } = generation.schedule;
        return {
          ...value,
          attempts: [
            {
              ...attempt,
              physicalGenerations: [
                { ...generation, schedule: withoutOperation as typeof generation.schedule },
              ],
            },
          ],
        };
      },
      (value) => {
        const attempt = value.attempts[0];
        const generation = attempt?.physicalGenerations[0];
        assert.ok(attempt && generation);
        return {
          ...value,
          attempts: [
            {
              ...attempt,
              physicalGenerations: [{ ...generation, zoneDeployments: [] }],
            },
          ],
        };
      },
      (value) => {
        const attempt = value.attempts[0];
        const generation = attempt?.physicalGenerations[0];
        assert.ok(attempt && generation);
        return {
          ...value,
          attempts: [
            {
              ...attempt,
              physicalGenerations: [{ ...generation, location: "eastus" as never }],
            },
          ],
        };
      },
      (value) => ({
        ...value,
        cleanup: { ...value.cleanup, unexpected: true },
      }),
      (value) => ({
        ...value,
        cleanup: {
          ...value.cleanup,
          terminalEvidence: {
            concludedAt: value.updatedAt,
            conclusion: "cancelled",
            repositoryId: value.identity.repository_id,
            runAttempt: value.identity.run_attempt,
            source: "github-workflow-run",
          } as TerminalEvidence,
        },
      }),
    ];

    for (const [index, mutate] of mutations.entries()) {
      const ledger = initialisedLedger();
      const allocation = await allocationWithRequestedSchedule(ledger, 30 + index);
      ledger.unsafeMutateAllocation(allocation.allocationId, mutate);
      await assert.rejects(
        () => ledger.getAllocation(allocation.allocationId),
        hasCode("authoritative-state-corrupt"),
      );
    }
  });

  it("preserves UTC admission-day allowance while concurrency remains provider-wide", async () => {
    const ledger = initialisedLedger();
    const dayOne = await acceptedWithCheckRun(ledger, acceptance(1));
    const first = await ledger.reserveProviderAttempt(azureAttempt(dayOne, { cost: 200 }));
    assert.equal(first.outcome, "reserved");

    const dayTwoRequest = acceptance(2, "Keep going", "2026-08-26T00:00:00.000Z");
    const dayTwo = await acceptedWithCheckRun(ledger, dayTwoRequest, "2026-08-26T00:00:01.000Z");
    const second = await ledger.reserveProviderAttempt(
      azureAttempt(dayTwo, {
        attemptedAt: "2026-08-26T00:00:02.000Z",
        cost: 300,
        day: "2026-08-26",
      }),
    );
    assert.equal(second.outcome, "reserved");
    assert.deepEqual(ledger.getCounterSnapshot("azure", "2026-08-25"), {
      activeReservations: 2,
      accountedDailyCostUsdCents: 200,
    });
    assert.deepEqual(ledger.getCounterSnapshot("azure", "2026-08-26"), {
      activeReservations: 2,
      accountedDailyCostUsdCents: 300,
    });
  });

  it("keeps Azure generations under attempt 1 and allows the exact minute-10 boundary", async () => {
    const ledger = initialisedLedger();
    let allocation = await acceptedWithCheckRun(ledger, acceptance(1));
    const reserved = await ledger.reserveProviderAttempt(azureAttempt(allocation, { cost: 300 }));
    assert.equal(reserved.outcome, "reserved");
    if (reserved.outcome !== "reserved") return;
    allocation = reserved.allocation;
    const generation = await ledger.addPhysicalGeneration(
      generationRequest({
        allocationId: allocation.allocationId,
        createdAt: "2026-08-25T00:09:59.997Z",
        expectedAttemptRevision: reserved.attempt.revision,
      }),
    );
    assert.equal(generation.outcome, "added");
    if (generation.outcome !== "added") return;
    allocation = await ledger.updatePhysicalGeneration({
      allocationId: allocation.allocationId,
      attemptOrdinal: 1,
      expectedRevision: generation.generation.revision,
      generationNumber: 1,
      state: readyGenerationState(generation.generation, "2026-08-25T00:09:59.998Z"),
      updatedAt: "2026-08-25T00:09:59.998Z",
    });
    assert.equal(
      allocation.attempts[0]?.physicalGenerations[0]?.readyAt,
      "2026-08-25T00:09:59.998Z",
    );
    const attempt = allocation.attempts[0];
    assert.ok(attempt);
    allocation = await ledger.markProviderAttemptSucceeded({
      allocationId: allocation.allocationId,
      expectedAllocationRevision: allocation.revision,
      expectedAttemptRevision: attempt.revision,
      ordinal: 1,
      succeededAt: "2026-08-25T00:09:59.999Z",
    });
    await assert.rejects(
      () =>
        ledger.assignRunner({
          allocationId: allocation.allocationId,
          assignment: {
            assignedAt: "2026-08-25T00:10:00.000Z",
            attemptOrdinal: 1,
            generationNumber: 1,
            provider: "azure",
            readinessCheckedAt: "2026-08-25T00:10:00.000Z",
            runnerIdle: true,
            runnerRegistrationId: "551001",
            runnerOnline: true,
            runnerLabel: azureRunnerLabelForAllocation(allocation.allocationId),
          },
          expectedAllocationRevision: allocation.revision,
        }),
      hasCode("precondition-failed"),
      "assignment requires a schedule check at least as fresh as the final runner observation",
    );
    const finalGeneration = allocation.attempts[0]?.physicalGenerations[0];
    assert.ok(finalGeneration?.schedule);
    allocation = await ledger.updatePhysicalGeneration({
      allocationId: allocation.allocationId,
      attemptOrdinal: 1,
      expectedRevision: finalGeneration.revision,
      generationNumber: 1,
      state: {
        ...generationState(finalGeneration),
        schedule: {
          ...finalGeneration.schedule,
          lastCheckedAt: "2026-08-25T00:10:00.000Z",
        },
      },
      updatedAt: "2026-08-25T00:10:00.000Z",
    });
    for (const readinessCheckedAt of ["2026-08-25T00:09:59.998Z", "2026-08-25T00:09:59.999Z"]) {
      await assert.rejects(
        () =>
          ledger.assignRunner({
            allocationId: allocation.allocationId,
            assignment: {
              assignedAt: "2026-08-25T00:10:00.000Z",
              attemptOrdinal: 1,
              generationNumber: 1,
              provider: "azure",
              readinessCheckedAt,
              runnerIdle: true,
              runnerRegistrationId: "551001",
              runnerOnline: true,
              runnerLabel: azureRunnerLabelForAllocation(allocation.allocationId),
            },
            expectedAllocationRevision: allocation.revision,
          }),
        hasCode("precondition-failed"),
      );
    }
    await assert.rejects(
      () =>
        ledger.assignRunner({
          allocationId: allocation.allocationId,
          assignment: {
            assignedAt: "2026-08-25T00:10:00.000Z",
            attemptOrdinal: 1,
            generationNumber: 1,
            provider: "azure",
            readinessCheckedAt: "2026-08-25T00:10:00.000Z",
            runnerIdle: true,
            runnerRegistrationId: "runner-1",
            runnerOnline: true,
            runnerLabel: azureRunnerLabelForAllocation(allocation.allocationId),
          },
          expectedAllocationRevision: allocation.revision,
        }),
      hasValidation("assignment.runnerRegistrationId", "must be a positive decimal string"),
    );
    const assigned = await ledger.assignRunner({
      allocationId: allocation.allocationId,
      assignment: {
        assignedAt: "2026-08-25T00:10:00.000Z",
        attemptOrdinal: 1,
        generationNumber: 1,
        provider: "azure",
        readinessCheckedAt: "2026-08-25T00:10:00.000Z",
        runnerIdle: true,
        runnerRegistrationId: "551001",
        runnerOnline: true,
        runnerLabel: azureRunnerLabelForAllocation(allocation.allocationId),
      },
      expectedAllocationRevision: allocation.revision,
    });
    assert.equal(assigned.runnerAssignment?.provider, "azure");
    ledger.unsafeMutateAllocation(assigned.allocationId, (current) => ({
      ...current,
      runnerAssignment:
        current.runnerAssignment?.provider === "azure"
          ? {
              ...current.runnerAssignment,
              readinessCheckedAt: "2026-08-25T00:09:59.999Z",
            }
          : current.runnerAssignment,
    }));
    await assert.rejects(
      () => ledger.getAllocation(assigned.allocationId),
      hasCode("authoritative-state-corrupt"),
    );
  });

  it("rejects forged persisted Run Command and runner identities", async () => {
    const vmResourceId =
      "/subscriptions/test/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm1";
    const mutations: Array<(record: AllocationRecord) => AllocationRecord> = [
      (record) => ({
        ...record,
        attempts: record.attempts.map((attempt) => ({
          ...attempt,
          physicalGenerations: attempt.physicalGenerations.map((generation) => ({
            ...generation,
            managedRunCommand:
              generation.managedRunCommand === null
                ? null
                : {
                    ...generation.managedRunCommand,
                    managedRunCommandId: `${vmResourceId}-other/runCommands/launch-jit-g1`,
                  },
          })),
        })),
      }),
      (record) => ({
        ...record,
        attempts: record.attempts.map((attempt) => ({
          ...attempt,
          physicalGenerations: attempt.physicalGenerations.map((generation) => ({
            ...generation,
            runnerRegistrationId: "runner-1",
          })),
        })),
      }),
      (record) => ({
        ...record,
        runnerAssignment:
          record.runnerAssignment?.provider === "azure"
            ? { ...record.runnerAssignment, runnerRegistrationId: "runner-1" }
            : record.runnerAssignment,
      }),
    ];

    for (const [index, mutate] of mutations.entries()) {
      const ledger = initialisedLedger();
      const assigned = await assignedAzureGeneration(ledger, 41 + index);
      ledger.unsafeMutateAllocation(assigned.allocationId, mutate);
      await assert.rejects(
        () => ledger.getAllocation(assigned.allocationId),
        hasCode("authoritative-state-corrupt"),
      );
    }
  });

  it("rejects generation two even after generation one is safely settled", async () => {
    const ledger = initialisedLedger();
    const accepted = await acceptedWithCheckRun(ledger, acceptance(21));
    const reserved = await ledger.reserveProviderAttempt(azureAttempt(accepted, { cost: 300 }));
    assert.equal(reserved.outcome, "reserved");
    if (reserved.outcome !== "reserved") return;
    const first = await ledger.addPhysicalGeneration(
      generationRequest({
        allocationId: accepted.allocationId,
        createdAt: "2026-08-25T00:02:30.000Z",
        expectedAttemptRevision: reserved.attempt.revision,
      }),
    );
    assert.equal(first.outcome, "added");
    if (first.outcome !== "added") return;
    let allocation = await ledger.updatePhysicalGeneration({
      allocationId: accepted.allocationId,
      attemptOrdinal: 1,
      expectedRevision: first.generation.revision,
      generationNumber: 1,
      state: readyGenerationState(first.generation, "2026-08-25T00:03:00.000Z"),
      updatedAt: "2026-08-25T00:03:00.000Z",
    });
    let generation = allocation.attempts[0]?.physicalGenerations[0];
    assert.ok(generation);
    allocation = await ledger.updatePhysicalGeneration({
      allocationId: accepted.allocationId,
      attemptOrdinal: 1,
      expectedRevision: generation.revision,
      generationNumber: 1,
      state: { ...generationState(generation), state: "fenced" },
      updatedAt: "2026-08-25T00:03:30.000Z",
    });
    generation = allocation.attempts[0]?.physicalGenerations[0];
    assert.ok(generation);
    allocation = await ledger.updatePhysicalGeneration({
      allocationId: accepted.allocationId,
      attemptOrdinal: 1,
      expectedRevision: generation.revision,
      generationNumber: 1,
      state: {
        ...generationState(generation),
        cleanup: {
          ...generation.cleanup,
          phase: "pending",
          startedAt: "2026-08-25T00:03:45.000Z",
        },
        state: "cleanup_pending",
      },
      updatedAt: "2026-08-25T00:03:45.000Z",
    });
    generation = allocation.attempts[0]?.physicalGenerations[0];
    assert.ok(generation);
    allocation = await ledger.updatePhysicalGeneration({
      allocationId: accepted.allocationId,
      attemptOrdinal: 1,
      expectedRevision: generation.revision,
      generationNumber: 1,
      state: {
        ...generationState(generation),
        cleanup: {
          phase: "settled",
          providerResourcesSettled: true,
          runnerRegistrationSettled: true,
          settledAt: "2026-08-25T00:04:00.000Z",
          startedAt: "2026-08-25T00:03:45.000Z",
        },
        state: "settled",
      },
      updatedAt: "2026-08-25T00:04:00.000Z",
    });
    await assert.rejects(
      () =>
        ledger.addPhysicalGeneration({
          ...generationRequest({
            allocationId: accepted.allocationId,
            createdAt: "2026-08-25T00:04:01.000Z",
            expectedAttemptRevision: allocation.attempts[0]?.revision ?? "missing",
          }),
          createdAt: "2026-08-25T00:05:00.000Z",
          generationNumber: 2 as never,
        }),
      hasCode("precondition-failed"),
    );
  });

  it("enforces exact V1 deadlines rather than accepting merely ordered times", async () => {
    const ledger = initialisedLedger();
    const allocation = await acceptedWithCheckRun(ledger, acceptance(22));
    const exact = azureAttempt(allocation);
    assert.equal((await ledger.reserveProviderAttempt(exact)).outcome, "reserved");

    const secondLedger = initialisedLedger();
    const second = await acceptedWithCheckRun(secondLedger, acceptance(23));
    await assert.rejects(
      () =>
        secondLedger.reserveProviderAttempt({
          ...azureAttempt(second),
          deadlines: {
            absoluteExpiry: "2026-08-25T00:45:02.000Z",
            computeDeadline: "2026-08-25T00:40:03.000Z",
            latestSafeStart: "2026-08-25T00:10:03.000Z",
          },
        }),
      hasCode("invalid-ledger-request"),
    );
  });

  it("binds each capability profile to its exact Ddsv6 VM size", async () => {
    const ledger = initialisedLedger();
    const allocation = await acceptedWithCheckRun(
      ledger,
      acceptance(27, "Keep going", DAY_ONE, "linux-x64-standard"),
    );
    const reserved = await ledger.reserveProviderAttempt(azureAttempt(allocation));
    assert.equal(reserved.outcome, "reserved");
    if (reserved.outcome !== "reserved") return;
    const request = generationRequest({
      allocationId: allocation.allocationId,
      createdAt: "2026-08-25T00:02:30.000Z",
      expectedAttemptRevision: reserved.attempt.revision,
    });
    await assert.rejects(
      () => ledger.addPhysicalGeneration(request),
      hasCode("invalid-ledger-request"),
    );
    const added = await ledger.addPhysicalGeneration({
      ...request,
      vmSize: "Standard_D4ds_v6",
    });
    assert.equal(added.outcome, "added");
  });

  it("rejects a wrong-VM schedule and any JIT launch before exact schedule acceptance", async () => {
    const ledger = initialisedLedger();
    const allocation = await acceptedWithCheckRun(ledger, acceptance(24));
    const reserved = await ledger.reserveProviderAttempt(azureAttempt(allocation));
    assert.equal(reserved.outcome, "reserved");
    if (reserved.outcome !== "reserved") return;
    const added = await ledger.addPhysicalGeneration(
      generationRequest({
        allocationId: allocation.allocationId,
        createdAt: "2026-08-25T00:02:30.000Z",
        expectedAttemptRevision: reserved.attempt.revision,
      }),
    );
    assert.equal(added.outcome, "added");
    if (added.outcome !== "added") return;
    const initialZone = added.generation.zoneDeployments[0];
    assert.ok(initialZone);
    const vmResourceId =
      "/subscriptions/test/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm1";
    const base: PhysicalGenerationState = {
      ...generationState(added.generation),
      state: "provisioning",
      vmResourceId,
      zoneDeployments: [
        {
          ...initialZone,
          completedAt: "2026-08-25T00:02:31.000Z",
          outcome: "vm-created",
          vmResourceId,
        },
      ],
    };
    await assert.rejects(
      () =>
        ledger.updatePhysicalGeneration({
          allocationId: allocation.allocationId,
          attemptOrdinal: 1,
          expectedRevision: added.generation.revision,
          generationNumber: 1,
          state: {
            ...base,
            schedule: {
              acceptedAt: "2026-08-25T00:02:32.000Z",
              requestCorrelationId: "correlation-1",
              deadlineType: "CompleteBy",
              lastCheckedAt: "2026-08-25T00:02:32.000Z",
              providerOperationId: "schedule-1",
              requestedDeadline: "2026-08-25T00:40:00.000Z",
              status: "accepted",
              targetVmResourceId: `${vmResourceId}-wrong`,
            },
          },
          updatedAt: "2026-08-25T00:02:32.000Z",
        }),
      hasCode("precondition-failed"),
    );
    await assert.rejects(
      () =>
        ledger.updatePhysicalGeneration({
          allocationId: allocation.allocationId,
          attemptOrdinal: 1,
          expectedRevision: added.generation.revision,
          generationNumber: 1,
          state: {
            ...base,
            launchPrerequisites: {
              bootstrapSucceeded: true,
              checkedAt: "2026-08-25T00:02:32.000Z",
              dockerHealthy: true,
              localNvmeMounted: true,
            },
            managedRunCommand: {
              boundVmResourceId: vmResourceId,
              deleteCompletedAt: null,
              deleteRequestedAt: null,
              launchConfirmedAt: null,
              managedRunCommandId: `${vmResourceId}/runCommands/launch-jit-g1`,
              requestedAt: "2026-08-25T00:02:32.000Z",
            },
          },
          updatedAt: "2026-08-25T00:02:32.000Z",
        }),
      hasCode("precondition-failed"),
    );
  });

  it("requires bootstrap, local NVMe, Docker and Run Command deletion before ready", async () => {
    const ledger = initialisedLedger();
    const allocation = await acceptedWithCheckRun(ledger, acceptance(25));
    const reserved = await ledger.reserveProviderAttempt(azureAttempt(allocation));
    assert.equal(reserved.outcome, "reserved");
    if (reserved.outcome !== "reserved") return;
    const added = await ledger.addPhysicalGeneration(
      generationRequest({
        allocationId: allocation.allocationId,
        createdAt: "2026-08-25T00:02:30.000Z",
        expectedAttemptRevision: reserved.attempt.revision,
      }),
    );
    assert.equal(added.outcome, "added");
    if (added.outcome !== "added") return;
    const ready = readyGenerationState(added.generation, "2026-08-25T00:03:00.000Z");
    const launchPrerequisites = ready.launchPrerequisites;
    const managedRunCommand = ready.managedRunCommand;
    assert.ok(launchPrerequisites && managedRunCommand);
    for (const managedRunCommandId of [
      "/subscriptions/test/resourceGroups/other/providers/Microsoft.Compute/virtualMachines/vm1/runCommands/launch-jit-g1",
      "/subscriptions/test/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm2/runCommands/launch-jit-g1",
      "/subscriptions/test/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm1/runCommands/other",
    ]) {
      await assert.rejects(
        () =>
          ledger.updatePhysicalGeneration({
            allocationId: allocation.allocationId,
            attemptOrdinal: 1,
            expectedRevision: added.generation.revision,
            generationNumber: 1,
            state: {
              ...ready,
              managedRunCommand: { ...managedRunCommand, managedRunCommandId },
            },
            updatedAt: "2026-08-25T00:03:00.000Z",
          }),
        hasCode("precondition-failed"),
      );
    }
    await assert.rejects(
      () =>
        ledger.updatePhysicalGeneration({
          allocationId: allocation.allocationId,
          attemptOrdinal: 1,
          expectedRevision: added.generation.revision,
          generationNumber: 1,
          state: { ...ready, runnerRegistrationId: "runner-1" },
          updatedAt: "2026-08-25T00:03:00.000Z",
        }),
      hasValidation("runnerRegistrationId", "must be a positive decimal string"),
    );
    for (const key of ["bootstrapSucceeded", "localNvmeMounted", "dockerHealthy"] as const) {
      await assert.rejects(
        () =>
          ledger.updatePhysicalGeneration({
            allocationId: allocation.allocationId,
            attemptOrdinal: 1,
            expectedRevision: added.generation.revision,
            generationNumber: 1,
            state: {
              ...ready,
              launchPrerequisites: {
                ...launchPrerequisites,
                [key]: false,
              } as never,
            },
            updatedAt: "2026-08-25T00:03:00.000Z",
          }),
        hasCode("precondition-failed"),
      );
    }
    await assert.rejects(
      () =>
        ledger.updatePhysicalGeneration({
          allocationId: allocation.allocationId,
          attemptOrdinal: 1,
          expectedRevision: added.generation.revision,
          generationNumber: 1,
          state: {
            ...ready,
            managedRunCommand: { ...managedRunCommand, deleteCompletedAt: null },
          },
          updatedAt: "2026-08-25T00:03:00.000Z",
        }),
      hasCode("precondition-failed"),
    );
  });

  it("progresses zones only after no-VM proof and stops forever once a VM exists", async () => {
    const ledger = initialisedLedger();
    const allocation = await acceptedWithCheckRun(ledger, acceptance(26));
    const reserved = await ledger.reserveProviderAttempt(azureAttempt(allocation));
    assert.equal(reserved.outcome, "reserved");
    if (reserved.outcome !== "reserved") return;
    const added = await ledger.addPhysicalGeneration(
      generationRequest({
        allocationId: allocation.allocationId,
        createdAt: "2026-08-25T00:02:30.000Z",
        expectedAttemptRevision: reserved.attempt.revision,
      }),
    );
    assert.equal(added.outcome, "added");
    if (added.outcome !== "added") return;
    const initialZone = added.generation.zoneDeployments[0];
    assert.ok(initialZone);
    const zoneTwo = {
      availabilityZone: "2" as const,
      childDeploymentId: initialZone.childDeploymentId,
      completedAt: null,
      deploymentId:
        "/subscriptions/test/providers/Microsoft.Resources/deployments/switchyard-g1-zone-2",
      deploymentName: "switchyard-g1-zone-2",
      outcome: "pending" as const,
      requestedAt: "2026-08-25T00:02:33.000Z",
      residualResourcesSettledAt: null,
      vmAbsenceVerifiedAt: null,
      vmResourceId: null,
    };
    await assert.rejects(
      () =>
        ledger.updatePhysicalGeneration({
          allocationId: allocation.allocationId,
          attemptOrdinal: 1,
          expectedRevision: added.generation.revision,
          generationNumber: 1,
          state: {
            ...generationState(added.generation),
            state: "provisioning",
            zoneDeployments: [initialZone, zoneTwo],
          },
          updatedAt: "2026-08-25T00:02:33.000Z",
        }),
      hasCode("precondition-failed"),
    );
    const firstNoVm = {
      ...initialZone,
      completedAt: "2026-08-25T00:02:31.000Z",
      outcome: "no-vm-created" as const,
      residualResourcesSettledAt: "2026-08-25T00:02:32.500Z",
      vmAbsenceVerifiedAt: "2026-08-25T00:02:32.000Z",
    };
    let current = await ledger.updatePhysicalGeneration({
      allocationId: allocation.allocationId,
      attemptOrdinal: 1,
      expectedRevision: added.generation.revision,
      generationNumber: 1,
      state: {
        ...generationState(added.generation),
        state: "provisioning",
        zoneDeployments: [firstNoVm, zoneTwo],
      },
      updatedAt: "2026-08-25T00:02:33.000Z",
    });
    let generation = current.attempts[0]?.physicalGenerations[0];
    assert.ok(generation);
    const vmResourceId =
      "/subscriptions/test/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm2";
    current = await ledger.updatePhysicalGeneration({
      allocationId: allocation.allocationId,
      attemptOrdinal: 1,
      expectedRevision: generation.revision,
      generationNumber: 1,
      state: {
        ...generationState(generation),
        state: "provisioning",
        vmResourceId,
        zoneDeployments: [
          firstNoVm,
          {
            ...zoneTwo,
            completedAt: "2026-08-25T00:02:34.000Z",
            outcome: "vm-created",
            vmResourceId,
          },
        ],
      },
      updatedAt: "2026-08-25T00:02:34.000Z",
    });
    generation = current.attempts[0]?.physicalGenerations[0];
    assert.ok(generation);
    await assert.rejects(
      () =>
        ledger.updatePhysicalGeneration({
          allocationId: allocation.allocationId,
          attemptOrdinal: 1,
          expectedRevision: generation.revision,
          generationNumber: 1,
          state: {
            ...generationState(generation),
            zoneDeployments: [
              ...generation.zoneDeployments,
              {
                ...zoneTwo,
                availabilityZone: "3",
                deploymentId:
                  "/subscriptions/test/providers/Microsoft.Resources/deployments/switchyard-g1-zone-3",
                deploymentName: "switchyard-g1-zone-3",
              },
            ],
          },
          updatedAt: "2026-08-25T00:02:35.000Z",
        }),
      hasCode("precondition-failed"),
    );
  });

  it("atomically aborts a cleaned unassigned Azure attempt after provider success", async () => {
    const ledger = initialisedLedger();
    let allocation = await successfulUnassignedAzureGeneration(ledger, 60);
    let attempt = allocation.attempts[0];
    assert.ok(attempt);
    const intentRequest = {
      allocationId: allocation.allocationId,
      classification: "lost-runner-before-assignment",
      expectedAllocationRevision: allocation.revision,
      expectedAttemptRevision: attempt.revision,
      ordinal: 1,
      recordedAt: "2026-08-25T00:03:02.000Z",
    } as const;
    allocation = await ledger.beginFatalAzureAbort(intentRequest);
    assert.equal((await ledger.beginFatalAzureAbort(intentRequest)).revision, allocation.revision);
    attempt = allocation.attempts[0];
    assert.ok(attempt);
    const attemptRevisionAfterIntent = attempt.revision;
    await assert.rejects(
      () =>
        ledger.beginFatalAzureAbort({
          ...intentRequest,
          classification: "schedule-failed",
          expectedAllocationRevision: allocation.revision,
          expectedAttemptRevision: attemptRevisionAfterIntent,
        }),
      hasCode("precondition-failed"),
    );
    let generation = allocation.attempts[0]?.physicalGenerations[0];
    assert.ok(generation);
    allocation = await ledger.updatePhysicalGeneration({
      allocationId: allocation.allocationId,
      attemptOrdinal: 1,
      expectedRevision: generation.revision,
      generationNumber: 1,
      state: {
        ...generationState(generation),
        cleanup: {
          ...generation.cleanup,
          phase: "pending",
          startedAt: "2026-08-25T00:03:02.000Z",
        },
        state: "cleanup_pending",
      },
      updatedAt: "2026-08-25T00:03:02.000Z",
    });
    generation = allocation.attempts[0]?.physicalGenerations[0];
    assert.ok(generation);
    allocation = await ledger.updatePhysicalGeneration({
      allocationId: allocation.allocationId,
      attemptOrdinal: 1,
      expectedRevision: generation.revision,
      generationNumber: 1,
      state: {
        ...generationState(generation),
        cleanup: {
          phase: "settled",
          providerResourcesSettled: true,
          runnerRegistrationSettled: true,
          settledAt: "2026-08-25T00:03:03.000Z",
          startedAt: "2026-08-25T00:03:02.000Z",
        },
        state: "settled",
      },
      updatedAt: "2026-08-25T00:03:03.000Z",
    });
    attempt = allocation.attempts[0];
    assert.ok(attempt);
    const request = {
      allocationId: allocation.allocationId,
      classification: "lost-runner-before-assignment",
      cleanup: settledAttemptCleanup("2026-08-25T00:03:03.000Z"),
      expectedAllocationRevision: allocation.revision,
      expectedAttemptRevision: attempt.revision,
      finalCostUsdCents: 25,
      ordinal: 1,
      settledAt: "2026-08-25T00:03:03.000Z",
    } as const;
    ledger.failAfterNextCommit();
    const aborted = await ledger.settleFatalAzureAbort(request);
    assert.equal(aborted.lifecycleState, "ended");
    assert.equal(aborted.runnerAssignment, null);
    assert.deepEqual(aborted.attempts[0]?.fatalAbort, {
      classification: "lost-runner-before-assignment",
      recordedAt: "2026-08-25T00:03:02.000Z",
    });
    assert.equal(aborted.attempts[0]?.reservation.settlementKind, "aborted");
    assert.equal((await ledger.settleFatalAzureAbort(request)).revision, aborted.revision);
    assert.deepEqual(ledger.getCounterSnapshot("azure", "2026-08-25"), {
      activeReservations: 0,
      accountedDailyCostUsdCents: 25,
    });
  });

  it("fences fatal abort and stale side-effect intent across allocation, attempt and generation rows", async () => {
    const ledger = initialisedLedger();
    let allocation = await acceptedWithCheckRun(ledger, acceptance(66));
    const reserved = await ledger.reserveProviderAttempt(azureAttempt(allocation));
    assert.equal(reserved.outcome, "reserved");
    if (reserved.outcome !== "reserved") return;
    const added = await ledger.addPhysicalGeneration(
      generationRequest({
        allocationId: allocation.allocationId,
        createdAt: "2026-08-25T00:02:30.000Z",
        expectedAttemptRevision: reserved.attempt.revision,
      }),
    );
    assert.equal(added.outcome, "added");
    if (added.outcome !== "added") return;
    allocation = added.allocation;
    const staleAllocationRevision = allocation.revision;
    const staleAttemptRevision = added.attempt.revision;
    const staleGenerationRevision = added.generation.revision;
    allocation = await ledger.updatePhysicalGenerationFenced({
      allocationId: allocation.allocationId,
      attemptOrdinal: 1,
      expectedAllocationRevision: staleAllocationRevision,
      expectedAttemptRevision: staleAttemptRevision,
      expectedRevision: staleGenerationRevision,
      generationNumber: 1,
      state: {
        ...generationState(added.generation),
        operationLease: {
          acquiredAt: "2026-08-25T00:02:31.000Z",
          expiresAt: "2026-08-25T00:04:31.000Z",
          kind: "base-deployment",
          leaseId: "11111111-1111-4111-8111-111111111111",
        },
      },
      updatedAt: "2026-08-25T00:02:31.000Z",
    });
    const currentAttempt = allocation.attempts[0];
    assert.ok(currentAttempt);
    await assert.rejects(
      () =>
        ledger.beginFatalAzureAbort({
          allocationId: allocation.allocationId,
          classification: "malformed-provider-output",
          expectedAllocationRevision: allocation.revision,
          expectedAttemptRevision: currentAttempt.revision,
          ordinal: 1,
          recordedAt: "2026-08-25T00:02:32.000Z",
        }),
      hasCode("precondition-failed"),
    );
    await assert.rejects(
      () =>
        ledger.updatePhysicalGenerationFenced({
          allocationId: allocation.allocationId,
          attemptOrdinal: 1,
          expectedAllocationRevision: staleAllocationRevision,
          expectedAttemptRevision: staleAttemptRevision,
          expectedRevision: staleGenerationRevision,
          generationNumber: 1,
          state: generationState(added.generation),
          updatedAt: "2026-08-25T00:02:32.000Z",
        }),
      hasCode("optimistic-concurrency-conflict"),
    );
  });

  it("rejects fatal abort until both runner and Azure cleanup are settled", async () => {
    const ledger = initialisedLedger();
    let allocation = await successfulUnassignedAzureGeneration(ledger, 61);
    let attempt = allocation.attempts[0];
    assert.ok(attempt);
    allocation = await ledger.beginFatalAzureAbort({
      allocationId: allocation.allocationId,
      classification: "schedule-failed",
      expectedAllocationRevision: allocation.revision,
      expectedAttemptRevision: attempt.revision,
      ordinal: 1,
      recordedAt: "2026-08-25T00:03:02.000Z",
    });
    attempt = allocation.attempts[0];
    assert.ok(attempt);
    await assert.rejects(
      () =>
        ledger.settleFatalAzureAbort({
          allocationId: allocation.allocationId,
          classification: "schedule-failed",
          cleanup: settledAttemptCleanup("2026-08-25T00:03:02.000Z"),
          expectedAllocationRevision: allocation.revision,
          expectedAttemptRevision: attempt.revision,
          finalCostUsdCents: 25,
          ordinal: 1,
          settledAt: "2026-08-25T00:03:02.000Z",
        }),
      hasCode("precondition-failed"),
    );
    assert.deepEqual(ledger.getCounterSnapshot("azure", "2026-08-25"), {
      activeReservations: 1,
      accountedDailyCostUsdCents: 100,
    });
  });

  it("requires schedule evidence at least as fresh as the ready runner observation", async () => {
    const ledger = initialisedLedger();
    const allocation = await acceptedWithCheckRun(ledger, acceptance(62));
    const reserved = await ledger.reserveProviderAttempt(azureAttempt(allocation));
    assert.equal(reserved.outcome, "reserved");
    if (reserved.outcome !== "reserved") return;
    const added = await ledger.addPhysicalGeneration(
      generationRequest({
        allocationId: allocation.allocationId,
        createdAt: "2026-08-25T00:02:30.000Z",
        expectedAttemptRevision: reserved.attempt.revision,
      }),
    );
    assert.equal(added.outcome, "added");
    if (added.outcome !== "added") return;
    const ready = readyGenerationState(added.generation, "2026-08-25T00:03:00.000Z");
    const schedule = ready.schedule;
    assert.ok(schedule);
    await assert.rejects(
      () =>
        ledger.updatePhysicalGeneration({
          allocationId: allocation.allocationId,
          attemptOrdinal: 1,
          expectedRevision: added.generation.revision,
          generationNumber: 1,
          state: {
            ...ready,
            schedule: {
              ...schedule,
              acceptedAt: "2026-08-25T00:02:58.000Z",
              lastCheckedAt: "2026-08-25T00:02:59.999Z",
            },
          },
          updatedAt: "2026-08-25T00:03:00.000Z",
        }),
      hasCode("precondition-failed"),
    );
  });

  it("persists immutable branch evidence and reports mismatches as conflict", async () => {
    const ledger = initialisedLedger();
    const branch = acceptance(1).evidence.trust.approvedBranch;
    assert.equal(await ledger.recordInitial(branch), "recorded");
    assert.equal(await ledger.recordInitial(structuredClone(branch)), "matched");
    assert.equal(
      await ledger.recordInitial({
        ...branch,
        commitSha: "fedcba9876543210fedcba9876543210fedcba98",
      }),
      "conflict",
    );
    assert.deepEqual(
      await ledger.load({ repositoryId: branch.repositoryId, runId: branch.runId }),
      branch,
    );
  });

  it("stores a monotonic reconciler heartbeat and fails closed when its foundation row vanishes", async () => {
    const ledger = initialisedLedger();
    assert.equal(await ledger.getReconcilerHeartbeat(), null);
    const first = await ledger.recordReconcilerHeartbeat({
      lastSucceededAt: "2026-08-25T12:00:00.000Z",
    });
    assert.equal(
      (
        await ledger.recordReconcilerHeartbeat({
          lastSucceededAt: "2026-08-25T12:00:00.000Z",
        })
      ).revision,
      first.revision,
    );
    await assert.rejects(
      () => ledger.recordReconcilerHeartbeat({ lastSucceededAt: "2026-08-25T11:59:59.999Z" }),
      hasCode("precondition-failed"),
    );
    ledger.unsafeDeleteHeartbeatRow();
    await assert.rejects(
      () => ledger.getReconcilerHeartbeat(),
      hasCode("authoritative-state-corrupt"),
    );
  });

  it("abandons only stale unassigned work with no provider hold and preserves truthful evidence", async () => {
    const ledger = initialisedLedger();
    const accepted = (await ledger.acceptAllocation(acceptance(70))).allocation;
    const request = {
      abandonedAt: "2026-08-25T00:15:00.000Z",
      allocationId: accepted.allocationId,
      expectedRevision: accepted.revision,
      reason: "controller-progress-timeout",
    } as const;
    await assert.rejects(
      () =>
        ledger.abandonUnassignedAllocation({ ...request, abandonedAt: "2026-08-25T00:14:59.999Z" }),
      hasCode("precondition-failed"),
    );
    ledger.failAfterNextCommit();
    const abandoned = await ledger.abandonUnassignedAllocation(request);
    const exact = await ledger.abandonUnassignedAllocation(request);
    assert.equal(exact.revision, abandoned.revision);
    assert.equal(abandoned.lifecycleState, "ended");
    assert.deepEqual(abandoned.cleanup.terminalEvidence, {
      concludedAt: request.abandonedAt,
      conclusion: "never_started",
      source: "allocation-never-returned",
    });
    assert.equal(abandoned.abandonment?.reason, "controller-progress-timeout");
    assert.deepEqual(lifecycleCheckRunSnapshot(abandoned), {
      allocationId: abandoned.allocationId,
      cleanupResult: "succeeded",
      durationSeconds: 900,
      estimatedCostUsdCents: 0,
      fallbackUsed: false,
      headSha: SHA,
      provider: null,
      revision: 5,
      stage: "ended",
      workloadOutcome: "never-started",
    });

    const heldLedger = initialisedLedger();
    let held = await acceptedWithCheckRun(heldLedger, acceptance(71));
    const reserved = await heldLedger.reserveProviderAttempt(azureAttempt(held));
    assert.equal(reserved.outcome, "reserved");
    held = reserved.allocation;
    await assert.rejects(
      () =>
        heldLedger.abandonUnassignedAllocation({
          abandonedAt: "2026-08-25T00:15:00.000Z",
          allocationId: held.allocationId,
          expectedRevision: held.revision,
          reason: "controller-progress-timeout",
        }),
      hasCode("precondition-failed"),
    );
  });

  it("paginates every reconciliation-open allocation and validates hidden ended state", async () => {
    const ledger = initialisedLedger();
    const first = (await ledger.acceptAllocation(acceptance(80))).allocation;
    const second = (await ledger.acceptAllocation(acceptance(81))).allocation;
    const firstPage = await ledger.listOpenAllocations({ pageSize: 1 });
    assert.equal(firstPage.allocations.length, 1);
    assert.notEqual(firstPage.continuationToken, null);
    if (firstPage.continuationToken === null) throw new Error("first page had no continuation");
    const secondPage = await ledger.listOpenAllocations({
      continuationToken: firstPage.continuationToken,
      pageSize: 1,
    });
    assert.equal(secondPage.allocations.length, 1);
    assert.equal(secondPage.continuationToken, null);
    assert.deepEqual(
      new Set(
        [...firstPage.allocations, ...secondPage.allocations].map((entry) => entry.allocationId),
      ),
      new Set([first.allocationId, second.allocationId]),
    );

    ledger.unsafeMutateAllocation(first.allocationId, (current) => ({
      ...current,
      lifecycleState: "ended" as const,
      abandonment: null,
      stop: null,
    }));
    await assert.rejects(
      () => ledger.listOpenAllocations({ pageSize: 50 }),
      hasCode("authoritative-state-corrupt"),
    );
  });
});

function initialisedLedger(): InMemoryAllocationLedger {
  return new InMemoryAllocationLedger(createInitialisedInMemoryLedgerStore(FOUNDATION), FOUNDATION);
}

function acceptance(
  sequence: number,
  backupChoice: "Keep going" | "Save money" = "Keep going",
  acceptedAt = DAY_ONE,
  profile: "linux-x64-standard" | "linux-x64-large" = "linux-x64-large",
): AcceptAllocationRequest {
  const runId = String(8000 + sequence);
  const checkRunId = String(9000 + sequence);
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
      request: { backupChoice, profile },
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
          jobId: String(10_000 + sequence),
          jobKey: "allocate-example-build",
          reusableWorkflow: {
            commitSha: REUSABLE_SHA,
            path: ".github/workflows/allocate.yml",
            repository: { name: "Switchyard", owner: "example-org" },
          },
        },
        identity,
        mappingPointer: "example-workload/example-build",
        ownerActorId: "900000001",
        repository: {
          id: "900000002",
          name: "example-workload",
          owner: "example-org",
        },
        workload: {
          backupChoice,
          blacksmithRunnerLabel:
            profile === "linux-x64-standard"
              ? "blacksmith-2vcpu-ubuntu-2404"
              : "blacksmith-4vcpu-ubuntu-2404",
          jobKey: "example-build",
          jobName: "Example approved build",
          production: true,
          profile,
          timeoutMinutes: 25,
        },
        workflow: { commitSha: SHA, path: ".github/workflows/ci.yml" },
      },
    },
  };
}

async function acceptedWithCheckRun(
  ledger: InMemoryAllocationLedger,
  request: AcceptAllocationRequest,
  leaseAt?: string,
): Promise<AllocationRecord> {
  const accepted = (await ledger.acceptAllocation(request)).allocation;
  const acquiredAt = leaseAt ?? nextInstant(request.acceptedAt, 1_000);
  const lease = await ledger.acquireCheckRunCreationLease({
    ...accepted.checkRunCreation.key,
    acquiredAt,
    leaseExpiresAt: nextInstant(acquiredAt, 120_000),
    leaseOwner: "worker-1",
  });
  assert.equal(lease.outcome, "acquired");
  if (lease.outcome !== "acquired") throw new Error("lease not acquired");
  return ledger.completeCheckRunCreation({
    allocationId: accepted.allocationId,
    checkRunId: String(7000 + Number(accepted.identity.run_id)),
    completedAt: acquiredAt,
    leaseOwner: lease.leaseOwner,
    leaseRevision: lease.leaseRevision,
  });
}

function azureAttempt(
  allocation: AllocationRecord,
  options: { readonly attemptedAt?: string; readonly cost?: number; readonly day?: string } = {},
): ReserveProviderAttemptRequest {
  const day = options.day ?? "2026-08-25";
  const attemptedAt = options.attemptedAt ?? `${day}T00:00:02.000Z`;
  return {
    allocationId: allocation.allocationId,
    attemptedAt,
    deadlines: {
      absoluteExpiry: nextInstant(allocation.createdAt, 45 * 60_000),
      computeDeadline: nextInstant(allocation.createdAt, 40 * 60_000),
      latestSafeStart: nextInstant(allocation.createdAt, 10 * 60_000),
    },
    expectedAllocationRevision: allocation.revision,
    ordinal: 1,
    provider: "azure",
    worstCaseCostUsdCents: options.cost ?? 100,
  };
}

function blacksmithAttempt(allocation: AllocationRecord): ReserveProviderAttemptRequest {
  return {
    allocationId: allocation.allocationId,
    attemptedAt: "2026-08-25T00:04:00.000Z",
    deadlines: null,
    expectedAllocationRevision: allocation.revision,
    ordinal: 2,
    provider: "blacksmith",
    worstCaseCostUsdCents: 100,
  };
}

async function assignedAzureGeneration(
  ledger: InMemoryAllocationLedger,
  sequence: number,
): Promise<AllocationRecord> {
  let allocation = await acceptedWithCheckRun(ledger, acceptance(sequence));
  const reserved = await ledger.reserveProviderAttempt(azureAttempt(allocation));
  assert.equal(reserved.outcome, "reserved");
  if (reserved.outcome !== "reserved") throw new Error("Azure was not reserved");
  const added = await ledger.addPhysicalGeneration(
    generationRequest({
      allocationId: allocation.allocationId,
      createdAt: "2026-08-25T00:02:30.000Z",
      expectedAttemptRevision: reserved.attempt.revision,
    }),
  );
  assert.equal(added.outcome, "added");
  if (added.outcome !== "added") throw new Error("generation was not added");
  allocation = await ledger.updatePhysicalGeneration({
    allocationId: allocation.allocationId,
    attemptOrdinal: 1,
    expectedRevision: added.generation.revision,
    generationNumber: 1,
    state: readyGenerationState(added.generation, "2026-08-25T00:03:00.000Z"),
    updatedAt: "2026-08-25T00:03:00.000Z",
  });
  const attempt = allocation.attempts[0];
  assert.ok(attempt);
  allocation = await ledger.markProviderAttemptSucceeded({
    allocationId: allocation.allocationId,
    expectedAllocationRevision: allocation.revision,
    expectedAttemptRevision: attempt.revision,
    ordinal: 1,
    succeededAt: "2026-08-25T00:03:01.000Z",
  });
  const finalGeneration = allocation.attempts[0]?.physicalGenerations[0];
  assert.ok(finalGeneration?.schedule);
  allocation = await ledger.updatePhysicalGeneration({
    allocationId: allocation.allocationId,
    attemptOrdinal: 1,
    expectedRevision: finalGeneration.revision,
    generationNumber: 1,
    state: {
      ...generationState(finalGeneration),
      schedule: { ...finalGeneration.schedule, lastCheckedAt: "2026-08-25T00:03:02.000Z" },
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
      runnerRegistrationId: "551001",
      runnerOnline: true,
      runnerLabel: azureRunnerLabelForAllocation(allocation.allocationId),
    },
    expectedAllocationRevision: allocation.revision,
  });
}

async function successfulUnassignedAzureGeneration(
  ledger: InMemoryAllocationLedger,
  sequence: number,
): Promise<AllocationRecord> {
  let allocation = await acceptedWithCheckRun(ledger, acceptance(sequence));
  const reserved = await ledger.reserveProviderAttempt(azureAttempt(allocation));
  assert.equal(reserved.outcome, "reserved");
  if (reserved.outcome !== "reserved") throw new Error("Azure was not reserved");
  const added = await ledger.addPhysicalGeneration(
    generationRequest({
      allocationId: allocation.allocationId,
      createdAt: "2026-08-25T00:02:30.000Z",
      expectedAttemptRevision: reserved.attempt.revision,
    }),
  );
  assert.equal(added.outcome, "added");
  if (added.outcome !== "added") throw new Error("generation was not added");
  allocation = await ledger.updatePhysicalGeneration({
    allocationId: allocation.allocationId,
    attemptOrdinal: 1,
    expectedRevision: added.generation.revision,
    generationNumber: 1,
    state: readyGenerationState(added.generation, "2026-08-25T00:03:00.000Z"),
    updatedAt: "2026-08-25T00:03:00.000Z",
  });
  const attempt = allocation.attempts[0];
  assert.ok(attempt);
  return ledger.markProviderAttemptSucceeded({
    allocationId: allocation.allocationId,
    expectedAllocationRevision: allocation.revision,
    expectedAttemptRevision: attempt.revision,
    ordinal: 1,
    succeededAt: "2026-08-25T00:03:01.000Z",
  });
}

async function blacksmithReadyAllocation(
  ledger: InMemoryAllocationLedger,
  sequence: number,
): Promise<AllocationRecord> {
  const allocation = await azureUnavailableAllocation(ledger, sequence);
  const blacksmith = await ledger.reserveProviderAttempt(blacksmithAttempt(allocation));
  assert.equal(blacksmith.outcome, "reserved");
  if (blacksmith.outcome !== "reserved") throw new Error("Blacksmith was not reserved");
  return ledger.markProviderAttemptSucceeded({
    allocationId: allocation.allocationId,
    expectedAllocationRevision: blacksmith.allocation.revision,
    expectedAttemptRevision: blacksmith.attempt.revision,
    ordinal: 2,
    succeededAt: "2026-08-25T00:04:01.000Z",
  });
}

async function assignedBlacksmithAllocation(
  ledger: InMemoryAllocationLedger,
  sequence: number,
): Promise<AllocationRecord> {
  const ready = await blacksmithReadyAllocation(ledger, sequence);
  return ledger.assignRunner({
    allocationId: ready.allocationId,
    assignment: {
      assignedAt: "2026-08-25T00:05:00.000Z",
      attemptOrdinal: 2,
      provider: "blacksmith",
      runnerLabel: "blacksmith-4vcpu-ubuntu-2404",
    },
    expectedAllocationRevision: ready.revision,
  });
}

async function azureUnavailableAllocation(
  ledger: InMemoryAllocationLedger,
  sequence: number,
): Promise<AllocationRecord> {
  let allocation = await acceptedWithCheckRun(ledger, acceptance(sequence));
  const azure = await ledger.reserveProviderAttempt(azureAttempt(allocation));
  assert.equal(azure.outcome, "reserved");
  if (azure.outcome !== "reserved") throw new Error("Azure was not reserved");
  allocation = await ledger.settleUnavailableProviderAttempt({
    allocationId: allocation.allocationId,
    classification: "readiness-timeout",
    cleanup: settledAttemptCleanup("2026-08-25T00:03:00.000Z"),
    expectedAllocationRevision: azure.allocation.revision,
    expectedAttemptRevision: azure.attempt.revision,
    finalCostUsdCents: 10,
    ordinal: 1,
    settledAt: "2026-08-25T00:03:00.000Z",
  });
  return allocation;
}

async function allocationWithRequestedSchedule(
  ledger: InMemoryAllocationLedger,
  sequence: number,
): Promise<AllocationRecord> {
  let allocation = await acceptedWithCheckRun(ledger, acceptance(sequence));
  const reserved = await ledger.reserveProviderAttempt(azureAttempt(allocation));
  assert.equal(reserved.outcome, "reserved");
  if (reserved.outcome !== "reserved") throw new Error("Azure was not reserved");
  const added = await ledger.addPhysicalGeneration(
    generationRequest({
      allocationId: allocation.allocationId,
      createdAt: "2026-08-25T00:02:30.000Z",
      expectedAttemptRevision: reserved.attempt.revision,
    }),
  );
  assert.equal(added.outcome, "added");
  if (added.outcome !== "added") throw new Error("generation was not added");
  const initialZone = added.generation.zoneDeployments[0];
  assert.ok(initialZone);
  allocation = await ledger.updatePhysicalGeneration({
    allocationId: allocation.allocationId,
    attemptOrdinal: 1,
    expectedRevision: added.generation.revision,
    generationNumber: 1,
    state: {
      cleanup: added.generation.cleanup,
      jitMintIntent: null,
      launchPrerequisites: null,
      managedRunCommand: null,
      operationLease: null,
      providerVmId: null,
      readyAt: null,
      runnerReadiness: null,
      runnerRegistrationId: null,
      schedule: {
        acceptedAt: null,
        requestCorrelationId: "schedule-correlation-1",
        deadlineType: "CompleteBy",
        lastCheckedAt: "2026-08-25T00:02:30.000Z",
        providerOperationId: "schedule-1",
        requestedDeadline: "2026-08-25T00:40:00.000Z",
        status: "requested",
        targetVmResourceId:
          "/subscriptions/test/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm1",
      },
      state: "provisioning",
      vmResourceId:
        "/subscriptions/test/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm1",
      zoneDeployments: [
        {
          ...initialZone,
          completedAt: "2026-08-25T00:02:30.000Z",
          outcome: "vm-created",
          vmResourceId:
            "/subscriptions/test/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm1",
        },
      ],
    },
    updatedAt: "2026-08-25T00:02:30.000Z",
  });
  return allocation;
}

function settledAttemptCleanup(settledAt: string) {
  return {
    phase: "settled",
    providerResourcesSettled: true,
    runnerRegistrationSettled: true,
    settledAt,
  } as const;
}

function settledAllocationCleanup(terminalEvidence: TerminalEvidence) {
  return {
    phase: "settled",
    providerResourcesSettled: true,
    runnerRegistrationSettled: true,
    settledAt: terminalEvidence.concludedAt,
    terminalEvidence,
  } as const;
}

function concludedCheckRunDelivery(
  allocation: AllocationRecord,
): AllocationRecord["checkRunCreation"]["delivery"] {
  const lifecycle = allocation.checkRunCreation.delivery.lifecycle;
  if (lifecycle.phase === "not-created") throw new Error("Check Run was not created");
  return {
    lifecycle: {
      allocationId: allocation.allocationId,
      checkRunId: lifecycle.checkRunId,
      headSha: lifecycle.headSha,
      phase: "concluded",
      publishedRevision: lifecycle.publishedRevision + 1,
      stage: "ended",
    },
    retry: null,
  };
}

function inProgressCheckRunDelivery(
  allocation: AllocationRecord,
): AllocationRecord["checkRunCreation"]["delivery"] {
  const lifecycle = allocation.checkRunCreation.delivery.lifecycle;
  if (lifecycle.phase === "not-created") throw new Error("Check Run was not created");
  return {
    lifecycle: {
      allocationId: allocation.allocationId,
      checkRunId: lifecycle.checkRunId,
      headSha: lifecycle.headSha,
      phase: "in-progress",
      publishedRevision: lifecycle.publishedRevision + 1,
      stage: "runner-ready",
    },
    retry: null,
  };
}

function changedAttemptAdmissions(
  request: ReserveProviderAttemptRequest,
): readonly ReserveProviderAttemptRequest[] {
  return [
    { ...request, provider: "azure" },
    { ...request, ordinal: 1 },
    { ...request, attemptedAt: "2026-08-25T00:04:00.001Z" },
    {
      ...request,
      deadlines: {
        absoluteExpiry: "2026-08-25T00:45:00.000Z",
        computeDeadline: "2026-08-25T00:40:00.000Z",
        latestSafeStart: "2026-08-25T00:10:00.000Z",
      },
    },
    { ...request, worstCaseCostUsdCents: request.worstCaseCostUsdCents + 1 },
  ];
}

function nextInstant(instant: string, milliseconds: number): string {
  return new Date(Date.parse(instant) + milliseconds).toISOString();
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
  readyAt: string,
): PhysicalGenerationState {
  const vmResourceId =
    "/subscriptions/test/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm1";
  const runCommandId = `${vmResourceId}/runCommands/launch-jit-g1`;
  const initialZone = generation.zoneDeployments[0];
  assert.ok(initialZone);
  return {
    ...generationState(generation),
    jitMintIntent: {
      intentId: "sy-aaaaaaaaaaaaaaaaaaaaaaaa-g1-jit-mint",
      jitDeploymentId:
        "/subscriptions/test/resourceGroups/rg/providers/Microsoft.Resources/deployments/sy-aaaaaaaaaaaaaaaaaaaaaaaa-g1-jit",
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
      managedRunCommandId: runCommandId,
      requestedAt: readyAt,
    },
    providerVmId: "provider-vm-1",
    readyAt,
    runnerReadiness: { checkedAt: readyAt, idle: true, online: true },
    runnerRegistrationId: "551001",
    schedule: {
      acceptedAt: readyAt,
      requestCorrelationId: "schedule-correlation-1",
      deadlineType: "CompleteBy",
      lastCheckedAt: readyAt,
      providerOperationId: "schedule-1",
      requestedDeadline: "2026-08-25T00:40:00.000Z",
      status: "accepted",
      targetVmResourceId: vmResourceId,
    },
    state: "ready",
    vmResourceId,
    zoneDeployments: [
      {
        ...initialZone,
        completedAt: readyAt,
        outcome: "vm-created",
        vmResourceId,
      },
    ],
  };
}

function generationRequest(input: {
  readonly allocationId: string;
  readonly createdAt: string;
  readonly expectedAttemptRevision: string;
}) {
  return {
    ...input,
    attemptOrdinal: 1,
    availabilityZone: "1",
    baseDeploymentId:
      "/subscriptions/test/providers/Microsoft.Resources/deployments/switchyard-g1-zone-1",
    baseDeploymentName: "switchyard-g1-zone-1",
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
    childDeploymentId:
      "/subscriptions/test/resourceGroups/rg/providers/Microsoft.Resources/deployments/switchyard-allocation-g1",
    generationNumber: 1,
    location: "uksouth",
    reservedIncrementalCostUsdCents: 0,
    resourceGroupId: "/subscriptions/test/resourceGroups/rg",
    resourceGroupName: "rg",
    vmSize: "Standard_D8ds_v6",
  } as const;
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof AllocationLedgerError && error.code === code;
}

function hasValidation(path: string, detail: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof ContractValidationError &&
    error.path === path &&
    error.message === `${path}: ${detail}`;
}
