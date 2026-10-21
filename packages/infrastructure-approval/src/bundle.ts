import {
  ContractValidationError,
  parseStrictJsonObject,
  requireExactKeys,
  requireRecord,
} from "@switchyard/core";

import type { PlanChangeSummary } from "./authority.js";
import {
  type BackendIdentity,
  commitSha,
  decimalId,
  exactString,
  INFRASTRUCTURE_PLAN_ENGINE_PATH,
  instant,
  InfrastructureApprovalError,
  managedResourceCount,
  PLAN_ARTIFACT_RETENTION_DAYS,
  PLAN_BUNDLE_SCHEMA_VERSION,
  PLAN_MAX_AGE_MS,
  type PlanAuthorityClass,
  sha256,
  sha256Bytes,
  sha256Text,
  type StateIdentity,
  stateLineage,
  stateSerial,
  SWITCHYARD_MAIN_REF,
  SWITCHYARD_OWNER_ID,
  SWITCHYARD_REPOSITORY,
  SWITCHYARD_REPOSITORY_ID,
  validateBackend,
  validateStateIdentity,
} from "./contracts.js";
import {
  EXACT_SAVED_PLAN_CREATE_COMMAND,
  EXACT_SAVED_PLAN_SHOW_JSON_COMMAND,
  EXACT_SAVED_PLAN_SHOW_TEXT_COMMAND,
  openTofuCommandDigest,
  PINNED_OPEN_TOFU_VERSION,
} from "./opentofu.js";
import { decodeStrictZip } from "./zip.js";

const MANIFEST_PATH = "manifest.json";
const PLAN_TEXT_PATH = "plan.txt";
const PLAN_JSON_PATH = "plan.json";
const SAVED_PLAN_PATH = "saved-plan";
const EXPECTED_PATHS = [MANIFEST_PATH, PLAN_TEXT_PATH, PLAN_JSON_PATH, SAVED_PLAN_PATH] as const;

export const PLAN_ARCHIVE_LIMITS = Object.freeze({
  archiveBytes: 40 * 1_024 * 1_024,
  entryCount: 4,
  manifestBytes: 64 * 1_024,
  maxCompressionRatio: 100,
  planJsonBytes: 1_024 * 1_024,
  planTextBytes: 4 * 1_024 * 1_024,
  savedPlanBytes: 32 * 1_024 * 1_024,
  totalCompressedBytes: 40 * 1_024 * 1_024,
  totalUncompressedBytes: 40 * 1_024 * 1_024,
});

const ZIP_LIMITS = Object.freeze({
  archiveBytes: PLAN_ARCHIVE_LIMITS.archiveBytes,
  entryCount: PLAN_ARCHIVE_LIMITS.entryCount,
  exactDosDate: 0x21,
  exactDosTime: 0,
  exactUnixMode: 0o100600,
  files: Object.freeze({
    [MANIFEST_PATH]: PLAN_ARCHIVE_LIMITS.manifestBytes,
    [PLAN_TEXT_PATH]: PLAN_ARCHIVE_LIMITS.planTextBytes,
    [PLAN_JSON_PATH]: PLAN_ARCHIVE_LIMITS.planJsonBytes,
    [SAVED_PLAN_PATH]: PLAN_ARCHIVE_LIMITS.savedPlanBytes,
  }),
  maxCompressionRatio: PLAN_ARCHIVE_LIMITS.maxCompressionRatio,
  totalCompressedBytes: PLAN_ARCHIVE_LIMITS.totalCompressedBytes,
  totalUncompressedBytes: PLAN_ARCHIVE_LIMITS.totalUncompressedBytes,
});

