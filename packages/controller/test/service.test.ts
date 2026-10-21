import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AllocationServiceError,
  PortableAllocationService,
  ProofVerificationError,
  projectAllocationControllerState,
  type AcceptedCheckRunPort,
  type PostTrustAllocationStateProvider,
} from "../src/index.js";
import { initialisedLedger, NOW, securityDecision } from "./fixtures.js";

describe("portable allocation orchestration", () => {
  it("runs the ordered Azure-to-Blacksmith fallback once and returns exact retries", async () => {
    const harness = await createHarness();
    const pending = await harness.service.allocate({ proof: "verified" });
    assert.equal(pending.status, "pending");
    assert.equal(harness.dispatches.length, 1);
    let allocation = await harness.ledger.getAllocation(pending.allocationId);
    assert.ok(allocation);
    assert.deepEqual(
      allocation.attempts.map(({ ordinal, provider, outcome }) => ({ ordinal, provider, outcome })),
      [{ ordinal: 1, provider: "azure", outcome: "pending" }],
    );
    assert.equal(allocation.checkRunCreation.delivery.lifecycle.phase, "in-progress");

    harness.advance(60_000);
    const azure = allocation.attempts[0];
    assert.ok(azure);
    allocation = await harness.ledger.settleUnavailableProviderAttempt({
      allocationId: allocation.allocationId,
      classification: "readiness-timeout",
      cleanup: {
        phase: "settled",
        providerResourcesSettled: true,
        runnerRegistrationSettled: true,
        settledAt: harness.now().toISOString(),
      },
      expectedAllocationRevision: allocation.revision,
      expectedAttemptRevision: azure.revision,
      finalCostUsdCents: 10,
      ordinal: 1,
      settledAt: harness.now().toISOString(),
    });

    const ready = await harness.service.allocate({ proof: "fresh" });
    assert.deepEqual(ready, {
      allocationId: allocation.allocationId,
      runnerLabel: "blacksmith-4vcpu-ubuntu-2404",
      status: "ready",
    });
    assert.deepEqual(harness.ledger.getCounterSnapshot("azure", "2026-08-25"), {
      accountedDailyCostUsdCents: 10,
      activeReservations: 0,
    });
    assert.deepEqual(harness.ledger.getCounterSnapshot("blacksmith", "2026-08-25"), {
      accountedDailyCostUsdCents: 125,
      activeReservations: 1,
    });

    const exact = await harness.service.allocate({ proof: "new-jti" });
    assert.deepEqual(exact, ready);
    const persisted = await harness.ledger.getAllocation(ready.allocationId);
    assert.equal(persisted?.attempts.length, 2);
    assert.equal(harness.securityCalls.length, 3);
    assert.equal(harness.stateOpens, 3);
  });

  it("covers both backup choices and both provider admission ceilings", async () => {
    const keepGoing = await createHarness();
    keepGoing.ledger.unsafeSetCounterState("azure", "2026-08-25", {
      accountedDailyCostUsdCents: 0,
      activeReservations: 3,
    });
    const fallback = await keepGoing.service.allocate({ proof: "fresh" });
    assert.equal(fallback.status, "ready");
    assert.equal(keepGoing.dispatches.length, 0);

    const saveMoney = await createHarness({ backupChoice: "Save money" });
    saveMoney.ledger.unsafeSetCounterState("azure", "2026-08-25", {
      accountedDailyCostUsdCents: 0,
      activeReservations: 3,
    });
    await assert.rejects(
      () => saveMoney.service.allocate({ proof: "fresh" }),
      hasServiceCode("runner-unavailable"),
    );
    const stopped = await saveMoney.ledger.getAllocationByIdentity(
      securityDecision().trust.identity,
    );
    assert.equal(stopped?.stop?.reason, "save-money");
    assert.equal(stopped?.attempts.length, 1);
    const stoppedCounter = saveMoney.ledger.getCounterSnapshot("azure", "2026-08-25");
    await assert.rejects(
      () => saveMoney.service.allocate({ proof: "exact-late-poll" }),
      hasServiceCode("runner-unavailable"),
    );
    assert.deepEqual(saveMoney.ledger.getCounterSnapshot("azure", "2026-08-25"), stoppedCounter);
    assert.equal(saveMoney.dispatches.length, 0);

    const noProvider = await createHarness();
    noProvider.ledger.unsafeSetCounterState("azure", "2026-08-25", {
      accountedDailyCostUsdCents: 0,
      activeReservations: 3,
    });
    noProvider.ledger.unsafeSetCounterState("blacksmith", "2026-08-25", {
      accountedDailyCostUsdCents: 0,
      activeReservations: 3,
    });
    await assert.rejects(
      () => noProvider.service.allocate({ proof: "fresh" }),
      hasServiceCode("runner-unavailable"),
    );
    const exhausted = await noProvider.ledger.getAllocationByIdentity(
      securityDecision().trust.identity,
    );
    assert.equal(exhausted?.stop?.reason, "all-providers-unavailable");
    assert.deepEqual(
      exhausted?.attempts.map(({ ordinal, provider }) => ({ ordinal, provider })),
      [
        { ordinal: 1, provider: "azure" },
        { ordinal: 2, provider: "blacksmith" },
      ],
    );
  });

  it("returns runner unavailable for an abandoned exact retry without reserving", async () => {
    const harness = await createHarness();
    const decision = securityDecision();
    let allocation = (
      await harness.ledger.acceptAllocation({
        acceptedAt: NOW,
        checkRunAppSlug: "switchyard",
        evidence: {
          request: {
            backupChoice: decision.policyInput.backupChoice,
            profile: decision.policyInput.profile,
          },
          trust: decision.trust,
        },
      })
    ).allocation;
    harness.advance(15 * 60_000);
    allocation = await harness.ledger.abandonUnassignedAllocation({
      abandonedAt: harness.now().toISOString(),
      allocationId: allocation.allocationId,
      expectedRevision: allocation.revision,
      reason: "controller-progress-timeout",
    });
    await harness.ledger.recordReconcilerHeartbeat({
      lastSucceededAt: harness.now().toISOString(),
    });

    await assert.rejects(
      () => harness.service.allocate({ proof: "exact-late-poll" }),
      hasServiceCode("runner-unavailable"),
    );
    assert.equal(allocation.lifecycleState, "ended");
    assert.equal(harness.dispatches.length, 0);
    assert.equal(harness.ledger.getCounterSnapshot("azure", "2026-08-25").activeReservations, 0);
  });

  it("never returns a formerly assigned label after terminal settlement", async () => {
    const harness = await createHarness();
    harness.ledger.unsafeSetCounterState("azure", "2026-08-25", {
      accountedDailyCostUsdCents: 0,
      activeReservations: 3,
    });
    const ready = await harness.service.allocate({ proof: "initial" });
    assert.equal(ready.status, "ready");
    let allocation = await harness.ledger.getAllocation(ready.allocationId);
    assert.ok(allocation);
    const concludedAt = new Date(harness.now().valueOf() + 1_000).toISOString();
    allocation = await harness.ledger.updateAllocationState({
      allocationId: allocation.allocationId,
      expectedRevision: allocation.revision,
      patch: {
        cleanup: {
          phase: "settled",
          providerResourcesSettled: true,
          runnerRegistrationSettled: true,
          settledAt: concludedAt,
          terminalEvidence: {
            concludedAt,
            conclusion: "cancelled",
            repositoryId: allocation.identity.repository_id,
            runAttempt: allocation.identity.run_attempt,
            runId: allocation.identity.run_id,
            source: "github-workflow-run",
          },
        },
        lifecycleState: "cleanup_pending",
      },
      updatedAt: concludedAt,
    });
    const attempt = allocation.attempts[1];
    assert.ok(attempt);
    allocation = await harness.ledger.settleFinalProviderAttempt({
      allocationId: allocation.allocationId,
      cleanup: {
        phase: "settled",
        providerResourcesSettled: true,
        runnerRegistrationSettled: true,
        settledAt: concludedAt,
      },
      expectedAllocationRevision: allocation.revision,
      expectedAttemptRevision: attempt.revision,
      finalCostUsdCents: attempt.reservation.reservedCostUsdCents,
      ordinal: 2,
      settledAt: concludedAt,
    });

    await assert.rejects(
      () => harness.service.allocate({ proof: "exact-late-poll" }),
      hasServiceCode("runner-unavailable"),
    );
    assert.equal(allocation.lifecycleState, "ended");
    assert.equal(harness.dispatches.length, 0);
    assert.equal(
      harness.ledger.getCounterSnapshot("blacksmith", "2026-08-25").activeReservations,
      0,
    );
  });

  it("never supplies state capability before proof and trust succeeds", async () => {
    let stateOpens = 0;
    const harness = await createHarness({
      security: {
        verify: async () => {
          throw new ProofVerificationError("invalid-proof", "denied");
        },
      },
      state: {
        open: async () => {
          stateOpens += 1;
          throw new Error("must not open");
        },
      },
    });
    await assert.rejects(
      () => harness.service.allocate({ proof: "bad" }),
      hasServiceCode("allocation-not-authorised"),
    );
    assert.equal(stateOpens, 0);
    assert.deepEqual(harness.ledger.getCounterSnapshot("azure", "2026-08-25"), {
      accountedDailyCostUsdCents: 0,
      activeReservations: 0,
    });
  });

  it("defers bounded Check Run contention and never reserves before its numeric ID is durable", async () => {
    const harness = await createHarness({
      checkRuns: { ensureAccepted: async () => ({ outcome: "deferred" }) },
    });
    const result = await harness.service.allocate({ proof: "fresh" });
    assert.equal(result.status, "pending");
    assert.deepEqual(harness.ledger.getCounterSnapshot("azure", "2026-08-25"), {
      accountedDailyCostUsdCents: 0,
      activeReservations: 0,
    });
    const allocation = await harness.ledger.getAllocation(result.allocationId);
    assert.equal(allocation?.checkRunCreation.delivery.lifecycle.phase, "not-created");
    assert.equal(allocation?.attempts.length, 0);
  });

  it("classifies Check Run and dispatch failures as unavailable without fallback", async () => {
    const checkRunFailure = await createHarness({
      checkRuns: {
        ensureAccepted: async () => {
          throw new Error("redacted GitHub outage");
        },
      },
    });
    await assert.rejects(
      () => checkRunFailure.service.allocate({ proof: "fresh" }),
      hasServiceCode("controller-unavailable"),
    );
    assert.equal(
      checkRunFailure.ledger.getCounterSnapshot("azure", "2026-08-25").activeReservations,
      0,
    );

    const dispatchFailure = await createHarness({ dispatchFails: true });
    await assert.rejects(
      () => dispatchFailure.service.allocate({ proof: "fresh" }),
      hasServiceCode("controller-unavailable"),
    );
    const allocation = await dispatchFailure.ledger.getAllocationByIdentity(
      securityDecision().trust.identity,
    );
    assert.equal(allocation?.attempts.length, 1);
    assert.equal(allocation?.attempts[0]?.provider, "azure");
    assert.equal(
      dispatchFailure.ledger.getCounterSnapshot("blacksmith", "2026-08-25").activeReservations,
      0,
    );
    dispatchFailure.recoverDispatch();
    assert.equal(
      (await dispatchFailure.service.allocate({ proof: "fresh-retry" })).status,
      "pending",
    );
    const retried = await dispatchFailure.ledger.getAllocationByIdentity(
      securityDecision().trust.identity,
    );
    assert.equal(retried?.attempts.length, 1);
    assert.equal(
      dispatchFailure.ledger.getCounterSnapshot("azure", "2026-08-25").activeReservations,
      1,
    );
    assert.equal(dispatchFailure.dispatches.length, 2);
  });

  it("fails closed at 150 seconds plus one millisecond, including an existing assignment", async () => {
    const harness = await createHarness();
    harness.ledger.unsafeSetCounterState("azure", "2026-08-25", {
      accountedDailyCostUsdCents: 0,
      activeReservations: 3,
    });
    const ready = await harness.service.allocate({ proof: "fresh" });
    assert.equal(ready.status, "ready");
    harness.advance(150_001);
    await assert.rejects(
      () => harness.service.allocate({ proof: "fresh-again" }),
      hasServiceCode("controller-unavailable"),
    );
  });

  it("rechecks heartbeat freshness after Check Run coordination before reserving", async () => {
    let advanceDuringCheckRun: (() => void) | undefined;
    const harness = await createHarness({
      checkRuns: {
        ensureAccepted: async ({ allocation, store }) => {
          const lease = await store.acquireCheckRunCreationLease({
            ...allocation.checkRunCreation.key,
            acquiredAt: NOW,
            leaseExpiresAt: "2026-08-25T12:03:00.000Z",
            leaseOwner: "slow-check-run",
          });
          assert.equal(lease.outcome, "acquired");
          if (lease.outcome !== "acquired") return { outcome: "deferred" };
          await store.completeCheckRunCreation({
            allocationId: allocation.allocationId,
            checkRunId: "7001",
            completedAt: NOW,
            leaseOwner: lease.leaseOwner,
            leaseRevision: lease.leaseRevision,
          });
          advanceDuringCheckRun?.();
          return { checkRunId: "7001", outcome: "completed" };
        },
      },
    });
    advanceDuringCheckRun = () => harness.advance(150_001);
    await assert.rejects(
      () => harness.service.allocate({ proof: "fresh" }),
      hasServiceCode("controller-unavailable"),
    );
    assert.equal(harness.ledger.getCounterSnapshot("azure", "2026-08-25").activeReservations, 0);
  });

  it("projects provider success as a repairable Azure assignment with a fresh recheck", async () => {
    const harness = await createHarness();
    const pending = await harness.service.allocate({ proof: "verified" });
    let allocation = await harness.ledger.getAllocation(pending.allocationId);
    assert.ok(allocation);
    const attempt = allocation.attempts[0];
    assert.ok(attempt);
    const added = await harness.ledger.addPhysicalGeneration({
      allocationId: allocation.allocationId,
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
      createdAt: NOW,
      expectedAttemptRevision: attempt.revision,
      generationNumber: 1,
      location: "uksouth",
      reservedIncrementalCostUsdCents: 0,
      resourceGroupId: "/subscriptions/test/resourceGroups/rg",
      resourceGroupName: "rg",
      vmSize: "Standard_D8ds_v6",
    });
    assert.equal(added.outcome, "added");
    if (added.outcome !== "added") return;
    const initialZone = added.generation.zoneDeployments[0];
    assert.ok(initialZone);
    const vmResourceId =
      "/subscriptions/test/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm1";
    allocation = await harness.ledger.updatePhysicalGeneration({
      allocationId: allocation.allocationId,
      attemptOrdinal: 1,
      expectedRevision: added.generation.revision,
      generationNumber: 1,
      state: {
        cleanup: added.generation.cleanup,
        jitMintIntent: {
          intentId: "sy-aaaaaaaaaaaaaaaaaaaaaaaa-g1-jit-mint",
          jitDeploymentId:
            "/subscriptions/test/resourceGroups/rg/providers/Microsoft.Resources/deployments/sy-aaaaaaaaaaaaaaaaaaaaaaaa-g1-jit",
          requestedAt: NOW,
        },
        launchPrerequisites: {
          bootstrapSucceeded: true,
          checkedAt: NOW,
          dockerHealthy: true,
          localNvmeMounted: true,
        },
        managedRunCommand: {
          boundVmResourceId: vmResourceId,
          deleteCompletedAt: NOW,
          deleteRequestedAt: NOW,
          launchConfirmedAt: NOW,
          managedRunCommandId: `${vmResourceId}/runCommands/launch-jit-g1`,
          requestedAt: NOW,
        },
        operationLease: null,
        providerVmId: "provider-vm-1",
        readyAt: NOW,
        runnerReadiness: { checkedAt: NOW, idle: true, online: true },
        runnerRegistrationId: "551001",
        schedule: {
          acceptedAt: NOW,
          requestCorrelationId: "schedule-correlation-1",
          deadlineType: "CompleteBy",
          lastCheckedAt: NOW,
          providerOperationId: "schedule-1",
          requestedDeadline: "2026-08-25T12:40:00.000Z",
          status: "accepted",
          targetVmResourceId: vmResourceId,
        },
        state: "ready",
        vmResourceId,
        zoneDeployments: [
          {
            ...initialZone,
            completedAt: NOW,
            outcome: "vm-created",
            vmResourceId,
          },
        ],
      },
      updatedAt: NOW,
    });
    const updatedAttempt = allocation.attempts[0];
    assert.ok(updatedAttempt);
    allocation = await harness.ledger.markProviderAttemptSucceeded({
      allocationId: allocation.allocationId,
      expectedAllocationRevision: allocation.revision,
      expectedAttemptRevision: updatedAttempt.revision,
      ordinal: 1,
      succeededAt: NOW,
    });

    assert.deepEqual(
      projectAllocationControllerState({
        allocation,
        controllerHealth: {
          authoritativeLedger: "available",
          doppler: "available",
          reconciler: { lastSucceededAt: NOW },
          switchyardApi: "available",
          trustVerification: "verified",
        },
        now: new Date(NOW),
      }),
      {
        action: "repair-azure-assignment",
        generationNumber: 1,
        requiresFreshOnlineIdleCheck: true,
        runnerRegistrationId: "551001",
      },
    );
    assert.equal(allocation.runnerAssignment, null);
    assert.equal(harness.dispatches.length, 1);
  });
});

