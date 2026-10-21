import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MANAGED_LABEL_CORRELATION_FAILURE_REASONS,
  parseManagedLabelJobCorrelation,
  parseProviderAttemptResult,
} from "../src/index.js";

describe("post-return managed-label job correlation", () => {
  it("represents an allocation awaiting GitHub job correlation", () => {
    assert.deepEqual(parseManagedLabelJobCorrelation({ state: "awaiting-correlation" }), {
      state: "awaiting-correlation",
    });
  });

  it("persists a positive numeric GitHub job ID once correlation succeeds", () => {
    assert.deepEqual(
      parseManagedLabelJobCorrelation({
        state: "correlated",
        persistedGitHubJobId: "12345678901234567890",
      }),
      {
        state: "correlated",
        persistedGitHubJobId: "12345678901234567890",
      },
    );
  });

  it("represents missing, different and ambiguous correlation as binding failures", () => {
    assert.deepEqual(MANAGED_LABEL_CORRELATION_FAILURE_REASONS, [
      "expected-job-missing",
      "different-job",
      "ambiguous-job",
    ]);

    for (const reason of MANAGED_LABEL_CORRELATION_FAILURE_REASONS) {
      assert.deepEqual(parseManagedLabelJobCorrelation({ state: "correlation-failed", reason }), {
        state: "correlation-failed",
        reason,
      });
    }
  });

  it("cannot reinterpret a correlation failure as provider unavailability or fallback", () => {
    const correlation = parseManagedLabelJobCorrelation({
      state: "correlation-failed",
      reason: "ambiguous-job",
    });

    assert.deepEqual(correlation, {
      state: "correlation-failed",
      reason: "ambiguous-job",
    });
    assert.throws(() => parseProviderAttemptResult(correlation), /providerAttemptResult\.outcome/);
  });

  it("strictly rejects malformed correlation transport values", () => {
    const malformedValues: readonly unknown[] = [
      { state: "correlated", persistedGitHubJobId: "0" },
      { state: "correlated", persistedGitHubJobId: -1 },
      { state: "correlated" },
      { state: "awaiting-correlation", persistedGitHubJobId: "99112233" },
      { state: "correlation-failed", reason: "provider-unavailable" },
      { state: "unknown" },
    ];

    for (const value of malformedValues) {
      assert.throws(() => parseManagedLabelJobCorrelation(value));
    }
  });
});
