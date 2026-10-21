import type { ProviderName } from "./provider.js";
import {
  ContractValidationError,
  requireExactKeys,
  requireNonEmptyString,
  requireRecord,
} from "./validation.js";
import { requireFullCommitSha, requirePositiveDecimalString } from "./github-trust.js";

export const SWITCHYARD_CHECK_RUN_STAGES = [
  "accepted",
  "provider-selected",
  "runner-ready",
  "workload-running",
  "cleanup-pending",
  "ended",
] as const;

export type SwitchyardCheckRunStage = (typeof SWITCHYARD_CHECK_RUN_STAGES)[number];
export type SwitchyardWorkloadOutcome =
  | "cancelled"
  | "failed"
  | "never-started"
  | "succeeded"
  | "timed-out";
export type SwitchyardCleanupResult = "failed" | "pending" | "succeeded";

export interface SwitchyardCheckRunSnapshot {
  readonly allocationId: string;
  readonly cleanupResult: SwitchyardCleanupResult | null;
  readonly durationSeconds: number | null;
  readonly estimatedCostUsdCents: number | null;
  readonly fallbackUsed: boolean | null;
  readonly headSha: string;
  readonly provider: ProviderName | null;
  readonly revision: number;
  readonly stage: SwitchyardCheckRunStage;
  readonly workloadOutcome: SwitchyardWorkloadOutcome | null;
}

export type SwitchyardCheckRunLifecycle =
  | {
      readonly allocationId: string;
      readonly headSha: string;
      readonly phase: "not-created";
      readonly publishedRevision: -1;
      readonly stage: null;
    }
  | {
      readonly allocationId: string;
      readonly checkRunId: string;
      readonly headSha: string;
      readonly phase: "in-progress";
      readonly publishedRevision: number;
      readonly stage: Exclude<SwitchyardCheckRunStage, "ended">;
    }
  | {
      readonly allocationId: string;
      readonly checkRunId: string;
      readonly headSha: string;
      readonly phase: "concluded";
      readonly publishedRevision: number;
      readonly stage: "ended";
    };

export type CheckRunDeliveryOperation = "conclude" | "create" | "update";

export interface RedactedCheckRunDeliveryFailure {
  readonly classification: "github-api-failure" | "github-response-invalid";
  readonly code: string;
  readonly requestId: string | null;
  readonly retryable: boolean;
  readonly status: number | null;
}

export interface CheckRunRetry {
  readonly alertRequired: boolean;
  readonly attempt: number;
  readonly failure: RedactedCheckRunDeliveryFailure;
  readonly notBefore: string;
  readonly operation: CheckRunDeliveryOperation;
}

export interface CheckRunDeliveryRecord {
  readonly lifecycle: SwitchyardCheckRunLifecycle;
  readonly retry: CheckRunRetry | null;
}

export type CheckRunDeliveryCommand =
  | { readonly operation: "noop" }
  | {
      readonly operation: CheckRunDeliveryOperation;
      readonly snapshot: SwitchyardCheckRunSnapshot;
    };

const SNAPSHOT_KEYS = [
  "allocationId",
  "headSha",
  "revision",
  "stage",
  "provider",
  "durationSeconds",
  "estimatedCostUsdCents",
  "fallbackUsed",
  "cleanupResult",
  "workloadOutcome",
] as const;
const RETRY_DELAYS_SECONDS = [60, 300, 900, 3600] as const;
export const MAX_CHECK_RUN_DELIVERY_ATTEMPTS = RETRY_DELAYS_SECONDS.length;

export function initialiseCheckRunDelivery(input: {
  readonly allocationId: string;
  readonly headSha: string;
}): CheckRunDeliveryRecord {
  return {
    lifecycle: {
      allocationId: requireNonEmptyString(input.allocationId, "checkRun.allocationId"),
      headSha: requireFullCommitSha(input.headSha, "checkRun.headSha"),
      phase: "not-created",
      publishedRevision: -1,
      stage: null,
    },
    retry: null,
  };
}

