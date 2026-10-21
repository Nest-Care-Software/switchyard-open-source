import { deflateRawSync } from "node:zlib";

import {
  bundleEntries,
  canonicalActivationSource,
  canonicalPlanManifest,
  classifyOpenTofuPlan,
  createPlanManifest,
  FUTURE_APPLY_DISPATCHER_PATH,
  FUTURE_PLAN_DISPATCHER_PATH,
  futureIdentityContracts,
  type GitHubJobEvidence,
  type GitHubRunEvidence,
  INFRASTRUCTURE_APPLY_ENGINE_PATH,
  INFRASTRUCTURE_INITIAL_STATE_DISPATCHER_PATH,
  INFRASTRUCTURE_PLAN_ENGINE_PATH,
  type InfrastructureApprovalPolicy,
  type InfrastructureIdentitySession,
  immutableOidcSubject,
  manifestFiles,
  type PlanAuthorityClass,
  type PlanManifest,
  parseActivationConfiguration,
  requiredOidcSettings,
  type StateIdentity,
  SWITCHYARD_MAIN_REF,
  SWITCHYARD_OWNER_ACTOR_ID,
  SWITCHYARD_OWNER_ID,
  SWITCHYARD_REPOSITORY,
  SWITCHYARD_REPOSITORY_ID,
  sha256Bytes,
  sha256Text,
  type VerifiedGitHubOidcClaims,
} from "../src/index.js";

export const COMMIT_SHA = "a".repeat(40);
export const PLAN_ENGINE_SHA = "0123456789abcdef0123456789abcdef01234567";
export const APPLY_ENGINE_SHA = PLAN_ENGINE_SHA;
export const PLAN_RUN_ID = "101";
export const APPROVAL_RUN_ID = "202";
export const ARTIFACT_ID = "303";
export const LINEAGE = "11111111-1111-4111-8111-111111111111";
export const NOW = new Date("2026-08-25T12:05:00.000Z");
export const MANIFEST_CREATED_AT = "2026-08-25T12:00:00.000Z";
export const ARTIFACT_CREATED_AT = "2026-08-25T12:00:00.500Z";
export const PUBLISHED_AT = "2026-08-25T12:00:01.000Z";
export const ARTIFACT_EXPIRES_AT = "2026-08-26T12:00:00.000Z";
export const RAW_PLAN_TOKEN = bytes("raw-plan-token.".repeat(8));
export const RAW_APPLY_TOKEN = bytes("raw-apply-token.".repeat(8));

export const ACTIVATION_BYTES = bytes(
  canonicalActivationSource({
    bootstrap: {
      clientId: "11111111-1111-1111-1111-111111111111",
      principalId: "22222222-2222-2222-2222-222222222222",
    },
    finalEngineSha: PLAN_ENGINE_SHA,
    foundation: {
      clientId: "33333333-3333-3333-3333-333333333333",
      principalId: "44444444-4444-4444-4444-444444444444",
    },
    planner: {
      clientId: "55555555-5555-5555-5555-555555555555",
      principalId: "66666666-6666-6666-6666-666666666666",
    },
  }),
);
export const ACTIVATION = parseActivationConfiguration(ACTIVATION_BYTES);
export const POLICY: InfrastructureApprovalPolicy = ACTIVATION.policy;
export const TARGET_CONFIGURATION_DIGEST = "7".repeat(64);
export const PLAN_JOB_CHECK_RUN_ID = "404";
export const APPLY_JOB_CHECK_RUN_ID = "505";

export interface PlanJsonInput {
  readonly actions?: readonly string[];
  readonly after?: unknown;
  readonly authorityClass?: PlanAuthorityClass;
  readonly before?: unknown;
  readonly importing?: unknown;
  readonly mode?: "data" | "managed";
  readonly priorResources?: readonly Record<string, unknown>[];
  readonly providerName?: string;
  readonly resourceDrift?: readonly unknown[];
  readonly resourceType?: string;
}