export interface ManifestFile {
  readonly path: "plan.json" | "plan.txt" | "saved-plan";
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface PlanRenderEvidence {
  readonly planCommandDigest: string;
  readonly priorStateDigest: string;
  readonly renderedSavedPlanDigest: string;
  readonly showJsonCommandDigest: string;
  readonly showTextCommandDigest: string;
}

export interface PlannerIdentityEvidence {
  readonly audience: string;
  readonly identity: "planner";
  readonly jobWorkflowRef: string;
  readonly subject: string;
}

export interface PlanManifest {
  readonly activationConfigDigest: string;
  readonly authorityClass: PlanAuthorityClass;
  readonly backend: BackendIdentity;
  readonly changeSummary: PlanChangeSummary;
  readonly commitSha: string;
  readonly createdAt: string;
  readonly destructive: boolean;
  readonly expiresAt: string;
  readonly files: readonly [ManifestFile, ManifestFile, ManifestFile];
  readonly planDispatcherWorkflowRef: string;
  readonly planEnginePath: typeof INFRASTRUCTURE_PLAN_ENGINE_PATH;
  readonly planEngineSha: string;
  readonly planJobWorkflowRef: string;
  readonly planRunId: string;
  readonly plannerIdentity: PlannerIdentityEvidence;
  readonly ref: typeof SWITCHYARD_MAIN_REF;
  readonly renderEvidence: PlanRenderEvidence;
  readonly repositoryId: typeof SWITCHYARD_REPOSITORY_ID;
  readonly repositoryOwnerId: typeof SWITCHYARD_OWNER_ID;
  readonly retentionDays: typeof PLAN_ARTIFACT_RETENTION_DAYS;
  readonly schemaVersion: typeof PLAN_BUNDLE_SCHEMA_VERSION;
  readonly state: StateIdentity;
  readonly subscriptionId: string;
  readonly targetConfigurationDigest: string;
  readonly tenantId: string;
  readonly tofuVersion: typeof PINNED_OPEN_TOFU_VERSION;
}

export interface VerifiedPlanBundle {
  readonly archiveBytes: Uint8Array;
  readonly archiveDigest: string;
  readonly manifest: PlanManifest;
  readonly manifestDigest: string;
  readonly planDigest: string;
  readonly planJson: Uint8Array;
  readonly planText: Uint8Array;
  readonly savedPlan: Uint8Array;
}

export function createPlanManifest(input: {
  readonly activationConfigDigest: string;
  readonly authorityClass: PlanAuthorityClass;
  readonly backend: BackendIdentity;
  readonly changeSummary: PlanChangeSummary;
  readonly commitSha: string;
  readonly createdAt: string;
  readonly destructive: boolean;
  readonly files: readonly [ManifestFile, ManifestFile, ManifestFile];
  readonly planDispatcherWorkflowRef: string;
  readonly planEngineSha: string;
  readonly planRunId: string;
  readonly plannerIdentity: PlannerIdentityEvidence;
  readonly priorStateDigest: string;
  readonly state: StateIdentity;
  readonly subscriptionId: string;
  readonly targetConfigurationDigest: string;
  readonly tenantId: string;
}): PlanManifest {
  const created = instant(input.createdAt, "manifest.created_at");
  const planJobWorkflowRef = `${SWITCHYARD_REPOSITORY}/${INFRASTRUCTURE_PLAN_ENGINE_PATH}@${commitSha(input.planEngineSha, "manifest.planEngineSha")}`;
  return parseManifestValue({
    schema_version: PLAN_BUNDLE_SCHEMA_VERSION,
    repository_owner_id: SWITCHYARD_OWNER_ID,
    repository_id: SWITCHYARD_REPOSITORY_ID,
    ref: SWITCHYARD_MAIN_REF,
    commit_sha: input.commitSha,
    plan_run_id: input.planRunId,
    plan_dispatcher_workflow_ref: input.planDispatcherWorkflowRef,
    plan_engine_path: INFRASTRUCTURE_PLAN_ENGINE_PATH,
    plan_engine_sha: input.planEngineSha,
    plan_job_workflow_ref: planJobWorkflowRef,
    planner_identity: plannerIdentityJson(input.plannerIdentity),
    authority_class: input.authorityClass,
    activation_config_sha256: input.activationConfigDigest,
    tenant_id: input.tenantId,
    subscription_id: input.subscriptionId,
    target_configuration_sha256: input.targetConfigurationDigest,
    backend: backendJson(input.backend),
    state: stateJson(input.state),
    tofu_version: PINNED_OPEN_TOFU_VERSION,
    render_evidence: {
      plan_command_sha256: openTofuCommandDigest(EXACT_SAVED_PLAN_CREATE_COMMAND),
      show_json_command_sha256: openTofuCommandDigest(EXACT_SAVED_PLAN_SHOW_JSON_COMMAND),
      show_text_command_sha256: openTofuCommandDigest(EXACT_SAVED_PLAN_SHOW_TEXT_COMMAND),
      rendered_saved_plan_sha256: input.files[2].sha256,
      prior_state_sha256: input.priorStateDigest,
    },
    created_at: created.toISOString(),
    expires_at: new Date(created.getTime() + PLAN_MAX_AGE_MS).toISOString(),
    retention_days: PLAN_ARTIFACT_RETENTION_DAYS,
    destructive: input.destructive,
    change_summary: summaryJson(input.changeSummary),
    files: input.files.map(fileJson),
  });
}

export function canonicalPlanManifest(manifest: PlanManifest): string {
  return `${JSON.stringify(manifestJson(manifest))}\n`;
}

const MANIFEST_KEYS = [
  "schema_version",
  "repository_owner_id",
  "repository_id",
  "ref",
  "commit_sha",
  "plan_run_id",
  "plan_dispatcher_workflow_ref",
  "plan_engine_path",
  "plan_engine_sha",
  "plan_job_workflow_ref",
  "planner_identity",
  "authority_class",
  "activation_config_sha256",
  "tenant_id",
  "subscription_id",
  "target_configuration_sha256",
  "backend",
  "state",
  "tofu_version",
  "render_evidence",
  "created_at",
  "expires_at",
  "retention_days",
  "destructive",
  "change_summary",
  "files",
] as const;

export function parseCanonicalPlanManifest(source: string): PlanManifest {
  const record = parseStrictJsonObject(source, MANIFEST_KEYS, {
    maxBytes: PLAN_ARCHIVE_LIMITS.manifestBytes,
    maxDepth: 6,
    path: "manifest",
  });
  const result = parseManifestValue(record);
  if (source !== canonicalPlanManifest(result)) {
    throw new InfrastructureApprovalError("manifest-is-not-canonical");
  }
  return result;
}

function parseManifestValue(value: Record<string, unknown>): PlanManifest {
  requireExactKeys(value, MANIFEST_KEYS, "manifest");
  if (value.schema_version !== PLAN_BUNDLE_SCHEMA_VERSION) invalid("schema_version");
  if (value.repository_owner_id !== SWITCHYARD_OWNER_ID) invalid("repository_owner_id");
  if (value.repository_id !== SWITCHYARD_REPOSITORY_ID) invalid("repository_id");
  if (value.ref !== SWITCHYARD_MAIN_REF) invalid("ref");
  if (value.plan_engine_path !== INFRASTRUCTURE_PLAN_ENGINE_PATH) invalid("plan_engine_path");
  if (value.tofu_version !== PINNED_OPEN_TOFU_VERSION) invalid("tofu_version");
  if (value.retention_days !== PLAN_ARTIFACT_RETENTION_DAYS) invalid("retention_days");
  if (value.authority_class !== "foundation" && value.authority_class !== "bootstrap") {
    invalid("authority_class");
  }
  if (typeof value.destructive !== "boolean") invalid("destructive");
  const createdAt = instant(value.created_at, "manifest.created_at").toISOString();
  const expiresAt = instant(value.expires_at, "manifest.expires_at").toISOString();
  if (Date.parse(expiresAt) - Date.parse(createdAt) !== PLAN_MAX_AGE_MS) invalid("expires_at");
  const planEngineSha = commitSha(value.plan_engine_sha, "manifest.plan_engine_sha");
  const expectedJobRef = `${SWITCHYARD_REPOSITORY}/${INFRASTRUCTURE_PLAN_ENGINE_PATH}@${planEngineSha}`;
  if (value.plan_job_workflow_ref !== expectedJobRef) invalid("plan_job_workflow_ref");
  return Object.freeze({
    activationConfigDigest: sha256(
      value.activation_config_sha256,
      "manifest.activation_config_sha256",
    ),
    authorityClass: value.authority_class,
    backend: parseBackend(value.backend),
    changeSummary: parseSummary(value.change_summary),
    commitSha: commitSha(value.commit_sha, "manifest.commit_sha"),
    createdAt,
    destructive: value.destructive,
    expiresAt,
    files: parseFiles(value.files),
    planDispatcherWorkflowRef: exactString(
      value.plan_dispatcher_workflow_ref,
      "manifest.plan_dispatcher_workflow_ref",
      512,
    ),
    planEnginePath: INFRASTRUCTURE_PLAN_ENGINE_PATH,
    planEngineSha,
    planJobWorkflowRef: expectedJobRef,
    planRunId: decimalId(value.plan_run_id, "manifest.plan_run_id"),
    plannerIdentity: parsePlannerIdentity(value.planner_identity, expectedJobRef),
    ref: SWITCHYARD_MAIN_REF,
    renderEvidence: parseRenderEvidence(value.render_evidence),
    repositoryId: SWITCHYARD_REPOSITORY_ID,
    repositoryOwnerId: SWITCHYARD_OWNER_ID,
    retentionDays: PLAN_ARTIFACT_RETENTION_DAYS,
    schemaVersion: PLAN_BUNDLE_SCHEMA_VERSION,
    state: parseState(value.state),
    subscriptionId: exactString(value.subscription_id, "manifest.subscription_id", 128),
    targetConfigurationDigest: sha256(
      value.target_configuration_sha256,
      "manifest.target_configuration_sha256",
    ),
    tenantId: exactString(value.tenant_id, "manifest.tenant_id", 128),
    tofuVersion: PINNED_OPEN_TOFU_VERSION,
  });
}

export async function verifyPlanArchive(archiveBytes: Uint8Array): Promise<VerifiedPlanBundle> {
  const archive = await decodeStrictZip(archiveBytes, ZIP_LIMITS);
  const entries = new Map(archive.entries.map((entry) => [entry.path, entry.contents]));
  for (const expected of EXPECTED_PATHS) {
    if (!entries.has(expected)) throw new InfrastructureApprovalError("archive-files-invalid");
  }
  const manifestBytes = requireEntry(entries, MANIFEST_PATH);
  const planText = requireEntry(entries, PLAN_TEXT_PATH);
  const planJson = requireEntry(entries, PLAN_JSON_PATH);
  const savedPlan = requireEntry(entries, SAVED_PLAN_PATH);
  const manifestSource = new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes);
  const manifest = parseCanonicalPlanManifest(manifestSource);
  const byPath = new Map(manifest.files.map((file) => [file.path, file]));
  for (const [path, contents] of [
    [PLAN_TEXT_PATH, planText],
    [PLAN_JSON_PATH, planJson],
    [SAVED_PLAN_PATH, savedPlan],
  ] as const) {
    const expected = byPath.get(path);
    if (
      expected === undefined ||
      expected.sizeBytes !== contents.byteLength ||
      expected.sha256 !== sha256Bytes(contents)
    ) {
      throw new InfrastructureApprovalError("bundle-file-digest-mismatch");
    }
  }
  const planDigest = sha256Bytes(savedPlan);
  if (manifest.renderEvidence.renderedSavedPlanDigest !== planDigest) {
    throw new InfrastructureApprovalError("manifest-rendered-plan-digest-mismatch");
  }
  return Object.freeze({
    archiveBytes,
    archiveDigest: sha256Bytes(archiveBytes),
    manifest,
    manifestDigest: sha256Text(manifestSource),
    planDigest,
    planJson,
    planText,
    savedPlan,
  });
}

