import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  ListTableEntitiesOptions,
  TableEntityResult,
  TableEntityResultPage,
  TableTransactionResponse,
  TransactionAction,
} from "@azure/data-tables";
import type {
  AcceptAllocationRequest,
  AllocationControlLedger,
  AllocationRecord,
  PhysicalGeneration,
  PhysicalGenerationState,
  ReserveProviderAttemptRequest,
  TerminalEvidence,
} from "@switchyard/core";
import { azureRunnerLabelForAllocation } from "@switchyard/core";
import {
  createInitialisedInMemoryLedgerStore,
  InMemoryAllocationLedger,
} from "@switchyard/core/testing";
import {
  AZURE_TABLE_LEDGER_PARTITION_KEY,
  AZURE_TABLE_LEDGER_SCHEMA_VERSION,
  type AzureLedgerInstanceEvidence,
  AzureTableAllocationLedger,
  type AzureTableClientPort,
  createAzureTableAllocationLedger,
} from "../src/index.js";

const DAY_ONE = "2026-08-25T00:00:00.000Z";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const REUSABLE_SHA = "89abcdef0123456789abcdef0123456789abcdef";
const FOUNDATION = {
  initialisedAt: DAY_ONE,
  ledgerInstanceId: "switchyard-ledger-test-instance",
  schemaVersion: AZURE_TABLE_LEDGER_SCHEMA_VERSION,
  utcDay: "2026-08-25",
} as const;

