import { createHash } from "node:crypto";

import {
  ContractValidationError,
  parseStrictJsonObject,
  requireAllowedKeys,
  requireExactKeys,
  requireRecord,
} from "@switchyard/core";

export const SWITCHYARD_REPOSITORY = "example-org/switchyard" as const;
export const SWITCHYARD_REPOSITORY_ID = "900000003" as const;
export const SWITCHYARD_OWNER_ID = "900000004" as const;
export const SWITCHYARD_OWNER_ACTOR_ID = "900000001" as const;
export const SWITCHYARD_MAIN_REF = "refs/heads/main" as const;
export const SWITCHYARD_DEFAULT_BRANCH = "main" as const;
export const INFRASTRUCTURE_PLAN_ENGINE_PATH =
  ".github/workflows/infrastructure-plan-engine.yml" as const;
export const INFRASTRUCTURE_APPLY_ENGINE_PATH =
  ".github/workflows/infrastructure-apply-engine.yml" as const;
export const FUTURE_PLAN_DISPATCHER_PATH = ".github/workflows/infrastructure-plan.yml" as const;
export const FUTURE_APPLY_DISPATCHER_PATH = ".github/workflows/infrastructure-apply.yml" as const;
export const INFRASTRUCTURE_INITIAL_STATE_DISPATCHER_PATH =
  ".github/workflows/infrastructure-initialise-state.yml" as const;
export const IMMUTABLE_SUBJECT_PREFIX = "repo:example-org@900000004/switchyard@900000003" as const;
export const REQUIRED_SUBJECT_CLAIMS = ["repo", "context", "job_workflow_ref"] as const;
export const APPROVAL_MAX_AGE_MS = 10 * 60 * 1_000;
export const PLAN_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
export const PUBLICATION_MAX_SKEW_MS = 30 * 1_000;
export const PLAN_ARTIFACT_RETENTION_DAYS = 1 as const;
export const PLAN_BUNDLE_SCHEMA_VERSION = 4 as const;
export const DESTRUCTIVE_ACKNOWLEDGEMENT_PREFIX = "APPROVE DESTRUCTIVE PLAN ";

export type PlanAuthorityClass = "bootstrap" | "foundation";
export type DeploymentIdentityClass = "bootstrap-applier" | "foundation-applier" | "planner";

export interface BackendIdentity {
  readonly containerName: string;
  readonly key: string;
  readonly resourceGroupName: string;
  readonly storageAccountName: string;
  readonly type: "azurerm";
}

export interface InfrastructureApprovalPolicy {
  readonly activationConfigDigest: string;
  readonly applyEngineSha: string;
  readonly backend: BackendIdentity;
  readonly bootstrapAudience: string;
  readonly bootstrapIdentityClientId: string;
  readonly bootstrapIdentityPrincipalId: string;
  readonly dedicatedSubscriptionConfirmed: true;
  readonly foundationAudience: string;
  readonly foundationIdentityClientId: string;
  readonly foundationIdentityPrincipalId: string;
  readonly planEngineSha: string;
  readonly plannerAudience: string;
  readonly plannerIdentityClientId: string;
  readonly plannerIdentityPrincipalId: string;
  readonly subscriptionId: string;
  readonly tenantId: string;
}

export interface RepositoryOidcSettings {
  readonly includeClaimKeys?: readonly string[];
  readonly subClaimPrefix: string;
  readonly useDefault: boolean;
  readonly useImmutableSubject: boolean;
}

export const CURRENT_DISABLED_GITHUB_EVIDENCE = Object.freeze({
  actions: Object.freeze({
    accessLevel: "none" as const,
    allowedActions: "all" as const,
    enabled: true,
    shaPinningRequired: false,
  }),
  defaultBranch: SWITCHYARD_DEFAULT_BRANCH,
  ownerId: SWITCHYARD_OWNER_ID,
  private: true,
  repositoryId: SWITCHYARD_REPOSITORY_ID,
  subject: Object.freeze({
    subClaimPrefix: IMMUTABLE_SUBJECT_PREFIX,
    useDefault: true,
    useImmutableSubject: false,
  }),
});