export function manifestFiles(input: {
  readonly planJson: Uint8Array;
  readonly planText: Uint8Array;
  readonly savedPlan: Uint8Array;
}): readonly [ManifestFile, ManifestFile, ManifestFile] {
  return Object.freeze([
    file(PLAN_TEXT_PATH, input.planText),
    file(PLAN_JSON_PATH, input.planJson),
    file(SAVED_PLAN_PATH, input.savedPlan),
  ]) as readonly [ManifestFile, ManifestFile, ManifestFile];
}

export function bundleEntries(input: {
  readonly manifestSource: string;
  readonly planJson: Uint8Array;
  readonly planText: Uint8Array;
  readonly savedPlan: Uint8Array;
}): readonly { readonly contents: Uint8Array; readonly path: string }[] {
  return Object.freeze([
    Object.freeze({
      path: MANIFEST_PATH,
      contents: new TextEncoder().encode(input.manifestSource),
    }),
    Object.freeze({ path: PLAN_TEXT_PATH, contents: input.planText }),
    Object.freeze({ path: PLAN_JSON_PATH, contents: input.planJson }),
    Object.freeze({ path: SAVED_PLAN_PATH, contents: input.savedPlan }),
  ]);
}

function manifestJson(manifest: PlanManifest): Record<string, unknown> {
  return {
    schema_version: manifest.schemaVersion,
    repository_owner_id: manifest.repositoryOwnerId,
    repository_id: manifest.repositoryId,
    ref: manifest.ref,
    commit_sha: manifest.commitSha,
    plan_run_id: manifest.planRunId,
    plan_dispatcher_workflow_ref: manifest.planDispatcherWorkflowRef,
    plan_engine_path: manifest.planEnginePath,
    plan_engine_sha: manifest.planEngineSha,
    plan_job_workflow_ref: manifest.planJobWorkflowRef,
    planner_identity: plannerIdentityJson(manifest.plannerIdentity),
    authority_class: manifest.authorityClass,
    activation_config_sha256: manifest.activationConfigDigest,
    tenant_id: manifest.tenantId,
    subscription_id: manifest.subscriptionId,
    target_configuration_sha256: manifest.targetConfigurationDigest,
    backend: backendJson(manifest.backend),
    state: stateJson(manifest.state),
    tofu_version: manifest.tofuVersion,
    render_evidence: renderEvidenceJson(manifest.renderEvidence),
    created_at: manifest.createdAt,
    expires_at: manifest.expiresAt,
    retention_days: manifest.retentionDays,
    destructive: manifest.destructive,
    change_summary: summaryJson(manifest.changeSummary),
    files: manifest.files.map(fileJson),
  };
}

