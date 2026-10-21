import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyCheckRunDeliverySuccess,
  initialiseCheckRunDelivery,
  parseSwitchyardCheckRunSnapshot,
  planCheckRunDelivery,
  scheduleCheckRunRetry,
  type CheckRunDeliveryRecord,
  type SwitchyardCheckRunSnapshot,
  validateCheckRunDeliveryTransition,
} from "../src/index.js";

const HEAD_SHA = "89abcdef0123456789abcdef0123456789abcdef";

const ACCEPTED: SwitchyardCheckRunSnapshot = {
  allocationId: "allocation-123",
  headSha: HEAD_SHA,
  revision: 0,
  stage: "accepted",
  provider: null,
  durationSeconds: null,
  estimatedCostUsdCents: null,
  fallbackUsed: null,
  cleanupResult: null,
  workloadOutcome: null,
};

const PROVIDER_SELECTED: SwitchyardCheckRunSnapshot = {
  ...ACCEPTED,
  revision: 1,
  stage: "provider-selected",
  provider: "azure",
  fallbackUsed: false,
};

const ENDED: SwitchyardCheckRunSnapshot = {
  ...PROVIDER_SELECTED,
  revision: 3,
  stage: "ended",
  durationSeconds: 1200,
  estimatedCostUsdCents: 42,
  cleanupResult: "succeeded",
  workloadOutcome: "succeeded",
};