export interface GitHubRunEvidence {
  readonly actorId: string;
  readonly commitSha: string;
  readonly completedAt: string | null;
  readonly conclusion: "cancelled" | "failure" | "success" | null;
  readonly createdAt: string;
  readonly eventName: string;
  readonly ref: string;
  readonly referencedWorkflows: readonly string[];
  readonly repositoryId: string;
  readonly repositoryOwnerId: string;
  readonly runAttempt: number;
  readonly runId: string;
  readonly triggeringActorId: string;
  readonly workflowPath: string;
  readonly workflowRef: string;
  readonly status: "completed" | "in_progress" | "queued";
}

export interface GitHubJobEvidence {
  readonly checkRunId: string;
  readonly commitSha: string;
  readonly jobId: string;
  readonly name: string;
  readonly runAttempt: number;
  readonly runId: string;
  readonly status: "completed" | "in_progress" | "queued";
  readonly workflowName: string;
}

export interface VerifiedGitHubOidcClaims {
  readonly actorId: string;
  readonly audience: string;
  readonly checkRunId: string;
  readonly commitSha: string;
  readonly eventName: string;
  readonly issuer: "https://token.actions.githubusercontent.com";
  readonly jobWorkflowRef: string;
  readonly jobWorkflowSha: string;
  readonly ref: string;
  readonly repositoryId: string;
  readonly repositoryOwnerId: string;
  readonly runAttempt: number;
  readonly runId: string;
  readonly signatureAlgorithm: "RS256";
  readonly subject: string;
  readonly tokenDigest: string;
  readonly verified: true;
  readonly workflowRef: string;
  readonly workflowSha: string;
}

export interface GitHubOidcTokenVerifierPort {
  verifyCryptographically(rawToken: Uint8Array): Promise<VerifiedGitHubOidcClaims>;
}

export interface GitHubOidcTokenRequestPort {
  requestToken(input: { readonly audience: string }): Promise<Uint8Array>;
}

export interface InfrastructureIdentitySession {
  readonly ambientCredentialsUsed: false;
  readonly assertionDigest: string;
  readonly audience: string;
  readonly authentication: "github-oidc-client-assertion";
  readonly clientId: string;
  readonly credential: InfrastructureSessionCredential;
  readonly identity: DeploymentIdentityClass;
  readonly jobWorkflowRef: string;
  readonly principalId: string;
  readonly subject: string;
  readonly subscriptionId: string;
  readonly tenantId: string;
}

export interface InfrastructureSessionCredential {
  getToken(scope: string): Promise<{
    readonly expiresOnTimestamp: number;
    readonly token: string;
  } | null>;
}

export interface GitHubOidcEntraExchangePort {
  exchangeExactToken(input: {
    readonly allowAmbientCredentials: false;
    readonly audience: string;
    readonly clientId: string;
    readonly identity: DeploymentIdentityClass;
    readonly jobWorkflowRef: string;
    readonly principalId: string;
    readonly rawToken: Uint8Array;
    readonly subject: string;
    readonly subscriptionId: string;
    readonly tenantId: string;
  }): Promise<InfrastructureIdentitySession>;
}

export interface ApprovalInputs {
  readonly artifactId: string;
  readonly commitSha: string;
  readonly destructiveAcknowledgement: string;
  readonly planDigest: string;
  readonly planRunId: string;
}

export interface StateIdentity {
  readonly backendStateDigest: string;
  readonly backendStateEtag: string;
  readonly lineage: string;
  readonly managedResourceCount: number;
  readonly managedResourcesEmpty: boolean;
  readonly serial: number;
}

export function parseApprovalInputs(source: string): ApprovalInputs {
  const value = parseStrictJsonObject(
    source,
    ["plan_run_id", "artifact_id", "commit_sha", "plan_digest", "destructive_acknowledgement"],
    { maxBytes: 8 * 1_024, maxDepth: 2, path: "approval" },
  );
  return Object.freeze({
    artifactId: decimalId(value.artifact_id, "approval.artifact_id"),
    commitSha: commitSha(value.commit_sha, "approval.commit_sha"),
    destructiveAcknowledgement: exactString(
      value.destructive_acknowledgement,
      "approval.destructive_acknowledgement",
      128,
      true,
    ),
    planDigest: sha256(value.plan_digest, "approval.plan_digest"),
    planRunId: decimalId(value.plan_run_id, "approval.plan_run_id"),
  });
}