function backendJson(value: BackendIdentity): Record<string, unknown> {
  return {
    type: value.type,
    resource_group_name: value.resourceGroupName,
    storage_account_name: value.storageAccountName,
    container_name: value.containerName,
    key: value.key,
  };
}

function parseBackend(value: unknown): BackendIdentity {
  const record = requireRecord(value, "manifest.backend");
  requireExactKeys(
    record,
    ["type", "resource_group_name", "storage_account_name", "container_name", "key"],
    "manifest.backend",
  );
  const result: BackendIdentity = {
    type: record.type === "azurerm" ? "azurerm" : invalid("backend.type"),
    resourceGroupName: exactString(
      record.resource_group_name,
      "manifest.backend.resource_group_name",
      90,
    ),
    storageAccountName: exactString(
      record.storage_account_name,
      "manifest.backend.storage_account_name",
      24,
    ),
    containerName: exactString(record.container_name, "manifest.backend.container_name", 63),
    key: exactString(record.key, "manifest.backend.key", 256),
  };
  validateBackend(result, "manifest.backend");
  return Object.freeze(result);
}

function stateJson(value: StateIdentity): Record<string, unknown> {
  return {
    backend_state_sha256: value.backendStateDigest,
    backend_state_etag: value.backendStateEtag,
    lineage: value.lineage,
    serial: value.serial,
    managed_resource_count: value.managedResourceCount,
    managed_resources_empty: value.managedResourcesEmpty,
  };
}