describe("Switchyard Check Run lifecycle", () => {
  it("creates on acceptance, updates through reconciliation and concludes only when ended", () => {
    const initial = initialiseCheckRunDelivery({
      allocationId: ACCEPTED.allocationId,
      headSha: ACCEPTED.headSha,
    });
    const create = planCheckRunDelivery(initial, ACCEPTED);
    assert.equal(create.operation, "create");
    assert.notEqual(create.operation, "noop");

    const created = applyCheckRunDeliverySuccess(initial, create, "991");
    const update = planCheckRunDelivery(created, PROVIDER_SELECTED);
    assert.equal(update.operation, "update");
    assert.notEqual(update.operation, "noop");

    const updated = applyCheckRunDeliverySuccess(created, update, "991");
    const conclude = planCheckRunDelivery(updated, ENDED);
    assert.equal(conclude.operation, "conclude");
    assert.notEqual(conclude.operation, "noop");

    const concluded = applyCheckRunDeliverySuccess(updated, conclude, "991");
    assert.equal(concluded.lifecycle.phase, "concluded");
    assert.equal(concluded.retry, null);
  });

  it("treats an exact publication retry as an idempotent no-op", () => {
    const created = createdRecord();

    assert.deepEqual(planCheckRunDelivery(created, ACCEPTED), { operation: "noop" });
  });

  it("rejects premature conclusion fields, backwards stages and post-conclusion changes", () => {
    assert.throws(
      () =>
        parseSwitchyardCheckRunSnapshot({
          ...PROVIDER_SELECTED,
          workloadOutcome: "succeeded",
        }),
      /cannot publish terminal workload/,
    );
    assert.throws(
      () => parseSwitchyardCheckRunSnapshot({ ...ENDED, cleanupResult: "failed" }),
      /successful settled cleanup/,
    );
    assert.doesNotThrow(() =>
      parseSwitchyardCheckRunSnapshot({
        ...PROVIDER_SELECTED,
        revision: 2,
        stage: "cleanup-pending",
        cleanupResult: "failed",
        workloadOutcome: "succeeded",
      }),
    );

    const created = createdRecord();
    const running = publish(created, {
      ...PROVIDER_SELECTED,
      revision: 2,
      stage: "workload-running",
    });
    assert.throws(
      () => planCheckRunDelivery(running, { ...PROVIDER_SELECTED, revision: 3 }),
      /cannot move.*backwards/,
    );

    const concluded = publish(running, ENDED);
    assert.throws(
      () => planCheckRunDelivery(concluded, { ...ENDED, revision: 4 }),
      /concluded.*cannot be changed/,
    );
  });

  it("keeps API failures as bounded, redacted retry data without changing lifecycle state", () => {
    const initial = initialiseCheckRunDelivery({
      allocationId: ACCEPTED.allocationId,
      headSha: ACCEPTED.headSha,
    });
    const failure = {
      classification: "github-api-failure",
      code: "github-api-503",
      status: 503,
      requestId: "request-123",
      retryable: true,
    } as const;

    const first = scheduleCheckRunRetry(
      initial,
      "create",
      failure,
      new Date("2026-01-01T00:00:00Z"),
    );
    const second = scheduleCheckRunRetry(
      first,
      "create",
      failure,
      new Date("2026-01-01T00:01:00Z"),
    );
    const third = scheduleCheckRunRetry(
      second,
      "create",
      failure,
      new Date("2026-01-01T00:06:00Z"),
    );

    assert.deepEqual(first.lifecycle, initial.lifecycle);
    assert.equal(first.retry?.notBefore, "2026-01-01T00:01:00.000Z");
    assert.equal(second.retry?.attempt, 2);
    assert.equal(third.retry?.alertRequired, true);
    assert.equal(JSON.stringify(third).includes("secret"), false);
  });

  it("validates authoritative lifecycle revisions and stages independently of reporter planning", () => {
    const created = createdRecord();
    const running = publish(created, {
      ...PROVIDER_SELECTED,
      revision: 3,
      stage: "workload-running",
    });

    assert.deepEqual(validateCheckRunDeliveryTransition(running, running), running);
    assert.throws(
      () =>
        validateCheckRunDeliveryTransition(running, {
          ...running,
          lifecycle: {
            ...running.lifecycle,
            publishedRevision: 2,
            stage: "runner-ready",
          },
        }),
      /publishedRevision.*cannot move backwards/,
    );
    assert.throws(
      () =>
        validateCheckRunDeliveryTransition(running, {
          ...running,
          lifecycle: { ...running.lifecycle, stage: "cleanup-pending" },
        }),
      /identical when reusing a published revision/,
    );
    assert.throws(
      () =>
        validateCheckRunDeliveryTransition(running, {
          ...running,
          lifecycle: {
            ...running.lifecycle,
            publishedRevision: 4,
            stage: "provider-selected",
          },
        }),
      /stage.*cannot move backwards/,
    );

    const concluded = publish(running, { ...ENDED, revision: 4 });
    assert.throws(
      () =>
        validateCheckRunDeliveryTransition(concluded, {
          lifecycle: {
            ...concluded.lifecycle,
            phase: "in-progress",
            publishedRevision: 5,
            stage: "workload-running",
          },
          retry: null,
        }),
      /concluded Check Run cannot return to in-progress/,
    );
  });

  it("validates bounded retry transitions without weakening lifecycle monotonicity", () => {
    const created = createdRecord();
    const failure = {
      classification: "github-api-failure",
      code: "github-api-503",
      status: 503,
      requestId: "request-123",
      retryable: true,
    } as const;
    const first = scheduleCheckRunRetry(
      created,
      "update",
      failure,
      new Date("2026-01-01T00:00:00Z"),
    );
    const firstRetry = first.retry;
    assert.ok(firstRetry);
    assert.deepEqual(validateCheckRunDeliveryTransition(first, first), first);
    assert.throws(
      () => validateCheckRunDeliveryTransition(first, { ...first, retry: null }),
      /cannot be cleared without a successful lifecycle publication/,
    );
    assert.throws(
      () =>
        validateCheckRunDeliveryTransition(first, {
          ...first,
          retry: {
            ...firstRetry,
            alertRequired: true,
            attempt: 3,
            notBefore: "2026-01-01T00:16:00.000Z",
          },
        }),
      /next bounded attempt/,
    );

    const second = scheduleCheckRunRetry(
      first,
      "update",
      failure,
      new Date("2026-01-01T00:01:00Z"),
    );
    assert.equal(second.retry?.attempt, 2);
    const secondRetry = second.retry;
    assert.ok(secondRetry);
    assert.throws(
      () =>
        validateCheckRunDeliveryTransition(second, {
          ...second,
          retry: {
            ...secondRetry,
            alertRequired: true,
            attempt: 3,
            notBefore: secondRetry.notBefore,
          },
        }),
      /notBefore.*must move forward/,
    );

    const conclude = scheduleCheckRunRetry(
      second,
      "conclude",
      failure,
      new Date("2026-01-01T00:07:00Z"),
    );
    assert.equal(conclude.retry?.attempt, 1);
    assert.throws(
      () => scheduleCheckRunRetry(conclude, "update", failure, new Date("2026-01-01T00:08:00Z")),
      /operation.*cannot move backwards/,
    );
  });
});

function createdRecord(): CheckRunDeliveryRecord {
  const initial = initialiseCheckRunDelivery({
    allocationId: ACCEPTED.allocationId,
    headSha: ACCEPTED.headSha,
  });
  const command = planCheckRunDelivery(initial, ACCEPTED);
  assert.notEqual(command.operation, "noop");
  if (command.operation === "noop") {
    throw new Error("expected create command");
  }
  return applyCheckRunDeliverySuccess(initial, command, "991");
}

function publish(
  record: CheckRunDeliveryRecord,
  snapshot: SwitchyardCheckRunSnapshot,
): CheckRunDeliveryRecord {
  const command = planCheckRunDelivery(record, snapshot);
  assert.notEqual(command.operation, "noop");
  if (command.operation === "noop") {
    throw new Error("expected publication command");
  }
  return applyCheckRunDeliverySuccess(record, command, "991");
}