export function requiredOidcSettings(): RepositoryOidcSettings {
  return Object.freeze({
    includeClaimKeys: REQUIRED_SUBJECT_CLAIMS,
    subClaimPrefix: IMMUTABLE_SUBJECT_PREFIX,
    useDefault: false,
    useImmutableSubject: true,
  });
}

export function requireActivationOidcSettings(settings: RepositoryOidcSettings): void {
  const record = requireRecord(settings, "oidcSettings");
  requireAllowedKeys(
    record,
    ["useDefault", "useImmutableSubject", "includeClaimKeys", "subClaimPrefix"],
    "oidcSettings",
  );
  if (settings.useDefault !== false) {
    throw new InfrastructureApprovalError("oidc-default-subject-active");
  }
  requireExactKeys(
    record,
    ["useDefault", "useImmutableSubject", "includeClaimKeys", "subClaimPrefix"],
    "oidcSettings",
  );
  if (settings.useImmutableSubject !== true) {
    throw new InfrastructureApprovalError("oidc-immutable-subject-disabled");
  }
  if (settings.subClaimPrefix !== IMMUTABLE_SUBJECT_PREFIX) {
    throw new InfrastructureApprovalError("oidc-subject-prefix-mismatch");
  }
  if (
    !Array.isArray(settings.includeClaimKeys) ||
    settings.includeClaimKeys.length !== REQUIRED_SUBJECT_CLAIMS.length ||
    settings.includeClaimKeys.some((value, index) => value !== REQUIRED_SUBJECT_CLAIMS[index])
  ) {
    throw new InfrastructureApprovalError("oidc-subject-claims-mismatch");
  }
}

export function immutableOidcSubject(enginePath: string, engineSha: string): string {
  commitSha(engineSha, "engineSha");
  if (
    enginePath !== INFRASTRUCTURE_PLAN_ENGINE_PATH &&
    enginePath !== INFRASTRUCTURE_APPLY_ENGINE_PATH
  ) {
    throw new ContractValidationError("enginePath", "is not an infrastructure engine path");
  }
  return `${IMMUTABLE_SUBJECT_PREFIX}:ref:${SWITCHYARD_MAIN_REF}:job_workflow_ref:${SWITCHYARD_REPOSITORY}/${enginePath}@${engineSha}`;
}

export function futureIdentityContracts(
  policy: InfrastructureApprovalPolicy,
): Readonly<
  Record<DeploymentIdentityClass, { readonly audience: string; readonly subject: string }>
> {
  validatePolicy(policy);
  return Object.freeze({
    "bootstrap-applier": Object.freeze({
      audience: policy.bootstrapAudience,
      subject: immutableOidcSubject(INFRASTRUCTURE_APPLY_ENGINE_PATH, policy.applyEngineSha),
    }),
    "foundation-applier": Object.freeze({
      audience: policy.foundationAudience,
      subject: immutableOidcSubject(INFRASTRUCTURE_APPLY_ENGINE_PATH, policy.applyEngineSha),
    }),
    planner: Object.freeze({
      audience: policy.plannerAudience,
      subject: immutableOidcSubject(INFRASTRUCTURE_PLAN_ENGINE_PATH, policy.planEngineSha),
    }),
  });
}

export function verifyReferencedWorkflow(
  run: GitHubRunEvidence,
  engineSha: string,
  engine: "apply" | "plan",
): void {
  const path =
    engine === "plan" ? INFRASTRUCTURE_PLAN_ENGINE_PATH : INFRASTRUCTURE_APPLY_ENGINE_PATH;
  const expected = `${SWITCHYARD_REPOSITORY}/${path}@${commitSha(engineSha, "engineSha")}`;
  if (
    !Array.isArray(run.referencedWorkflows) ||
    run.referencedWorkflows.length !== 1 ||
    run.referencedWorkflows[0] !== expected
  ) {
    throw new InfrastructureApprovalError(`${engine}-engine-provenance-mismatch`);
  }
}