function parseState(value: unknown): StateIdentity {
  const record = requireRecord(value, "manifest.state");
  requireExactKeys(
    record,
    [
      "backend_state_sha256",
      "backend_state_etag",
      "lineage",
      "serial",
      "managed_resource_count",
      "managed_resources_empty",
    ],
    "manifest.state",
  );
  if (typeof record.managed_resources_empty !== "boolean") invalid("state.managed_resources_empty");
  const result: StateIdentity = {
    backendStateDigest: sha256(record.backend_state_sha256, "manifest.state.backend_state_sha256"),
    backendStateEtag: exactString(
      record.backend_state_etag,
      "manifest.state.backend_state_etag",
      256,
    ),
    lineage: stateLineage(record.lineage, "manifest.state.lineage"),
    managedResourceCount: managedResourceCount(
      record.managed_resource_count,
      "manifest.state.managed_resource_count",
    ),
    managedResourcesEmpty: record.managed_resources_empty,
    serial: stateSerial(record.serial, "manifest.state.serial"),
  };
  validateStateIdentity(result, "manifest.state");
  return Object.freeze(result);
}

function renderEvidenceJson(value: PlanRenderEvidence): Record<string, unknown> {
  return {
    plan_command_sha256: value.planCommandDigest,
    show_json_command_sha256: value.showJsonCommandDigest,
    show_text_command_sha256: value.showTextCommandDigest,
    rendered_saved_plan_sha256: value.renderedSavedPlanDigest,
    prior_state_sha256: value.priorStateDigest,
  };
}

