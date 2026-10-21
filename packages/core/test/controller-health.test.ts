import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  evaluateControllerReadiness,
  evaluateControllerReadinessFromHeartbeat,
  type ControllerHealthSnapshot,
} from "../src/index.js";
import {
  createInitialisedInMemoryLedgerStore,
  InMemoryAllocationLedger,
  IN_MEMORY_LEDGER_SCHEMA_VERSION,
} from "../src/testing/index.js";

const HEALTHY: ControllerHealthSnapshot = {
  switchyardApi: "available",
  authoritativeLedger: "available",
  trustVerification: "verified",
  doppler: "available",
  reconciler: { lastSucceededAt: "2026-08-25T12:00:00.000Z" },
};
const NOW = new Date("2026-08-25T12:01:00.000Z");

const REQUIRED_COMPONENTS = [
  "switchyardApi",
  "authoritativeLedger",
  "trustVerification",
  "doppler",
  "reconciler",
] as const;

describe("controller readiness", () => {
  it("is healthy only when every required component has its one healthy value", () => {
    assert.deepEqual(evaluateControllerReadiness(HEALTHY, NOW), { ready: true });
  });

  it("fails closed for every missing health component", () => {
    for (const component of REQUIRED_COMPONENTS) {
      const missing = { ...HEALTHY } as Record<string, unknown>;
      delete missing[component];
      assertControllerUnavailable(evaluateControllerReadiness(missing, NOW), component);
    }
  });

  it("fails closed for unknown, unavailable or degraded runtime values", () => {
    const unhealthyValues: ReadonlyArray<[string, unknown]> = [
      ["switchyardApi", { ...HEALTHY, switchyardApi: "degraded" }],
      ["authoritativeLedger", { ...HEALTHY, authoritativeLedger: "unknown" }],
      ["trustVerification", { ...HEALTHY, trustVerification: "unavailable" }],
      ["doppler", { ...HEALTHY, doppler: "unavailable" }],
    ];

    for (const [component, value] of unhealthyValues) {
      assertControllerUnavailable(evaluateControllerReadiness(value, NOW), component);
    }
  });

  it("fails closed for extra fields and non-object transport values", () => {
    assertControllerUnavailable(
      evaluateControllerReadiness({ ...HEALTHY, optionalDependency: "available" }, NOW),
      "extra field",
    );
    assertControllerUnavailable(evaluateControllerReadiness(undefined, NOW), "undefined");
    assertControllerUnavailable(evaluateControllerReadiness([], NOW), "array");
    assertControllerUnavailable(
      evaluateControllerReadiness(Object.create(HEALTHY), NOW),
      "inherited values",
    );

    let getterCalled = false;
    const accessor = { ...HEALTHY } as Record<string, unknown>;
    Object.defineProperty(accessor, "doppler", {
      enumerable: true,
      get: () => {
        getterCalled = true;
        return "available";
      },
    });
    assertControllerUnavailable(evaluateControllerReadiness(accessor, NOW), "accessor value");
    assert.equal(getterCalled, false);

    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, HEALTHY, {
      reconciler: Object.assign(Object.create(null) as Record<string, unknown>, HEALTHY.reconciler),
    });
    assert.deepEqual(evaluateControllerReadiness(nullPrototype, NOW), { ready: true });
  });

  it("keeps optional D1 reporting telemetry outside controller health", () => {
    assert.deepEqual(evaluateControllerReadiness(HEALTHY, NOW), { ready: true });

    const attemptedReportingDependency = {
      ...HEALTHY,
      d1Reporting: "unavailable",
    };
    const readiness = evaluateControllerReadiness(attemptedReportingDependency, NOW);
    assert.equal(readiness.ready, false);
    if (!readiness.ready) {
      assert.equal(readiness.failure.code, "controller-health-invalid");
    }
  });

  it("classifies an explicit failed trust check as a security failure", () => {
    const readiness = evaluateControllerReadiness({ ...HEALTHY, trustVerification: "failed" }, NOW);

    assert.equal(readiness.ready, false);
    if (!readiness.ready) {
      assert.equal(readiness.failure.classification, "security-failure");
      assert.equal(readiness.failure.code, "trust-verification-failed");
    }
  });

  it("accepts the exact 150-second boundary and fails closed one millisecond later", () => {
    const heartbeat = { ...HEALTHY, reconciler: { lastSucceededAt: "2026-08-25T12:00:00.000Z" } };
    assert.deepEqual(evaluateControllerReadiness(heartbeat, new Date("2026-08-25T12:02:30.000Z")), {
      ready: true,
    });
    const stale = evaluateControllerReadiness(heartbeat, new Date("2026-08-25T12:02:30.001Z"));
    assert.equal(stale.ready, false);
    if (!stale.ready) {
      assert.equal(stale.failure.code, "reconciler-heartbeat-stale");
    }
  });

  it("rejects malformed, future and ambiguous reconciler evidence", () => {
    for (const reconciler of [
      undefined,
      { lastSucceededAt: "not-a-time" },
      { lastSucceededAt: "2026-08-25T12:01:00.001Z" },
      { lastSucceededAt: "2026-08-25T12:00:00.000Z", extra: true },
    ]) {
      assertControllerUnavailable(
        evaluateControllerReadiness({ ...HEALTHY, reconciler }, NOW),
        "reconciler evidence",
      );
    }
    assertControllerUnavailable(
      evaluateControllerReadiness(HEALTHY, new Date("invalid")),
      "controller clock",
    );
  });

  it("feeds the 150-second health contract from durable heartbeat storage", async () => {
    const evidence = {
      initialisedAt: "2026-08-25T00:00:00.000Z",
      ledgerInstanceId: "heartbeat-health-test",
      schemaVersion: IN_MEMORY_LEDGER_SCHEMA_VERSION,
      utcDay: "2026-08-25",
    } as const;
    const ledger = new InMemoryAllocationLedger(
      createInitialisedInMemoryLedgerStore(evidence),
      evidence,
    );
    const dependencies = {
      switchyardApi: HEALTHY.switchyardApi,
      authoritativeLedger: HEALTHY.authoritativeLedger,
      trustVerification: HEALTHY.trustVerification,
      doppler: HEALTHY.doppler,
    } as const;
    const missing = await evaluateControllerReadinessFromHeartbeat(dependencies, ledger, NOW);
    assert.equal(missing.ready, false);
    await ledger.recordReconcilerHeartbeat({ lastSucceededAt: "2026-08-25T12:00:00.000Z" });
    assert.deepEqual(
      await evaluateControllerReadinessFromHeartbeat(
        dependencies,
        ledger,
        new Date("2026-08-25T12:02:30.000Z"),
      ),
      { ready: true },
    );
    const stale = await evaluateControllerReadinessFromHeartbeat(
      dependencies,
      ledger,
      new Date("2026-08-25T12:02:30.001Z"),
    );
    assert.equal(stale.ready, false);
    if (!stale.ready) assert.equal(stale.failure.code, "reconciler-heartbeat-stale");
  });
});

function assertControllerUnavailable(
  readiness: ReturnType<typeof evaluateControllerReadiness>,
  context: string,
): void {
  assert.equal(readiness.ready, false, context);
  if (!readiness.ready) {
    assert.equal(readiness.failure.classification, "controller-unavailable", context);
  }
}