export function verifyRunEvidence(
  evidence: GitHubRunEvidence,
  expected: {
    readonly commitSha: string;
    readonly runId: string;
    readonly workflowPath: string;
  },
): void {
  instant(evidence.createdAt, "github.created_at");
  if (evidence.completedAt !== null) instant(evidence.completedAt, "github.completed_at");
  const expectedWorkflowRef = `${SWITCHYARD_REPOSITORY}/${expected.workflowPath}@${SWITCHYARD_MAIN_REF}`;
  const checks: ReadonlyArray<readonly [boolean, string]> = [
    [evidence.repositoryId === SWITCHYARD_REPOSITORY_ID, "github-repository-mismatch"],
    [evidence.repositoryOwnerId === SWITCHYARD_OWNER_ID, "github-owner-mismatch"],
    [evidence.actorId === SWITCHYARD_OWNER_ACTOR_ID, "github-actor-mismatch"],
    [evidence.triggeringActorId === SWITCHYARD_OWNER_ACTOR_ID, "github-triggering-actor-mismatch"],
    [evidence.eventName === "workflow_dispatch", "github-event-mismatch"],
    [evidence.runAttempt === 1, "github-rerun-rejected"],
    [evidence.ref === SWITCHYARD_MAIN_REF, "github-ref-mismatch"],
    [evidence.commitSha === expected.commitSha, "github-commit-mismatch"],
    [evidence.runId === expected.runId, "github-run-mismatch"],
    [evidence.workflowPath === expected.workflowPath, "github-workflow-mismatch"],
    [evidence.workflowRef === expectedWorkflowRef, "github-workflow-ref-mismatch"],
  ];
  for (const [valid, code] of checks) {
    if (!valid) throw new InfrastructureApprovalError(code);
  }
}

export function verifyOidcClaims(
  evidence: VerifiedGitHubOidcClaims,
  identity: DeploymentIdentityClass,
  callerWorkflowPath: string,
  job: GitHubJobEvidence,
  run: GitHubRunEvidence,
  policy: InfrastructureApprovalPolicy,
  tokenDigest: string,
): void {
  requireExactKeys(
    requireRecord(evidence, "oidcClaims"),
    [
      "actorId",
      "audience",
      "checkRunId",
      "commitSha",
      "eventName",
      "issuer",
      "jobWorkflowRef",
      "jobWorkflowSha",
      "ref",
      "repositoryId",
      "repositoryOwnerId",
      "runAttempt",
      "runId",
      "signatureAlgorithm",
      "subject",
      "tokenDigest",
      "verified",
      "workflowRef",
      "workflowSha",
    ],
    "oidcClaims",
  );
  const contracts = futureIdentityContracts(policy);
  const enginePath =
    identity === "planner" ? INFRASTRUCTURE_PLAN_ENGINE_PATH : INFRASTRUCTURE_APPLY_ENGINE_PATH;
  const engineSha = identity === "planner" ? policy.planEngineSha : policy.applyEngineSha;
  const allowedCallerPaths: readonly string[] =
    identity === "planner"
      ? [FUTURE_PLAN_DISPATCHER_PATH]
      : identity === "foundation-applier"
        ? [FUTURE_APPLY_DISPATCHER_PATH]
        : [FUTURE_APPLY_DISPATCHER_PATH, INFRASTRUCTURE_INITIAL_STATE_DISPATCHER_PATH];
  if (!allowedCallerPaths.includes(callerWorkflowPath)) {
    throw new InfrastructureApprovalError("oidc-caller-contract-invalid");
  }
  const expectedJobWorkflowRef = `${SWITCHYARD_REPOSITORY}/${enginePath}@${engineSha}`;
  const expectedWorkflowRef = `${SWITCHYARD_REPOSITORY}/${callerWorkflowPath}@${SWITCHYARD_MAIN_REF}`;
  const checks: ReadonlyArray<readonly [boolean, string]> = [
    [evidence.verified === true, "oidc-not-cryptographically-verified"],
    [evidence.signatureAlgorithm === "RS256", "oidc-algorithm-mismatch"],
    [evidence.issuer === "https://token.actions.githubusercontent.com", "oidc-issuer-mismatch"],
    [evidence.tokenDigest === tokenDigest, "oidc-token-digest-mismatch"],
    [evidence.actorId === SWITCHYARD_OWNER_ACTOR_ID, "oidc-actor-mismatch"],
    [evidence.actorId === run.actorId, "oidc-api-actor-mismatch"],
    [evidence.checkRunId === job.checkRunId, "oidc-job-check-run-mismatch"],
    [evidence.repositoryId === SWITCHYARD_REPOSITORY_ID, "oidc-repository-mismatch"],
    [evidence.repositoryId === run.repositoryId, "oidc-api-repository-mismatch"],
    [evidence.repositoryOwnerId === SWITCHYARD_OWNER_ID, "oidc-owner-mismatch"],
    [evidence.repositoryOwnerId === run.repositoryOwnerId, "oidc-api-owner-mismatch"],
    [evidence.ref === SWITCHYARD_MAIN_REF, "oidc-ref-mismatch"],
    [evidence.ref === run.ref, "oidc-api-ref-mismatch"],
    [evidence.commitSha === run.commitSha, "oidc-commit-mismatch"],
    [evidence.eventName === "workflow_dispatch", "oidc-event-mismatch"],
    [evidence.eventName === run.eventName, "oidc-api-event-mismatch"],
    [evidence.runId === run.runId, "oidc-run-mismatch"],
    [evidence.runAttempt === 1, "oidc-rerun-rejected"],
    [evidence.runAttempt === run.runAttempt, "oidc-api-attempt-mismatch"],
    [evidence.workflowRef === expectedWorkflowRef, "oidc-workflow-ref-mismatch"],
    [evidence.workflowRef === run.workflowRef, "oidc-api-workflow-ref-mismatch"],
    [evidence.workflowSha === run.commitSha, "oidc-workflow-sha-mismatch"],
    [evidence.jobWorkflowRef === expectedJobWorkflowRef, "oidc-job-workflow-ref-mismatch"],
    [evidence.jobWorkflowSha === engineSha, "oidc-job-workflow-sha-mismatch"],
    [
      evidence.jobWorkflowRef.endsWith(`@${evidence.jobWorkflowSha}`),
      "oidc-job-workflow-ref-sha-mismatch",
    ],
    [evidence.subject === contracts[identity].subject, "oidc-subject-mismatch"],
    [evidence.audience === contracts[identity].audience, "oidc-audience-mismatch"],
  ];
  for (const [valid, code] of checks) {
    if (!valid) throw new InfrastructureApprovalError(code);
  }
}

