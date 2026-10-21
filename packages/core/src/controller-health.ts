import type { AllocationFailure } from "./provider.js";
import { ContractValidationError, requireExactKeys, requireRecord } from "./validation.js";

export type DependencyAvailability = "available" | "unavailable";
export type TrustVerificationStatus = "verified" | "failed" | "unavailable";

export const RECONCILER_HEARTBEAT_INTERVAL_SECONDS = 60;
export const RECONCILER_STALE_AFTER_SECONDS = 150;

export interface ReconcilerHealthEvidence {
  readonly lastSucceededAt: string;
}

export interface ReconcilerHeartbeatState extends ReconcilerHealthEvidence {
  readonly revision: string;
}

export interface ReconcilerHeartbeatStore {
  getReconcilerHeartbeat(): Promise<ReconcilerHeartbeatState | null>;
  recordReconcilerHeartbeat(input: {
    readonly lastSucceededAt: string;
  }): Promise<ReconcilerHeartbeatState>;
}

export interface ControllerHealthSnapshot {
  readonly authoritativeLedger: DependencyAvailability;
  readonly doppler: DependencyAvailability;
  readonly reconciler: ReconcilerHealthEvidence;
  readonly switchyardApi: DependencyAvailability;
  readonly trustVerification: TrustVerificationStatus;
}

export type ControllerReadiness =
  | { readonly ready: true }
  | { readonly failure: AllocationFailure; readonly ready: false };

const CONTROLLER_HEALTH_KEYS = [
  "switchyardApi",
  "authoritativeLedger",
  "trustVerification",
  "doppler",
  "reconciler",
] as const;

export function evaluateControllerReadiness(
  snapshot: unknown,
  now: Date = new Date(),
): ControllerReadiness {
  let record: Record<string, unknown>;
  try {
    record = requireRecord(snapshot, "controllerHealth");
    requireExactKeys(record, CONTROLLER_HEALTH_KEYS, "controllerHealth");
    for (const key of CONTROLLER_HEALTH_KEYS) {
      if (!Object.hasOwn(record, key)) {
        throw new ContractValidationError(`controllerHealth.${key}`, "is required");
      }
    }
  } catch (error) {
    return unhealthy("controller-health-invalid", validationMessage(error));
  }

  if (record.trustVerification === "failed") {
    return {
      ready: false,
      failure: {
        classification: "security-failure",
        code: "trust-verification-failed",
        message: "workload trust verification failed",
      },
    };
  }

  if (record.switchyardApi !== "available") {
    return unhealthy(
      "switchyard-api-unhealthy",
      "Switchyard API health is not the required 'available' value",
    );
  }
  if (record.authoritativeLedger !== "available") {
    return unhealthy(
      "authoritative-ledger-unhealthy",
      "authoritative ledger health is not the required 'available' value",
    );
  }
  if (record.trustVerification !== "verified") {
    return unhealthy(
      "trust-verification-unhealthy",
      "trust verification is not the required 'verified' value",
    );
  }
  if (record.doppler !== "available") {
    return unhealthy("doppler-unhealthy", "Doppler health is not the required 'available' value");
  }

  const reconciler = parseReconcilerHealth(record.reconciler);
  if (!reconciler.valid) {
    return unhealthy("reconciler-health-invalid", reconciler.message);
  }
  const nowMilliseconds = now instanceof Date ? now.valueOf() : Number.NaN;
  if (!Number.isFinite(nowMilliseconds)) {
    return unhealthy("controller-clock-invalid", "Controller time is invalid");
  }
  const heartbeatMilliseconds = Date.parse(reconciler.lastSucceededAt);
  const ageMilliseconds = nowMilliseconds - heartbeatMilliseconds;
  if (ageMilliseconds < 0) {
    return unhealthy("reconciler-heartbeat-future", "Reconciler heartbeat is in the future");
  }
  if (ageMilliseconds > RECONCILER_STALE_AFTER_SECONDS * 1000) {
    return unhealthy(
      "reconciler-heartbeat-stale",
      "Reconciler heartbeat is older than the 150-second safety threshold",
    );
  }

  return { ready: true };
}

export async function evaluateControllerReadinessFromHeartbeat(
  snapshot: Omit<ControllerHealthSnapshot, "reconciler">,
  heartbeatStore: ReconcilerHeartbeatStore,
  now: Date = new Date(),
): Promise<ControllerReadiness> {
  let heartbeat: ReconcilerHeartbeatState | null;
  try {
    heartbeat = await heartbeatStore.getReconcilerHeartbeat();
  } catch {
    return unhealthy(
      "reconciler-heartbeat-unavailable",
      "Durable reconciler heartbeat evidence is unavailable",
    );
  }
  return evaluateControllerReadiness(
    {
      ...snapshot,
      reconciler: heartbeat === null ? null : { lastSucceededAt: heartbeat.lastSucceededAt },
    },
    now,
  );
}

function parseReconcilerHealth(
  value: unknown,
):
  | { readonly lastSucceededAt: string; readonly valid: true }
  | { readonly message: string; readonly valid: false } {
  try {
    const record = requireRecord(value, "controllerHealth.reconciler");
    requireExactKeys(record, ["lastSucceededAt"], "controllerHealth.reconciler");
    if (typeof record.lastSucceededAt !== "string") {
      throw new ContractValidationError(
        "controllerHealth.reconciler.lastSucceededAt",
        "must be a canonical UTC instant",
      );
    }
    const parsed = new Date(record.lastSucceededAt);
    if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== record.lastSucceededAt) {
      throw new ContractValidationError(
        "controllerHealth.reconciler.lastSucceededAt",
        "must be a canonical UTC instant",
      );
    }
    return { valid: true, lastSucceededAt: record.lastSucceededAt };
  } catch (error) {
    return { valid: false, message: validationMessage(error) };
  }
}

function unhealthy(code: string, message: string): ControllerReadiness {
  return {
    ready: false,
    failure: {
      classification: "controller-unavailable",
      code,
      message,
    },
  };
}

function validationMessage(error: unknown): string {
  return error instanceof ContractValidationError
    ? error.message
    : "controller health is malformed";
}
