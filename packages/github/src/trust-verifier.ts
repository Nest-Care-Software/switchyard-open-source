import {
  APPROVED_GITHUB_REF,
  OWNER_GITHUB_USER_ID,
  parseAllocationIdentity,
  parseApprovedBranchEvidence,
  parseApprovedWorkloadMappings,
  parseVerifiedWorkloadTrust,
  requireFullCommitSha,
  requirePositiveDecimalString,
  type AllocationIdentity,
  type ApprovedBranchEvidence,
  type ApprovedBranchEvidenceStore,
  type ApprovedRepository,
  type ApprovedWorkloadMapping,
  type EnabledApprovedWorkloadMapping,
  type TrustVerificationFailure,
  type TrustVerificationResult,
} from "@switchyard/core";

import {
  GITHUB_API_BASE_URL,
  GitHubRequestError,
  type GitHubRepositoryCoordinates,
  type WorkloadGitHubClient,
  type WorkloadGitHubClientProvider,
} from "./api.js";
import { verifyImmutableCallerWorkflow, WorkflowVerificationError } from "./workflow-yaml.js";

export class GitHubTrustVerifier {
  readonly #approvedMappings: unknown;
  readonly #branchEvidence: ApprovedBranchEvidenceStore;
  readonly #clients: WorkloadGitHubClientProvider;

  constructor(options: {
    readonly approvedMappings: unknown;
    readonly branchEvidence: ApprovedBranchEvidenceStore;
    readonly clients: WorkloadGitHubClientProvider;
  }) {
    if (
      typeof options.branchEvidence?.load !== "function" ||
      typeof options.branchEvidence.recordInitial !== "function"
    ) {
      throw new TypeError("An authoritative approved branch evidence store is required");
    }
    this.#approvedMappings = options.approvedMappings;
    this.#branchEvidence = options.branchEvidence;
    this.#clients = options.clients;
  }