function plannerIdentityJson(value: PlannerIdentityEvidence): Record<string, unknown> {
  return {
    identity: value.identity,
    audience: value.audience,
    subject: value.subject,
    job_workflow_ref: value.jobWorkflowRef,
  };
}

function parsePlannerIdentity(value: unknown, expectedJobRef: string): PlannerIdentityEvidence {
  const record = requireRecord(value, "manifest.planner_identity");
  requireExactKeys(
    record,
    ["identity", "audience", "subject", "job_workflow_ref"],
    "manifest.planner_identity",
  );
  if (record.identity !== "planner" || record.job_workflow_ref !== expectedJobRef) {
    invalid("planner_identity");
  }
  return Object.freeze({
    identity: "planner",
    audience: exactString(record.audience, "manifest.planner_identity.audience", 256),
    subject: exactString(record.subject, "manifest.planner_identity.subject", 1024),
    jobWorkflowRef: expectedJobRef,
  });
}

function parseRenderEvidence(value: unknown): PlanRenderEvidence {
  const record = requireRecord(value, "manifest.render_evidence");
  requireExactKeys(
    record,
    [
      "plan_command_sha256",
      "show_json_command_sha256",
      "show_text_command_sha256",
      "rendered_saved_plan_sha256",
      "prior_state_sha256",
    ],
    "manifest.render_evidence",
  );
  const result = Object.freeze({
    planCommandDigest: sha256(
      record.plan_command_sha256,
      "manifest.render_evidence.plan_command_sha256",
    ),
    showJsonCommandDigest: sha256(
      record.show_json_command_sha256,
      "manifest.render_evidence.show_json_command_sha256",
    ),
    showTextCommandDigest: sha256(
      record.show_text_command_sha256,
      "manifest.render_evidence.show_text_command_sha256",
    ),
    renderedSavedPlanDigest: sha256(
      record.rendered_saved_plan_sha256,
      "manifest.render_evidence.rendered_saved_plan_sha256",
    ),
    priorStateDigest: sha256(
      record.prior_state_sha256,
      "manifest.render_evidence.prior_state_sha256",
    ),
  });
  if (
    result.planCommandDigest !== openTofuCommandDigest(EXACT_SAVED_PLAN_CREATE_COMMAND) ||
    result.showJsonCommandDigest !== openTofuCommandDigest(EXACT_SAVED_PLAN_SHOW_JSON_COMMAND) ||
    result.showTextCommandDigest !== openTofuCommandDigest(EXACT_SAVED_PLAN_SHOW_TEXT_COMMAND)
  ) {
    throw new InfrastructureApprovalError("manifest-opentofu-command-digest-mismatch");
  }
  return result;
}