export function planJson(input: PlanJsonInput = {}): Uint8Array {
  const authorityClass = input.authorityClass ?? "foundation";
  const resourceType =
    input.resourceType ??
    (authorityClass === "bootstrap" ? "azurerm_role_assignment" : "azurerm_storage_account");
  const isAzapi = resourceType === "azapi_resource";
  const priorResources = input.priorResources ?? priorManagedResources(authorityClass);
  const before =
    input.before !== undefined
      ? input.before
      : isAzapi
        ? { type: "Microsoft.Storage/storageAccounts/tableServices/tables@2025-01-01" }
        : null;
  const after =
    input.after !== undefined
      ? input.after
      : isAzapi
        ? { type: "Microsoft.Storage/storageAccounts/tableServices/tables@2025-01-01" }
        : {};
  return bytes(
    JSON.stringify({
      format_version: "1.2",
      prior_state: priorState(priorResources),
      resource_changes: [
        {
          address: `module.control.${resourceType}.fixture`,
          change: {
            actions: input.actions ?? ["create"],
            after,
            before,
            ...(input.importing === undefined ? {} : { importing: input.importing }),
          },
          mode: input.mode ?? "managed",
          provider_name:
            input.providerName ??
            (isAzapi
              ? "registry.opentofu.org/azure/azapi"
              : "registry.opentofu.org/hashicorp/azurerm"),
          type: resourceType,
        },
      ],
      resource_drift: input.resourceDrift ?? [],
      terraform_version: "1.12.1",
    }),
  );
}

export function stateIdentity(
  authorityClass: PlanAuthorityClass = "foundation",
  overrides: Partial<StateIdentity> = {},
): StateIdentity {
  const resources = priorManagedResources(authorityClass);
  return {
    backendStateDigest: sha256Text(`${canonicalJson(priorState(resources))}\n`),
    backendStateEtag: '"state-etag-7"',
    lineage: LINEAGE,
    managedResourceCount: resources.length,
    managedResourcesEmpty: resources.length === 0,
    serial: authorityClass === "bootstrap" ? 0 : 7,
    ...overrides,
  };
}

export interface BundleFixture {
  readonly archive: Uint8Array;
  readonly entries: readonly ZipInputEntry[];
  readonly manifest: PlanManifest;
  readonly planJson: Uint8Array;
  readonly planText: Uint8Array;
  readonly savedPlan: Uint8Array;
  readonly state: StateIdentity;
}

export function makePlanArchive(
  input: {
    readonly authorityClass?: PlanAuthorityClass;
    readonly commitSha?: string;
    readonly createdAt?: string;
    readonly planJsonBytes?: Uint8Array;
    readonly planRunId?: string;
    readonly planTextBytes?: Uint8Array;
    readonly savedPlanBytes?: Uint8Array;
    readonly state?: StateIdentity;
  } = {},
): Uint8Array {
  return makeBundleFixture(input).archive;
}

