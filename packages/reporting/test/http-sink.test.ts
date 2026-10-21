import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createReportingHttpSink, type DeliveryClock } from "../src/index.js";
import { usageRecord } from "./fixture.js";

class FakeClock implements DeliveryClock {
  #nextHandle = 1;
  #now = 0;
  readonly #timers = new Map<
    number,
    { readonly callback: () => void; readonly deadline: number }
  >();

  clearTimeout(handle: unknown): void {
    if (typeof handle !== "number") {
      throw new TypeError("fake clock received a non-numeric timer handle");
    }
    this.#timers.delete(handle);
  }

  nowMilliseconds(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, delayMilliseconds: number): unknown {
    const handle = this.#nextHandle;
    this.#nextHandle += 1;
    this.#timers.set(handle, { callback, deadline: this.#now + delayMilliseconds });
    return handle;
  }

  advanceBy(milliseconds: number): void {
    const target = this.#now + milliseconds;
    while (true) {
      const next = [...this.#timers.entries()]
        .filter(([, timer]) => timer.deadline <= target)
        .sort((left, right) => left[1].deadline - right[1].deadline)[0];
      if (next === undefined) {
        break;
      }
      const [handle, timer] = next;
      this.#now = timer.deadline;
      this.#timers.delete(handle);
      timer.callback();
    }
    this.#now = target;
  }

  get pendingTimers(): number {
    return this.#timers.size;
  }
}

describe("Access-protected reporting HTTP sink", () => {
  it("takes credentials only at runtime and sends the strict operation", async () => {
    let capturedRequest: Request | undefined;
    const sink = createReportingHttpSink({
      baseUrl: "https://reporting.example.test",
      credentials: { clientId: "runtime-client", clientSecret: "runtime-secret" },
      fetch: async (input, init) => {
        capturedRequest = new Request(input, init);
        return Response.json({ status: "created" }, { status: 201 });
      },
    });

    assert.deepEqual(await sink.deliver("allocation:123", usageRecord()), {
      status: "delivered",
      write: "stored",
      attempts: 1,
    });
    assert.equal(capturedRequest?.url, "https://reporting.example.test/v1/usage-records");
    assert.equal(capturedRequest?.method, "POST");
    assert.equal(capturedRequest?.headers.get("CF-Access-Client-Id"), "runtime-client");
    assert.equal(capturedRequest?.headers.get("CF-Access-Client-Secret"), "runtime-secret");
    assert.equal(capturedRequest?.headers.get("Idempotency-Key"), "allocation:123");
    assert.deepEqual(await capturedRequest?.json(), usageRecord());
  });

  it("maps only fixed write responses and turns other HTTP results into discard-and-alert", async () => {
    for (const [status, expected] of [
      [200, { status: "delivered", write: "replayed", attempts: 1 }],
      [201, { status: "delivered", write: "stored", attempts: 1 }],
      [
        409,
        {
          status: "discarded",
          disposition: "discard-and-alert",
          reason: "idempotency-conflict",
          attempts: 1,
        },
      ],
    ] as const) {
      const sink = createReportingHttpSink({
        baseUrl: "https://reporting.example.test",
        credentials: { clientId: "runtime-client", clientSecret: "runtime-secret" },
        fetch: async () => new Response(null, { status }),
      });
      assert.deepEqual(await sink.deliver("allocation:123", usageRecord()), expected);
    }

    let attempts = 0;
    const unavailable = createReportingHttpSink({
      baseUrl: "https://reporting.example.test",
      credentials: { clientId: "runtime-client", clientSecret: "runtime-secret" },
      fetch: async () => {
        attempts += 1;
        return new Response(null, { status: 503 });
      },
    });
    assert.deepEqual(await unavailable.deliver("allocation:123", usageRecord()), {
      status: "discarded",
      disposition: "discard-and-alert",
      reason: "telemetry-unavailable",
      attempts: 3,
    });
    assert.equal(attempts, 3);
  });

  it("retries a failed request and never exceeds three attempts", async () => {
    const responses = [503, 201];
    let attempts = 0;
    const retrying = createReportingHttpSink({
      baseUrl: "https://reporting.example.test",
      credentials: { clientId: "runtime-client", clientSecret: "runtime-secret" },
      fetch: async () => {
        attempts += 1;
        return new Response(null, { status: responses.shift() ?? 503 });
      },
    });

    assert.deepEqual(await retrying.deliver("allocation:123", usageRecord()), {
      status: "delivered",
      write: "stored",
      attempts: 2,
    });
    assert.equal(attempts, 2);
  });

  it("returns after a per-attempt deadline when fetch never resolves and ignores abort", async () => {
    const clock = new FakeClock();
    const signals: AbortSignal[] = [];
    const sink = createReportingHttpSink({
      baseUrl: "https://reporting.example.test",
      credentials: { clientId: "runtime-client", clientSecret: "runtime-secret" },
      clock,
      maximumAttempts: 1,
      perAttemptTimeoutMilliseconds: 10,
      overallTimeoutMilliseconds: 100,
      fetch: async (_input, init) => {
        assert.ok(init?.signal instanceof AbortSignal);
        signals.push(init.signal);
        return new Promise<Response>(() => {});
      },
    });

    const result = sink.deliver("allocation:123", usageRecord());
    await flushMicrotasks();
    assert.equal(signals.length, 1);
    clock.advanceBy(10);
    await flushMicrotasks();

    assert.deepEqual(await result, {
      status: "discarded",
      disposition: "discard-and-alert",
      reason: "telemetry-timeout",
      timeoutScope: "attempt",
      attempts: 1,
    });
    assert.equal(signals[0]?.aborted, true);
    assert.equal(clock.pendingTimers, 0);
  });

  it("caps three never-resolving attempts at the overall wall-clock deadline", async () => {
    const clock = new FakeClock();
    const signals: AbortSignal[] = [];
    const sink = createReportingHttpSink({
      baseUrl: "https://reporting.example.test",
      credentials: { clientId: "runtime-client", clientSecret: "runtime-secret" },
      clock,
      maximumAttempts: 3,
      perAttemptTimeoutMilliseconds: 100,
      overallTimeoutMilliseconds: 250,
      fetch: async (_input, init) => {
        assert.ok(init?.signal instanceof AbortSignal);
        signals.push(init.signal);
        return new Promise<Response>(() => {});
      },
    });

    const result = sink.deliver("allocation:123", usageRecord());
    await flushMicrotasks();
    clock.advanceBy(100);
    await flushMicrotasks();
    clock.advanceBy(100);
    await flushMicrotasks();
    clock.advanceBy(50);
    await flushMicrotasks();

    assert.deepEqual(await result, {
      status: "discarded",
      disposition: "discard-and-alert",
      reason: "telemetry-timeout",
      timeoutScope: "overall",
      attempts: 3,
    });
    assert.equal(clock.nowMilliseconds(), 250);
    assert.equal(signals.length, 3);
    assert.equal(
      signals.every((signal) => signal.aborted),
      true,
    );
    assert.equal(clock.pendingTimers, 0);
  });

  it("classifies an external abort and releases the caller even when fetch ignores it", async () => {
    const clock = new FakeClock();
    const external = new AbortController();
    let attemptSignal: AbortSignal | undefined;
    const sink = createReportingHttpSink({
      baseUrl: "https://reporting.example.test",
      credentials: { clientId: "runtime-client", clientSecret: "runtime-secret" },
      clock,
      fetch: async (_input, init) => {
        assert.ok(init?.signal instanceof AbortSignal);
        attemptSignal = init.signal;
        return new Promise<Response>(() => {});
      },
    });

    const result = sink.deliver("allocation:123", usageRecord(), { signal: external.signal });
    await flushMicrotasks();
    external.abort(new Error("controller cleanup is continuing"));
    await flushMicrotasks();

    assert.deepEqual(await result, {
      status: "discarded",
      disposition: "discard-and-alert",
      reason: "delivery-aborted",
      attempts: 1,
    });
    assert.equal(attemptSignal?.aborted, true);
    assert.equal(clock.pendingTimers, 0);
  });

  it("observes a late rejection after timeout so it cannot become unhandled", async () => {
    const clock = new FakeClock();
    let rejectFetch: ((error: Error) => void) | undefined;
    const sink = createReportingHttpSink({
      baseUrl: "https://reporting.example.test",
      credentials: { clientId: "runtime-client", clientSecret: "runtime-secret" },
      clock,
      maximumAttempts: 1,
      perAttemptTimeoutMilliseconds: 10,
      overallTimeoutMilliseconds: 20,
      fetch: async () =>
        new Promise<Response>((_resolve, reject) => {
          rejectFetch = reject;
        }),
    });

    const result = sink.deliver("allocation:123", usageRecord());
    await flushMicrotasks();
    clock.advanceBy(10);
    await flushMicrotasks();
    assert.equal((await result).status, "discarded");

    assert.ok(rejectFetch);
    rejectFetch(new Error("late network failure"));
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it("rejects embedded credentials, non-HTTPS endpoints and invalid deadline settings", async () => {
    assert.throws(() =>
      createReportingHttpSink({
        baseUrl: "http://reporting.example.test",
        credentials: { clientId: "id", clientSecret: "secret" },
      }),
    );
    assert.throws(() =>
      createReportingHttpSink({
        baseUrl: "https://user:password@reporting.example.test",
        credentials: { clientId: "id", clientSecret: "secret" },
      }),
    );
    assert.throws(() =>
      createReportingHttpSink({
        baseUrl: "https://reporting.example.test",
        credentials: { clientId: "id", clientSecret: "" },
      }),
    );

    const invalidDeadline = createReportingHttpSink({
      baseUrl: "https://reporting.example.test",
      credentials: { clientId: "id", clientSecret: "secret" },
      maximumAttempts: 4,
    });
    await assert.rejects(
      () => invalidDeadline.deliver("allocation:123", usageRecord()),
      /between 1 and 3/,
    );
  });
});

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}
