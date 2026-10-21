import {
  parseBackupChoice,
  parseCapabilityProfile,
  requireAllowedKeys,
  requireExactKeys,
  requireNonEmptyString,
  requireRecord,
  type EnabledApprovedWorkloadMapping,
} from "@switchyard/core";
import { isAlias, parseDocument, visit } from "yaml";

const WORKFLOW_TOP_LEVEL_KEYS = [
  "name",
  "run-name",
  "on",
  "permissions",
  "env",
  "defaults",
  "concurrency",
  "jobs",
] as const;
const REUSABLE_JOB_KEYS = [
  "name",
  "needs",
  "uses",
  "with",
  "secrets",
  "permissions",
  "strategy",
  "concurrency",
] as const;
const WORKLOAD_JOB_KEYS = [
  "name",
  "needs",
  "runs-on",
  "timeout-minutes",
  "permissions",
  "environment",
  "concurrency",
  "outputs",
  "env",
  "defaults",
  "if",
  "steps",
  "services",
  "container",
  "strategy",
  "continue-on-error",
] as const;

export class WorkflowVerificationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`Workflow verification failed (${code})`);
    this.name = "WorkflowVerificationError";
    this.code = code;
  }
}

export function verifyImmutableCallerWorkflow(
  bytes: Uint8Array,
  mapping: EnabledApprovedWorkloadMapping,
): void {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new WorkflowVerificationError("workflow-not-utf8");
  }

  const document = parseDocument(source, {
    prettyErrors: false,
    schema: "core",
    uniqueKeys: true,
  });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new WorkflowVerificationError("workflow-yaml-invalid");
  }
  try {
    visit(document, (_key, node) => {
      if (isAlias(node)) {
        throw new WorkflowVerificationError("workflow-yaml-alias-forbidden");
      }
    });
  } catch (error) {
    if (error instanceof WorkflowVerificationError) {
      throw error;
    }
    throw new WorkflowVerificationError("workflow-yaml-shape-invalid");
  }

  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new WorkflowVerificationError("workflow-yaml-shape-invalid");
  }

  try {
    verifyWorkflowValue(value, mapping);
  } catch (error) {
    if (error instanceof WorkflowVerificationError) {
      throw error;
    }
    throw new WorkflowVerificationError("workflow-contract-mismatch");
  }
}

function verifyWorkflowValue(value: unknown, mapping: EnabledApprovedWorkloadMapping): void {
  const workflow = requireRecord(value, "workflow");
  requireAllowedKeys(workflow, WORKFLOW_TOP_LEVEL_KEYS, "workflow");
  verifyDispatchTrigger(workflow.on);

  const jobs = requireRecord(workflow.jobs, "workflow.jobs");
  rejectDangerousKeys(jobs);
  if (!Object.hasOwn(jobs, mapping.approvedCallerGateJobKey)) {
    throw new WorkflowVerificationError("approved-gate-job-missing");
  }

  const allocator = requireRecord(
    jobs[mapping.allocator.jobKey],
    `workflow.jobs.${mapping.allocator.jobKey}`,
  );
  requireAllowedKeys(allocator, REUSABLE_JOB_KEYS, `workflow.jobs.${mapping.allocator.jobKey}`);
  if (allocator.name !== mapping.allocator.jobName) {
    throw new WorkflowVerificationError("allocator-job-name-mismatch");
  }
  if (allocator.needs !== mapping.approvedCallerGateJobKey) {
    throw new WorkflowVerificationError("allocator-gate-dependency-mismatch");
  }
  verifyExactAllocatorPermissions(allocator.permissions);

  const reusable = mapping.allocator.reusableWorkflow;
  const expectedUses = `${reusable.repository.owner}/${reusable.repository.name}/${reusable.path}@${reusable.commitSha}`;
  if (allocator.uses !== expectedUses) {
    throw new WorkflowVerificationError("reusable-workflow-reference-mismatch");
  }

  const inputs = requireRecord(allocator.with, `workflow.jobs.${mapping.allocator.jobKey}.with`);
  requireExactKeys(
    inputs,
    ["profile", "backupChoice"],
    `workflow.jobs.${mapping.allocator.jobKey}.with`,
  );
  if (parseCapabilityProfile(inputs.profile) !== mapping.workload.profile) {
    throw new WorkflowVerificationError("allocator-profile-mismatch");
  }
  if (parseBackupChoice(inputs.backupChoice) !== mapping.workload.backupChoice) {
    throw new WorkflowVerificationError("allocator-backup-choice-mismatch");
  }

  const workload = requireRecord(
    jobs[mapping.workload.jobKey],
    `workflow.jobs.${mapping.workload.jobKey}`,
  );
  requireAllowedKeys(workload, WORKLOAD_JOB_KEYS, `workflow.jobs.${mapping.workload.jobKey}`);
  if (workload.name !== mapping.workload.jobName) {
    throw new WorkflowVerificationError("workload-job-name-mismatch");
  }
  if (workload.needs !== mapping.allocator.jobKey) {
    throw new WorkflowVerificationError("workload-allocator-dependency-mismatch");
  }
  if (Object.hasOwn(workload, "strategy")) {
    throw new WorkflowVerificationError("workload-strategy-forbidden");
  }
  if (
    typeof workload["timeout-minutes"] !== "number" ||
    !Number.isSafeInteger(workload["timeout-minutes"]) ||
    workload["timeout-minutes"] !== mapping.workload.timeoutMinutes
  ) {
    throw new WorkflowVerificationError("workload-timeout-not-approved-literal");
  }

  const expectedRunnerLabel = `\${{ needs.${mapping.allocator.jobKey}.outputs.runner_label }}`;
  if (workload["runs-on"] !== expectedRunnerLabel) {
    throw new WorkflowVerificationError("workload-runner-label-dependency-mismatch");
  }

  verifyMappedDisplayNames(jobs, mapping);
  verifyUniqueAllocatorConsumer(jobs, mapping, expectedRunnerLabel);
}