export function parseSwitchyardCheckRunSnapshot(value: unknown): SwitchyardCheckRunSnapshot {
  const record = requireRecord(value, "checkRunSnapshot");
  requireExactKeys(record, SNAPSHOT_KEYS, "checkRunSnapshot");

  const snapshot: SwitchyardCheckRunSnapshot = {
    allocationId: requireNonEmptyString(record.allocationId, "checkRunSnapshot.allocationId"),
    headSha: requireFullCommitSha(record.headSha, "checkRunSnapshot.headSha"),
    revision: requireNonNegativeSafeInteger(record.revision, "checkRunSnapshot.revision"),
    stage: parseStage(record.stage),
    provider: parseProvider(record.provider),
    durationSeconds: parseNullableNonNegativeInteger(
      record.durationSeconds,
      "checkRunSnapshot.durationSeconds",
    ),
    estimatedCostUsdCents: parseNullableNonNegativeInteger(
      record.estimatedCostUsdCents,
      "checkRunSnapshot.estimatedCostUsdCents",
    ),
    fallbackUsed: parseNullableBoolean(record.fallbackUsed, "checkRunSnapshot.fallbackUsed"),
    cleanupResult: parseCleanupResult(record.cleanupResult),
    workloadOutcome: parseWorkloadOutcome(record.workloadOutcome),
  };

  validateStageFields(snapshot);
  return snapshot;
}

export function planCheckRunDelivery(
  record: CheckRunDeliveryRecord,
  snapshotValue: unknown,
): CheckRunDeliveryCommand {
  const current = parseCheckRunDeliveryRecord(record);
  const snapshot = parseSwitchyardCheckRunSnapshot(snapshotValue);
  const { lifecycle } = current;
  if (snapshot.allocationId !== lifecycle.allocationId || snapshot.headSha !== lifecycle.headSha) {
    throw new ContractValidationError(
      "checkRunSnapshot",
      "does not belong to the persisted allocation and immutable commit",
    );
  }

  if (lifecycle.phase === "not-created") {
    if (snapshot.stage !== "accepted") {
      throw new ContractValidationError(
        "checkRunSnapshot.stage",
        "the first publication must create the Check Run at 'accepted'",
      );
    }
    return { operation: "create", snapshot };
  }

  if (snapshot.revision < lifecycle.publishedRevision) {
    return { operation: "noop" };
  }
  if (snapshot.revision === lifecycle.publishedRevision) {
    if (snapshot.stage !== lifecycle.stage) {
      throw new ContractValidationError(
        "checkRunSnapshot.stage",
        "cannot reuse a published revision for a different lifecycle stage",
      );
    }
    return { operation: "noop" };
  }

  if (lifecycle.phase === "concluded") {
    throw new ContractValidationError(
      "checkRunSnapshot.stage",
      "a concluded Switchyard Check Run cannot be changed",
    );
  }
  if (stageRank(snapshot.stage) < stageRank(lifecycle.stage)) {
    throw new ContractValidationError(
      "checkRunSnapshot.stage",
      "cannot move the Switchyard Check Run lifecycle backwards",
    );
  }

  return snapshot.stage === "ended"
    ? { operation: "conclude", snapshot }
    : { operation: "update", snapshot };
}

export function applyCheckRunDeliverySuccess(
  record: CheckRunDeliveryRecord,
  command: Exclude<CheckRunDeliveryCommand, { readonly operation: "noop" }>,
  checkRunIdValue: unknown,
): CheckRunDeliveryRecord {
  const current = parseCheckRunDeliveryRecord(record);
  const checkRunId = requirePositiveDecimalString(checkRunIdValue, "checkRunId");
  const existingId =
    current.lifecycle.phase === "not-created" ? undefined : current.lifecycle.checkRunId;
  if (existingId !== undefined && existingId !== checkRunId) {
    throw new ContractValidationError("checkRunId", "does not match the persisted Check Run");
  }

  const { snapshot } = command;
  if (snapshot.stage === "ended") {
    return validateCheckRunDeliveryTransition(current, {
      lifecycle: {
        allocationId: snapshot.allocationId,
        headSha: snapshot.headSha,
        checkRunId,
        phase: "concluded",
        publishedRevision: snapshot.revision,
        stage: "ended",
      },
      retry: null,
    });
  }

  return validateCheckRunDeliveryTransition(current, {
    lifecycle: {
      allocationId: snapshot.allocationId,
      headSha: snapshot.headSha,
      checkRunId,
      phase: "in-progress",
      publishedRevision: snapshot.revision,
      stage: snapshot.stage,
    },
    retry: null,
  });
}

