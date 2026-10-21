import { ContractValidationError } from "./validation.js";

export const CAPABILITY_PROFILES = ["linux-x64-standard", "linux-x64-large"] as const;

export type CapabilityProfile = (typeof CAPABILITY_PROFILES)[number];

export function isCapabilityProfile(value: unknown): value is CapabilityProfile {
  return typeof value === "string" && CAPABILITY_PROFILES.some((profile) => profile === value);
}

export function parseCapabilityProfile(value: unknown, path = "profile"): CapabilityProfile {
  if (!isCapabilityProfile(value)) {
    throw new ContractValidationError(
      path,
      `must be one of ${CAPABILITY_PROFILES.map((profile) => `'${profile}'`).join(", ")}`,
    );
  }

  return value;
}