function summaryJson(value: PlanChangeSummary): Record<string, unknown> {
  return {
    create: value.create,
    update: value.update,
    delete: value.delete,
    replace: value.replace,
    read: value.read,
    authority: value.authority,
  };
}

function parseSummary(value: unknown): PlanChangeSummary {
  const record = requireRecord(value, "manifest.change_summary");
  requireExactKeys(
    record,
    ["create", "update", "delete", "replace", "read", "authority"],
    "manifest.change_summary",
  );
  return Object.freeze({
    authority: count(record.authority, "authority"),
    create: count(record.create, "create"),
    delete: count(record.delete, "delete"),
    read: count(record.read, "read"),
    replace: count(record.replace, "replace"),
    update: count(record.update, "update"),
  });
}

function count(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 4_096) {
    throw new ContractValidationError(
      `manifest.change_summary.${field}`,
      "must be a bounded count",
    );
  }
  return value as number;
}

function fileJson(value: ManifestFile): Record<string, unknown> {
  return { path: value.path, sha256: value.sha256, size_bytes: value.sizeBytes };
}

function parseFiles(value: unknown): readonly [ManifestFile, ManifestFile, ManifestFile] {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new ContractValidationError("manifest.files", "must contain exactly three files");
  }
  const expected = [PLAN_TEXT_PATH, PLAN_JSON_PATH, SAVED_PLAN_PATH] as const;
  const limits = [
    PLAN_ARCHIVE_LIMITS.planTextBytes,
    PLAN_ARCHIVE_LIMITS.planJsonBytes,
    PLAN_ARCHIVE_LIMITS.savedPlanBytes,
  ] as const;
  return value.map((raw, index) => {
    const path = `manifest.files[${index}]`;
    const expectedPath = expected[index];
    const limit = limits[index];
    if (expectedPath === undefined || limit === undefined) invalid(`${path}.index`);
    const record = requireRecord(raw, path);
    requireExactKeys(record, ["path", "sha256", "size_bytes"], path);
    if (record.path !== expectedPath) invalid(`${path}.path`);
    if (
      !Number.isSafeInteger(record.size_bytes) ||
      (record.size_bytes as number) < 1 ||
      (record.size_bytes as number) > limit
    ) {
      invalid(`${path}.size_bytes`);
    }
    return Object.freeze({
      path: expectedPath,
      sha256: sha256(record.sha256, `${path}.sha256`),
      sizeBytes: record.size_bytes as number,
    });
  }) as unknown as readonly [ManifestFile, ManifestFile, ManifestFile];
}

function requireEntry(entries: Map<string, Uint8Array>, path: string): Uint8Array {
  const value = entries.get(path);
  if (value === undefined || value.byteLength < 1)
    throw new InfrastructureApprovalError("archive-entry-missing");
  return value;
}

function file(path: ManifestFile["path"], contents: Uint8Array): ManifestFile {
  if (contents.byteLength < 1) throw new InfrastructureApprovalError("bundle-file-empty");
  return Object.freeze({ path, sha256: sha256Bytes(contents), sizeBytes: contents.byteLength });
}

function invalid(field: string): never {
  throw new ContractValidationError(`manifest.${field}`, "has an invalid value");
}