export function scheduleCheckRunRetry(
  record: CheckRunDeliveryRecord,
  operation: CheckRunDeliveryOperation,
  failureValue: unknown,
  now: Date,
): CheckRunDeliveryRecord {
  const current = parseCheckRunDeliveryRecord(record);
  const failure = parseRedactedFailure(failureValue);
  const previousAttempt = current.retry?.operation === operation ? current.retry.attempt : 0;
  const attempt = previousAttempt + 1;
  if (attempt > MAX_CHECK_RUN_DELIVERY_ATTEMPTS) {
    throw new ContractValidationError(
      "checkRunRetry.attempt",
      `cannot exceed ${MAX_CHECK_RUN_DELIVERY_ATTEMPTS}`,
    );
  }
  const delay = RETRY_DELAYS_SECONDS[Math.min(attempt - 1, RETRY_DELAYS_SECONDS.length - 1)];
  if (delay === undefined || !Number.isFinite(now.valueOf())) {
    throw new ContractValidationError("checkRunRetry", "cannot calculate a retry time");
  }

  return validateCheckRunDeliveryTransition(current, {
    lifecycle: current.lifecycle,
    retry: {
      operation,
      attempt,
      notBefore: new Date(now.valueOf() + delay * 1000).toISOString(),
      alertRequired: attempt >= 3 || !failure.retryable,
      failure,
    },
  });
}

/**
 * Validates one authoritative persisted delivery transition. Reporter snapshot
 * planning may ignore stale observations, but a ledger write may never move its
 * durable lifecycle or bounded retry state backwards.
 */
export function validateCheckRunDeliveryTransition(
  currentValue: unknown,
  nextValue: unknown,
): CheckRunDeliveryRecord {
  const current = parseCheckRunDeliveryRecord(currentValue);
  const next = parseCheckRunDeliveryRecord(nextValue);
  const operation = validateLifecycleTransition(current.lifecycle, next.lifecycle);
  validateRetryTransition(current.retry, next.retry, operation);
  return next;
}

export function parseCheckRunDeliveryRecord(value: unknown): CheckRunDeliveryRecord {
  const record = requireRecord(value, "checkRunDelivery");
  requireExactKeys(record, ["lifecycle", "retry"], "checkRunDelivery");
  const lifecycleValue = requireRecord(record.lifecycle, "checkRunDelivery.lifecycle");
  const phase = lifecycleValue.phase;
  let lifecycle: SwitchyardCheckRunLifecycle;

  if (phase === "not-created") {
    requireExactKeys(
      lifecycleValue,
      ["allocationId", "headSha", "phase", "publishedRevision", "stage"],
      "checkRunDelivery.lifecycle",
    );
    if (lifecycleValue.publishedRevision !== -1 || lifecycleValue.stage !== null) {
      throw new ContractValidationError(
        "checkRunDelivery.lifecycle",
        "not-created lifecycle has invalid publication state",
      );
    }
    lifecycle = {
      allocationId: requireNonEmptyString(
        lifecycleValue.allocationId,
        "checkRunDelivery.lifecycle.allocationId",
      ),
      headSha: requireFullCommitSha(lifecycleValue.headSha, "checkRunDelivery.lifecycle.headSha"),
      phase,
      publishedRevision: -1,
      stage: null,
    };
  } else if (phase === "in-progress" || phase === "concluded") {
    requireExactKeys(
      lifecycleValue,
      ["allocationId", "checkRunId", "headSha", "phase", "publishedRevision", "stage"],
      "checkRunDelivery.lifecycle",
    );
    const publishedRevision = requireNonNegativeSafeInteger(
      lifecycleValue.publishedRevision,
      "checkRunDelivery.lifecycle.publishedRevision",
    );
    const stage = parseStage(lifecycleValue.stage);
    if (
      (phase === "concluded" && stage !== "ended") ||
      (phase === "in-progress" && stage === "ended") ||
      (phase === "in-progress" && (stage === "accepted") !== (publishedRevision === 0)) ||
      (phase === "concluded" && publishedRevision === 0)
    ) {
      throw new ContractValidationError(
        "checkRunDelivery.lifecycle.stage",
        "does not agree with the lifecycle phase",
      );
    }
    const common = {
      allocationId: requireNonEmptyString(
        lifecycleValue.allocationId,
        "checkRunDelivery.lifecycle.allocationId",
      ),
      checkRunId: requirePositiveDecimalString(
        lifecycleValue.checkRunId,
        "checkRunDelivery.lifecycle.checkRunId",
      ),
      headSha: requireFullCommitSha(lifecycleValue.headSha, "checkRunDelivery.lifecycle.headSha"),
      publishedRevision,
    };
    lifecycle =
      phase === "concluded"
        ? { ...common, phase, stage: "ended" }
        : {
            ...common,
            phase,
            stage: stage as Exclude<SwitchyardCheckRunStage, "ended">,
          };
  } else {
    throw new ContractValidationError("checkRunDelivery.lifecycle.phase", "is not recognised");
  }

  if (record.retry === null) {
    const parsed = { lifecycle, retry: null } as const;
    validateRetryForLifecycle(parsed);
    return parsed;
  }
  const retryValue = requireRecord(record.retry, "checkRunDelivery.retry");
  requireExactKeys(
    retryValue,
    ["alertRequired", "attempt", "failure", "notBefore", "operation"],
    "checkRunDelivery.retry",
  );
  const attempt = requireNonNegativeSafeInteger(
    retryValue.attempt,
    "checkRunDelivery.retry.attempt",
  );
  if (attempt < 1 || attempt > MAX_CHECK_RUN_DELIVERY_ATTEMPTS) {
    throw new ContractValidationError(
      "checkRunDelivery.retry.attempt",
      `must be between 1 and ${MAX_CHECK_RUN_DELIVERY_ATTEMPTS}`,
    );
  }
  if (
    retryValue.operation !== "create" &&
    retryValue.operation !== "update" &&
    retryValue.operation !== "conclude"
  ) {
    throw new ContractValidationError("checkRunDelivery.retry.operation", "is not recognised");
  }
  if (typeof retryValue.alertRequired !== "boolean") {
    throw new ContractValidationError("checkRunDelivery.retry.alertRequired", "must be a boolean");
  }
  const notBefore = requireCanonicalUtcInstant(
    retryValue.notBefore,
    "checkRunDelivery.retry.notBefore",
  );
  const failure = parseRedactedFailure(retryValue.failure);
  if (retryValue.alertRequired !== (attempt >= 3 || !failure.retryable)) {
    throw new ContractValidationError(
      "checkRunDelivery.retry.alertRequired",
      "does not match the bounded retry and alert policy",
    );
  }
  const parsed: CheckRunDeliveryRecord = {
    lifecycle,
    retry: {
      alertRequired: retryValue.alertRequired,
      attempt,
      failure,
      notBefore,
      operation: retryValue.operation,
    },
  };
  validateRetryForLifecycle(parsed);
  return parsed;
}