export function copyRawOidcToken(value: unknown, path: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < 32 || value.byteLength > 16 * 1_024) {
    throw new ContractValidationError(path, "must be a bounded raw GitHub OIDC token");
  }
  return Uint8Array.from(value);
}

export function verifyIdentitySession(
  session: InfrastructureIdentitySession,
  identity: DeploymentIdentityClass,
  policy: InfrastructureApprovalPolicy,
  tokenDigest: string,
): void {
  requireExactKeys(
    requireRecord(session, "identitySession"),
    [
      "ambientCredentialsUsed",
      "assertionDigest",
      "audience",
      "authentication",
      "clientId",
      "credential",
      "identity",
      "jobWorkflowRef",
      "principalId",
      "subject",
      "subscriptionId",
      "tenantId",
    ],
    "identitySession",
  );
  const enginePath =
    identity === "planner" ? INFRASTRUCTURE_PLAN_ENGINE_PATH : INFRASTRUCTURE_APPLY_ENGINE_PATH;
  const engineSha = identity === "planner" ? policy.planEngineSha : policy.applyEngineSha;
  const jobWorkflowRef = `${SWITCHYARD_REPOSITORY}/${enginePath}@${engineSha}`;
  const contract = futureIdentityContracts(policy)[identity];
  const expectedClientId = identityClientId(policy, identity);
  const expectedPrincipalId = identityPrincipalId(policy, identity);
  if (
    session.credential === null ||
    typeof session.credential !== "object" ||
    typeof session.credential.getToken !== "function"
  ) {
    throw new InfrastructureApprovalError("identity-session-credential-missing");
  }
  if (
    session.ambientCredentialsUsed !== false ||
    session.authentication !== "github-oidc-client-assertion" ||
    session.assertionDigest !== tokenDigest ||
    session.clientId !== expectedClientId ||
    session.identity !== identity ||
    session.audience !== contract.audience ||
    session.subject !== contract.subject ||
    session.jobWorkflowRef !== jobWorkflowRef ||
    session.principalId !== expectedPrincipalId ||
    session.subscriptionId !== policy.subscriptionId ||
    session.tenantId !== policy.tenantId
  ) {
    throw new InfrastructureApprovalError("identity-session-authority-mismatch");
  }
}