  async verify(requestValue: unknown): Promise<TrustVerificationResult> {
    let identity: AllocationIdentity;
    try {
      identity = parseAllocationIdentity(requestValue);
    } catch {
      return rejected(
        "security-failure",
        "allocation-identity-invalid",
        "Allocation identity is invalid",
      );
    }

    let mappings: ReturnType<typeof parseApprovedWorkloadMappings>;
    try {
      mappings = parseApprovedWorkloadMappings(this.#approvedMappings);
    } catch {
      return rejected(
        "invalid-configuration",
        "approved-mappings-invalid",
        "Approved workload mappings are invalid",
      );
    }

    const matchingMappings = mappings.filter(
      (mapping) => mapping.repository.id === identity.repository_id,
    );
    if (matchingMappings.length === 0) {
      return rejected(
        "security-failure",
        "repository-not-approved",
        "The repository is not approved for Switchyard",
      );
    }
    const baseMapping = matchingMappings[0];
    if (baseMapping === undefined || !mappingsShareCallerPolicy(matchingMappings)) {
      return rejected(
        "invalid-configuration",
        "approved-caller-policy-ambiguous",
        "Approved mappings disagree about repository, workflow or owner policy",
      );
    }

    const enabledMappings = matchingMappings.filter(
      (mapping): mapping is EnabledApprovedWorkloadMapping => mapping.state === "enabled",
    );
    if (enabledMappings.length === 0) {
      return rejected(
        "invalid-configuration",
        "approved-mapping-disabled",
        "The production workload mapping is disabled",
      );
    }
    if (baseMapping.ownerActorId !== OWNER_GITHUB_USER_ID) {
      return rejected(
        "invalid-configuration",
        "owner-actor-policy-invalid",
        "The owner actor policy does not match Switchyard V1",
      );
    }
    if (enabledMappings.some((mapping) => !mappingJobKeysAreDistinct(mapping))) {
      return rejected(
        "invalid-configuration",
        "approved-job-keys-ambiguous",
        "Approved gate, allocator and workload job keys must be distinct",
      );
    }
    if (
      new Set(enabledMappings.map((mapping) => mapping.allocator.checkName)).size !==
      enabledMappings.length
    ) {
      return rejected(
        "invalid-configuration",
        "approved-allocator-checks-ambiguous",
        "Approved allocator Check Run names must be distinct within a repository",
      );
    }

    try {
      const evidence = await this.#clients.withWorkloadClient((client) =>
        verifyRemoteEvidence(client, identity, baseMapping, enabledMappings, this.#branchEvidence),
      );
      return { trusted: true, evidence };
    } catch (error) {
      if (error instanceof TrustRejectedError) {
        return { trusted: false, failure: error.failure };
      }
      if (error instanceof WorkflowVerificationError) {
        return rejected(
          "security-failure",
          error.code,
          "The immutable caller workflow does not match the approved mapping",
        );
      }
      if (error instanceof GitHubRequestError) {
        return rejected(
          "controller-unavailable",
          error.failure.code,
          "GitHub trust evidence is unavailable or malformed",
        );
      }
      if (error instanceof TrustEvidenceUnavailableError) {
        return rejected(
          "controller-unavailable",
          error.code,
          "Authoritative trust evidence is unavailable or malformed",
        );
      }
      return rejected(
        "controller-unavailable",
        "github-trust-unexpected",
        "GitHub trust verification could not complete",
      );
    }
  }
}

async function verifyRemoteEvidence(
  client: WorkloadGitHubClient,
  identity: AllocationIdentity,
  baseMapping: ApprovedWorkloadMapping,
  mappings: readonly EnabledApprovedWorkloadMapping[],
  branchEvidenceStore: ApprovedBranchEvidenceStore,
) {
  const repository: GitHubRepositoryCoordinates = {
    owner: baseMapping.repository.owner,
    name: baseMapping.repository.name,
  };

  const [repositoryValue, runValue] = await Promise.all([
    client.getRepository(repository),
    client.getWorkflowRunAttempt(repository, identity.run_id, identity.run_attempt),
  ]);
  verifyRepository(repositoryValue, baseMapping.repository);
  const run = verifyWorkflowRunAttempt(runValue, identity, baseMapping);

  const approvedBranch =
    identity.run_attempt === 1
      ? verifyInitialBranch(
          await client.getGitRef(repository, APPROVED_GITHUB_REF),
          identity,
          run.headSha,
        )
      : await loadRerunBranchEvidence(branchEvidenceStore, identity, run.headSha);

  const [jobsValue, checkValue, commitValue, workflowBytes] = await Promise.all([
    client.listJobsForWorkflowRunAttempt(repository, identity.run_id, identity.run_attempt),
    client.getCheckRun(repository, identity.allocator_check_run_id),
    client.getCommit(repository, run.headSha),
    client.getWorkflowBytes(repository, baseMapping.callerWorkflow.path, run.headSha),
  ]);

  const { mapping, jobId } = verifyAllocatorJob(jobsValue, identity, mappings, run.headSha);
  verifyAllocatorCheckRun(checkValue, identity, mapping, run);
  verifyCommit(commitValue, run.headSha);
  verifyImmutableCallerWorkflow(workflowBytes, mapping);

  const evidence = parseVerifiedWorkloadTrust({
    identity,
    approvedBranch,
    mappingPointer: mapping.mappingPointer,
    repository: mapping.repository,
    workflow: {
      path: mapping.callerWorkflow.path,
      commitSha: run.headSha,
    },
    ownerActorId: mapping.ownerActorId,
    allocator: {
      jobKey: mapping.allocator.jobKey,
      checkName: mapping.allocator.checkName,
      checkRunId: identity.allocator_check_run_id,
      jobId,
      reusableWorkflow: mapping.allocator.reusableWorkflow,
    },
    workload: mapping.workload,
  });
  if (identity.run_attempt === 1) {
    await persistInitialBranchEvidence(branchEvidenceStore, approvedBranch);
  }
  return evidence;
}

interface VerifiedRun {
  readonly checkSuiteId: string;
  readonly headSha: string;
}

function verifyRepository(value: unknown, expected: ApprovedRepository): void {
  const repository = remoteRecord(value, "repository");
  if (
    remoteGitHubId(repository.id, "repository.id") !== expected.id ||
    repository.full_name !== `${expected.owner}/${expected.name}` ||
    repository.private !== true
  ) {
    throw securityFailure("repository-identity-mismatch", "Repository identity is not approved");
  }
}

function verifyWorkflowRunAttempt(
  value: unknown,
  identity: AllocationIdentity,
  mapping: ApprovedWorkloadMapping,
): VerifiedRun {
  const run = remoteRecord(value, "workflowRunAttempt");
  const headSha = remoteFullCommitSha(run.head_sha, "workflowRunAttempt.head_sha");
  const headCommit = remoteRecord(run.head_commit, "workflowRunAttempt.head_commit");
  const repository = remoteRecord(run.repository, "workflowRunAttempt.repository");
  const headRepository = remoteRecord(run.head_repository, "workflowRunAttempt.head_repository");
  const actor = remoteRecord(run.actor, "workflowRunAttempt.actor");
  const triggeringActor = remoteRecord(run.triggering_actor, "workflowRunAttempt.triggering_actor");
  const pullRequests = remoteArray(run.pull_requests, "workflowRunAttempt.pull_requests");
  const branchName = APPROVED_GITHUB_REF.slice("refs/heads/".length);

  if (remoteGitHubId(run.id, "workflowRunAttempt.id") !== identity.run_id) {
    throw securityFailure("run-id-mismatch", "Workflow run identity does not match");
  }
  if (run.run_attempt !== identity.run_attempt) {
    throw securityFailure("run-attempt-mismatch", "Workflow run attempt does not match");
  }
  if (run.event !== "workflow_dispatch" || pullRequests.length !== 0) {
    throw securityFailure(
      "workflow-event-not-approved",
      "Only a non-pull-request workflow_dispatch event is approved",
    );
  }
  if (run.head_branch !== branchName) {
    throw securityFailure(
      "workflow-branch-name-mismatch",
      "Workflow run branch name does not match the approved policy",
    );
  }
  verifyRunWorkflowPath(run.path, mapping.callerWorkflow.path);
  if (
    remoteGitHubId(repository.id, "workflowRunAttempt.repository.id") !== mapping.repository.id ||
    remoteGitHubId(headRepository.id, "workflowRunAttempt.head_repository.id") !==
      mapping.repository.id
  ) {
    throw securityFailure("run-repository-mismatch", "Workflow run repository does not match");
  }
  if (remoteFullCommitSha(headCommit.id, "workflowRunAttempt.head_commit.id") !== headSha) {
    throw securityFailure("run-commit-mismatch", "Workflow run commit evidence does not match");
  }
  if (
    remoteGitHubId(actor.id, "workflowRunAttempt.actor.id") !== mapping.ownerActorId ||
    remoteGitHubId(triggeringActor.id, "workflowRunAttempt.triggering_actor.id") !==
      mapping.ownerActorId
  ) {
    throw securityFailure(
      "workflow-actor-not-approved",
      "Original and triggering actors must both be the approved owner",
    );
  }

  return {
    headSha,
    checkSuiteId: remoteGitHubId(run.check_suite_id, "workflowRunAttempt.check_suite_id"),
  };
}

function verifyAllocatorJob(
  value: unknown,
  identity: AllocationIdentity,
  mappings: readonly EnabledApprovedWorkloadMapping[],
  headSha: string,
): { readonly jobId: string; readonly mapping: EnabledApprovedWorkloadMapping } {
  const envelope = remoteRecord(value, "workflowJobs");
  const jobs = remoteArray(envelope.jobs, "workflowJobs.jobs");
  if (
    !Number.isSafeInteger(envelope.total_count) ||
    envelope.total_count !== jobs.length ||
    jobs.length > 100
  ) {
    throw GitHubRequestError.invalidResponse("github-jobs-pagination-ambiguous");
  }

  const parsedJobs = jobs.map((jobValue, index) => {
    const job = remoteRecord(jobValue, `workflowJobs.jobs[${index}]`);
    const checkRunUrl = remoteString(
      job.check_run_url,
      `workflowJobs.jobs[${index}].check_run_url`,
    );
    return {
      id: remoteGitHubId(job.id, `workflowJobs.jobs[${index}].id`),
      checkRunId: parseAllocatorCheckRunUrl(checkRunUrl, mappings),
      runId: remoteGitHubId(job.run_id, `workflowJobs.jobs[${index}].run_id`),
      headSha: remoteFullCommitSha(job.head_sha, `workflowJobs.jobs[${index}].head_sha`),
      name: remoteString(job.name, `workflowJobs.jobs[${index}].name`),
      status: remoteString(job.status, `workflowJobs.jobs[${index}].status`),
    };
  });

  const checkRunJobs = parsedJobs.filter(
    (job) => job.checkRunId === identity.allocator_check_run_id,
  );
  if (checkRunJobs.length === 0) {
    throw securityFailure(
      "allocator-check-id-mismatch",
      "Allocator check identity does not match a job in this run attempt",
    );
  }
  if (checkRunJobs.length !== 1) {
    throw securityFailure(
      "allocator-check-id-ambiguous",
      "Allocator Check Run identity is associated with more than one job",
    );
  }
  const allocatorJob = checkRunJobs[0];
  if (allocatorJob === undefined) {
    throw securityFailure("allocator-check-id-mismatch", "Allocator job is missing");
  }
  const approvedMappings = mappings.filter(
    (mapping) => mapping.allocator.checkName === allocatorJob.name,
  );
  if (approvedMappings.length !== 1) {
    throw securityFailure(
      "allocator-check-not-approved",
      "Allocator check identity does not match one approved mapping",
    );
  }
  const mapping = approvedMappings[0];
  if (mapping === undefined) {
    throw securityFailure("allocator-check-not-approved", "Allocator check is not approved");
  }
  if (parsedJobs.filter((job) => job.name === mapping.allocator.checkName).length !== 1) {
    throw securityFailure(
      "allocator-check-ambiguous",
      "The approved allocator check is ambiguous in this run attempt",
    );
  }
  if (
    allocatorJob.runId !== identity.run_id ||
    allocatorJob.headSha !== headSha ||
    allocatorJob.checkRunId !== identity.allocator_check_run_id ||
    allocatorJob.status !== "in_progress"
  ) {
    throw securityFailure(
      "allocator-job-evidence-mismatch",
      "Allocator job evidence does not match this run and commit",
    );
  }
  return { mapping, jobId: allocatorJob.id };
}

function verifyAllocatorCheckRun(
  value: unknown,
  identity: AllocationIdentity,
  mapping: EnabledApprovedWorkloadMapping,
  run: VerifiedRun,
): void {
  const check = remoteRecord(value, "allocatorCheckRun");
  const app = remoteRecord(check.app, "allocatorCheckRun.app");
  const suite = remoteRecord(check.check_suite, "allocatorCheckRun.check_suite");
  const pullRequests = remoteArray(check.pull_requests, "allocatorCheckRun.pull_requests");
  if (
    remoteGitHubId(check.id, "allocatorCheckRun.id") !== identity.allocator_check_run_id ||
    remoteFullCommitSha(check.head_sha, "allocatorCheckRun.head_sha") !== run.headSha ||
    check.name !== mapping.allocator.checkName ||
    app.slug !== "github-actions" ||
    remoteGitHubId(suite.id, "allocatorCheckRun.check_suite.id") !== run.checkSuiteId ||
    check.status !== "in_progress" ||
    check.conclusion !== null ||
    pullRequests.length !== 0
  ) {
    throw securityFailure(
      "allocator-check-evidence-mismatch",
      "Allocator Check Run evidence does not match the approved invocation",
    );
  }
}

function verifyCommit(value: unknown, expectedSha: string): void {
  const commit = remoteRecord(value, "commit");
  if (remoteFullCommitSha(commit.sha, "commit.sha") !== expectedSha) {
    throw securityFailure("immutable-commit-mismatch", "Immutable commit evidence does not match");
  }
}

function verifyInitialBranch(
  value: unknown,
  identity: AllocationIdentity,
  headSha: string,
): ApprovedBranchEvidence {
  const gitRef = remoteRecord(value, "gitRef");
  const target = remoteRecord(gitRef.object, "gitRef.object");
  if (
    gitRef.ref !== APPROVED_GITHUB_REF ||
    target.type !== "commit" ||
    remoteFullCommitSha(target.sha, "gitRef.object.sha") !== headSha
  ) {
    throw securityFailure(
      "approved-branch-evidence-mismatch",
      "The exact approved branch does not point to the immutable workflow commit",
    );
  }

  return parseApprovedBranchEvidence({
    kind: "approved-branch-evidence",
    repositoryId: identity.repository_id,
    runId: identity.run_id,
    approvedRunAttempt: 1,
    ref: APPROVED_GITHUB_REF,
    commitSha: headSha,
  });
}

async function loadRerunBranchEvidence(
  store: ApprovedBranchEvidenceStore,
  identity: AllocationIdentity,
  headSha: string,
): Promise<ApprovedBranchEvidence> {
  let value: unknown | null;
  try {
    value = await store.load({
      repositoryId: identity.repository_id,
      runId: identity.run_id,
    });
  } catch {
    throw new TrustEvidenceUnavailableError("approved-branch-evidence-unavailable");
  }
  if (value === null) {
    throw securityFailure(
      "approved-branch-evidence-missing",
      "A rerun requires persisted approval evidence from the initial attempt",
    );
  }

  let evidence: ApprovedBranchEvidence;
  try {
    evidence = parseApprovedBranchEvidence(value);
  } catch {
    throw new TrustEvidenceUnavailableError("approved-branch-evidence-invalid");
  }
  if (
    evidence.repositoryId !== identity.repository_id ||
    evidence.runId !== identity.run_id ||
    evidence.ref !== APPROVED_GITHUB_REF ||
    evidence.commitSha !== headSha
  ) {
    throw securityFailure(
      "approved-branch-evidence-conflict",
      "Persisted branch approval evidence conflicts with this rerun",
    );
  }
  return evidence;
}

async function persistInitialBranchEvidence(
  store: ApprovedBranchEvidenceStore,
  evidence: ApprovedBranchEvidence,
): Promise<void> {
  let result: unknown;
  try {
    result = await store.recordInitial(evidence);
  } catch {
    throw new TrustEvidenceUnavailableError("approved-branch-evidence-unavailable");
  }
  if (result === "recorded" || result === "matched") {
    return;
  }
  if (result === "conflict") {
    throw securityFailure(
      "approved-branch-evidence-conflict",
      "Existing branch approval evidence conflicts with the initial attempt",
    );
  }
  throw new TrustEvidenceUnavailableError("approved-branch-evidence-result-invalid");
}

function parseAllocatorCheckRunUrl(
  value: string,
  mappings: readonly EnabledApprovedWorkloadMapping[],
): string {
  const mapping = mappings[0];
  if (mapping === undefined) {
    throw GitHubRequestError.invalidResponse("allocator-check-url-policy-missing");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw GitHubRequestError.invalidResponse("allocator-check-url-invalid");
  }
  const pathPrefix = `/repos/${mapping.repository.owner}/${mapping.repository.name}/check-runs/`;
  if (
    url.origin !== GITHUB_API_BASE_URL ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !url.pathname.startsWith(pathPrefix)
  ) {
    throw GitHubRequestError.invalidResponse("allocator-check-url-invalid");
  }
  const checkRunId = url.pathname.slice(pathPrefix.length);
  if (checkRunId.includes("/")) {
    throw GitHubRequestError.invalidResponse("allocator-check-url-invalid");
  }
  try {
    const parsedCheckRunId = requirePositiveDecimalString(checkRunId, "workflowJob.check_run_url");
    const expectedUrl = `${pathPrefix}${parsedCheckRunId}`;
    if (value !== `${GITHUB_API_BASE_URL}${expectedUrl}`) {
      throw new Error("URL is not canonical");
    }
    return parsedCheckRunId;
  } catch {
    throw GitHubRequestError.invalidResponse("allocator-check-url-invalid");
  }
}

function verifyRunWorkflowPath(value: unknown, expectedPath: string): void {
  if (value !== expectedPath) {
    throw securityFailure("workflow-path-mismatch", "Workflow path does not match");
  }
}

function remoteRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw GitHubRequestError.invalidResponse(`${path}-shape-invalid`);
  }
  return value as Record<string, unknown>;
}

function remoteArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw GitHubRequestError.invalidResponse(`${path}-shape-invalid`);
  }
  return value;
}

function remoteString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw GitHubRequestError.invalidResponse(`${path}-shape-invalid`);
  }
  return value;
}

function remoteGitHubId(value: unknown, path: string): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw GitHubRequestError.invalidResponse(`${path}-shape-invalid`);
  }
  return requirePositiveDecimalString(String(value), path);
}

function remoteFullCommitSha(value: unknown, path: string): string {
  try {
    return requireFullCommitSha(value, path);
  } catch {
    throw GitHubRequestError.invalidResponse(`${path}-shape-invalid`);
  }
}

class TrustRejectedError extends Error {
  readonly failure: TrustVerificationFailure;

  constructor(failure: TrustVerificationFailure) {
    super(failure.code);
    this.name = "TrustRejectedError";
    this.failure = failure;
  }
}

class TrustEvidenceUnavailableError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "TrustEvidenceUnavailableError";
    this.code = code;
  }
}

function securityFailure(code: string, message: string): TrustRejectedError {
  return new TrustRejectedError({ classification: "security-failure", code, message });
}

function rejected(
  classification: TrustVerificationFailure["classification"],
  code: string,
  message: string,
): TrustVerificationResult {
  return { trusted: false, failure: { classification, code, message } };
}

function mappingJobKeysAreDistinct(mapping: EnabledApprovedWorkloadMapping): boolean {
  return (
    new Set([mapping.approvedCallerGateJobKey, mapping.allocator.jobKey, mapping.workload.jobKey])
      .size === 3
  );
}

function mappingsShareCallerPolicy(mappings: readonly ApprovedWorkloadMapping[]): boolean {
  const first = mappings[0];
  if (first === undefined) {
    return false;
  }
  return mappings.every(
    (mapping) =>
      mapping.repository.id === first.repository.id &&
      mapping.repository.owner === first.repository.owner &&
      mapping.repository.name === first.repository.name &&
      mapping.callerWorkflow.path === first.callerWorkflow.path &&
      mapping.callerWorkflow.ref === first.callerWorkflow.ref &&
      mapping.ownerActorId === first.ownerActorId,
  );
}