async function createHarness(
  overrides: {
    readonly backupChoice?: "Keep going" | "Save money";
    readonly checkRuns?: AcceptedCheckRunPort;
    readonly dispatchFails?: boolean;
    readonly security?: { verify(input: unknown): Promise<never> };
    readonly state?: PostTrustAllocationStateProvider;
  } = {},
) {
  const ledger = initialisedLedger();
  await ledger.recordReconcilerHeartbeat({ lastSucceededAt: NOW });
  let milliseconds = Date.parse(NOW);
  const now = () => new Date(milliseconds);
  const securityCalls: unknown[] = [];
  let stateOpens = 0;
  let dispatchFails = overrides.dispatchFails ?? false;
  const state =
    overrides.state ??
    ({
      open: async () => {
        stateOpens += 1;
        return { heartbeat: ledger, ledger };
      },
    } satisfies PostTrustAllocationStateProvider);
  let checkRunSequence = 0;
  const checkRuns =
    overrides.checkRuns ??
    ({
      ensureAccepted: async ({ allocation, store }) => {
        checkRunSequence += 1;
        const completed = allocation.checkRunCreation.delivery.lifecycle;
        if (completed.phase !== "not-created") {
          return { checkRunId: completed.checkRunId, outcome: "completed" } as const;
        }
        const acquiredAt = now().toISOString();
        const lease = await store.acquireCheckRunCreationLease({
          ...allocation.checkRunCreation.key,
          acquiredAt,
          leaseExpiresAt: new Date(now().valueOf() + 60_000).toISOString(),
          leaseOwner: `test-controller:${checkRunSequence}`,
        });
        if (lease.outcome !== "acquired") return { outcome: "deferred" } as const;
        const checkRunId = "7001";
        await store.completeCheckRunCreation({
          allocationId: allocation.allocationId,
          checkRunId,
          completedAt: acquiredAt,
          leaseOwner: lease.leaseOwner,
          leaseRevision: lease.leaseRevision,
        });
        return { checkRunId, outcome: "completed" } as const;
      },
    } satisfies AcceptedCheckRunPort);
  const dispatches: unknown[] = [];
  const service = new PortableAllocationService({
    admission: {
      planAzure: async ({ allocationCreatedAt }) => ({
        deadlines: {
          absoluteExpiry: new Date(Date.parse(allocationCreatedAt) + 45 * 60_000).toISOString(),
          computeDeadline: new Date(Date.parse(allocationCreatedAt) + 40 * 60_000).toISOString(),
          latestSafeStart: new Date(Date.parse(allocationCreatedAt) + 10 * 60_000).toISOString(),
        },
        worstCaseCostUsdCents: 100,
      }),
      planBlacksmith: async () => ({ worstCaseCostUsdCents: 125 }),
    },
    azureDispatch: {
      dispatch: async (request) => {
        dispatches.push(request);
        if (dispatchFails) throw new Error("queue unavailable");
      },
    },
    checkRunAppSlug: "switchyard",
    checkRuns,
    dependencyHealth: {
      read: async () => ({
        authoritativeLedger: "available",
        doppler: "available",
        switchyardApi: "available",
      }),
    },
    now,
    security: overrides.security ?? {
      verify: async (input) => {
        securityCalls.push(input);
        return securityDecision(overrides.backupChoice);
      },
    },
    state,
  });
  return {
    advance: (amount: number) => {
      milliseconds += amount;
    },
    dispatches,
    ledger,
    now,
    recoverDispatch: () => {
      dispatchFails = false;
    },
    securityCalls,
    service,
    get stateOpens() {
      return stateOpens;
    },
  };
}

function hasServiceCode(code: AllocationServiceError["code"]) {
  return (error: unknown): boolean =>
    error instanceof AllocationServiceError && error.code === code;
}