export function makeBundleFixture(
  input: {
    readonly authorityClass?: PlanAuthorityClass;
    readonly commitSha?: string;
    readonly createdAt?: string;
    readonly planJsonBytes?: Uint8Array;
    readonly planRunId?: string;
    readonly planTextBytes?: Uint8Array;
    readonly savedPlanBytes?: Uint8Array;
    readonly state?: StateIdentity;
  } = {},
): BundleFixture {
  const authorityClass = input.authorityClass ?? "foundation";
  const state = input.state ?? stateIdentity(authorityClass);
  const json = input.planJsonBytes ?? planJson({ authorityClass });
  const text = input.planTextBytes ?? bytes("OpenTofu will perform the reviewed actions.\n");
  const saved = input.savedPlanBytes ?? bytes("opaque-sensitive-saved-plan-fixture");
  const classification = classifyOpenTofuPlan(textOf(json), authorityClass, state);
  const commit = input.commitSha ?? COMMIT_SHA;
  const planner = futureIdentityContracts(POLICY).planner;
  const planJobWorkflowRef = `${SWITCHYARD_REPOSITORY}/${INFRASTRUCTURE_PLAN_ENGINE_PATH}@${PLAN_ENGINE_SHA}`;
  const manifest = createPlanManifest({
    activationConfigDigest: POLICY.activationConfigDigest,
    authorityClass,
    backend: POLICY.backend,
    changeSummary: classification.summary,
    commitSha: commit,
    createdAt: input.createdAt ?? MANIFEST_CREATED_AT,
    destructive: classification.destructive,
    files: manifestFiles({ planJson: json, planText: text, savedPlan: saved }),
    planDispatcherWorkflowRef: `${SWITCHYARD_REPOSITORY}/${FUTURE_PLAN_DISPATCHER_PATH}@${SWITCHYARD_MAIN_REF}`,
    planEngineSha: PLAN_ENGINE_SHA,
    planRunId: input.planRunId ?? PLAN_RUN_ID,
    plannerIdentity: {
      audience: planner.audience,
      identity: "planner",
      jobWorkflowRef: planJobWorkflowRef,
      subject: planner.subject,
    },
    priorStateDigest: classification.priorStateDigest,
    state,
    subscriptionId: POLICY.subscriptionId,
    targetConfigurationDigest: TARGET_CONFIGURATION_DIGEST,
    tenantId: POLICY.tenantId,
  });
  const entries = bundleEntries({
    manifestSource: canonicalPlanManifest(manifest),
    planJson: json,
    planText: text,
    savedPlan: saved,
  });
  return {
    archive: createZip(entries),
    entries,
    manifest,
    planJson: json,
    planText: text,
    savedPlan: saved,
    state,
  };
}

export function runEvidence(
  kind: "apply" | "plan",
  overrides: Partial<GitHubRunEvidence> = {},
): GitHubRunEvidence {
  const path = kind === "plan" ? FUTURE_PLAN_DISPATCHER_PATH : FUTURE_APPLY_DISPATCHER_PATH;
  const enginePath =
    kind === "plan" ? INFRASTRUCTURE_PLAN_ENGINE_PATH : INFRASTRUCTURE_APPLY_ENGINE_PATH;
  const engineSha = kind === "plan" ? PLAN_ENGINE_SHA : APPLY_ENGINE_SHA;
  const runId = kind === "plan" ? PLAN_RUN_ID : APPROVAL_RUN_ID;
  return {
    actorId: SWITCHYARD_OWNER_ACTOR_ID,
    commitSha: COMMIT_SHA,
    completedAt: kind === "plan" ? "2026-08-25T12:00:03.000Z" : null,
    conclusion: kind === "plan" ? "success" : null,
    createdAt: kind === "plan" ? "2026-08-25T11:55:00.000Z" : "2026-08-25T12:01:00.000Z",
    eventName: "workflow_dispatch",
    ref: SWITCHYARD_MAIN_REF,
    referencedWorkflows: [`${SWITCHYARD_REPOSITORY}/${enginePath}@${engineSha}`],
    repositoryId: SWITCHYARD_REPOSITORY_ID,
    repositoryOwnerId: SWITCHYARD_OWNER_ID,
    runAttempt: 1,
    runId,
    status: kind === "plan" ? "completed" : "in_progress",
    triggeringActorId: SWITCHYARD_OWNER_ACTOR_ID,
    workflowPath: path,
    workflowRef: `${SWITCHYARD_REPOSITORY}/${path}@${SWITCHYARD_MAIN_REF}`,
    ...overrides,
  };
}

export function activePlanRun(overrides: Partial<GitHubRunEvidence> = {}): GitHubRunEvidence {
  return runEvidence("plan", {
    completedAt: null,
    conclusion: null,
    status: "in_progress",
    ...overrides,
  });
}

