import type { AllocationIdentity } from "./allocation-identity.js";
import { parseAllocationIdentity } from "./allocation-identity.js";
import { parseBackupChoice, type BackupChoice } from "./backup-choice.js";
import { parseCapabilityProfile, type CapabilityProfile } from "./capabilities.js";
import {
  ContractValidationError,
  requireExactKeys,
  requireNonEmptyString,
  requireRecord,
} from "./validation.js";

export const APPROVED_GITHUB_REF = "refs/heads/main" as const;
// Synthetic preview identity. Replace through review before enabling any mapping.
export const OWNER_GITHUB_USER_ID = "900000001" as const;
export const RUNNER_LABEL_OUTPUT_NAME = "runner_label" as const;

export interface ApprovedRepository {
  readonly id: string;
  readonly name: string;
  readonly owner: string;
}

export interface ApprovedCallerWorkflow {
  readonly path: string;
  readonly ref: typeof APPROVED_GITHUB_REF;
}

export interface ApprovedBranchEvidence {
  readonly approvedRunAttempt: 1;
  readonly commitSha: string;
  readonly kind: "approved-branch-evidence";
  readonly ref: typeof APPROVED_GITHUB_REF;
  readonly repositoryId: string;
  readonly runId: string;
}

export type ApprovedBranchEvidenceRecordResult = "conflict" | "matched" | "recorded";

/**
 * The controller must back this port with authoritative durable state. Recording
 * is an atomic insert-or-compare operation keyed by repository and workflow run.
 */
export interface ApprovedBranchEvidenceStore {
  load(input: { readonly repositoryId: string; readonly runId: string }): Promise<unknown | null>;
  recordInitial(evidence: ApprovedBranchEvidence): Promise<ApprovedBranchEvidenceRecordResult>;
}

export interface ApprovedWorkloadDefinition {
  readonly backupChoice: BackupChoice;
  readonly blacksmithRunnerLabel: string;
  readonly jobKey: string;
  readonly jobName: string;
  readonly production: true;
  readonly profile: CapabilityProfile;
  readonly timeoutMinutes: number;
}

export interface DisabledApprovedWorkloadDefinition
  extends Omit<ApprovedWorkloadDefinition, "jobName"> {
  readonly jobName: string | null;
}

export interface ApprovedReusableWorkflow {
  readonly commitSha: string;
  readonly path: string;
  readonly repository: {
    readonly name: string;
    readonly owner: string;
  };
}

export interface EnabledApprovedWorkloadMapping {
  readonly allocator: {
    readonly checkName: string;
    readonly jobKey: string;
    readonly jobName: string;
    readonly reusableWorkflow: ApprovedReusableWorkflow;
  };
  readonly approvedCallerGateJobKey: string;
  readonly callerWorkflow: ApprovedCallerWorkflow;
  readonly mappingPointer: string;
  readonly ownerActorId: string;
  readonly repository: ApprovedRepository;
  readonly state: "enabled";
  readonly workload: ApprovedWorkloadDefinition;
}

export interface DisabledApprovedWorkloadMapping {
  readonly callerWorkflow: ApprovedCallerWorkflow;
  readonly mappingPointer: string;
  readonly ownerActorId: string;
  readonly reason: string;
  readonly repository: ApprovedRepository;
  readonly state: "disabled";
  readonly workload: DisabledApprovedWorkloadDefinition;
}

export type ApprovedWorkloadMapping =
  | DisabledApprovedWorkloadMapping
  | EnabledApprovedWorkloadMapping;

export interface VerifiedWorkloadTrust {
  readonly approvedBranch: ApprovedBranchEvidence;
  readonly allocator: {
    readonly checkName: string;
    readonly checkRunId: string;
    readonly jobId: string;
    readonly jobKey: string;
    readonly reusableWorkflow: ApprovedReusableWorkflow;
  };
  readonly identity: AllocationIdentity;
  readonly mappingPointer: string;
  readonly ownerActorId: string;
  readonly repository: ApprovedRepository;
  readonly workload: ApprovedWorkloadDefinition;
  readonly workflow: {
    readonly commitSha: string;
    readonly path: string;
  };
}

export type TrustVerificationFailureClassification =
  | "controller-unavailable"
  | "invalid-configuration"
  | "security-failure";

export interface TrustVerificationFailure {
  readonly classification: TrustVerificationFailureClassification;
  readonly code: string;
  readonly message: string;
}

export type TrustVerificationResult =
  | { readonly evidence: VerifiedWorkloadTrust; readonly trusted: true }
  | { readonly failure: TrustVerificationFailure; readonly trusted: false };

