import { timingSafeEqual } from "node:crypto";

import type {
  InfrastructureApprovalPolicy,
  InfrastructureIdentitySession,
  PlanAuthorityClass,
  StateIdentity,
} from "./contracts.js";
import { InfrastructureApprovalError, sha256Bytes, sha256Text } from "./contracts.js";

export const PINNED_OPEN_TOFU_VERSION = "1.12.1" as const;

export const EXACT_SAVED_PLAN_CREATE_COMMAND = Object.freeze([
  "tofu",
  "plan",
  "-input=false",
  "-lock=false",
  "-no-color",
  "-out=saved-plan",
] as const);

export const EXACT_SAVED_PLAN_SHOW_JSON_COMMAND = Object.freeze([
  "tofu",
  "show",
  "-json",
  "saved-plan",
] as const);

export const EXACT_SAVED_PLAN_SHOW_TEXT_COMMAND = Object.freeze([
  "tofu",
  "show",
  "-no-color",
  "saved-plan",
] as const);

export type SavedPlanCreateCommand = typeof EXACT_SAVED_PLAN_CREATE_COMMAND;
export type SavedPlanShowJsonCommand = typeof EXACT_SAVED_PLAN_SHOW_JSON_COMMAND;
export type SavedPlanShowTextCommand = typeof EXACT_SAVED_PLAN_SHOW_TEXT_COMMAND;

export interface SavedPlanCreation {
  readonly savedPlan: Uint8Array;
  readonly savedPlanDigest: string;
}

export interface SavedPlanRendering {
  readonly planJson: Uint8Array;
  readonly planText: Uint8Array;
  readonly renderedSavedPlanDigest: string;
}

/**
 * Contract for one pinned OpenTofu adapter. Planning yields only the opaque
 * saved plan; both reviewed views are subsequently rendered from those exact
 * bytes with fixed commands. The live adapter implements only this surface.
 */
export interface FixedOpenTofuPlanPort {
  getTargetConfigurationDigest(): Promise<string>;
  createSavedPlan(input: {
    readonly authorityClass: PlanAuthorityClass;
    readonly backend: InfrastructureApprovalPolicy["backend"];
    readonly command: SavedPlanCreateCommand;
    readonly commitSha: string;
    readonly expectedState: StateIdentity;
    readonly plannerSession: InfrastructureIdentitySession & { readonly identity: "planner" };
    readonly transientGitHubOidcToken: Uint8Array;
    readonly subscriptionId: string;
    readonly tenantId: string;
    readonly tofuVersion: typeof PINNED_OPEN_TOFU_VERSION;
  }): Promise<SavedPlanCreation>;
  renderSavedPlan(input: {
    readonly jsonCommand: SavedPlanShowJsonCommand;
    readonly savedPlan: Uint8Array;
    readonly textCommand: SavedPlanShowTextCommand;
    readonly tofuVersion: typeof PINNED_OPEN_TOFU_VERSION;
  }): Promise<SavedPlanRendering>;
}

/** The planner can observe the exact state blob but cannot write or lease it. */
export interface PlannerStateReadPort {
  readIdentity(input: {
    readonly backend: InfrastructureApprovalPolicy["backend"];
    readonly plannerSession: InfrastructureIdentitySession & { readonly identity: "planner" };
  }): Promise<StateIdentity>;
}

export type SavedPlanRenderPort = Pick<
  FixedOpenTofuPlanPort,
  "getTargetConfigurationDigest" | "renderSavedPlan"
>;

export function assertExactOpenTofuCommand(
  kind: "create" | "show-json" | "show-text",
  command: readonly string[],
): void {
  const expected =
    kind === "create"
      ? EXACT_SAVED_PLAN_CREATE_COMMAND
      : kind === "show-json"
        ? EXACT_SAVED_PLAN_SHOW_JSON_COMMAND
        : EXACT_SAVED_PLAN_SHOW_TEXT_COMMAND;
  if (
    command.length !== expected.length ||
    command.some((part, index) => part !== expected[index]) ||
    command.some((part) => /(^|[=])(destroy|target|replace|refresh-only)(=|$)/.test(part))
  ) {
    throw new InfrastructureApprovalError(`opentofu-${kind}-command-not-exact`);
  }
}

export function openTofuCommandDigest(command: readonly string[]): string {
  return sha256Text(`${JSON.stringify(command)}\n`);
}

export function requireRenderedFromSavedPlan(
  rendering: SavedPlanRendering,
  savedPlan: Uint8Array,
): void {
  const actual = sha256Bytes(savedPlan);
  if (
    rendering.renderedSavedPlanDigest !== actual ||
    !/^[a-f0-9]{64}$/.test(rendering.renderedSavedPlanDigest) ||
    !timingSafeEqual(
      Buffer.from(rendering.renderedSavedPlanDigest, "hex"),
      Buffer.from(actual, "hex"),
    )
  ) {
    throw new InfrastructureApprovalError("rendered-saved-plan-digest-mismatch");
  }
  if (rendering.planJson.byteLength < 1 || rendering.planText.byteLength < 1) {
    throw new InfrastructureApprovalError("saved-plan-render-empty");
  }
}