function validateLifecycleTransition(
  current: SwitchyardCheckRunLifecycle,
  next: SwitchyardCheckRunLifecycle,
): CheckRunDeliveryOperation | null {
  if (current.allocationId !== next.allocationId || current.headSha !== next.headSha) {
    throw new ContractValidationError(
      "checkRunDelivery.lifecycle",
      "cannot change its allocation or immutable commit identity",
    );
  }
  if (current.phase === "not-created") {
    if (next.phase === "not-created") {
      return null;
    }
    if (next.phase !== "in-progress" || next.publishedRevision !== 0 || next.stage !== "accepted") {
      throw new ContractValidationError(
        "checkRunDelivery.lifecycle",
        "creation must publish revision 0 at the accepted stage",
      );
    }
    return "create";
  }
  if (next.phase === "not-created" || next.checkRunId !== current.checkRunId) {
    throw new ContractValidationError(
      "checkRunDelivery.lifecycle",
      "cannot remove or change the persisted Check Run identity",
    );
  }
  if (current.phase === "concluded") {
    if (!sameLifecycle(current, next)) {
      throw new ContractValidationError(
        "checkRunDelivery.lifecycle",
        "a concluded Check Run cannot return to in-progress or otherwise change",
      );
    }
    return null;
  }
  if (next.publishedRevision < current.publishedRevision) {
    throw new ContractValidationError(
      "checkRunDelivery.lifecycle.publishedRevision",
      "cannot move backwards",
    );
  }
  if (next.publishedRevision === current.publishedRevision) {
    if (!sameLifecycle(current, next)) {
      throw new ContractValidationError(
        "checkRunDelivery.lifecycle",
        "must be identical when reusing a published revision",
      );
    }
    return null;
  }
  if (stageRank(next.stage) < stageRank(current.stage)) {
    throw new ContractValidationError("checkRunDelivery.lifecycle.stage", "cannot move backwards");
  }
  return next.phase === "concluded" ? "conclude" : "update";
}

