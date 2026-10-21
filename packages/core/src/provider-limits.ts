import type { AllocationFailure, ProviderName } from "./provider.js";

const FIVE_DOLLARS_IN_CENTS = 500;

export interface ProviderLimits {
  readonly dailyAllowanceUsdCents: number;
  readonly maximumConcurrentAllocations: number;
}

export const PROVIDER_LIMITS: Readonly<Record<ProviderName, ProviderLimits>> = Object.freeze({
  azure: Object.freeze({
    dailyAllowanceUsdCents: FIVE_DOLLARS_IN_CENTS,
    maximumConcurrentAllocations: 3,
  }),
  blacksmith: Object.freeze({
    dailyAllowanceUsdCents: FIVE_DOLLARS_IN_CENTS,
    maximumConcurrentAllocations: 3,
  }),
});

export interface ProviderLimitState {
  readonly activeAllocations: number;
  readonly reservedDailyCostUsdCents: number;
}

export interface ProviderLimitRequest {
  readonly estimatedCostUsdCents: number;
  readonly provider: ProviderName;
  readonly state: ProviderLimitState;
}

export type ProviderLimitDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly failure: AllocationFailure };

export function evaluateProviderLimits(request: ProviderLimitRequest): ProviderLimitDecision {
  const { estimatedCostUsdCents, provider } = request;

  if (provider !== "azure" && provider !== "blacksmith") {
    return invalidValue("provider", "must be 'azure' or 'blacksmith'");
  }
  if (typeof request.state !== "object" || request.state === null) {
    return invalidValue("state", "must contain authoritative limit counters");
  }

  const limits = PROVIDER_LIMITS[provider];
  const activeAllocations: unknown = request.state.activeAllocations;
  const reservedDailyCostUsdCents: unknown = request.state.reservedDailyCostUsdCents;

  if (
    typeof activeAllocations === "number" &&
    Number.isInteger(activeAllocations) &&
    activeAllocations > limits.maximumConcurrentAllocations
  ) {
    return corruptState(
      "activeAllocations",
      `${provider} active allocations exceed the authoritative concurrency limit`,
    );
  }
  if (
    typeof reservedDailyCostUsdCents === "number" &&
    Number.isInteger(reservedDailyCostUsdCents) &&
    reservedDailyCostUsdCents > limits.dailyAllowanceUsdCents
  ) {
    return corruptState(
      "reservedDailyCostUsdCents",
      `${provider} reserved daily cost exceeds the authoritative allowance`,
    );
  }

  if (!Number.isSafeInteger(activeAllocations) || (activeAllocations as number) < 0) {
    return invalidValue("activeAllocations", "must be a non-negative safe integer");
  }
  if (
    !Number.isSafeInteger(reservedDailyCostUsdCents) ||
    (reservedDailyCostUsdCents as number) < 0
  ) {
    return invalidValue("reservedDailyCostUsdCents", "must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(estimatedCostUsdCents) || estimatedCostUsdCents <= 0) {
    return invalidValue("estimatedCostUsdCents", "must be a positive safe integer");
  }

  if (activeAllocations === limits.maximumConcurrentAllocations) {
    return unavailable(
      "concurrency-limit",
      `${provider} already has ${limits.maximumConcurrentAllocations} active allocations`,
    );
  }

  const remainingAllowance = limits.dailyAllowanceUsdCents - (reservedDailyCostUsdCents as number);
  if (estimatedCostUsdCents > remainingAllowance) {
    return unavailable(
      "daily-allowance",
      `${provider} does not have enough daily allowance for this reservation`,
    );
  }

  return { allowed: true };
}

function invalidValue(field: string, requirement: string): ProviderLimitDecision {
  return {
    allowed: false,
    failure: {
      classification: "invalid-configuration",
      code: "invalid-limit-value",
      message: `${field} ${requirement}`,
    },
  };
}

function corruptState(field: string, message: string): ProviderLimitDecision {
  return {
    allowed: false,
    failure: {
      classification: "controller-unavailable",
      code: "authoritative-limit-state-corrupt",
      message: `${field}: ${message}`,
    },
  };
}

function unavailable(code: string, message: string): ProviderLimitDecision {
  return {
    allowed: false,
    failure: {
      classification: "provider-unavailable",
      unavailableReason: "capacity-unavailable",
      code,
      message,
    },
  };
}