const REPOSITORY_KEYS = ["id", "owner", "name"] as const;
const CALLER_WORKFLOW_KEYS = ["path", "ref"] as const;
const WORKLOAD_KEYS = [
  "backupChoice",
  "blacksmithRunnerLabel",
  "jobKey",
  "jobName",
  "profile",
  "timeoutMinutes",
  "production",
] as const;
const ENABLED_MAPPING_KEYS = [
  "state",
  "mappingPointer",
  "repository",
  "callerWorkflow",
  "ownerActorId",
  "approvedCallerGateJobKey",
  "allocator",
  "workload",
] as const;
const DISABLED_MAPPING_KEYS = [
  "state",
  "mappingPointer",
  "reason",
  "repository",
  "callerWorkflow",
  "ownerActorId",
  "workload",
] as const;
const ALLOCATOR_KEYS = ["jobKey", "jobName", "checkName", "reusableWorkflow"] as const;
const REUSABLE_WORKFLOW_KEYS = ["repository", "path", "commitSha"] as const;

export function parseApprovedWorkloadMapping(value: unknown): ApprovedWorkloadMapping {
  const record = requireRecord(value, "approvedWorkloadMapping");
  if (record.state === "enabled") {
    requireExactKeys(record, ENABLED_MAPPING_KEYS, "approvedWorkloadMapping");
    return {
      state: "enabled",
      mappingPointer: requireNonEmptyString(
        record.mappingPointer,
        "approvedWorkloadMapping.mappingPointer",
      ),
      repository: parseApprovedRepository(record.repository),
      callerWorkflow: parseApprovedCallerWorkflow(record.callerWorkflow),
      ownerActorId: requirePositiveDecimalString(
        record.ownerActorId,
        "approvedWorkloadMapping.ownerActorId",
      ),
      approvedCallerGateJobKey: requireJobKey(
        record.approvedCallerGateJobKey,
        "approvedWorkloadMapping.approvedCallerGateJobKey",
      ),
      allocator: parseApprovedAllocator(record.allocator),
      workload: parseApprovedWorkload(record.workload),
    };
  }

  if (record.state === "disabled") {
    requireExactKeys(record, DISABLED_MAPPING_KEYS, "approvedWorkloadMapping");
    return {
      state: "disabled",
      mappingPointer: requireNonEmptyString(
        record.mappingPointer,
        "approvedWorkloadMapping.mappingPointer",
      ),
      reason: requireNonEmptyString(record.reason, "approvedWorkloadMapping.reason"),
      repository: parseApprovedRepository(record.repository),
      callerWorkflow: parseApprovedCallerWorkflow(record.callerWorkflow),
      ownerActorId: requirePositiveDecimalString(
        record.ownerActorId,
        "approvedWorkloadMapping.ownerActorId",
      ),
      workload: parseDisabledApprovedWorkload(record.workload),
    };
  }

  throw new ContractValidationError(
    "approvedWorkloadMapping.state",
    "must be 'enabled' or 'disabled'",
  );
}

export function parseApprovedWorkloadMappings(value: unknown): readonly ApprovedWorkloadMapping[] {
  if (!Array.isArray(value)) {
    throw new ContractValidationError("approvedWorkloadMappings", "must be an array");
  }

  return value.map((entry) => parseApprovedWorkloadMapping(entry));
}

export function requireEnabledApprovedWorkloadMapping(
  mapping: ApprovedWorkloadMapping,
): EnabledApprovedWorkloadMapping {
  if (mapping.state !== "enabled") {
    throw new ContractValidationError(
      "approvedWorkloadMapping.state",
      "mapping is disabled and cannot authorise an allocation",
    );
  }

  return mapping;
}