function validateRetryTransition(
  current: CheckRunRetry | null,
  next: CheckRunRetry | null,
  lifecycleOperation: CheckRunDeliveryOperation | null,
): void {
  if (lifecycleOperation !== null) {
    if (next !== null) {
      throw new ContractValidationError(
        "checkRunDelivery.retry",
        "must clear after a successful lifecycle publication",
      );
    }
    return;
  }
  if (sameRetry(current, next)) {
    return;
  }
  if (next === null) {
    throw new ContractValidationError(
      "checkRunDelivery.retry",
      "cannot be cleared without a successful lifecycle publication",
    );
  }
  if (
    current !== null &&
    current.operation !== next.operation &&
    deliveryOperationRank(next.operation) < deliveryOperationRank(current.operation)
  ) {
    throw new ContractValidationError("checkRunDelivery.retry.operation", "cannot move backwards");
  }
  const expectedAttempt = current?.operation === next.operation ? current.attempt + 1 : 1;
  if (next.attempt !== expectedAttempt) {
    throw new ContractValidationError(
      "checkRunDelivery.retry.attempt",
      "must be the next bounded attempt for its operation",
    );
  }
  if (
    current?.operation === next.operation &&
    Date.parse(next.notBefore) <= Date.parse(current.notBefore)
  ) {
    throw new ContractValidationError(
      "checkRunDelivery.retry.notBefore",
      "must move forward for another attempt of the same operation",
    );
  }
  if (next.alertRequired !== (next.attempt >= 3 || !next.failure.retryable)) {
    throw new ContractValidationError(
      "checkRunDelivery.retry.alertRequired",
      "does not match the bounded retry and alert policy",
    );
  }
}

function validateRetryForLifecycle(record: CheckRunDeliveryRecord): void {
  const operation = record.retry?.operation;
  if (
    (record.lifecycle.phase === "not-created" &&
      operation !== undefined &&
      operation !== "create") ||
    (record.lifecycle.phase === "in-progress" && operation === "create") ||
    (record.lifecycle.phase === "concluded" && record.retry !== null)
  ) {
    throw new ContractValidationError(
      "checkRunDelivery.retry.operation",
      "does not match the current lifecycle phase",
    );
  }
}

function sameLifecycle(
  left: SwitchyardCheckRunLifecycle,
  right: SwitchyardCheckRunLifecycle,
): boolean {
  return (
    left.phase === right.phase &&
    left.allocationId === right.allocationId &&
    left.headSha === right.headSha &&
    left.publishedRevision === right.publishedRevision &&
    left.stage === right.stage &&
    (left.phase === "not-created" ||
      (right.phase !== "not-created" && left.checkRunId === right.checkRunId))
  );
}

function sameRetry(left: CheckRunRetry | null, right: CheckRunRetry | null): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.alertRequired === right.alertRequired &&
      left.attempt === right.attempt &&
      left.notBefore === right.notBefore &&
      left.operation === right.operation &&
      left.failure.classification === right.failure.classification &&
      left.failure.code === right.failure.code &&
      left.failure.requestId === right.failure.requestId &&
      left.failure.retryable === right.failure.retryable &&
      left.failure.status === right.failure.status)
  );
}

function deliveryOperationRank(operation: CheckRunDeliveryOperation): number {
  return operation === "create" ? 0 : operation === "update" ? 1 : 2;
}

function validateStageFields(snapshot: SwitchyardCheckRunSnapshot): void {
  if (snapshot.stage === "accepted") {
    if (snapshot.revision !== 0) {
      throw new ContractValidationError("checkRunSnapshot.revision", "must be 0 when accepted");
    }
    requireAllNull(snapshot);
    return;
  }

  const endedWithoutProvider =
    snapshot.stage === "ended" &&
    snapshot.provider === null &&
    snapshot.workloadOutcome === "never-started" &&
    snapshot.estimatedCostUsdCents === 0 &&
    snapshot.fallbackUsed === false;
  if (
    snapshot.revision === 0 ||
    (snapshot.provider === null && !endedWithoutProvider) ||
    snapshot.fallbackUsed === null
  ) {
    throw new ContractValidationError(
      "checkRunSnapshot",
      "a post-acceptance stage requires a provider, fallback result and positive revision",
    );
  }

  if (snapshot.stage === "cleanup-pending") {
    if (
      (snapshot.cleanupResult !== "pending" && snapshot.cleanupResult !== "failed") ||
      snapshot.workloadOutcome === null
    ) {
      throw new ContractValidationError(
        "checkRunSnapshot",
        "cleanup-pending requires a terminal workload outcome and unsettled cleanup",
      );
    }
    return;
  }

  if (snapshot.stage === "ended") {
    if (
      snapshot.durationSeconds === null ||
      snapshot.estimatedCostUsdCents === null ||
      snapshot.workloadOutcome === null ||
      snapshot.cleanupResult !== "succeeded"
    ) {
      throw new ContractValidationError(
        "checkRunSnapshot",
        "ended requires duration, estimated cost, workload outcome and successful settled cleanup",
      );
    }
    return;
  }

  if (snapshot.cleanupResult !== null || snapshot.workloadOutcome !== null) {
    throw new ContractValidationError(
      "checkRunSnapshot",
      "a running allocation cannot publish terminal workload or cleanup fields",
    );
  }
}