function verifyExactAllocatorPermissions(value: unknown): void {
  try {
    const permissions = requireRecord(value, "workflow allocator permissions");
    requireExactKeys(permissions, ["id-token"], "workflow allocator permissions");
    if (permissions["id-token"] !== "write") {
      throw new WorkflowVerificationError("allocator-permissions-not-approved");
    }
  } catch (error) {
    if (error instanceof WorkflowVerificationError) {
      throw error;
    }
    throw new WorkflowVerificationError("allocator-permissions-not-approved");
  }
}

function verifyMappedDisplayNames(
  jobs: Record<string, unknown>,
  mapping: EnabledApprovedWorkloadMapping,
): void {
  const protectedNames = [
    {
      code: "workload-job-name-ambiguous",
      jobKey: mapping.workload.jobKey,
      name: mapping.workload.jobName,
    },
    {
      code: "allocator-job-name-ambiguous",
      jobKey: mapping.allocator.jobKey,
      name: mapping.allocator.jobName,
    },
  ] as const;

  for (const [jobKey, jobValue] of Object.entries(jobs)) {
    const job = requireRecord(jobValue, `workflow.jobs.${jobKey}`);
    let displayName = jobKey;
    if (Object.hasOwn(job, "name")) {
      if (
        typeof job.name !== "string" ||
        job.name.trim().length === 0 ||
        job.name.includes("${{")
      ) {
        throw new WorkflowVerificationError("workflow-job-display-name-not-literal");
      }
      displayName = job.name;
    }

    for (const protectedName of protectedNames) {
      if (jobKey !== protectedName.jobKey && displayName === protectedName.name) {
        throw new WorkflowVerificationError(protectedName.code);
      }
    }
    if (displayName === mapping.allocator.checkName) {
      throw new WorkflowVerificationError("allocator-check-name-ambiguous");
    }
  }
}

function verifyLiteralRunnerShape(value: unknown, managedLabel: string): void {
  if (typeof value === "string") {
    verifyLiteralRunnerLabel(value, managedLabel);
    return;
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    throw new WorkflowVerificationError("unmapped-job-runs-on-not-approved-literal");
  }
  for (const label of value) {
    if (typeof label !== "string") {
      throw new WorkflowVerificationError("unmapped-job-runs-on-not-approved-literal");
    }
    verifyLiteralRunnerLabel(label, managedLabel);
  }
}

function verifyLiteralRunnerLabel(value: string, managedLabel: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new WorkflowVerificationError("unmapped-job-runs-on-not-approved-literal");
  }
  if (asciiCaseInsensitiveEqual(value, managedLabel)) {
    throw new WorkflowVerificationError("managed-label-consumer-ambiguous");
  }
}

function asciiCaseInsensitiveEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const leftCode = foldAsciiUppercase(left.charCodeAt(index));
    const rightCode = foldAsciiUppercase(right.charCodeAt(index));
    if (leftCode !== rightCode) {
      return false;
    }
  }
  return true;
}

