import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { evaluateProviderLimits, PROVIDER_LIMITS, type ProviderName } from "../src/index.js";

const PROVIDERS: readonly ProviderName[] = ["azure", "blacksmith"];

describe("provider concurrency and daily allowance decisions", () => {
  it("uses the agreed separate V1 limits for both providers", () => {
    assert.deepEqual(PROVIDER_LIMITS, {
      azure: { maximumConcurrentAllocations: 3, dailyAllowanceUsdCents: 500 },
      blacksmith: { maximumConcurrentAllocations: 3, dailyAllowanceUsdCents: 500 },
    });
  });

  it("allows the third concurrent allocation and an exact allowance reservation", () => {
    for (const provider of PROVIDERS) {
      assert.deepEqual(
        evaluateProviderLimits({
          provider,
          state: { activeAllocations: 2, reservedDailyCostUsdCents: 450 },
          estimatedCostUsdCents: 50,
        }),
        { allowed: true },
      );
    }
  });

  it("rejects zero and other non-positive requested costs as invalid configuration", () => {
    for (const estimatedCostUsdCents of [0, -1]) {
      const decision = evaluateProviderLimits({
        provider: "azure",
        state: { activeAllocations: 0, reservedDailyCostUsdCents: 0 },
        estimatedCostUsdCents,
      });

      assert.equal(decision.allowed, false);
      if (!decision.allowed) {
        assert.equal(decision.failure.classification, "invalid-configuration");
        assert.equal(decision.failure.code, "invalid-limit-value");
      }
    }
  });

  it("treats counters exactly at their limits as ordinary unavailable capacity", () => {
    for (const provider of PROVIDERS) {
      const concurrencyDecision = evaluateProviderLimits({
        provider,
        state: { activeAllocations: 3, reservedDailyCostUsdCents: 0 },
        estimatedCostUsdCents: 1,
      });
      assertProviderUnavailable(concurrencyDecision, "concurrency-limit");

      const allowanceDecision = evaluateProviderLimits({
        provider,
        state: { activeAllocations: 0, reservedDailyCostUsdCents: 500 },
        estimatedCostUsdCents: 1,
      });
      assertProviderUnavailable(allowanceDecision, "daily-allowance");
    }
  });

  it("treats authoritative counters above either limit as corrupt controller state", () => {
    for (const provider of PROVIDERS) {
      const overConcurrency = evaluateProviderLimits({
        provider,
        state: { activeAllocations: 4, reservedDailyCostUsdCents: 0 },
        estimatedCostUsdCents: 1,
      });
      assertCorruptState(overConcurrency);

      const overAllowance = evaluateProviderLimits({
        provider,
        state: { activeAllocations: 0, reservedDailyCostUsdCents: 501 },
        estimatedCostUsdCents: 1,
      });
      assertCorruptState(overAllowance);

      const wildlyOverConcurrency = evaluateProviderLimits({
        provider,
        state: {
          activeAllocations: Number.MAX_SAFE_INTEGER + 1,
          reservedDailyCostUsdCents: 0,
        },
        estimatedCostUsdCents: 1,
      });
      assertCorruptState(wildlyOverConcurrency);
    }
  });

  it("classifies a valid request larger than remaining allowance as unavailable", () => {
    const decision = evaluateProviderLimits({
      provider: "azure",
      state: { activeAllocations: 0, reservedDailyCostUsdCents: 499 },
      estimatedCostUsdCents: 2,
    });

    assertProviderUnavailable(decision, "daily-allowance");
  });

  it("treats negative or non-integer counter data as invalid configuration", () => {
    for (const state of [
      { activeAllocations: -1, reservedDailyCostUsdCents: 0 },
      { activeAllocations: 0, reservedDailyCostUsdCents: -1 },
      { activeAllocations: 1.5, reservedDailyCostUsdCents: 0 },
    ]) {
      const decision = evaluateProviderLimits({
        provider: "azure",
        state,
        estimatedCostUsdCents: 1,
      });

      assert.equal(decision.allowed, false);
      if (!decision.allowed) {
        assert.equal(decision.failure.classification, "invalid-configuration");
      }
    }
  });
});

function assertProviderUnavailable(
  decision: ReturnType<typeof evaluateProviderLimits>,
  code: string,
): void {
  assert.equal(decision.allowed, false);
  if (!decision.allowed) {
    assert.equal(decision.failure.classification, "provider-unavailable");
    assert.equal(decision.failure.code, code);
    if (decision.failure.classification === "provider-unavailable") {
      assert.equal(decision.failure.unavailableReason, "capacity-unavailable");
    }
  }
}

function assertCorruptState(decision: ReturnType<typeof evaluateProviderLimits>): void {
  assert.equal(decision.allowed, false);
  if (!decision.allowed) {
    assert.equal(decision.failure.classification, "controller-unavailable");
    assert.equal(decision.failure.code, "authoritative-limit-state-corrupt");
  }
}