describe("Azure Table ordered allocation ledger", () => {
  it("constructs only an explicit managed-identity HTTPS configuration", () => {
    assert.ok(
      createAzureTableAllocationLedger({
        accountName: "switchyardledger",
        ledgerInstanceId: FOUNDATION.ledgerInstanceId,
        managedIdentityClientId: "managed-identity-client-id",
        schemaVersion: AZURE_TABLE_LEDGER_SCHEMA_VERSION,
        tableName: "SwitchyardControl",
      }) instanceof AzureTableAllocationLedger,
    );
    assert.throws(
      () =>
        createAzureTableAllocationLedger({
          accountName: "https://invalid",
          ledgerInstanceId: FOUNDATION.ledgerInstanceId,
          managedIdentityClientId: "managed-identity-client-id",
          schemaVersion: AZURE_TABLE_LEDGER_SCHEMA_VERSION,
          tableName: "SwitchyardControl",
        }),
      hasCode("invalid-ledger-request"),
    );
  });

  it("fails closed unless all four fresh-bootstrap foundation rows match schema 10", async () => {
    const table = new MemoryTableClient();
    const ledger = new AzureTableAllocationLedger(table, runtimeEvidence());
    await assert.rejects(
      () => ledger.acceptAllocation(acceptance(1)),
      hasCode("authoritative-state-corrupt"),
    );

    await seedFoundation(table, FOUNDATION);
    table.deleteRow("heartbeat!reconciler");
    await assert.rejects(
      () => ledger.acceptAllocation(acceptance(1)),
      hasCode("authoritative-state-corrupt"),
    );
  });

  it("accepts immutable provider-neutral evidence once and requires a durable Check Run", async () => {
    const { ledger, table } = await initialisedLedger();
    const request = acceptance(1);
    table.failAfterNextCommit();
    const first = await ledger.acceptAllocation(request);
    assert.equal(first.acceptance, "exact-retry");
    assert.deepEqual(first.allocation.attempts, []);
    assert.equal(counter(table, "azure").activeReservations, 0);

    const retries = await Promise.all(
      Array.from({ length: 8 }, () => ledger.acceptAllocation(structuredClone(request))),
    );
    assert.equal(
      retries.every(({ acceptance }) => acceptance === "exact-retry"),
      true,
    );
    const raced = await Promise.all(
      Array.from({ length: 8 }, () => ledger.acceptAllocation(acceptance(12))),
    );
    assert.equal(raced.filter(({ acceptance }) => acceptance === "created").length, 1);
    assert.equal(raced.filter(({ acceptance }) => acceptance === "exact-retry").length, 7);
    await assert.rejects(
      () => ledger.reserveProviderAttempt(azureAttempt(first.allocation)),
      hasCode("precondition-failed"),
    );
    assert.equal(table.maximumTransactionSize(), 1);
  });

  it("atomically records Azure unavailable then Blacksmith and recovers lost responses", async () => {
    const { ledger, table } = await initialisedLedger();
    let allocation = await acceptedWithCheckRun(ledger, acceptance(2));
    const azureRequest = azureAttempt(allocation, { cost: 200 });
    const azure = await ledger.reserveProviderAttempt(azureRequest);
    assert.equal(azure.outcome, "reserved");
    if (azure.outcome !== "reserved") return;
    assert.deepEqual(counter(table, "azure"), {
      accountedDailyCostUsdCents: 200,
      activeReservations: 1,
    });
    allocation = await ledger.settleUnavailableProviderAttempt({
      allocationId: allocation.allocationId,
      classification: "management-plane-provisioning",
      cleanup: settledAttemptCleanup("2026-08-25T00:03:00.000Z"),
      expectedAllocationRevision: azure.allocation.revision,
      expectedAttemptRevision: azure.attempt.revision,
      finalCostUsdCents: 25,
      ordinal: 1,
      settledAt: "2026-08-25T00:03:00.000Z",
    });
    assert.deepEqual(counter(table, "azure"), {
      accountedDailyCostUsdCents: 25,
      activeReservations: 0,
    });

    const fallbackRequest = blacksmithAttempt(allocation);
    table.failAfterNextCommit();
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
    await Promise.all(
      Array.from({ length: 8 }, () => ledger.reserveProviderAttempt(fallbackRequest)),
    );
    assert.deepEqual(counter(table, "blacksmith"), {
      accountedDailyCostUsdCents: 100,
      activeReservations: 1,
    });
    assert.equal(table.maximumTransactionSize() <= 4, true);
    assert.equal(table.allTransactionsUseOnePartition(), true);
  });

  it("durably records an Azure capacity refusal without moving its counters", async () => {
    const { ledger, table } = await initialisedLedger();
    const allocation = await acceptedWithCheckRun(ledger, acceptance(13));
    table.mutateDocument("control!azure", (document) => ({
      ...document,
      activeReservations: 3,
    }));
    table.setProperty("control!azure", "activeReservations", 3);
    const result = await ledger.reserveProviderAttempt(azureAttempt(allocation));
    assert.equal(result.outcome, "capacity-unavailable");
    if (result.outcome !== "capacity-unavailable") return;
    assert.equal(result.constraint, "concurrency-limit");
    assert.equal(result.attempt.ordinal, 1);
    assert.equal(result.attempt.reservation.state, "not-held");
    assert.deepEqual(counter(table, "azure"), {
      accountedDailyCostUsdCents: 0,
      activeReservations: 3,
    });
  });

  it("fences a final Blacksmith capacity refusal through conflict, lost response and exact retry", async () => {
    const first = await initialisedLedger();
    let allocation = await azureUnavailableAllocation(first.ledger, 16);
    setControlCounters(first.table, "blacksmith", {
      activeReservations: 3,
      accountedDailyCostUsdCents: 400,
    });
    const request = blacksmithAttempt(allocation);
    first.table.conflictBeforeNextCommit();
    first.table.failAfterNextCommit();
    const refused = await first.ledger.reserveProviderAttempt(request);
    assert.equal(refused.outcome, "capacity-unavailable");
    if (refused.outcome !== "capacity-unavailable") return;
    assert.equal(refused.constraint, "concurrency-limit");
    assert.equal(refused.reservation, "exact-retry");
    assert.equal(first.table.injectedTransactionConflicts, 1);
    assert.equal(refused.attempt.provider, "blacksmith");
    assert.equal(refused.attempt.ordinal, 2);
    assert.equal(refused.attempt.reservation.state, "not-held");
    assert.equal(refused.attempt.cleanup.phase, "settled");
    const retries = await Promise.all(
      Array.from({ length: 8 }, () =>
        first.ledger.reserveProviderAttempt(structuredClone(request)),
      ),
    );
    assert.equal(
      retries.every(
        (result) =>
          result.outcome === "capacity-unavailable" && result.reservation === "exact-retry",
      ),
      true,
    );
    assert.deepEqual(counter(first.table, "blacksmith"), {
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
    const stopped = await first.ledger.stopAllocation(stopRequest);
    assert.equal(stopped.stop?.reason, "all-providers-unavailable");
    assert.equal(stopped.lifecycleState, "ended");
    assert.equal((await first.ledger.stopAllocation(stopRequest)).revision, stopped.revision);
    const transactionCount = first.table.transactions.length;
    const delayedRefusalRetry = await first.ledger.reserveProviderAttempt(request);
    assert.equal(delayedRefusalRetry.outcome, "capacity-unavailable");
    assert.equal(delayedRefusalRetry.reservation, "exact-retry");
    assert.equal(delayedRefusalRetry.allocation.revision, stopped.revision);
    assert.equal(first.table.transactions.length, transactionCount);
    assert.deepEqual(counter(first.table, "blacksmith"), {
      activeReservations: 3,
      accountedDailyCostUsdCents: 400,
    });

    const boundary = await initialisedLedger();
    const boundaryAllocation = await azureUnavailableAllocation(boundary.ledger, 17);
    setControlCounters(boundary.table, "blacksmith", {
      activeReservations: 2,
      accountedDailyCostUsdCents: 400,
    });
    const admitted = await boundary.ledger.reserveProviderAttempt(
      blacksmithAttempt(boundaryAllocation),
    );
    assert.equal(admitted.outcome, "reserved");
    assert.deepEqual(counter(boundary.table, "blacksmith"), {
      activeReservations: 3,
      accountedDailyCostUsdCents: 500,
    });
  });

  it("stops Save money and rejects an ordered fallback replay", async () => {
    const { ledger } = await initialisedLedger();
    let allocation = await acceptedWithCheckRun(ledger, acceptance(3, "Save money"));
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
    const stopped = await ledger.stopAllocation({
      allocationId: allocation.allocationId,
      expectedRevision: allocation.revision,
      reason: "save-money",
      stoppedAt: "2026-08-25T00:04:00.000Z",
    });
    assert.equal(stopped.lifecycleState, "ended");
  });

  it("writes a final assignment once without reserving again and conflicts on reuse", async () => {
    const { ledger, table } = await initialisedLedger();
    let allocation = await blacksmithReady(ledger, 4);
    const before = counter(table, "blacksmith");
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
      expectedAllocationRevision: "stale-exact-retry",
    });
    assert.deepEqual(exact.runnerAssignment, assignment);
    assert.deepEqual(counter(table, "blacksmith"), before);
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

  it("rejects premature Check Run conclusion before any active provider-hold transaction", async () => {
    for (const provider of ["azure", "blacksmith"] as const) {
      const { ledger, table } = await initialisedLedger();
      let allocation: AllocationRecord;
      if (provider === "azure") {
        const accepted = await acceptedWithCheckRun(ledger, acceptance(40));
        const reserved = await ledger.reserveProviderAttempt(azureAttempt(accepted));
        assert.equal(reserved.outcome, "reserved");
        if (reserved.outcome !== "reserved") throw new Error("Azure was not reserved");
        allocation = reserved.allocation;
      } else {
        allocation = await blacksmithReady(ledger, 41);
      }
      const before = table.snapshot();
      const counters = counter(table, provider);
      const transactionCount = table.transactions.length;
      const premature = {
        allocationId: allocation.allocationId,
        expectedRevision: allocation.revision,
        patch: { checkRunDelivery: concludedCheckRunDelivery(allocation) },
        updatedAt: nextInstant(allocation.updatedAt, 1_000),
      } as const;

      table.failAfterNextCommit();
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
      assert.deepEqual(table.snapshot(), before);
      assert.deepEqual(counter(table, provider), counters);
      assert.equal(table.transactions.length, transactionCount);

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
      assert.deepEqual(counter(table, provider), counters);
      assert.equal(table.transactions.length, transactionCount + 1);

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
      const authoritativeState = table.snapshot();
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
      assert.deepEqual(table.snapshot(), authoritativeState);
      assert.deepEqual(counter(table, provider), counters);
      assert.equal(table.transactions.length, transactionCount + 1);
    }
  });

  it("matches delayed reservation retries only to immutable attempt admission data", async () => {
    const stopped = await initialisedLedger();
    let stoppedAllocation = await acceptedWithCheckRun(
      stopped.ledger,
      acceptance(43, "Save money"),
    );
    const stoppedRequest = azureAttempt(stoppedAllocation);
    const azure = await stopped.ledger.reserveProviderAttempt(stoppedRequest);
    assert.equal(azure.outcome, "reserved");
    if (azure.outcome !== "reserved") throw new Error("Azure was not reserved");
    stoppedAllocation = await stopped.ledger.settleUnavailableProviderAttempt({
      allocationId: stoppedAllocation.allocationId,
      classification: "zones-exhausted",
      cleanup: settledAttemptCleanup("2026-08-25T00:03:00.000Z"),
      expectedAllocationRevision: azure.allocation.revision,
      expectedAttemptRevision: azure.attempt.revision,
      finalCostUsdCents: 0,
      ordinal: 1,
      settledAt: "2026-08-25T00:03:00.000Z",
    });
    stoppedAllocation = await stopped.ledger.stopAllocation({
      allocationId: stoppedAllocation.allocationId,
      expectedRevision: stoppedAllocation.revision,
      reason: "save-money",
      stoppedAt: "2026-08-25T00:04:00.000Z",
    });
    const stoppedCounters = counter(stopped.table, "azure");
    const stoppedTransactionCount = stopped.table.transactions.length;
    const stoppedRetry = await stopped.ledger.reserveProviderAttempt(stoppedRequest);
    assert.equal(stoppedRetry.outcome, "reserved");
    assert.equal(stoppedRetry.reservation, "exact-retry");
    assert.equal(stoppedRetry.allocation.revision, stoppedAllocation.revision);
    assert.deepEqual(counter(stopped.table, "azure"), stoppedCounters);
    assert.equal(stopped.table.transactions.length, stoppedTransactionCount);
    const conclusionRequest = {
      allocationId: stoppedAllocation.allocationId,
      expectedRevision: stoppedAllocation.revision,
      patch: { checkRunDelivery: concludedCheckRunDelivery(stoppedAllocation) },
      updatedAt: "2026-08-25T00:04:01.000Z",
    } as const;
    stopped.table.failAfterNextCommit();
    const concluded = await stopped.ledger.updateAllocationState(conclusionRequest);
    const exactConclusion = await stopped.ledger.updateAllocationState(conclusionRequest);
    assert.equal(concluded.revision, exactConclusion.revision);
    assert.equal(exactConclusion.lifecycleState, "ended");
    assert.equal(exactConclusion.checkRunCreation.delivery.lifecycle.phase, "concluded");
    assert.equal(exactConclusion.updatedAt, stoppedAllocation.updatedAt);
    assert.deepEqual(counter(stopped.table, "azure"), stoppedCounters);
    assert.equal(stopped.table.transactions.length, stoppedTransactionCount + 1);
    const concludedState = stopped.table.snapshot();
    const concludedLifecycle = exactConclusion.checkRunCreation.delivery.lifecycle;
    if (concludedLifecycle.phase !== "concluded") throw new Error("Check Run was not concluded");
    await assert.rejects(
      () =>
        stopped.ledger.updateAllocationState({
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
    assert.deepEqual(stopped.table.snapshot(), concludedState);
    assert.deepEqual(counter(stopped.table, "azure"), stoppedCounters);
    assert.equal(stopped.table.transactions.length, stoppedTransactionCount + 1);

    const assignedLedger = await initialisedLedger();
    let assigned = await azureUnavailableAllocation(assignedLedger.ledger, 44);
    const blacksmithRequest = blacksmithAttempt(assigned);
    const blacksmith = await assignedLedger.ledger.reserveProviderAttempt(blacksmithRequest);
    assert.equal(blacksmith.outcome, "reserved");
    if (blacksmith.outcome !== "reserved") throw new Error("Blacksmith was not reserved");
    assigned = await assignedLedger.ledger.markProviderAttemptSucceeded({
      allocationId: assigned.allocationId,
      expectedAllocationRevision: blacksmith.allocation.revision,
      expectedAttemptRevision: blacksmith.attempt.revision,
      ordinal: 2,
      succeededAt: "2026-08-25T00:04:30.000Z",
    });
    assigned = await assignedLedger.ledger.assignRunner({
      allocationId: assigned.allocationId,
      assignment: {
        assignedAt: "2026-08-25T00:05:00.000Z",
        attemptOrdinal: 2,
        provider: "blacksmith",
        runnerLabel: "blacksmith-4vcpu-ubuntu-2404",
      },
      expectedAllocationRevision: assigned.revision,
    });
    const assignedCounters = counter(assignedLedger.table, "blacksmith");
    const assignedTransactionCount = assignedLedger.table.transactions.length;
    const assignedRetry = await assignedLedger.ledger.reserveProviderAttempt(blacksmithRequest);
    assert.equal(assignedRetry.outcome, "reserved");
    assert.equal(assignedRetry.reservation, "exact-retry");
    assert.equal(assignedRetry.allocation.revision, assigned.revision);
    assert.deepEqual(counter(assignedLedger.table, "blacksmith"), assignedCounters);
    assert.equal(assignedLedger.table.transactions.length, assignedTransactionCount);

    assigned = await assignedLedger.ledger.updateAllocationState({
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
    assigned = await assignedLedger.ledger.settleFinalProviderAttempt({
      allocationId: assigned.allocationId,
      cleanup: finalAttempt.cleanup,
      expectedAllocationRevision: assigned.revision,
      expectedAttemptRevision: finalAttempt.revision,
      finalCostUsdCents: 75,
      ordinal: 2,
      settledAt: "2026-08-25T00:07:01.000Z",
    });
    const settledCounters = counter(assignedLedger.table, "blacksmith");
    const settledTransactionCount = assignedLedger.table.transactions.length;
    const settledRetry = await assignedLedger.ledger.reserveProviderAttempt(blacksmithRequest);
    assert.equal(settledRetry.outcome, "reserved");
    assert.equal(settledRetry.reservation, "exact-retry");
    assert.equal(settledRetry.allocation.revision, assigned.revision);
    assert.deepEqual(counter(assignedLedger.table, "blacksmith"), settledCounters);
    assert.equal(assignedLedger.table.transactions.length, settledTransactionCount);

    for (const changed of changedAttemptAdmissions(blacksmithRequest)) {
      await assert.rejects(
        () => assignedLedger.ledger.reserveProviderAttempt(changed),
        hasCode("allocation-conflict"),
      );
    }
    assert.deepEqual(counter(assignedLedger.table, "blacksmith"), settledCounters);
    assert.equal(assignedLedger.table.transactions.length, settledTransactionCount);
  });

  it("retains Blacksmith until mapped job or workflow terminal evidence", async () => {
    const { ledger, table } = await initialisedLedger();
    let allocation = await blacksmithReady(ledger, 5);
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
    assert.equal(counter(table, "blacksmith").activeReservations, 1);

    await assert.rejects(
      () =>
        ledger.updateAllocationState({
          allocationId: allocation.allocationId,
          expectedRevision: allocation.revision,
          patch: {
            cleanup: settledAllocationCleanup({
              concludedAt: "2026-08-26T00:00:00.000Z",
              conclusion: "cancelled",
              githubJobId: "551100",
              source: "github-job",
            }),
            lifecycleState: "cleanup_pending",
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
            cleanup: settledAllocationCleanup({
              concludedAt: "2026-08-26T00:00:00.000Z",
              conclusion: "cancelled",
              repositoryId: allocation.identity.repository_id,
              runAttempt: allocation.identity.run_attempt,
              runId: "999999",
              source: "github-workflow-run",
            }),
            lifecycleState: "cleanup_pending",
          },
          updatedAt: "2026-08-26T00:00:00.000Z",
        }),
      hasCode("precondition-failed"),
    );

    allocation = await ledger.updateAllocationState({
      allocationId: allocation.allocationId,
      expectedRevision: allocation.revision,
      patch: {
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
        lifecycleState: "cleanup_pending",
      },
      updatedAt: "2026-08-26T00:00:00.000Z",
    });
    const terminalAttempt = allocation.attempts[1];
    assert.ok(terminalAttempt);
    await ledger.settleFinalProviderAttempt({
      allocationId: allocation.allocationId,
      cleanup: terminalAttempt.cleanup,
      expectedAllocationRevision: allocation.revision,
      expectedAttemptRevision: terminalAttempt.revision,
      finalCostUsdCents: 75,
      ordinal: 2,
      settledAt: "2026-08-26T00:00:01.000Z",
    });
    assert.equal(counter(table, "blacksmith").activeReservations, 0);
  });

  it("accepts job terminal evidence only for the identical durable binding", async () => {
    const { ledger } = await initialisedLedger();
    let allocation = await assignedBlacksmithAllocation(ledger, 18);
    allocation = await ledger.updateAllocationState({
      allocationId: allocation.allocationId,
      expectedRevision: allocation.revision,
      patch: { workloadBinding: { githubJobId: "551100", state: "bound" } },
      updatedAt: "2026-08-25T00:06:00.000Z",
    });
    await assert.rejects(
      () =>
        ledger.updateAllocationState({
          allocationId: allocation.allocationId,
          expectedRevision: allocation.revision,
          patch: {
            cleanup: settledAllocationCleanup({
              concludedAt: "2026-08-25T00:07:00.000Z",
              conclusion: "succeeded",
              githubJobId: "551101",
              source: "github-job",
            }),
            lifecycleState: "cleanup_pending",
          },
          updatedAt: "2026-08-25T00:07:00.000Z",
        }),
      hasCode("precondition-failed"),
    );
    const terminal = await ledger.updateAllocationState({
      allocationId: allocation.allocationId,
      expectedRevision: allocation.revision,
      patch: {
        cleanup: settledAllocationCleanup({
          concludedAt: "2026-08-25T00:07:00.000Z",
          conclusion: "succeeded",
          githubJobId: "551100",
          source: "github-job",
        }),
        lifecycleState: "cleanup_pending",
      },
      updatedAt: "2026-08-25T00:07:00.000Z",
    });
    assert.equal(terminal.cleanup.terminalEvidence?.source, "github-job");
  });

  it("preserves ETag-safe Azure generation rows and the minute-10 equality boundary", async () => {
    const { ledger, table } = await initialisedLedger();
    let allocation = await acceptedWithCheckRun(ledger, acceptance(6));
    const reserved = await ledger.reserveProviderAttempt(azureAttempt(allocation, { cost: 300 }));
    assert.equal(reserved.outcome, "reserved");
    if (reserved.outcome !== "reserved") return;
    const added = await ledger.addPhysicalGeneration(
      generationRequest({
        allocationId: allocation.allocationId,
        createdAt: "2026-08-25T00:09:59.997Z",
        expectedAttemptRevision: reserved.attempt.revision,
      }),
    );
    assert.equal(added.outcome, "added");
    if (added.outcome !== "added") return;
    allocation = await ledger.updatePhysicalGeneration({
      allocationId: allocation.allocationId,
      attemptOrdinal: 1,
      expectedRevision: added.generation.revision,
      generationNumber: 1,
      state: readyGenerationState(added.generation, "2026-08-25T00:09:59.998Z"),
      updatedAt: "2026-08-25T00:09:59.998Z",
    });
    const attempt = allocation.attempts[0];
    assert.ok(attempt);
    allocation = await ledger.markProviderAttemptSucceeded({
      allocationId: allocation.allocationId,
      expectedAllocationRevision: allocation.revision,
      expectedAttemptRevision: attempt.revision,
      ordinal: 1,
      succeededAt: "2026-08-25T00:09:59.999Z",
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
        schedule: {
          ...finalGeneration.schedule,
          lastCheckedAt: "2026-08-25T00:10:00.000Z",
        },
      },
      updatedAt: "2026-08-25T00:10:00.000Z",
    });
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
    assert.equal(
      table.rowKeys().some((row) => row.includes("generation!") && row.endsWith("!01!01")),
      true,
    );
  });

  it("atomically releases Azure counters for a cleaned fatal pre-assignment abort", async () => {
    const { ledger, table } = await initialisedLedger();
    let allocation = await successfulUnassignedAzureGeneration(ledger, 70);
    let attempt = allocation.attempts[0];
    assert.ok(attempt);
    allocation = await ledger.beginFatalAzureAbort({
      allocationId: allocation.allocationId,
      classification: "lost-runner-before-assignment",
      expectedAllocationRevision: allocation.revision,
      expectedAttemptRevision: attempt.revision,
      ordinal: 1,
      recordedAt: "2026-08-25T00:03:02.000Z",
    });
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
    table.failAfterNextCommit();
    const aborted = await ledger.settleFatalAzureAbort(request);
    assert.equal(aborted.lifecycleState, "ended");
    assert.equal(aborted.attempts[0]?.reservation.settlementKind, "aborted");
    assert.equal((await ledger.settleFatalAzureAbort(request)).revision, aborted.revision);
    assert.deepEqual(counter(table, "azure"), {
      activeReservations: 0,
      accountedDailyCostUsdCents: 25,
    });
  });

  it("keeps allowance by admission day while concurrency remains provider-wide", async () => {
    const { ledger, table } = await initialisedLedger();
    const dayOne = await acceptedWithCheckRun(ledger, acceptance(7));
    const first = await ledger.reserveProviderAttempt(azureAttempt(dayOne, { cost: 200 }));
    assert.equal(first.outcome, "reserved");

    const dayTwo = await acceptedWithCheckRun(
      ledger,
      acceptance(8, "Keep going", "2026-08-26T00:00:00.000Z"),
      "2026-08-26T00:00:01.000Z",
    );
    const second = await ledger.reserveProviderAttempt(
      azureAttempt(dayTwo, {
        attemptedAt: "2026-08-26T00:00:02.000Z",
        cost: 300,
        day: "2026-08-26",
      }),
    );
    assert.equal(second.outcome, "reserved");
    assert.equal(counter(table, "azure").activeReservations, 2);
    assert.equal(counter(table, "azure").accountedDailyCostUsdCents, 300);
    assert.equal(historyCost(table, "azure", "2026-08-25"), 200);
  });

  it("fails corrupt counters and impossible row state without creating fallback evidence", async () => {
    const { ledger, table } = await initialisedLedger();
    const allocation = await acceptedWithCheckRun(ledger, acceptance(9));
    table.mutateDocument("control!azure", (document) => ({
      ...document,
      activeReservations: 4,
    }));
    table.setProperty("control!azure", "activeReservations", 4);
    await assert.rejects(
      () => ledger.reserveProviderAttempt(azureAttempt(allocation)),
      hasCode("authoritative-state-corrupt"),
    );
    assert.equal(
      table.rowKeys().some((row) => row.startsWith("attempt!")),
      false,
    );

    const second = await initialisedLedger();
    const impossible = (await second.ledger.acceptAllocation(acceptance(14))).allocation;
    const rowKey = `allocation!${impossible.allocationId}`;
    second.table.mutateDocument(rowKey, (document) => ({
      ...document,
      lifecycleState: "assigned",
    }));
    second.table.setProperty(rowKey, "lifecycleState", "assigned");
    await assert.rejects(
      () => second.ledger.getAllocation(impossible.allocationId),
      hasCode("authoritative-state-corrupt"),
    );
  });

  it("rejects missing, extra, duplicate and malformed nested schema-10 JSON", async () => {
    const mutations: Array<(table: MemoryTableClient, allocation: AllocationRecord) => void> = [
      (table, allocation) => {
        table.mutateDocument(`allocation!${allocation.allocationId}`, (document) => ({
          ...document,
          unexpected: true,
        }));
      },
      (table, allocation) => {
        table.mutateDocument(`attempt!${allocation.allocationId}!01`, (document) => {
          const { outcome: _missing, ...withoutOutcome } = document;
          return withoutOutcome;
        });
      },
      (table, allocation) => {
        table.mutateDocument(`attempt!${allocation.allocationId}!01`, (document) => ({
          ...document,
          reservation: {
            ...(document.reservation as Record<string, unknown>),
            unexpected: true,
          },
        }));
      },
      (table, allocation) => {
        const rowKey = `generation!${allocation.allocationId}!01!01`;
        table.mutateDocument(rowKey, (document) => ({ ...document, state: "unknown" }));
        table.setProperty(rowKey, "state", "unknown");
      },
      (table, allocation) => {
        table.mutateDocument(`generation!${allocation.allocationId}!01!01`, (document) => {
          const schedule = document.schedule as Record<string, unknown>;
          const { requestCorrelationId: _missing, ...withoutOperation } = schedule;
          return { ...document, schedule: withoutOperation };
        });
      },
      (table, allocation) => {
        table.mutateDocument(`allocation!${allocation.allocationId}`, (document) => ({
          ...document,
          cleanup: {
            ...(document.cleanup as Record<string, unknown>),
            unexpected: true,
          },
        }));
      },
      (table, allocation) => {
        table.mutateDocument(`allocation!${allocation.allocationId}`, (document) => ({
          ...document,
          cleanup: {
            ...(document.cleanup as Record<string, unknown>),
            terminalEvidence: {
              concludedAt: document.updatedAt,
              conclusion: "cancelled",
              repositoryId: allocation.identity.repository_id,
              runAttempt: allocation.identity.run_attempt,
              source: "github-workflow-run",
            },
          },
        }));
      },
      (table, allocation) => {
        const rowKey = `generation!${allocation.allocationId}!01!01`;
        table.setDocumentText(
          rowKey,
          table
            .documentText(rowKey)
            .replace('"status":"requested"', '"status":"requested","status":"accepted"'),
        );
      },
    ];

    for (const [index, mutate] of mutations.entries()) {
      const { ledger, table } = await initialisedLedger();
      const allocation = await allocationWithRequestedSchedule(ledger, 30 + index);
      mutate(table, allocation);
      await assert.rejects(
        () => ledger.getAllocation(allocation.allocationId),
        hasCode("authoritative-state-corrupt"),
      );
    }
  });

  it("requires the schema-10 JIT intent to bind its exact deployment ID", async () => {
    const { ledger, table } = await initialisedLedger();
    const allocation = await successfulUnassignedAzureGeneration(ledger, 88);
    table.mutateDocument(`generation!${allocation.allocationId}!01!01`, (document) => {
      const intent = document.jitMintIntent as Record<string, unknown>;
      const { jitDeploymentId: _missing, ...withoutDeployment } = intent;
      return { ...document, jitMintIntent: withoutDeployment };
    });
    await assert.rejects(
      () => ledger.getAllocation(allocation.allocationId),
      hasCode("authoritative-state-corrupt"),
    );
  });

  it("coordinates Check Run lease takeover with revision fencing", async () => {
    const { ledger, table } = await initialisedLedger();
    const allocation = (await ledger.acceptAllocation(acceptance(10))).allocation;
    const acquisition = {
      ...allocation.checkRunCreation.key,
      acquiredAt: "2026-08-25T00:00:01.000Z",
      leaseExpiresAt: "2026-08-25T00:02:01.000Z",
      leaseOwner: "worker-1",
    } as const;
    table.failAfterNextCommit();
    const first = await ledger.acquireCheckRunCreationLease(acquisition);
    assert.equal(first.outcome, "acquired");
    if (first.outcome !== "acquired") return;
    const exactAcquisition = await ledger.acquireCheckRunCreationLease(acquisition);
    assert.deepEqual(exactAcquisition, first);
    table.conflictBeforeNextCommit();
    await assert.rejects(
      () =>
        ledger.renewCheckRunCreationLease({
          allocationId: allocation.allocationId,
          leaseExpiresAt: "2026-08-25T00:03:01.000Z",
          leaseOwner: "worker-1",
          leaseRevision: first.leaseRevision,
          renewedAt: "2026-08-25T00:01:01.000Z",
        }),
      hasCode("optimistic-concurrency-conflict"),
    );
    table.failAfterNextCommit();
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
    assert.equal(
      (
        await ledger.acquireCheckRunCreationLease({
          ...allocation.checkRunCreation.key,
          acquiredAt: "2026-08-25T00:03:01.000Z",
          leaseExpiresAt: "2026-08-25T00:05:01.000Z",
          leaseOwner: "worker-2",
        })
      ).outcome,
      "busy",
    );
    const takeover = await ledger.acquireCheckRunCreationLease({
      ...allocation.checkRunCreation.key,
      acquiredAt: "2026-08-25T00:03:01.001Z",
      leaseExpiresAt: "2026-08-25T00:05:01.001Z",
      leaseOwner: "worker-2",
    });
    assert.equal(takeover.outcome, "acquired");
    if (takeover.outcome !== "acquired") return;
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
  });

  it("persists immutable branch evidence and monotonic reconciler heartbeats", async () => {
    const { ledger, table } = await initialisedLedger();
    const branch = acceptance(11).evidence.trust.approvedBranch;
    assert.equal(await ledger.recordInitial(branch), "recorded");
    assert.equal(await ledger.recordInitial(structuredClone(branch)), "matched");
    assert.equal(
      await ledger.recordInitial({
        ...branch,
        commitSha: "fedcba9876543210fedcba9876543210fedcba98",
      }),
      "conflict",
    );
    assert.equal(await ledger.getReconcilerHeartbeat(), null);
    const heartbeat = await ledger.recordReconcilerHeartbeat({
      lastSucceededAt: "2026-08-25T12:00:00.000Z",
    });
    assert.equal(heartbeat.lastSucceededAt, "2026-08-25T12:00:00.000Z");
    await assert.rejects(
      () => ledger.recordReconcilerHeartbeat({ lastSucceededAt: "2026-08-25T11:59:59.999Z" }),
      hasCode("precondition-failed"),
    );
    table.deleteRow("heartbeat!reconciler");
    await assert.rejects(
      () => ledger.getReconcilerHeartbeat(),
      hasCode("authoritative-state-corrupt"),
    );
  });

  it("enumerates allocation rows with bounded continuation and retains ended visibility work", async () => {
    const { ledger } = await initialisedLedger();
    const first = (await ledger.acceptAllocation(acceptance(31))).allocation;
    const second = (await ledger.acceptAllocation(acceptance(32))).allocation;

    const pageOne = await ledger.listOpenAllocations({ pageSize: 1 });
    assert.equal(pageOne.allocations.length, 1);
    assert.notEqual(pageOne.continuationToken, null);
    if (pageOne.continuationToken === null) throw new Error("first page lacked continuation");
    const pageTwo = await ledger.listOpenAllocations({
      continuationToken: pageOne.continuationToken,
      pageSize: 1,
    });
    assert.equal(pageTwo.allocations.length, 1);
    assert.deepEqual(
      new Set([...pageOne.allocations, ...pageTwo.allocations].map((entry) => entry.allocationId)),
      new Set([first.allocationId, second.allocationId]),
    );

    const abandoned = await ledger.abandonUnassignedAllocation({
      abandonedAt: "2026-08-25T00:15:00.000Z",
      allocationId: first.allocationId,
      expectedRevision: first.revision,
      reason: "controller-progress-timeout",
    });
    assert.equal(abandoned.lifecycleState, "ended");
    assert.equal(abandoned.cleanup.terminalEvidence?.source, "allocation-never-returned");
    const reconciliationOpen = await ledger.listOpenAllocations({ pageSize: 50 });
    assert.equal(
      reconciliationOpen.allocations.some((entry) => entry.allocationId === first.allocationId),
      true,
    );
  });

  it("fails enumeration when a corrupt allocation row could otherwise hide a reservation", async () => {
    const { ledger, table } = await initialisedLedger();
    const allocation = (await ledger.acceptAllocation(acceptance(33))).allocation;
    const rowKey = `allocation!${allocation.allocationId}`;
    table.mutateDocument(rowKey, (document) => ({
      ...document,
      lifecycleState: "ended",
    }));
    table.setProperty(rowKey, "lifecycleState", "ended");

    await assert.rejects(
      () => ledger.listOpenAllocations({ pageSize: 50 }),
      hasCode("authoritative-state-corrupt"),
    );
  });

  it("finds an allocation row even when its entity-type discriminator is corrupt", async () => {
    const { ledger, table } = await initialisedLedger();
    const allocation = (await ledger.acceptAllocation(acceptance(34))).allocation;
    table.setProperty(`allocation!${allocation.allocationId}`, "entityType", "provider-attempt");

    await assert.rejects(
      () => ledger.listOpenAllocations({ pageSize: 50 }),
      hasCode("authoritative-state-corrupt"),
    );
  });

  it("matches the in-memory aggregate for the complete ordered fallback path", async () => {
    const azure = await initialisedLedger();
    const memory = new InMemoryAllocationLedger(
      createInitialisedInMemoryLedgerStore(FOUNDATION),
      FOUNDATION,
    );
    const [azureResult, memoryResult] = await Promise.all([
      completeFallbackPath(azure.ledger, 15),
      completeFallbackPath(memory, 15),
    ]);
    assert.deepEqual(withoutStorageRevisions(azureResult), withoutStorageRevisions(memoryResult));
  });
});

class MemoryTableClient implements AzureTableClientPort {
  readonly transactions: TransactionAction[][] = [];
  injectedTransactionConflicts = 0;
  readonly #entities = new Map<string, Record<string, unknown>>();
  #conflictBeforeCommit = false;
  #failAfterCommit = false;
  #revision = 0;

  async getEntity<T extends object = Record<string, unknown>>(
    partitionKey: string,
    rowKey: string,
  ): Promise<TableEntityResult<T>> {
    await Promise.resolve();
    const entity = this.#entities.get(key(partitionKey, rowKey));
    if (entity === undefined) throw { statusCode: 404 };
    return structuredClone(entity) as TableEntityResult<T>;
  }

  listEntities<T extends object = Record<string, unknown>>(
    options?: ListTableEntitiesOptions,
  ): {
    byPage(settings?: {
      readonly continuationToken?: string;
      readonly maxPageSize?: number;
    }): AsyncIterableIterator<TableEntityResultPage<T>>;
  } {
    const expectedFilter = `PartitionKey eq '${AZURE_TABLE_LEDGER_PARTITION_KEY}' and RowKey ge 'allocation!' and RowKey lt 'allocation"'`;
    assert.equal(options?.queryOptions?.filter, expectedFilter);
    const entities = [...this.#entities.values()]
      .filter((entity) => String(entity.rowKey).startsWith("allocation!"))
      .sort((left, right) => String(left.rowKey).localeCompare(String(right.rowKey)));
    return {
      byPage(settings = {}) {
        const offset = settings.continuationToken
          ? Number(/^table-open-v1:(\d+)$/.exec(settings.continuationToken)?.[1] ?? Number.NaN)
          : 0;
        const maximum = settings.maxPageSize ?? entities.length;
        return (async function* pages() {
          if (!Number.isSafeInteger(offset) || offset < 0 || offset > entities.length) {
            throw { statusCode: 400 };
          }
          const values = entities
            .slice(offset, offset + maximum)
            .map((entity) => structuredClone(entity)) as TableEntityResultPage<T>;
          const nextOffset = offset + values.length;
          if (nextOffset < entities.length) {
            values.continuationToken = `table-open-v1:${nextOffset}`;
          }
          yield values;
        })();
      },
    };
  }

  async submitTransaction(actions: TransactionAction[]): Promise<TableTransactionResponse> {
    await Promise.resolve();
    if (this.#conflictBeforeCommit) {
      this.#conflictBeforeCommit = false;
      this.injectedTransactionConflicts += 1;
      throw { statusCode: 412 };
    }
    const cloned = structuredClone(actions);
    assert.equal(cloned.length <= 100, true);
    assert.equal(new Set(cloned.map((action) => action[1].partitionKey)).size, 1);
    const staged = structuredClone(this.#entities);
    const responses: Array<{ etag: string; rowKey: string; status: number }> = [];
    for (const action of cloned) {
      const [operation, entity] = action;
      const entityKey = key(entity.partitionKey, entity.rowKey);
      const existing = staged.get(entityKey);
      if (operation === "create" && existing !== undefined) throw { statusCode: 409 };
      if (operation === "update") {
        if (existing === undefined || action[3]?.etag !== existing.etag) {
          throw { statusCode: 412 };
        }
      } else if (operation !== "create") {
        throw new Error(`unsupported test operation ${operation}`);
      }
      const etag = `table-${++this.#revision}`;
      staged.set(entityKey, { ...structuredClone(entity), etag });
      responses.push({ etag, rowKey: entity.rowKey, status: operation === "create" ? 201 : 204 });
    }
    this.#entities.clear();
    for (const [entityKey, entity] of staged) this.#entities.set(entityKey, entity);
    this.transactions.push(cloned);
    if (this.#failAfterCommit) {
      this.#failAfterCommit = false;
      throw { statusCode: 503 };
    }
    return {
      status: 202,
      subResponses: responses,
      getResponseForEntity: (rowKey) => responses.find((response) => response.rowKey === rowKey),
    };
  }

  failAfterNextCommit(): void {
    this.#failAfterCommit = true;
  }

  conflictBeforeNextCommit(): void {
    this.#conflictBeforeCommit = true;
  }

  deleteRow(rowKey: string): void {
    this.#entities.delete(key(AZURE_TABLE_LEDGER_PARTITION_KEY, rowKey));
  }

  mutateDocument(
    rowKey: string,
    mutate: (document: Record<string, unknown>) => Record<string, unknown>,
  ): void {
    const entity = this.#required(rowKey);
    entity.document = JSON.stringify(
      mutate(JSON.parse(String(entity.document)) as Record<string, unknown>),
    );
  }

  documentText(rowKey: string): string {
    return String(this.#required(rowKey).document);
  }

  setDocumentText(rowKey: string, document: string): void {
    this.#required(rowKey).document = document;
  }

  setProperty(rowKey: string, property: string, value: unknown): void {
    this.#required(rowKey)[property] = value;
  }

  property(rowKey: string, property: string): unknown {
    return this.#required(rowKey)[property];
  }

  rowKeys(): string[] {
    return [...this.#entities.values()].map((entity) => String(entity.rowKey)).sort();
  }

  snapshot(): readonly (readonly [string, Record<string, unknown>])[] {
    return [...this.#entities.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([entityKey, entity]) => [entityKey, structuredClone(entity)] as const);
  }

  maximumTransactionSize(): number {
    return Math.max(0, ...this.transactions.map((transaction) => transaction.length));
  }

  allTransactionsUseOnePartition(): boolean {
    return this.transactions.every((transaction) =>
      transaction.every((action) => action[1].partitionKey === AZURE_TABLE_LEDGER_PARTITION_KEY),
    );
  }

  #required(rowKey: string): Record<string, unknown> {
    const entity = this.#entities.get(key(AZURE_TABLE_LEDGER_PARTITION_KEY, rowKey));
    if (entity === undefined) throw new Error(`missing test row ${rowKey}`);
    return entity;
  }
}

function acceptance(
  sequence: number,
  backupChoice: "Keep going" | "Save money" = "Keep going",
  acceptedAt = DAY_ONE,
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
      request: { backupChoice, profile: "linux-x64-large" },
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
        repository: { id: "900000002", name: "example-workload", owner: "example-org" },
        workload: {
          backupChoice,
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

function azureAttempt(
  allocation: AllocationRecord,
  options: {
    readonly attemptedAt?: string;
    readonly cost?: number;
    readonly day?: string;
  } = {},
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

async function acceptedWithCheckRun(
  ledger: AllocationControlLedger,
  request: AcceptAllocationRequest,
  leaseAt = nextInstant(request.acceptedAt, 1_000),
): Promise<AllocationRecord> {
  const accepted = (await ledger.acceptAllocation(request)).allocation;
  const lease = await ledger.acquireCheckRunCreationLease({
    ...accepted.checkRunCreation.key,
    acquiredAt: leaseAt,
    leaseExpiresAt: nextInstant(leaseAt, 120_000),
    leaseOwner: "worker-1",
  });
  assert.equal(lease.outcome, "acquired");
  if (lease.outcome !== "acquired") throw new Error("Check Run lease not acquired");
  return ledger.completeCheckRunCreation({
    allocationId: accepted.allocationId,
    checkRunId: String(7000 + Number(accepted.identity.run_id)),
    completedAt: leaseAt,
    leaseOwner: lease.leaseOwner,
    leaseRevision: lease.leaseRevision,
  });
}

async function completeFallbackPath(
  ledger: AllocationControlLedger,
  sequence: number,
): Promise<AllocationRecord> {
  let allocation = await acceptedWithCheckRun(ledger, acceptance(sequence));
  const azure = await ledger.reserveProviderAttempt(azureAttempt(allocation, { cost: 200 }));
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
  const blacksmith = await ledger.reserveProviderAttempt(blacksmithAttempt(allocation));
  assert.equal(blacksmith.outcome, "reserved");
  if (blacksmith.outcome !== "reserved") throw new Error("Blacksmith was not reserved");
  allocation = await ledger.markProviderAttemptSucceeded({
    allocationId: allocation.allocationId,
    expectedAllocationRevision: blacksmith.allocation.revision,
    expectedAttemptRevision: blacksmith.attempt.revision,
    ordinal: 2,
    succeededAt: "2026-08-25T00:04:30.000Z",
  });
  return ledger.assignRunner({
    allocationId: allocation.allocationId,
    assignment: {
      assignedAt: "2026-08-25T00:05:00.000Z",
      attemptOrdinal: 2,
      provider: "blacksmith",
      runnerLabel: "blacksmith-4vcpu-ubuntu-2404",
    },
    expectedAllocationRevision: allocation.revision,
  });
}

async function blacksmithReady(
  ledger: AzureTableAllocationLedger,
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
    succeededAt: "2026-08-25T00:04:30.000Z",
  });
}

async function assignedBlacksmithAllocation(
  ledger: AzureTableAllocationLedger,
  sequence: number,
): Promise<AllocationRecord> {
  const ready = await blacksmithReady(ledger, sequence);
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

async function successfulUnassignedAzureGeneration(
  ledger: AzureTableAllocationLedger,
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

async function azureUnavailableAllocation(
  ledger: AzureTableAllocationLedger,
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
  ledger: AzureTableAllocationLedger,
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

async function initialisedLedger(): Promise<{
  readonly ledger: AzureTableAllocationLedger;
  readonly table: MemoryTableClient;
}> {
  const table = new MemoryTableClient();
  await seedFoundation(table, FOUNDATION);
  table.transactions.length = 0;
  return { ledger: new AzureTableAllocationLedger(table, runtimeEvidence()), table };
}

async function seedFoundation(
  table: MemoryTableClient,
  evidence: AzureLedgerInstanceEvidence,
): Promise<void> {
  const registry = {
    initialisedAt: evidence.initialisedAt,
    ledgerInstanceId: evidence.ledgerInstanceId,
    partitionKey: AZURE_TABLE_LEDGER_PARTITION_KEY,
    schemaVersion: evidence.schemaVersion,
    utcDay: evidence.utcDay,
  };
  const actions: TransactionAction[] = [
    [
      "create",
      {
        partitionKey: AZURE_TABLE_LEDGER_PARTITION_KEY,
        rowKey: "bootstrap!ledger",
        document: JSON.stringify(registry),
        entityType: "bootstrap-registry",
        ledgerInstanceId: evidence.ledgerInstanceId,
        schemaVersion: evidence.schemaVersion,
      },
    ],
  ];
  for (const provider of ["azure", "blacksmith"] as const) {
    const document = {
      accountedDailyCostUsdCents: 0,
      activeReservations: 0,
      initialisedAt: evidence.initialisedAt,
      ledgerInstanceId: evidence.ledgerInstanceId,
      provider,
      schemaVersion: evidence.schemaVersion,
      utcDay: evidence.utcDay,
    };
    actions.push([
      "create",
      {
        partitionKey: AZURE_TABLE_LEDGER_PARTITION_KEY,
        rowKey: `control!${provider}`,
        accountedDailyCostUsdCents: 0,
        activeReservations: 0,
        document: JSON.stringify(document),
        entityType: "provider-control",
        ledgerInstanceId: evidence.ledgerInstanceId,
        provider,
        schemaVersion: evidence.schemaVersion,
        utcDay: evidence.utcDay,
      },
    ]);
  }
  actions.push([
    "create",
    {
      partitionKey: AZURE_TABLE_LEDGER_PARTITION_KEY,
      rowKey: "heartbeat!reconciler",
      document: JSON.stringify({
        lastSucceededAt: null,
        ledgerInstanceId: evidence.ledgerInstanceId,
        schemaVersion: evidence.schemaVersion,
      }),
      entityType: "reconciler-heartbeat",
      lastSucceededAt: "",
      ledgerInstanceId: evidence.ledgerInstanceId,
      schemaVersion: evidence.schemaVersion,
    },
  ]);
  await table.submitTransaction(actions);
}

function counter(
  table: MemoryTableClient,
  provider: "azure" | "blacksmith",
): { readonly accountedDailyCostUsdCents: number; readonly activeReservations: number } {
  return {
    accountedDailyCostUsdCents: Number(
      table.property(`control!${provider}`, "accountedDailyCostUsdCents"),
    ),
    activeReservations: Number(table.property(`control!${provider}`, "activeReservations")),
  };
}

function setControlCounters(
  table: MemoryTableClient,
  provider: "azure" | "blacksmith",
  counters: { readonly accountedDailyCostUsdCents: number; readonly activeReservations: number },
): void {
  table.mutateDocument(`control!${provider}`, (document) => ({ ...document, ...counters }));
  table.setProperty(`control!${provider}`, "activeReservations", counters.activeReservations);
  table.setProperty(
    `control!${provider}`,
    "accountedDailyCostUsdCents",
    counters.accountedDailyCostUsdCents,
  );
}

function historyCost(
  table: MemoryTableClient,
  provider: "azure" | "blacksmith",
  utcDay: string,
): number {
  return Number(
    table.property(`allowance-history!${provider}!${utcDay}`, "accountedDailyCostUsdCents"),
  );
}

function runtimeEvidence() {
  return {
    ledgerInstanceId: FOUNDATION.ledgerInstanceId,
    schemaVersion: FOUNDATION.schemaVersion,
  } as const;
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

function readyGenerationState(
  generation: PhysicalGeneration,
  readyAt: string,
): PhysicalGenerationState {
  const vmResourceId =
    "/subscriptions/test/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm1";
  const initialZone = generation.zoneDeployments[0];
  assert.ok(initialZone);
  return {
    cleanup: generation.cleanup,
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
      managedRunCommandId: `${vmResourceId}/runCommands/launch-jit-g1`,
      requestedAt: readyAt,
    },
    operationLease: null,
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

function nextInstant(value: string, milliseconds: number): string {
  return new Date(Date.parse(value) + milliseconds).toISOString();
}

function key(partitionKey: string, rowKey: string): string {
  return `${partitionKey}\u0000${rowKey}`;
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof Error && "code" in error && error.code === code;
}

function withoutStorageRevisions(value: AllocationRecord): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, entry: unknown) =>
      key === "revision" || key === "settledFromRevision" ? undefined : entry,
    ),
  ) as unknown;
}