export function parseVerifiedWorkloadTrust(value: unknown): VerifiedWorkloadTrust {
  const record = requireRecord(value, "verifiedWorkloadTrust");
  requireExactKeys(
    record,
    [
      "identity",
      "approvedBranch",
      "mappingPointer",
      "repository",
      "workflow",
      "ownerActorId",
      "allocator",
      "workload",
    ],
    "verifiedWorkloadTrust",
  );

  const workflow = requireRecord(record.workflow, "verifiedWorkloadTrust.workflow");
  requireExactKeys(workflow, ["path", "commitSha"], "verifiedWorkloadTrust.workflow");
  const identity = parseAllocationIdentity(record.identity);
  const repository = parseApprovedRepository(record.repository, "verifiedWorkloadTrust.repository");
  const approvedBranch = parseApprovedBranchEvidence(record.approvedBranch);
  const commitSha = requireFullCommitSha(
    workflow.commitSha,
    "verifiedWorkloadTrust.workflow.commitSha",
  );
  if (
    approvedBranch.repositoryId !== repository.id ||
    approvedBranch.repositoryId !== identity.repository_id ||
    approvedBranch.runId !== identity.run_id ||
    approvedBranch.commitSha !== commitSha
  ) {
    throw new ContractValidationError(
      "verifiedWorkloadTrust.approvedBranch",
      "does not match the allocation identity, repository and immutable workflow commit",
    );
  }

  const allocator = requireRecord(record.allocator, "verifiedWorkloadTrust.allocator");
  requireExactKeys(
    allocator,
    ["jobKey", "jobId", "checkName", "checkRunId", "reusableWorkflow"],
    "verifiedWorkloadTrust.allocator",
  );

  return {
    identity,
    approvedBranch,
    mappingPointer: requireNonEmptyString(
      record.mappingPointer,
      "verifiedWorkloadTrust.mappingPointer",
    ),
    repository,
    workflow: {
      path: requireWorkflowPath(workflow.path, "verifiedWorkloadTrust.workflow.path"),
      commitSha,
    },
    ownerActorId: requirePositiveDecimalString(
      record.ownerActorId,
      "verifiedWorkloadTrust.ownerActorId",
    ),
    allocator: {
      jobKey: requireJobKey(allocator.jobKey, "verifiedWorkloadTrust.allocator.jobKey"),
      checkName: requireNonEmptyString(
        allocator.checkName,
        "verifiedWorkloadTrust.allocator.checkName",
      ),
      checkRunId: requirePositiveDecimalString(
        allocator.checkRunId,
        "verifiedWorkloadTrust.allocator.checkRunId",
      ),
      jobId: requirePositiveDecimalString(allocator.jobId, "verifiedWorkloadTrust.allocator.jobId"),
      reusableWorkflow: parseApprovedReusableWorkflow(allocator.reusableWorkflow),
    },
    workload: parseApprovedWorkload(record.workload, "verifiedWorkloadTrust.workload"),
  };
}

export function parseApprovedBranchEvidence(value: unknown): ApprovedBranchEvidence {
  const path = "approvedBranchEvidence";
  const record = requireRecord(value, path);
  requireExactKeys(
    record,
    ["kind", "repositoryId", "runId", "approvedRunAttempt", "ref", "commitSha"],
    path,
  );
  if (record.kind !== "approved-branch-evidence") {
    throw new ContractValidationError(`${path}.kind`, "must be 'approved-branch-evidence'");
  }
  if (record.approvedRunAttempt !== 1) {
    throw new ContractValidationError(`${path}.approvedRunAttempt`, "must be the literal 1");
  }
  if (record.ref !== APPROVED_GITHUB_REF) {
    throw new ContractValidationError(`${path}.ref`, `must be '${APPROVED_GITHUB_REF}'`);
  }

  return {
    kind: "approved-branch-evidence",
    repositoryId: requirePositiveDecimalString(record.repositoryId, `${path}.repositoryId`),
    runId: requirePositiveDecimalString(record.runId, `${path}.runId`),
    approvedRunAttempt: 1,
    ref: APPROVED_GITHUB_REF,
    commitSha: requireFullCommitSha(record.commitSha, `${path}.commitSha`),
  };
}

export function requireFullCommitSha(value: unknown, path = "commitSha"): string {
  const sha = requireNonEmptyString(value, path);
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new ContractValidationError(path, "must be a full lowercase 40-character commit SHA");
  }

  return sha;
}

export function requirePositiveDecimalString(value: unknown, path: string): string {
  const identifier = requireNonEmptyString(value, path);
  if (!/^[1-9]\d*$/.test(identifier)) {
    throw new ContractValidationError(path, "must be a positive decimal string");
  }

  return identifier;
}

export function requireJobKey(value: unknown, path: string): string {
  const jobKey = requireNonEmptyString(value, path);
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(jobKey)) {
    throw new ContractValidationError(path, "must be a literal GitHub Actions job key");
  }

  return jobKey;
}

function parseApprovedRepository(
  value: unknown,
  path = "approvedWorkloadMapping.repository",
): ApprovedRepository {
  const record = requireRecord(value, path);
  requireExactKeys(record, REPOSITORY_KEYS, path);

  return {
    id: requirePositiveDecimalString(record.id, `${path}.id`),
    owner: requireRepositoryNamePart(record.owner, `${path}.owner`),
    name: requireRepositoryNamePart(record.name, `${path}.name`),
  };
}

function parseApprovedCallerWorkflow(value: unknown): ApprovedCallerWorkflow {
  const record = requireRecord(value, "approvedWorkloadMapping.callerWorkflow");
  requireExactKeys(record, CALLER_WORKFLOW_KEYS, "approvedWorkloadMapping.callerWorkflow");
  if (record.ref !== APPROVED_GITHUB_REF) {
    throw new ContractValidationError(
      "approvedWorkloadMapping.callerWorkflow.ref",
      `must be '${APPROVED_GITHUB_REF}'`,
    );
  }

  return {
    path: requireWorkflowPath(record.path, "approvedWorkloadMapping.callerWorkflow.path"),
    ref: APPROVED_GITHUB_REF,
  };
}

