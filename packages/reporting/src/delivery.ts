import {
  createUsageRecordContract,
  V1_USAGE_RECORD_CONTRACT,
  type ApprovedReportingDimensions,
  type UsageRecord,
} from "./usage-record.js";

export const MAXIMUM_TELEMETRY_ATTEMPTS = 3;
export const DEFAULT_ATTEMPT_TIMEOUT_MILLISECONDS = 2_000;
export const DEFAULT_OVERALL_TIMEOUT_MILLISECONDS = 5_000;

export type UsageRecordWriteResult = "stored" | "replayed" | "conflict";

export interface UsageRecordWriteContext {
  readonly signal: AbortSignal;
}

export interface UsageRecordSink {
  write(
    idempotencyKey: string,
    record: UsageRecord,
    context: UsageRecordWriteContext,
  ): Promise<UsageRecordWriteResult>;
}

export interface DeliveryClock {
  clearTimeout(handle: unknown): void;
  nowMilliseconds(): number;
  setTimeout(callback: () => void, delayMilliseconds: number): unknown;
}

export interface BestEffortDeliveryOptions {
  readonly approvedDimensions?: readonly ApprovedReportingDimensions[];
  readonly clock?: DeliveryClock;
  readonly maximumAttempts?: number;
  readonly overallTimeoutMilliseconds?: number;
  readonly perAttemptTimeoutMilliseconds?: number;
  readonly signal?: AbortSignal;
}

export type BestEffortDeliveryResult =
  | {
      readonly attempts: number;
      readonly status: "delivered";
      readonly write: "stored" | "replayed";
    }
  | {
      readonly attempts: number;
      readonly disposition: "discard-and-alert";
      readonly reason:
        | "delivery-aborted"
        | "idempotency-conflict"
        | "invalid-telemetry"
        | "telemetry-timeout"
        | "telemetry-unavailable";
      readonly status: "discarded";
      readonly timeoutScope?: "attempt" | "overall";
    };

const SYSTEM_CLOCK: DeliveryClock = {
  clearTimeout(handle: unknown): void {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
  nowMilliseconds(): number {
    return Date.now();
  },
  setTimeout(callback: () => void, delayMilliseconds: number): unknown {
    return globalThis.setTimeout(callback, delayMilliseconds);
  },
};

type AttemptOutcome =
  | { readonly kind: "aborted" }
  | { readonly kind: "error" }
  | { readonly kind: "timeout"; readonly scope: "attempt" | "overall" }
  | { readonly kind: "write"; readonly write: UsageRecordWriteResult };

export async function deliverUsageRecordBestEffort(
  sink: UsageRecordSink,
  idempotencyKey: string,
  value: unknown,
  options: BestEffortDeliveryOptions = {},
): Promise<BestEffortDeliveryResult> {
  const maximumAttempts = requireAttemptCount(
    options.maximumAttempts ?? MAXIMUM_TELEMETRY_ATTEMPTS,
  );
  const perAttemptTimeoutMilliseconds = requireTimeout(
    options.perAttemptTimeoutMilliseconds ?? DEFAULT_ATTEMPT_TIMEOUT_MILLISECONDS,
    "per-attempt telemetry timeout",
  );
  const overallTimeoutMilliseconds = requireTimeout(
    options.overallTimeoutMilliseconds ?? DEFAULT_OVERALL_TIMEOUT_MILLISECONDS,
    "overall telemetry timeout",
  );
  const clock = options.clock ?? SYSTEM_CLOCK;
  const startedAt = requireClockTime(clock.nowMilliseconds());
  const overallDeadline = addTimeout(startedAt, overallTimeoutMilliseconds);
  const usageRecordContract =
    options.approvedDimensions === undefined
      ? V1_USAGE_RECORD_CONTRACT
      : createUsageRecordContract(options.approvedDimensions);
  const externalSignal = options.signal;

  let record: UsageRecord;
  let validatedKey: string;
  try {
    record = usageRecordContract.parse(value);
    validatedKey = parseIdempotencyKey(idempotencyKey);
  } catch {
    return discarded("invalid-telemetry", 0);
  }

  if (isAborted(externalSignal)) {
    return discarded("delivery-aborted", 0);
  }

  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const attemptStartedAt = requireClockTime(clock.nowMilliseconds());
    if (attemptStartedAt >= overallDeadline) {
      return timedOut(attempt - 1, "overall");
    }
    const attemptDeadline = Math.min(
      addTimeout(attemptStartedAt, perAttemptTimeoutMilliseconds),
      overallDeadline,
    );
    const timeoutScope = attemptDeadline === overallDeadline ? "overall" : "attempt";
    const outcome = await runAttempt(
      sink,
      validatedKey,
      record,
      clock,
      attemptDeadline,
      timeoutScope,
      externalSignal,
    );

    if (outcome.kind === "aborted") {
      return discarded("delivery-aborted", attempt);
    }
    if (outcome.kind === "timeout") {
      if (outcome.scope === "overall" || attempt === maximumAttempts) {
        return timedOut(attempt, outcome.scope);
      }
      continue;
    }
    if (outcome.kind === "write") {
      if (outcome.write === "conflict") {
        return discarded("idempotency-conflict", attempt);
      }
      return { status: "delivered", write: outcome.write, attempts: attempt };
    }

    if (isAborted(externalSignal)) {
      return discarded("delivery-aborted", attempt);
    }
    if (requireClockTime(clock.nowMilliseconds()) >= overallDeadline) {
      return timedOut(attempt, "overall");
    }
    if (attempt === maximumAttempts) {
      return discarded("telemetry-unavailable", attempt);
    }
  }

  return discarded("telemetry-unavailable", maximumAttempts);
}