function foldAsciiUppercase(code: number): number {
  return code >= 0x41 && code <= 0x5a ? code + 0x20 : code;
}

function verifyUniqueAllocatorConsumer(
  jobs: Record<string, unknown>,
  mapping: EnabledApprovedWorkloadMapping,
  expectedRunnerLabel: string,
): void {
  let approvedConsumers = 0;

  for (const [jobKey, jobValue] of Object.entries(jobs)) {
    const job = requireRecord(jobValue, `workflow.jobs.${jobKey}`);
    const dependsOnAllocator = containsAllocatorDependency(job.needs, mapping.allocator.jobKey);
    const outputReferences = findAllocatorOutputReferences(job, mapping.allocator.jobKey);

    if (jobKey !== mapping.workload.jobKey) {
      if (dependsOnAllocator || outputReferences.length > 0) {
        throw new WorkflowVerificationError("workload-runner-label-consumer-ambiguous");
      }
      if (Object.hasOwn(job, "runs-on")) {
        verifyLiteralRunnerShape(job["runs-on"], mapping.workload.blacksmithRunnerLabel);
      }
      continue;
    }

    const approvedReference = outputReferences.filter(
      ({ path, value }) => path === "runs-on" && value === expectedRunnerLabel,
    );
    if (!dependsOnAllocator || approvedReference.length !== 1 || outputReferences.length !== 1) {
      throw new WorkflowVerificationError("workload-runner-label-consumer-ambiguous");
    }
    approvedConsumers += 1;
  }

  if (approvedConsumers !== 1) {
    throw new WorkflowVerificationError("workload-runner-label-consumer-ambiguous");
  }
}

function containsAllocatorDependency(value: unknown, allocatorJobKey: string): boolean {
  if (typeof value === "string") {
    return value.includes(allocatorJobKey);
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsAllocatorDependency(entry, allocatorJobKey));
  }
  return value !== undefined && value !== null;
}

function findAllocatorOutputReferences(
  value: unknown,
  allocatorJobKey: string,
  path = "",
): ReadonlyArray<{ readonly path: string; readonly value: string }> {
  if (typeof value === "string") {
    return referencesAllocatorOutput(value, allocatorJobKey) ? [{ path, value }] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      findAllocatorOutputReferences(entry, allocatorJobKey, `${path}[${index}]`),
    );
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }

  const references: Array<{ readonly path: string; readonly value: string }> = [];
  for (const [key, entry] of Object.entries(value)) {
    const entryPath = path.length === 0 ? key : `${path}.${key}`;
    if (referencesAllocatorOutput(key, allocatorJobKey)) {
      references.push({ path: `${entryPath}#key`, value: key });
    }
    references.push(...findAllocatorOutputReferences(entry, allocatorJobKey, entryPath));
  }
  return references;
}

function referencesAllocatorOutput(value: string, allocatorJobKey: string): boolean {
  const compact = value.replaceAll(/\s/g, "");
  const unquoted = compact.replaceAll(/["']/g, "");
  return (
    (unquoted.includes("runner_label") && unquoted.includes("needs")) ||
    (unquoted.includes(allocatorJobKey) && unquoted.includes("outputs"))
  );
}

function verifyDispatchTrigger(value: unknown): void {
  if (value === "workflow_dispatch") {
    return;
  }
  if (Array.isArray(value)) {
    if (value.filter((event) => event === "workflow_dispatch").length === 1) {
      return;
    }
    throw new WorkflowVerificationError("workflow-dispatch-trigger-missing");
  }
  const triggers = requireRecord(value, "workflow.on");
  if (!Object.hasOwn(triggers, "workflow_dispatch")) {
    throw new WorkflowVerificationError("workflow-dispatch-trigger-missing");
  }
  const dispatch = triggers.workflow_dispatch;
  if (dispatch !== null && typeof dispatch !== "object") {
    throw new WorkflowVerificationError("workflow-dispatch-trigger-invalid");
  }
}

function rejectDangerousKeys(value: Record<string, unknown>): void {
  for (const key of ["__proto__", "constructor", "prototype"]) {
    if (Object.hasOwn(value, key)) {
      throw new WorkflowVerificationError("workflow-job-key-forbidden");
    }
  }
  for (const [key, job] of Object.entries(value)) {
    requireNonEmptyString(key, "workflow.jobs key");
    if (typeof job !== "object" || job === null || Array.isArray(job)) {
      throw new WorkflowVerificationError("workflow-job-shape-invalid");
    }
  }
}