export function initialStateRunEvidence(
  overrides: Partial<GitHubRunEvidence> = {},
): GitHubRunEvidence {
  return runEvidence("apply", {
    workflowPath: INFRASTRUCTURE_INITIAL_STATE_DISPATCHER_PATH,
    workflowRef: `${SWITCHYARD_REPOSITORY}/${INFRASTRUCTURE_INITIAL_STATE_DISPATCHER_PATH}@${SWITCHYARD_MAIN_REF}`,
    ...overrides,
  });
}

export function oidcClaims(
  identity: "bootstrap-applier" | "foundation-applier" | "planner",
  rawToken: Uint8Array,
  run = identity === "planner"
    ? runEvidence("plan")
    : identity === "bootstrap-applier"
      ? initialStateRunEvidence()
      : runEvidence("apply"),
  overrides: Partial<VerifiedGitHubOidcClaims> = {},
): VerifiedGitHubOidcClaims {
  const planner = identity === "planner";
  const path = planner ? INFRASTRUCTURE_PLAN_ENGINE_PATH : INFRASTRUCTURE_APPLY_ENGINE_PATH;
  const sha = planner ? PLAN_ENGINE_SHA : APPLY_ENGINE_SHA;
  const contract = futureIdentityContracts(POLICY)[identity];
  return {
    actorId: SWITCHYARD_OWNER_ACTOR_ID,
    audience: contract.audience,
    checkRunId: planner ? PLAN_JOB_CHECK_RUN_ID : APPLY_JOB_CHECK_RUN_ID,
    commitSha: run.commitSha,
    eventName: "workflow_dispatch",
    issuer: "https://token.actions.githubusercontent.com",
    jobWorkflowRef: `${SWITCHYARD_REPOSITORY}/${path}@${sha}`,
    jobWorkflowSha: sha,
    ref: SWITCHYARD_MAIN_REF,
    repositoryId: SWITCHYARD_REPOSITORY_ID,
    repositoryOwnerId: SWITCHYARD_OWNER_ID,
    runAttempt: 1,
    runId: run.runId,
    signatureAlgorithm: "RS256",
    subject: immutableOidcSubject(path, sha),
    tokenDigest: sha256Bytes(rawToken),
    verified: true,
    workflowRef: run.workflowRef,
    workflowSha: run.commitSha,
    ...overrides,
  };
}

export function jobEvidence(
  engine: "apply" | "plan",
  overrides: Partial<GitHubJobEvidence> = {},
): GitHubJobEvidence {
  const planner = engine === "plan";
  return {
    checkRunId: planner ? PLAN_JOB_CHECK_RUN_ID : APPLY_JOB_CHECK_RUN_ID,
    commitSha: COMMIT_SHA,
    jobId: planner ? "606" : "707",
    name: planner ? "plan" : "apply",
    runAttempt: 1,
    runId: planner ? PLAN_RUN_ID : APPROVAL_RUN_ID,
    status: "in_progress",
    workflowName: planner ? "Infrastructure plan" : "Infrastructure apply",
    ...overrides,
  };
}

export function identitySession(
  identity: "bootstrap-applier" | "foundation-applier" | "planner",
  rawToken: Uint8Array,
  overrides: Partial<InfrastructureIdentitySession> = {},
): InfrastructureIdentitySession {
  const planner = identity === "planner";
  const path = planner ? INFRASTRUCTURE_PLAN_ENGINE_PATH : INFRASTRUCTURE_APPLY_ENGINE_PATH;
  const sha = planner ? PLAN_ENGINE_SHA : APPLY_ENGINE_SHA;
  const contract = futureIdentityContracts(POLICY)[identity];
  return {
    ambientCredentialsUsed: false,
    assertionDigest: sha256Bytes(rawToken),
    audience: contract.audience,
    authentication: "github-oidc-client-assertion",
    clientId:
      identity === "planner"
        ? POLICY.plannerIdentityClientId
        : identity === "foundation-applier"
          ? POLICY.foundationIdentityClientId
          : POLICY.bootstrapIdentityClientId,
    credential: {
      async getToken() {
        return {
          expiresOnTimestamp: NOW.getTime() + 60 * 60 * 1_000,
          token: "test-azure-access-token.".repeat(4),
        };
      },
    },
    identity,
    jobWorkflowRef: `${SWITCHYARD_REPOSITORY}/${path}@${sha}`,
    principalId:
      identity === "planner"
        ? POLICY.plannerIdentityPrincipalId
        : identity === "foundation-applier"
          ? POLICY.foundationIdentityPrincipalId
          : POLICY.bootstrapIdentityPrincipalId,
    subject: contract.subject,
    subscriptionId: POLICY.subscriptionId,
    tenantId: POLICY.tenantId,
    ...overrides,
  };
}