export function validatePolicy(policy: InfrastructureApprovalPolicy): void {
  sha256(policy.activationConfigDigest, "policy.activationConfigDigest");
  commitSha(policy.planEngineSha, "policy.planEngineSha");
  commitSha(policy.applyEngineSha, "policy.applyEngineSha");
  exactString(policy.tenantId, "policy.tenantId", 128);
  exactString(policy.subscriptionId, "policy.subscriptionId", 128);
  for (const [name, value] of [
    ["plannerAudience", policy.plannerAudience],
    ["foundationAudience", policy.foundationAudience],
    ["bootstrapAudience", policy.bootstrapAudience],
  ] as const) {
    exactString(value, `policy.${name}`, 256);
  }
  if (
    new Set([policy.plannerAudience, policy.foundationAudience, policy.bootstrapAudience]).size !==
    3
  ) {
    throw new ContractValidationError("policy.audiences", "must be distinct");
  }
  if (policy.dedicatedSubscriptionConfirmed !== true) {
    throw new ContractValidationError(
      "policy.dedicatedSubscriptionConfirmed",
      "must explicitly confirm the dedicated subscription",
    );
  }
  validateBackend(policy.backend, "policy.backend");
  const identityIds = [
    policy.plannerIdentityClientId,
    policy.plannerIdentityPrincipalId,
    policy.foundationIdentityClientId,
    policy.foundationIdentityPrincipalId,
    policy.bootstrapIdentityClientId,
    policy.bootstrapIdentityPrincipalId,
  ];
  for (const [index, value] of identityIds.entries()) {
    azureUuid(value, `policy.identityIds[${index}]`);
  }
  if (new Set(identityIds).size !== identityIds.length) {
    throw new ContractValidationError("policy.identityIds", "must be distinct");
  }
}

export function verifyJobEvidence(
  evidence: GitHubJobEvidence,
  expected: {
    readonly checkRunId: string;
    readonly commitSha: string;
    readonly runId: string;
  },
): void {
  requireExactKeys(
    requireRecord(evidence, "githubJob"),
    ["checkRunId", "commitSha", "jobId", "name", "runAttempt", "runId", "status", "workflowName"],
    "githubJob",
  );
  decimalId(evidence.checkRunId, "githubJob.checkRunId");
  decimalId(evidence.jobId, "githubJob.jobId");
  exactString(evidence.name, "githubJob.name", 256);
  exactString(evidence.workflowName, "githubJob.workflowName", 256);
  const checks: ReadonlyArray<readonly [boolean, string]> = [
    [evidence.checkRunId === expected.checkRunId, "github-job-check-run-mismatch"],
    [evidence.commitSha === expected.commitSha, "github-job-commit-mismatch"],
    [evidence.runAttempt === 1, "github-job-rerun-rejected"],
    [evidence.runId === expected.runId, "github-job-run-mismatch"],
    [evidence.status === "in_progress", "github-job-not-active"],
  ];
  for (const [valid, code] of checks) {
    if (!valid) throw new InfrastructureApprovalError(code);
  }
}

export function identityClientId(
  policy: InfrastructureApprovalPolicy,
  identity: DeploymentIdentityClass,
): string {
  return identity === "planner"
    ? policy.plannerIdentityClientId
    : identity === "foundation-applier"
      ? policy.foundationIdentityClientId
      : policy.bootstrapIdentityClientId;
}

export function identityPrincipalId(
  policy: InfrastructureApprovalPolicy,
  identity: DeploymentIdentityClass,
): string {
  return identity === "planner"
    ? policy.plannerIdentityPrincipalId
    : identity === "foundation-applier"
      ? policy.foundationIdentityPrincipalId
      : policy.bootstrapIdentityPrincipalId;
}

export function validateBackend(value: BackendIdentity, path: string): void {
  requireExactKeys(
    requireRecord(value, path),
    ["type", "resourceGroupName", "storageAccountName", "containerName", "key"],
    path,
  );
  if (value.type !== "azurerm")
    throw new ContractValidationError(`${path}.type`, "must be azurerm");
  exactString(value.resourceGroupName, `${path}.resourceGroupName`, 90);
  exactString(value.storageAccountName, `${path}.storageAccountName`, 24);
  exactString(value.containerName, `${path}.containerName`, 63);
  exactString(value.key, `${path}.key`, 256);
}

