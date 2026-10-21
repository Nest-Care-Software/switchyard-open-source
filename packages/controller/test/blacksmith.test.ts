import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AllocationControlLedger, AllocationRecord } from "@switchyard/core";

import {
  BlacksmithCorrelationError,
  BlacksmithManagedCorrelationEngine,
  expectationFromTrust,
  type ManagedJobObservation,
  type ManagedRunObservation,
} from "../src/index.js";
import { initialisedLedger, NOW, verifiedTrust } from "./fixtures.js";

describe("Blacksmith managed-label correlation", () => {
  it("derives every expected field from immutable trust and persists the exact numeric job", async () => {
    const { allocation, ledger } = await assignedBlacksmith();
    assert.deepEqual(expectationFromTrust(allocation.acceptance.trust), {
      backupChoice: "Keep going",
      jobKey: "example-build",
      jobName: "Example approved build",
      mappingPointer: "example-workload/example-build",
      profile: "linux-x64-large",
      runnerLabel: "blacksmith-4vcpu-ubuntu-2404",
      timeoutMinutes: 25,
    });
    const engine = engineFor(ledger, observation(allocation, [expectedJob()]));
    assert.deepEqual(await engine.reconcileAllocation(allocation.allocationId), {
      githubJobId: "33001",
      outcome: "bound",
    });
    const persisted = await ledger.getAllocation(allocation.allocationId);
    assert.deepEqual(persisted?.workloadBinding, { githubJobId: "33001", state: "bound" });
  });

  it("returns awaiting without a write while the exact job has not appeared", async () => {
    const { allocation, ledger } = await assignedBlacksmith();
    const revision = allocation.revision;
    const engine = engineFor(ledger, observation(allocation, []));
    assert.deepEqual(await engine.reconcileAllocation(allocation.allocationId), {
      outcome: "awaiting",
    });
    assert.equal((await ledger.getAllocation(allocation.allocationId))?.revision, revision);
  });

  it("matches managed runner labels with GitHub's case-insensitive semantics", async () => {
    const { allocation, ledger } = await assignedBlacksmith();
    const engine = engineFor(
      ledger,
      observation(allocation, [
        {
          ...expectedJob(),
          runnerLabels: ["BLACKSMITH-4VCPU-UBUNTU-2404"],
        },
      ]),
    );
    assert.deepEqual(await engine.reconcileAllocation(allocation.allocationId), {
      githubJobId: "33001",
      outcome: "bound",
    });
  });

  it("persists each conservative binding failure and requires an incident", async () => {
    const cases: ReadonlyArray<
      [
        ManagedRunObservation["state"],
        readonly ReturnType<typeof expectedJob>[],
        "expected-job-missing" | "different-job" | "ambiguous-job",
      ]
    > = [
      ["terminal", [], "expected-job-missing"],
      ["active", [{ ...expectedJob(), jobName: "Another job" }], "different-job"],
      ["active", [{ ...expectedJob(), runnerLabels: ["different-label"] }], "different-job"],
      ["active", [expectedJob(), { ...expectedJob(), githubJobId: "33002" }], "ambiguous-job"],
      [
        "active",
        [
          expectedJob(),
          {
            ...expectedJob(),
            githubJobId: "33002",
            jobName: "Another job",
          },
        ],
        "ambiguous-job",
      ],
    ];
    for (const [runState, jobs, reason] of cases) {
      const { allocation, ledger } = await assignedBlacksmith();
      const before = ledger.getCounterSnapshot("blacksmith", "2026-08-25");
      const engine = engineFor(ledger, observation(allocation, jobs, runState));
      assert.deepEqual(await engine.reconcileAllocation(allocation.allocationId), {
        incidentRequired: true,
        outcome: "binding-failed",
        reason,
      });
      const persisted = await ledger.getAllocation(allocation.allocationId);
      assert.deepEqual(persisted?.workloadBinding, { reason, state: "binding-failed" });
      assert.equal(persisted?.attempts.length, 2);
      assert.deepEqual(ledger.getCounterSnapshot("blacksmith", "2026-08-25"), before);
      assert.equal(persisted?.attempts[1]?.reservation.state, "held");

      const retry = engineFor(ledger, observation(allocation, [expectedJob()]));
      assert.deepEqual(await retry.reconcileAllocation(allocation.allocationId), {
        incidentRequired: true,
        outcome: "binding-failed",
        reason,
      });
    }
  });

  it("rejects mismatched run-attempt evidence as controller unavailable", async () => {
    const { allocation, ledger } = await assignedBlacksmith();
    const mismatched = {
      ...observation(allocation, [expectedJob()]),
      runAttempt: 2,
    };
    await assert.rejects(
      () => engineFor(ledger, mismatched).reconcileAllocation(allocation.allocationId),
      hasCorrelationCode("controller-unavailable"),
    );
    assert.equal(
      (await ledger.getAllocation(allocation.allocationId))?.workloadBinding.state,
      "awaiting-correlation",
    );
  });

  it("recovers a lost persistence response without observing or reserving again", async () => {
    const { allocation, ledger } = await assignedBlacksmith();
    let observations = 0;
    let loseResponse = true;
    const wrapped = new Proxy(ledger, {
      get(target, property, receiver) {
        if (property === "updateAllocationState") {
          return async (
            ...arguments_: Parameters<AllocationControlLedger["updateAllocationState"]>
          ) => {
            const result = await target.updateAllocationState(...arguments_);
            if (loseResponse) {
              loseResponse = false;
              throw new Error("lost response");
            }
            return result;
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as AllocationControlLedger;
    const observationsPort = {
      observe: async () => {
        observations += 1;
        return observation(allocation, [expectedJob()]);
      },
    };
    await assert.rejects(
      () =>
        new BlacksmithManagedCorrelationEngine({
          ledger: wrapped,
          now: () => new Date(NOW),
          observations: observationsPort,
        }).reconcileAllocation(allocation.allocationId),
      hasCorrelationCode("controller-unavailable"),
    );
    assert.deepEqual((await ledger.getAllocation(allocation.allocationId))?.workloadBinding, {
      githubJobId: "33001",
      state: "bound",
    });
    assert.deepEqual(
      await new BlacksmithManagedCorrelationEngine({
        ledger,
        observations: observationsPort,
      }).reconcileAllocation(allocation.allocationId),
      { githubJobId: "33001", outcome: "bound" },
    );
    assert.equal(observations, 1);
    assert.equal(ledger.getCounterSnapshot("blacksmith", "2026-08-25").activeReservations, 1);
  });
});

async function assignedBlacksmith() {
  const ledger = initialisedLedger();
  const trust = verifiedTrust();
  let allocation = (
    await ledger.acceptAllocation({
      acceptedAt: NOW,
      checkRunAppSlug: "switchyard",
      evidence: {
        request: {
          backupChoice: trust.workload.backupChoice,
          profile: trust.workload.profile,
        },
        trust,
      },
    })
  ).allocation;
  const lease = await ledger.acquireCheckRunCreationLease({
    ...allocation.checkRunCreation.key,
    acquiredAt: NOW,
    leaseExpiresAt: "2026-08-25T12:01:00.000Z",
    leaseOwner: "correlation-test",
  });
  assert.equal(lease.outcome, "acquired");
  if (lease.outcome !== "acquired") throw new Error("lease unavailable");
  allocation = await ledger.completeCheckRunCreation({
    allocationId: allocation.allocationId,
    checkRunId: "7001",
    completedAt: NOW,
    leaseOwner: lease.leaseOwner,
    leaseRevision: lease.leaseRevision,
  });
  ledger.unsafeSetCounterState("azure", "2026-08-25", {
    accountedDailyCostUsdCents: 0,
    activeReservations: 3,
  });
  allocation = (
    await ledger.reserveProviderAttempt({
      allocationId: allocation.allocationId,
      attemptedAt: NOW,
      deadlines: {
        absoluteExpiry: "2026-08-25T12:45:00.000Z",
        computeDeadline: "2026-08-25T12:40:00.000Z",
        latestSafeStart: "2026-08-25T12:10:00.000Z",
      },
      expectedAllocationRevision: allocation.revision,
      ordinal: 1,
      provider: "azure",
      worstCaseCostUsdCents: 100,
    })
  ).allocation;
  const blacksmith = await ledger.reserveProviderAttempt({
    allocationId: allocation.allocationId,
    attemptedAt: NOW,
    deadlines: null,
    expectedAllocationRevision: allocation.revision,
    ordinal: 2,
    provider: "blacksmith",
    worstCaseCostUsdCents: 125,
  });
  assert.equal(blacksmith.outcome, "reserved");
  allocation = await ledger.markProviderAttemptSucceeded({
    allocationId: allocation.allocationId,
    expectedAllocationRevision: blacksmith.allocation.revision,
    expectedAttemptRevision: blacksmith.attempt.revision,
    ordinal: 2,
    succeededAt: NOW,
  });
  allocation = await ledger.assignRunner({
    allocationId: allocation.allocationId,
    assignment: {
      assignedAt: NOW,
      attemptOrdinal: 2,
      provider: "blacksmith",
      runnerLabel: "blacksmith-4vcpu-ubuntu-2404",
    },
    expectedAllocationRevision: allocation.revision,
  });
  return { allocation, ledger };
}

function expectedJob(): ManagedJobObservation {
  return {
    githubJobId: "33001",
    jobName: "Example approved build",
    runnerLabels: ["blacksmith-4vcpu-ubuntu-2404"],
  };
}

function observation(
  allocation: AllocationRecord,
  jobs: ManagedRunObservation["jobs"],
  state: ManagedRunObservation["state"] = "active",
): ManagedRunObservation {
  return {
    jobs,
    repositoryId: allocation.identity.repository_id,
    runAttempt: allocation.identity.run_attempt,
    runId: allocation.identity.run_id,
    state,
  };
}

function engineFor(ledger: AllocationControlLedger, observed: ManagedRunObservation) {
  return new BlacksmithManagedCorrelationEngine({
    ledger,
    now: () => new Date(NOW),
    observations: { observe: async () => observed },
  });
}

function hasCorrelationCode(code: BlacksmithCorrelationError["code"]) {
  return (error: unknown): boolean =>
    error instanceof BlacksmithCorrelationError && error.code === code;
}