export const REQUIRED_OIDC_SETTINGS = requiredOidcSettings();

export interface ZipInputEntry {
  readonly compressedSuffix?: Uint8Array;
  readonly contents: Uint8Array;
  readonly dataDescriptor?: boolean;
  readonly dosDate?: number;
  readonly dosTime?: number;
  readonly flags?: number;
  readonly method?: 0 | 8;
  readonly path: string;
  readonly unixMode?: number;
}

/** Small real-ZIP writer used only to drive the reviewed production decoder. */
export function createZip(entries: readonly ZipInputEntry[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, "ascii");
    const contents = Buffer.from(entry.contents);
    const method = entry.method ?? 8;
    const compressedPayload = method === 8 ? deflateRawSync(contents) : contents;
    const compressed = entry.compressedSuffix
      ? Buffer.concat([compressedPayload, Buffer.from(entry.compressedSuffix)])
      : compressedPayload;
    const checksum = crc32(contents);
    const usesDataDescriptor = entry.dataDescriptor === true;
    const flags = (entry.flags ?? 0) | (usesDataDescriptor ? 0x0008 : 0);
    const local = Buffer.alloc(30 + name.byteLength);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(entry.dosTime ?? 0, 10);
    local.writeUInt16LE(entry.dosDate ?? 0x21, 12);
    local.writeUInt32LE(usesDataDescriptor ? 0 : checksum, 14);
    local.writeUInt32LE(usesDataDescriptor ? 0 : compressed.byteLength, 18);
    local.writeUInt32LE(usesDataDescriptor ? 0 : contents.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    name.copy(local, 30);
    locals.push(local, compressed);
    let descriptorBytes = 0;
    if (usesDataDescriptor) {
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(checksum, 4);
      descriptor.writeUInt32LE(compressed.byteLength, 8);
      descriptor.writeUInt32LE(contents.byteLength, 12);
      locals.push(descriptor);
      descriptorBytes = descriptor.byteLength;
    }

    const central = Buffer.alloc(46 + name.byteLength);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | (usesDataDescriptor ? 45 : 20), 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(entry.dosTime ?? 0, 12);
    central.writeUInt16LE(entry.dosDate ?? 0x21, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.byteLength, 20);
    central.writeUInt32LE(contents.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(((entry.unixMode ?? 0o100600) << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);
    centrals.push(central);
    localOffset += local.byteLength + compressed.byteLength + descriptorBytes;
  }
  const centralSize = centrals.reduce((total, value) => total + value.byteLength, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Uint8Array.from(Buffer.concat([...locals, ...centrals, eocd]));
}

export function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function textOf(value: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(value);
}

function priorManagedResources(
  authorityClass: PlanAuthorityClass,
): readonly Record<string, unknown>[] {
  return authorityClass === "bootstrap"
    ? []
    : [{ address: "azurerm_resource_group.foundation", mode: "managed" }];
}

function priorState(resources: readonly Record<string, unknown>[]): Record<string, unknown> {
  return { format_version: "1.0", values: { root_module: { resources } } };
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    typeof value === "number"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function crc32(value: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    const tableValue = CRC32_TABLE[(crc ^ byte) & 0xff];
    if (tableValue === undefined) throw new Error("crc-table-fixture-invalid");
    crc = tableValue ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC32_TABLE = Array.from({ length: 256 }, (_unused, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});