export function parseIdempotencyKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 200 ||
    !/^[A-Za-z0-9._:-]+$/.test(value)
  ) {
    throw new TypeError(
      "idempotency key must contain 1 to 200 letters, digits, dots, underscores, colons or hyphens",
    );
  }
  return value;
}

async function runAttempt(
  sink: UsageRecordSink,
  idempotencyKey: string,
  record: UsageRecord,
  clock: DeliveryClock,
  deadline: number,
  timeoutScope: "attempt" | "overall",
  externalSignal: AbortSignal | undefined,
): Promise<AttemptOutcome> {
  const attemptController = new AbortController();
  let timeoutHandle: unknown;
  let removeExternalAbortListener = (): void => {};

  const timeout = new Promise<AttemptOutcome>((resolve) => {
    const remaining = Math.max(0, deadline - requireClockTime(clock.nowMilliseconds()));
    timeoutHandle = clock.setTimeout(() => {
      resolve({ kind: "timeout", scope: timeoutScope });
      attemptController.abort(new Error(`reporting ${timeoutScope} timeout`));
    }, remaining);
  });

  const externalAbort = new Promise<AttemptOutcome>((resolve) => {
    if (externalSignal === undefined) {
      return;
    }
    const abort = (): void => {
      resolve({ kind: "aborted" });
      attemptController.abort(externalSignal.reason);
    };
    if (externalSignal.aborted) {
      abort();
      return;
    }
    externalSignal.addEventListener("abort", abort, { once: true });
    removeExternalAbortListener = (): void => {
      externalSignal.removeEventListener("abort", abort);
    };
  });

  const operation = Promise.resolve()
    .then(() => sink.write(idempotencyKey, record, { signal: attemptController.signal }))
    .then(
      (write): AttemptOutcome => ({ kind: "write", write }),
      (): AttemptOutcome => ({ kind: "error" }),
    );

  const outcome = await Promise.race([operation, timeout, externalAbort]);
  if (timeoutHandle !== undefined) {
    clock.clearTimeout(timeoutHandle);
  }
  removeExternalAbortListener();

  if (outcome.kind === "write" && requireClockTime(clock.nowMilliseconds()) >= deadline) {
    attemptController.abort(new Error(`reporting ${timeoutScope} timeout`));
    return { kind: "timeout", scope: timeoutScope };
  }
  return outcome;
}

function discarded(
  reason: Exclude<BestEffortDeliveryResult, { status: "delivered" }>["reason"],
  attempts: number,
): BestEffortDeliveryResult {
  return { status: "discarded", disposition: "discard-and-alert", reason, attempts };
}

function timedOut(attempts: number, timeoutScope: "attempt" | "overall"): BestEffortDeliveryResult {
  return {
    status: "discarded",
    disposition: "discard-and-alert",
    reason: "telemetry-timeout",
    timeoutScope,
    attempts,
  };
}

function requireAttemptCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAXIMUM_TELEMETRY_ATTEMPTS) {
    throw new TypeError(
      `maximum telemetry attempts must be between 1 and ${MAXIMUM_TELEMETRY_ATTEMPTS}`,
    );
  }
  return value;
}

function requireTimeout(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function requireClockTime(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("telemetry clock must return a non-negative safe integer");
  }
  return value;
}

function addTimeout(time: number, timeout: number): number {
  const result = time + timeout;
  if (!Number.isSafeInteger(result)) {
    throw new TypeError("telemetry deadline exceeds the safe clock range");
  }
  return result;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