export function requireFreshApproval(createdAt: string, now: Date): void {
  const created = instant(createdAt, "approval.created_at");
  const age = now.getTime() - created.getTime();
  if (age < 0 || age > APPROVAL_MAX_AGE_MS) {
    throw new InfrastructureApprovalError("approval-expired");
  }
}

export function requirePlanFresh(createdAt: string, expiresAt: string, now: Date): void {
  const created = instant(createdAt, "manifest.created_at");
  const expires = instant(expiresAt, "manifest.expires_at");
  if (expires.getTime() - created.getTime() !== PLAN_MAX_AGE_MS) {
    throw new InfrastructureApprovalError("plan-expiry-invalid");
  }
  if (now.getTime() < created.getTime() || now.getTime() > expires.getTime()) {
    throw new InfrastructureApprovalError("stale-plan");
  }
}

export function requireDestructiveAcknowledgement(
  destructive: boolean,
  acknowledgement: string,
  planDigest: string,
): void {
  const expected = destructive ? `${DESTRUCTIVE_ACKNOWLEDGEMENT_PREFIX}${planDigest}` : "";
  if (acknowledgement !== expected) {
    throw new InfrastructureApprovalError(
      destructive
        ? "destructive-acknowledgement-required"
        : "unexpected-destructive-acknowledgement",
    );
  }
}

export function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function sha256(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new ContractValidationError(path, "must be a full lowercase SHA-256 digest");
  }
  return value;
}

export function commitSha(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) {
    throw new ContractValidationError(path, "must be a full lowercase commit SHA");
  }
  return value;
}

export function azureUuid(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) ||
    value === "00000000-0000-0000-0000-000000000000"
  ) {
    throw new ContractValidationError(path, "must be a canonical lowercase non-placeholder UUID");
  }
  return value;
}

export function decimalId(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/.test(value)) {
    throw new ContractValidationError(path, "must be a positive canonical decimal ID");
  }
  return value;
}

export function exactString(
  value: unknown,
  path: string,
  maxLength: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > maxLength ||
    value.includes("\u0000")
  ) {
    throw new ContractValidationError(
      path,
      `must be ${allowEmpty ? "a" : "a non-empty"} string of at most ${maxLength} characters`,
    );
  }
  return value;
}

export function instant(value: unknown, path: string): Date {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new ContractValidationError(path, "must be a canonical millisecond UTC instant");
  }
  const result = new Date(value);
  if (!Number.isFinite(result.getTime()) || result.toISOString() !== value) {
    throw new ContractValidationError(path, "must be a real canonical UTC instant");
  }
  return result;
}

export function stateLineage(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  ) {
    throw new ContractValidationError(path, "must be a lowercase UUID lineage");
  }
  return value;
}

export function stateSerial(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ContractValidationError(path, "must be a non-negative safe integer");
  }
  return value as number;
}

export function managedResourceCount(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 4_096) {
    throw new ContractValidationError(path, "must be an integer between 0 and 4096");
  }
  return value as number;
}

export function validateStateIdentity(value: StateIdentity, path: string): void {
  requireExactKeys(
    requireRecord(value, path),
    [
      "backendStateDigest",
      "backendStateEtag",
      "lineage",
      "managedResourceCount",
      "managedResourcesEmpty",
      "serial",
    ],
    path,
  );
  sha256(value.backendStateDigest, `${path}.backendStateDigest`);
  stateEtag(value.backendStateEtag, `${path}.backendStateEtag`);
  stateLineage(value.lineage, `${path}.lineage`);
  const count = managedResourceCount(value.managedResourceCount, `${path}.managedResourceCount`);
  stateSerial(value.serial, `${path}.serial`);
  if (value.managedResourcesEmpty !== (count === 0)) {
    throw new ContractValidationError(
      `${path}.managedResourcesEmpty`,
      "must exactly match the managed resource count",
    );
  }
}

export function stateEtag(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    value.length < 3 ||
    value.length > 256 ||
    !/^"[^"\r\n]+"$/.test(value)
  ) {
    throw new ContractValidationError(path, "must be one bounded quoted Azure ETag");
  }
  return value;
}

export class InfrastructureApprovalError extends Error {
  override readonly name = "InfrastructureApprovalError";

  constructor(readonly code: string) {
    super(code);
  }
}