function requireAllNull(snapshot: SwitchyardCheckRunSnapshot): void {
  if (
    snapshot.provider !== null ||
    snapshot.durationSeconds !== null ||
    snapshot.estimatedCostUsdCents !== null ||
    snapshot.fallbackUsed !== null ||
    snapshot.cleanupResult !== null ||
    snapshot.workloadOutcome !== null
  ) {
    throw new ContractValidationError(
      "checkRunSnapshot",
      "accepted is created before provider and lifecycle results are known",
    );
  }
}

function parseStage(value: unknown): SwitchyardCheckRunStage {
  if (!SWITCHYARD_CHECK_RUN_STAGES.some((stage) => stage === value)) {
    throw new ContractValidationError("checkRunSnapshot.stage", "is not a recognised stage");
  }
  return value as SwitchyardCheckRunStage;
}

function parseProvider(value: unknown): ProviderName | null {
  if (value === null || value === "azure" || value === "blacksmith") {
    return value;
  }
  throw new ContractValidationError("checkRunSnapshot.provider", "is not a recognised provider");
}

function parseCleanupResult(value: unknown): SwitchyardCleanupResult | null {
  if (value === null || value === "failed" || value === "pending" || value === "succeeded") {
    return value;
  }
  throw new ContractValidationError(
    "checkRunSnapshot.cleanupResult",
    "is not a recognised cleanup result",
  );
}

function parseWorkloadOutcome(value: unknown): SwitchyardWorkloadOutcome | null {
  if (
    value === null ||
    value === "cancelled" ||
    value === "failed" ||
    value === "never-started" ||
    value === "succeeded" ||
    value === "timed-out"
  ) {
    return value;
  }
  throw new ContractValidationError(
    "checkRunSnapshot.workloadOutcome",
    "is not a recognised workload outcome",
  );
}

function parseNullableBoolean(value: unknown, path: string): boolean | null {
  if (value === null || typeof value === "boolean") {
    return value;
  }
  throw new ContractValidationError(path, "must be a boolean or null");
}

function parseNullableNonNegativeInteger(value: unknown, path: string): number | null {
  if (value === null) {
    return null;
  }
  return requireNonNegativeSafeInteger(value, path);
}

function requireNonNegativeSafeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ContractValidationError(path, "must be a non-negative safe integer");
  }
  return value;
}

function requireCanonicalUtcInstant(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new ContractValidationError(path, "must be a canonical UTC instant");
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new ContractValidationError(path, "must be a canonical UTC instant");
  }
  return value;
}

function parseRedactedFailure(value: unknown): RedactedCheckRunDeliveryFailure {
  const record = requireRecord(value, "checkRunFailure");
  requireExactKeys(
    record,
    ["classification", "code", "status", "requestId", "retryable"],
    "checkRunFailure",
  );
  if (
    record.classification !== "github-api-failure" &&
    record.classification !== "github-response-invalid"
  ) {
    throw new ContractValidationError("checkRunFailure.classification", "is not recognised");
  }

  return {
    classification: record.classification,
    code: requireNonEmptyString(record.code, "checkRunFailure.code"),
    status: parseNullableStatus(record.status),
    requestId:
      record.requestId === null
        ? null
        : requireNonEmptyString(record.requestId, "checkRunFailure.requestId"),
    retryable:
      typeof record.retryable === "boolean"
        ? record.retryable
        : (() => {
            throw new ContractValidationError("checkRunFailure.retryable", "must be a boolean");
          })(),
  };
}

function parseNullableStatus(value: unknown): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 100 || value > 599) {
    throw new ContractValidationError("checkRunFailure.status", "must be an HTTP status or null");
  }
  return value;
}

function stageRank(stage: SwitchyardCheckRunStage): number {
  return SWITCHYARD_CHECK_RUN_STAGES.indexOf(stage);
}
