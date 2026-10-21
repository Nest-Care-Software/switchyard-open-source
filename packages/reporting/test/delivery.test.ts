import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { evaluateControllerReadiness } from "@switchyard/core";

import {
  deliverUsageRecordBestEffort,
  parseIdempotencyKey,
  type UsageRecord,
  type UsageRecordSink,
  type UsageRecordWriteContext,
  type UsageRecordWriteResult,
} from "../src/index.js";
import { usageRecord } from "./fixture.js";

class FakeUsageRecordSink implements UsageRecordSink {
  readonly writes: Array<{ readonly idempotencyKey: string; readonly record: UsageRecord }> = [];
  readonly #results: Array<UsageRecordWriteResult | Error>;

  constructor(results: readonly (UsageRecordWriteResult | Error)[]) {
    this.#results = [...results];
  }

  async write(
    idempotencyKey: string,
    record: UsageRecord,
    _context: UsageRecordWriteContext,
  ): Promise<UsageRecordWriteResult> {
    this.writes.push({ idempotencyKey, record });
    const result = this.#results.shift();
    if (result instanceof Error) {
      throw result;
    }
    if (result === undefined) {
      throw new Error("fake sink has no queued result");
    }
    return result;
  }
}

describe("best-effort telemetry delivery", () => {
  it("delivers a stored record and treats an exact replay as success", async () => {
    for (const write of ["stored", "replayed"] as const) {
      const sink = new FakeUsageRecordSink([write]);
      assert.deepEqual(await deliverUsageRecordBestEffort(sink, "allocation:123", usageRecord()), {
        status: "delivered",
        write,
        attempts: 1,
      });
    }
  });

  it("discards an idempotency conflict without retrying or making a decision", async () => {
    const sink = new FakeUsageRecordSink(["conflict"]);
    assert.deepEqual(await deliverUsageRecordBestEffort(sink, "allocation:123", usageRecord()), {
      status: "discarded",
      disposition: "discard-and-alert",
      reason: "idempotency-conflict",
      attempts: 1,
    });
    assert.equal(sink.writes.length, 1);
  });

  it("bounds D1 outage retries and discards telemetry without throwing", async () => {
    const sink = new FakeUsageRecordSink([
      new Error("D1 offline"),
      new Error("D1 offline"),
      new Error("D1 offline"),
    ]);

    assert.deepEqual(await deliverUsageRecordBestEffort(sink, "allocation:123", usageRecord()), {
      status: "discarded",
      disposition: "discard-and-alert",
      reason: "telemetry-unavailable",
      attempts: 3,
    });
    assert.equal(sink.writes.length, 3);
    assert.deepEqual(
      evaluateControllerReadiness(
        {
          switchyardApi: "available",
          authoritativeLedger: "available",
          trustVerification: "verified",
          doppler: "available",
          reconciler: { lastSucceededAt: "2026-08-25T12:00:00.000Z" },
        },
        new Date("2026-08-25T12:01:00.000Z"),
      ),
      { ready: true },
    );
  });

  it("strictly validates the idempotency key and retry bound before delivery", async () => {
    for (const key of ["", "contains space", "x".repeat(201), "secret=value"]) {
      assert.throws(() => parseIdempotencyKey(key));
      assert.deepEqual(
        await deliverUsageRecordBestEffort(new FakeUsageRecordSink([]), key, usageRecord()),
        {
          status: "discarded",
          disposition: "discard-and-alert",
          reason: "invalid-telemetry",
          attempts: 0,
        },
      );
    }
    assert.deepEqual(
      await deliverUsageRecordBestEffort(new FakeUsageRecordSink([]), "allocation:123", {
        ...usageRecord(),
        machine_sku: "forbidden",
      }),
      {
        status: "discarded",
        disposition: "discard-and-alert",
        reason: "invalid-telemetry",
        attempts: 0,
      },
    );
    const sink = new FakeUsageRecordSink(["stored"]);
    await assert.rejects(() =>
      deliverUsageRecordBestEffort(sink, "allocation:123", usageRecord(), {
        maximumAttempts: 4,
      }),
    );
  });
});