function parseApprovedWorkload(
  value: unknown,
  path = "approvedWorkloadMapping.workload",
): ApprovedWorkloadDefinition {
  const record = requireRecord(value, path);
  requireExactKeys(record, WORKLOAD_KEYS, path);
  if (record.production !== true) {
    throw new ContractValidationError(`${path}.production`, "must be the literal true value");
  }

  return {
    backupChoice: parseBackupChoice(record.backupChoice, `${path}.backupChoice`),
    blacksmithRunnerLabel: requireRunnerLabel(
      record.blacksmithRunnerLabel,
      `${path}.blacksmithRunnerLabel`,
    ),
    jobKey: requireJobKey(record.jobKey, `${path}.jobKey`),
    jobName: requireNonEmptyString(record.jobName, `${path}.jobName`),
    profile: parseCapabilityProfile(record.profile, `${path}.profile`),
    timeoutMinutes: requirePositiveSafeInteger(record.timeoutMinutes, `${path}.timeoutMinutes`),
    production: true,
  };
}

function parseDisabledApprovedWorkload(value: unknown): DisabledApprovedWorkloadDefinition {
  const path = "approvedWorkloadMapping.workload";
  const record = requireRecord(value, path);
  requireExactKeys(record, WORKLOAD_KEYS, path);
  if (record.production !== true) {
    throw new ContractValidationError(`${path}.production`, "must be the literal true value");
  }

  return {
    backupChoice: parseBackupChoice(record.backupChoice, `${path}.backupChoice`),
    blacksmithRunnerLabel: requireRunnerLabel(
      record.blacksmithRunnerLabel,
      `${path}.blacksmithRunnerLabel`,
    ),
    jobKey: requireJobKey(record.jobKey, `${path}.jobKey`),
    jobName:
      record.jobName === null ? null : requireNonEmptyString(record.jobName, `${path}.jobName`),
    profile: parseCapabilityProfile(record.profile, `${path}.profile`),
    timeoutMinutes: requirePositiveSafeInteger(record.timeoutMinutes, `${path}.timeoutMinutes`),
    production: true,
  };
}

function parseApprovedAllocator(value: unknown): EnabledApprovedWorkloadMapping["allocator"] {
  const path = "approvedWorkloadMapping.allocator";
  const record = requireRecord(value, path);
  requireExactKeys(record, ALLOCATOR_KEYS, path);

  return {
    jobKey: requireJobKey(record.jobKey, `${path}.jobKey`),
    jobName: requireNonEmptyString(record.jobName, `${path}.jobName`),
    checkName: requireNonEmptyString(record.checkName, `${path}.checkName`),
    reusableWorkflow: parseApprovedReusableWorkflow(record.reusableWorkflow),
  };
}

function parseApprovedReusableWorkflow(value: unknown): ApprovedReusableWorkflow {
  const path = "approvedWorkloadMapping.allocator.reusableWorkflow";
  const record = requireRecord(value, path);
  requireExactKeys(record, REUSABLE_WORKFLOW_KEYS, path);
  const repository = requireRecord(record.repository, `${path}.repository`);
  requireExactKeys(repository, ["owner", "name"], `${path}.repository`);

  return {
    repository: {
      owner: requireRepositoryNamePart(repository.owner, `${path}.repository.owner`),
      name: requireRepositoryNamePart(repository.name, `${path}.repository.name`),
    },
    path: requireWorkflowPath(record.path, `${path}.path`),
    commitSha: requireFullCommitSha(record.commitSha, `${path}.commitSha`),
  };
}

function requireWorkflowPath(value: unknown, path: string): string {
  const workflowPath = requireNonEmptyString(value, path);
  if (
    !/^\.github\/workflows\/[A-Za-z0-9_./-]+\.ya?ml$/.test(workflowPath) ||
    workflowPath.includes("..") ||
    workflowPath.includes("//")
  ) {
    throw new ContractValidationError(path, "must be a literal workflow YAML path");
  }

  return workflowPath;
}

function requireRepositoryNamePart(value: unknown, path: string): string {
  const part = requireNonEmptyString(value, path);
  if (!/^[A-Za-z0-9_.-]+$/.test(part) || part === "." || part === "..") {
    throw new ContractValidationError(path, "must be a literal repository owner or name");
  }

  return part;
}

function requireRunnerLabel(value: unknown, path: string): string {
  const label = requireNonEmptyString(value, path);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(label)) {
    throw new ContractValidationError(path, "must be a literal GitHub runner label");
  }
  return label;
}

function requirePositiveSafeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ContractValidationError(path, "must be a positive safe integer");
  }

  return value;
}
