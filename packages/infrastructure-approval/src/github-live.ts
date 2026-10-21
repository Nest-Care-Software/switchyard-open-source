import { createPublicKey, type JsonWebKey, verify as verifySignature } from "node:crypto";

import {
  parseStrictJson,
  requireAllowedKeys,
  requireExactKeys,
  requireRecord,
} from "@switchyard/core";

import { ACTIVATION_CONFIGURATION_PATH } from "./activation.js";
import type { PlanBundleEvidencePort } from "./apply-engine.js";
import { PLAN_ARCHIVE_LIMITS } from "./bundle.js";
import {
  commitSha,
  decimalId,
  exactString,
  type GitHubJobEvidence,
  type GitHubOidcTokenRequestPort,
  type GitHubOidcTokenVerifierPort,
  type GitHubRunEvidence,
  IMMUTABLE_SUBJECT_PREFIX,
  InfrastructureApprovalError,
  type RepositoryOidcSettings,
  SWITCHYARD_DEFAULT_BRANCH,
  SWITCHYARD_MAIN_REF,
  SWITCHYARD_REPOSITORY_ID,
  sha256Bytes,
  type VerifiedGitHubOidcClaims,
} from "./contracts.js";
import type { InfrastructureGitHubEvidencePort } from "./github-evidence.js";
import { decodeStrictZip } from "./zip.js";

export const GITHUB_API_VERSION = "2026-03-10" as const;
export const GITHUB_API_ORIGIN = "https://api.github.com" as const;
export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com" as const;
export const GITHUB_OIDC_JWKS_URI =
  "https://token.actions.githubusercontent.com/.well-known/jwks" as const;

const REPOSITORY_PATH = "/repos/example-org/switchyard";
const JSON_LIMIT = 1024 * 1024;
const ACTIVATION_LIMIT = 64 * 1024;
const ARTIFACT_ARCHIVE_LIMIT = PLAN_ARCHIVE_LIMITS.archiveBytes + 1024 * 1024;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_JOB_PAGES = 4;
const JOBS_PER_PAGE = 100;
const MAX_JWT_BYTES = 24 * 1024;
const MAX_TOKEN_LIFETIME_SECONDS = 10 * 60;
const CLOCK_SKEW_SECONDS = 30;
const REQUIRED_GITHUB_CLAIMS = [
  "actor",
  "actor_id",
  "aud",
  "base_ref",
  "check_run_id",
  "event_name",
  "exp",
  "head_ref",
  "iat",
  "iss",
  "job_workflow_ref",
  "job_workflow_sha",
  "jti",
  "nbf",
  "ref",
  "ref_protected",
  "ref_type",
  "repository",
  "repository_id",
  "repository_owner",
  "repository_owner_id",
  "repository_visibility",
  "run_attempt",
  "run_id",
  "run_number",
  "runner_environment",
  "sha",
  "sub",
  "workflow",
  "workflow_ref",
  "workflow_sha",
] as const;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class LiveGitHubOidcTokenRequester implements GitHubOidcTokenRequestPort {
  readonly #fetch: FetchLike;
  #requestToken: string | undefined;
  readonly #requestUrl: URL;

  constructor(options: {
    readonly fetch?: FetchLike;
    readonly requestToken: string;
    readonly requestUrl: string;
  }) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#requestToken = boundedCredential(options.requestToken, "github-oidc-request-token");
    this.#requestUrl = githubOidcRequestUrl(options.requestUrl);
  }

  async requestToken(input: { readonly audience: string }): Promise<Uint8Array> {
    const requestToken = this.#requestToken;
    if (requestToken === undefined) {
      throw new InfrastructureApprovalError("github-oidc-request-token-already-consumed");
    }
    const audience = exactString(input.audience, "oidcRequest.audience", 256);
    const url = new URL(this.#requestUrl);
    if (url.searchParams.has("audience")) {
      throw new InfrastructureApprovalError("github-oidc-request-audience-preconfigured");
    }
    url.searchParams.append("audience", audience);
    let response: Awaited<ReturnType<typeof fetchBounded>>;
    try {
      response = await fetchBounded(this.#fetch, url, {
        headers: { authorization: `Bearer ${requestToken}` },
        maxBytes: 20 * 1024,
        redirect: "error",
      });
    } finally {
      this.#requestToken = undefined;
    }
    if (response.status !== 200) {
      throw new InfrastructureApprovalError("github-oidc-request-rejected");
    }
    const value = strictJsonRecord(response.bytes, "githubOidcResponse", 20 * 1024);
    requireExactKeys(value, ["value"], "githubOidcResponse");
    const token = exactString(value.value, "githubOidcResponse.value", MAX_JWT_BYTES);
    return new TextEncoder().encode(token);
  }
}

export class LiveGitHubOidcTokenVerifier implements GitHubOidcTokenVerifierPort {
  readonly #fetch: FetchLike;
  readonly #now: () => number;

  constructor(options: { readonly fetch?: FetchLike; readonly now?: () => number } = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
  }

  async verifyCryptographically(rawToken: Uint8Array): Promise<VerifiedGitHubOidcClaims> {
    if (
      !(rawToken instanceof Uint8Array) ||
      rawToken.byteLength < 32 ||
      rawToken.byteLength > MAX_JWT_BYTES
    ) {
      throw new InfrastructureApprovalError("github-oidc-token-size-invalid");
    }
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(rawToken);
    } catch {
      throw new InfrastructureApprovalError("github-oidc-token-not-utf8");
    }
    const segments = source.split(".");
    if (segments.length !== 3 || segments.some((segment) => !/^[A-Za-z0-9_-]+$/.test(segment))) {
      throw new InfrastructureApprovalError("github-oidc-token-malformed");
    }
    const [encodedHeader, encodedPayload, encodedSignature] = segments as [string, string, string];
    const header = strictJsonRecord(
      decodeBase64Url(encodedHeader, 4 * 1024),
      "githubOidcHeader",
      4 * 1024,
    );
    requireReviewedKeys(
      header,
      ["alg", "kid", "typ"],
      ["alg", "kid", "typ", "x5t"],
      "github-oidc-header-contract-invalid",
    );
    if (header.alg !== "RS256" || header.typ !== "JWT") {
      throw new InfrastructureApprovalError("github-oidc-algorithm-invalid");
    }
    const kid = exactString(header.kid, "githubOidcHeader.kid", 256);
    const x5t =
      header.x5t === undefined
        ? undefined
        : oidcCertificateThumbprint(header.x5t, "githubOidcHeader.x5t");
    const payloadBytes = decodeBase64Url(encodedPayload, 16 * 1024);
    const payload = strictJsonRecord(payloadBytes, "githubOidcPayload", 16 * 1024);
    requireReviewedKeys(
      payload,
      REQUIRED_GITHUB_CLAIMS,
      REQUIRED_GITHUB_CLAIMS,
      "github-oidc-payload-contract-invalid",
    );
    const key = await this.#loadSigningKey(kid, x5t);
    const signature = decodeBase64Url(encodedSignature, 1024);
    const verified = verifySignature(
      "RSA-SHA256",
      Buffer.from(`${encodedHeader}.${encodedPayload}`, "ascii"),
      createPublicKey({ format: "jwk", key }),
      signature,
    );
    if (!verified) throw new InfrastructureApprovalError("github-oidc-signature-invalid");
    return this.#claims(payload, rawToken);
  }

  async #loadSigningKey(kid: string, x5t: string | undefined): Promise<JsonWebKey> {
    const discoveryResponse = await fetchBounded(
      this.#fetch,
      `${GITHUB_OIDC_ISSUER}/.well-known/openid-configuration`,
      { maxBytes: 64 * 1024, redirect: "error" },
    );
    if (discoveryResponse.status !== 200) {
      throw new InfrastructureApprovalError("github-oidc-discovery-unavailable");
    }
    const discovery = strictJsonRecord(discoveryResponse.bytes, "githubOidcDiscovery", 64 * 1024);
    const claimsSupported = discovery.claims_supported;
    if (
      discovery.issuer !== GITHUB_OIDC_ISSUER ||
      discovery.jwks_uri !== GITHUB_OIDC_JWKS_URI ||
      !Array.isArray(discovery.id_token_signing_alg_values_supported) ||
      discovery.id_token_signing_alg_values_supported.length !== 1 ||
      discovery.id_token_signing_alg_values_supported[0] !== "RS256" ||
      !Array.isArray(claimsSupported) ||
      REQUIRED_GITHUB_CLAIMS.some((claim) => !claimsSupported.includes(claim))
    ) {
      throw new InfrastructureApprovalError("github-oidc-discovery-invalid");
    }
    const jwksResponse = await fetchBounded(this.#fetch, GITHUB_OIDC_JWKS_URI, {
      maxBytes: 64 * 1024,
      redirect: "error",
    });
    if (jwksResponse.status !== 200) {
      throw new InfrastructureApprovalError("github-oidc-jwks-unavailable");
    }
    const jwks = strictJsonRecord(jwksResponse.bytes, "githubOidcJwks", 64 * 1024);
    requireExactKeys(jwks, ["keys"], "githubOidcJwks");
    if (!Array.isArray(jwks.keys) || jwks.keys.length < 1 || jwks.keys.length > 16) {
      throw new InfrastructureApprovalError("github-oidc-jwks-invalid");
    }
    const matches = jwks.keys.filter((raw) => {
      const candidate = requireRecord(raw, "githubOidcJwk");
      return (
        candidate.kid === kid &&
        (x5t === undefined || candidate.x5t === x5t) &&
        candidate.kty === "RSA" &&
        candidate.use === "sig" &&
        candidate.alg === "RS256" &&
        typeof candidate.n === "string" &&
        typeof candidate.e === "string"
      );
    });
    if (matches.length !== 1) {
      throw new InfrastructureApprovalError("github-oidc-jwks-kid-ambiguous-or-missing");
    }
    return matches[0] as JsonWebKey;
  }

  #claims(payload: Record<string, unknown>, rawToken: Uint8Array): VerifiedGitHubOidcClaims {
    const now = this.#now() / 1000;
    const issuedAt = epoch(payload.iat, "iat");
    const notBefore = epoch(payload.nbf, "nbf");
    const expiresAt = epoch(payload.exp, "exp");
    if (
      expiresAt <= issuedAt ||
      expiresAt <= notBefore ||
      expiresAt - issuedAt > MAX_TOKEN_LIFETIME_SECONDS ||
      issuedAt > now + CLOCK_SKEW_SECONDS ||
      notBefore > now + CLOCK_SKEW_SECONDS ||
      expiresAt <= now - CLOCK_SKEW_SECONDS
    ) {
      throw new InfrastructureApprovalError("github-oidc-time-invalid");
    }
    requireClaim(payload, "jti", 256);
    requireClaim(payload, "actor", 128);
    requireClaim(payload, "repository", 256);
    requireClaim(payload, "repository_owner", 128);
    requireClaim(payload, "run_number", 20);
    requireClaim(payload, "workflow", 256);
    requireClaim(payload, "head_ref", 256, true);
    requireClaim(payload, "base_ref", 256, true);
    if (
      payload.ref_type !== "branch" ||
      payload.ref_protected !== "false" ||
      payload.repository_visibility !== "private" ||
      payload.runner_environment !== "github-hosted"
    ) {
      throw new InfrastructureApprovalError("github-oidc-runtime-shape-invalid");
    }
    return Object.freeze({
      actorId: decimalId(payload.actor_id, "githubOidc.actor_id"),
      audience: requireClaim(payload, "aud", 256),
      checkRunId: decimalId(payload.check_run_id, "githubOidc.check_run_id"),
      commitSha: commitSha(payload.sha, "githubOidc.sha"),
      eventName: requireClaim(payload, "event_name", 64),
      issuer:
        payload.iss === GITHUB_OIDC_ISSUER
          ? GITHUB_OIDC_ISSUER
          : invalid("github-oidc-issuer-invalid"),
      jobWorkflowRef: requireClaim(payload, "job_workflow_ref", 512),
      jobWorkflowSha: commitSha(payload.job_workflow_sha, "githubOidc.job_workflow_sha"),
      ref: requireClaim(payload, "ref", 256),
      repositoryId: decimalId(payload.repository_id, "githubOidc.repository_id"),
      repositoryOwnerId: decimalId(payload.repository_owner_id, "githubOidc.repository_owner_id"),
      runAttempt: positiveIntegerClaim(payload.run_attempt, "githubOidc.run_attempt"),
      runId: decimalId(payload.run_id, "githubOidc.run_id"),
      signatureAlgorithm: "RS256" as const,
      subject: requireClaim(payload, "sub", 1024),
      tokenDigest: sha256Bytes(rawToken),
      verified: true as const,
      workflowRef: requireClaim(payload, "workflow_ref", 512),
      workflowSha: commitSha(payload.workflow_sha, "githubOidc.workflow_sha"),
    });
  }
}

export class LiveInfrastructureGitHubEvidence implements InfrastructureGitHubEvidencePort {
  readonly #client: BoundedGitHubClient;

  constructor(options: { readonly fetch?: FetchLike; readonly token: string }) {
    this.#client = new BoundedGitHubClient(options);
  }

  getActivationConfiguration(commitShaValue: string): Promise<Uint8Array> {
    return this.#client.getBytes(
      `${REPOSITORY_PATH}/contents/${ACTIVATION_CONFIGURATION_PATH}?ref=${commitSha(commitShaValue, "github.activationCommit")}`,
      ACTIVATION_LIMIT,
      "application/vnd.github.raw+json",
    );
  }

  async getCurrentMainSha(): Promise<string> {
    const response = await this.#client.getJson(`${REPOSITORY_PATH}/git/ref/heads/main`);
    if (response.ref !== SWITCHYARD_MAIN_REF) invalid("github-main-ref-mismatch");
    const object = requireRecord(response.object, "githubMain.object");
    if (object.type !== "commit") invalid("github-main-object-not-commit");
    return commitSha(object.sha, "githubMain.object.sha");
  }

  async getOidcSettings(): Promise<RepositoryOidcSettings> {
    const response = await this.#client.getJson(
      `${REPOSITORY_PATH}/actions/oidc/customization/sub`,
    );
    if (
      typeof response.use_default !== "boolean" ||
      typeof response.use_immutable_subject !== "boolean" ||
      !Array.isArray(response.include_claim_keys) ||
      response.include_claim_keys.some((value) => typeof value !== "string")
    ) {
      invalid("github-oidc-settings-malformed");
    }
    return Object.freeze({
      includeClaimKeys: Object.freeze([...response.include_claim_keys]) as readonly string[],
      subClaimPrefix: IMMUTABLE_SUBJECT_PREFIX,
      useDefault: response.use_default,
      useImmutableSubject: response.use_immutable_subject,
    });
  }

  async getRun(runIdValue: string): Promise<GitHubRunEvidence> {
    const runId = decimalId(runIdValue, "github.runId");
    const response = await this.#client.getJson(
      `${REPOSITORY_PATH}/actions/runs/${runId}/attempts/1`,
    );
    const repository = requireRecord(response.repository, "githubRun.repository");
    const owner = requireRecord(repository.owner, "githubRun.repository.owner");
    const actor = requireRecord(response.actor, "githubRun.actor");
    const triggeringActor = requireRecord(response.triggering_actor, "githubRun.triggeringActor");
    const commit = commitSha(response.head_sha, "githubRun.headSha");
    const workflowPath = requireClaim(response, "path", 512);
    if (!workflowPath.startsWith(".github/workflows/") || !workflowPath.endsWith(".yml")) {
      invalid("github-run-workflow-path-invalid");
    }
    const referenced = parseReferencedWorkflows(response.referenced_workflows);
    const status = runStatus(response.status);
    const conclusion = runConclusion(response.conclusion);
    return Object.freeze({
      actorId: decimalId(idString(actor.id), "githubRun.actor.id"),
      commitSha: commit,
      completedAt: status === "completed" ? githubInstant(response.updated_at) : null,
      conclusion,
      createdAt: githubInstant(response.created_at),
      eventName: requireClaim(response, "event", 64),
      ref:
        response.head_branch === SWITCHYARD_DEFAULT_BRANCH
          ? SWITCHYARD_MAIN_REF
          : requireClaim(response, "head_branch", 256),
      referencedWorkflows: referenced,
      repositoryId: decimalId(idString(repository.id), "githubRun.repository.id"),
      repositoryOwnerId: decimalId(idString(owner.id), "githubRun.repository.owner.id"),
      runAttempt: positiveInteger(response.run_attempt, "githubRun.runAttempt"),
      runId: decimalId(idString(response.id), "githubRun.id"),
      triggeringActorId: decimalId(idString(triggeringActor.id), "githubRun.triggeringActor.id"),
      workflowPath,
      workflowRef: `example-org/switchyard/${workflowPath}@${SWITCHYARD_MAIN_REF}`,
      status,
    });
  }

  async getJob(input: { readonly checkRunId: string; readonly runId: string }) {
    const checkRunId = decimalId(input.checkRunId, "githubJob.checkRunId");
    const runId = decimalId(input.runId, "githubJob.runId");
    const jobs: GitHubJobEvidence[] = [];
    const seen = new Set<string>();
    let expectedTotal: number | undefined;
    for (let page = 1; page <= MAX_JOB_PAGES; page += 1) {
      const response = await this.#client.getJson(
        `${REPOSITORY_PATH}/actions/runs/${runId}/attempts/1/jobs?per_page=${JOBS_PER_PAGE}&page=${page}`,
      );
      const total = boundedCount(
        response.total_count,
        "githubJobs.totalCount",
        MAX_JOB_PAGES * JOBS_PER_PAGE,
      );
      if (expectedTotal === undefined) expectedTotal = total;
      if (
        expectedTotal !== total ||
        !Array.isArray(response.jobs) ||
        response.jobs.length > JOBS_PER_PAGE
      ) {
        invalid("github-jobs-pagination-invalid");
      }
      for (const raw of response.jobs) {
        const job = parseJob(raw, runId);
        if (seen.has(job.jobId)) invalid("github-jobs-duplicate");
        seen.add(job.jobId);
        jobs.push(job);
      }
      if (jobs.length === total) break;
      if (response.jobs.length === 0 || page === MAX_JOB_PAGES) {
        invalid("github-jobs-pagination-incomplete");
      }
    }
    const matches = jobs.filter((job) => job.checkRunId === checkRunId);
    if (matches.length !== 1) invalid("github-job-ambiguous-or-missing");
    return matches[0] as GitHubJobEvidence;
  }
}

export class LiveGitHubPlanBundleEvidence implements PlanBundleEvidencePort {
  readonly #client: BoundedGitHubClient;

  constructor(options: { readonly fetch?: FetchLike; readonly token: string }) {
    this.#client = new BoundedGitHubClient(options);
  }

  async downloadArtifact(input: { readonly artifactId: string; readonly planRunId: string }) {
    const artifactId = decimalId(input.artifactId, "artifact.id");
    const planRunId = decimalId(input.planRunId, "artifact.planRunId");
    const metadata = await this.#client.getJson(
      `${REPOSITORY_PATH}/actions/artifacts/${artifactId}`,
    );
    const workflowRun = requireRecord(metadata.workflow_run, "artifact.workflowRun");
    if (
      decimalId(idString(metadata.id), "artifact.id") !== artifactId ||
      decimalId(idString(workflowRun.id), "artifact.workflowRun.id") !== planRunId ||
      decimalId(idString(workflowRun.repository_id), "artifact.workflowRun.repositoryId") !==
        SWITCHYARD_REPOSITORY_ID
    ) {
      invalid("github-artifact-scope-mismatch");
    }
    const expectedName = requireClaim(metadata, "name", 256);
    if (!/^switchyard-infrastructure-plan-[a-f0-9]{64}$/.test(expectedName)) {
      invalid("github-artifact-name-invalid");
    }
    const metadataDigest = requireClaim(metadata, "digest", 80);
    if (!/^sha256:[a-f0-9]{64}$/.test(metadataDigest)) invalid("github-artifact-digest-invalid");
    const outer = await this.#client.downloadArtifact(artifactId, ARTIFACT_ARCHIVE_LIMIT);
    if (`sha256:${sha256Bytes(outer)}` !== metadataDigest) {
      invalid("github-artifact-download-digest-mismatch");
    }
    const decoded = await decodeStrictZip(outer, {
      allowDataDescriptor: true,
      archiveBytes: ARTIFACT_ARCHIVE_LIMIT,
      entryCount: 1,
      files: { "switchyard-plan-bundle.zip": PLAN_ARCHIVE_LIMITS.archiveBytes },
      maxCompressionRatio: 100,
      totalCompressedBytes: ARTIFACT_ARCHIVE_LIMIT,
      totalUncompressedBytes: PLAN_ARCHIVE_LIMITS.archiveBytes,
    });
    const bundle = decoded.entries[0];
    if (bundle?.path !== "switchyard-plan-bundle.zip") invalid("github-artifact-entry-invalid");
    const createdAt = githubInstant(metadata.created_at);
    const expiresAt = githubInstant(metadata.expires_at);
    const publishedAt = githubInstant(metadata.updated_at);
    return Object.freeze({
      artifactId,
      bytes: Uint8Array.from(bundle.contents),
      createdAt,
      expired: metadata.expired === true,
      expiresAt,
      immutable: true,
      planRunId,
      present: true,
      publishedAt,
    });
  }
}

class BoundedGitHubClient {
  readonly #fetch: FetchLike;
  readonly #token: string;

  constructor(options: { readonly fetch?: FetchLike; readonly token: string }) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#token = boundedCredential(options.token, "github-workflow-token");
  }

  async getJson(path: string): Promise<Record<string, unknown>> {
    const response = await this.#get(path, JSON_LIMIT, "application/vnd.github+json");
    return strictJsonRecord(response, "githubResponse", JSON_LIMIT);
  }

  getBytes(path: string, maxBytes: number, accept: string): Promise<Uint8Array> {
    return this.#get(path, maxBytes, accept);
  }

  async downloadArtifact(artifactId: string, maxBytes: number): Promise<Uint8Array> {
    const first = await fetchBounded(
      this.#fetch,
      `${GITHUB_API_ORIGIN}${REPOSITORY_PATH}/actions/artifacts/${artifactId}/zip`,
      {
        headers: githubHeaders(this.#token, "application/vnd.github+json"),
        maxBytes: 0,
        redirect: "manual",
      },
    );
    if (first.status !== 302) invalid("github-artifact-redirect-missing");
    const location = first.headers.get("location");
    if (location === null) invalid("github-artifact-redirect-location-missing");
    const target = artifactDownloadUrl(location);
    const downloaded = await fetchBounded(this.#fetch, target, {
      maxBytes,
      redirect: "error",
    });
    if (downloaded.status !== 200) invalid("github-artifact-download-failed");
    return downloaded.bytes;
  }

  async #get(path: string, maxBytes: number, accept: string): Promise<Uint8Array> {
    if (!path.startsWith(`${REPOSITORY_PATH}/`) || path.includes("..") || path.length > 1024) {
      invalid("github-api-path-invalid");
    }
    const response = await fetchBounded(this.#fetch, `${GITHUB_API_ORIGIN}${path}`, {
      headers: githubHeaders(this.#token, accept),
      maxBytes,
      redirect: "error",
    });
    if (response.status !== 200) invalid(`github-api-status-${response.status}`);
    return response.bytes;
  }
}

async function fetchBounded(
  fetch: FetchLike,
  url: string | URL,
  options: {
    readonly headers?: Readonly<Record<string, string>>;
    readonly maxBytes: number;
    readonly redirect: RequestRedirect;
  },
): Promise<{ readonly bytes: Uint8Array; readonly headers: Headers; readonly status: number }> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      method: "GET",
      redirect: options.redirect,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new InfrastructureApprovalError("github-network-unavailable");
  }
  const bytes = await readBounded(response, options.maxBytes);
  return Object.freeze({ bytes, headers: response.headers, status: response.status });
}

async function readBounded(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^[0-9]+$/.test(declared) ||
      Number(declared) > maximum ||
      !Number.isSafeInteger(Number(declared)))
  ) {
    await response.body?.cancel();
    invalid("github-response-too-large");
  }
  if (maximum === 0) {
    await response.body?.cancel();
    return new Uint8Array();
  }
  if (response.body === null) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        invalid("github-response-too-large");
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof InfrastructureApprovalError) throw error;
    invalid("github-response-read-failed");
  } finally {
    reader.releaseLock();
  }
  const bytes = concatenate(chunks, total);
  if (declared !== null && Number(declared) !== bytes.byteLength)
    invalid("github-response-truncated");
  return bytes;
}

function strictJsonRecord(
  bytes: Uint8Array,
  path: string,
  maxBytes: number,
): Record<string, unknown> {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return invalid("github-json-not-utf8");
  }
  try {
    return requireRecord(parseStrictJson(source, { maxBytes, maxDepth: 12 }), path);
  } catch (error) {
    if (error instanceof InfrastructureApprovalError) throw error;
    return invalid("github-json-malformed-or-duplicate");
  }
}

function parseReferencedWorkflows(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length !== 1) invalid("github-referenced-workflows-invalid");
  const result = value.map((raw, index) => {
    const workflow = requireRecord(raw, `githubRun.referencedWorkflows[${index}]`);
    const path = requireClaim(workflow, "path", 512);
    const sha = commitSha(workflow.sha, `githubRun.referencedWorkflows[${index}].sha`);
    if (!path.endsWith(`@${sha}`)) invalid("github-referenced-workflow-sha-mismatch");
    if (workflow.ref !== undefined) invalid("github-referenced-workflow-mutable-ref");
    return path;
  });
  if (new Set(result).size !== result.length) invalid("github-referenced-workflow-duplicate");
  return Object.freeze(result);
}

function parseJob(value: unknown, runId: string): GitHubJobEvidence {
  const job = requireRecord(value, "githubJob");
  const checkRunUrl = requireClaim(job, "check_run_url", 512);
  const prefix = `${GITHUB_API_ORIGIN}${REPOSITORY_PATH}/check-runs/`;
  if (!checkRunUrl.startsWith(prefix)) invalid("github-job-check-run-url-invalid");
  const checkRunId = decimalId(checkRunUrl.slice(prefix.length), "githubJob.checkRunId");
  const observedRunId = decimalId(idString(job.run_id), "githubJob.runId");
  if (observedRunId !== runId) invalid("github-job-run-mismatch");
  return Object.freeze({
    checkRunId,
    commitSha: commitSha(job.head_sha, "githubJob.headSha"),
    jobId: decimalId(idString(job.id), "githubJob.id"),
    name: requireClaim(job, "name", 256),
    runAttempt: positiveInteger(job.run_attempt, "githubJob.runAttempt"),
    runId,
    status: runStatus(job.status),
    workflowName: requireClaim(job, "workflow_name", 256),
  });
}

function githubHeaders(token: string, accept: string): Record<string, string> {
  return {
    accept,
    authorization: `Bearer ${token}`,
    "user-agent": "switchyard-infrastructure-approval",
    "x-github-api-version": GITHUB_API_VERSION,
  };
}

function githubOidcRequestUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid("github-oidc-request-url-invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.searchParams.has("audience") ||
    url.href.length > 4096 ||
    (url.hostname !== "actions.githubusercontent.com" &&
      !url.hostname.endsWith(".actions.githubusercontent.com"))
  ) {
    invalid("github-oidc-request-url-invalid");
  }
  return url;
}

function artifactDownloadUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid("github-artifact-redirect-url-invalid");
  }
  const allowed =
    url.hostname === "objects.githubusercontent.com" ||
    url.hostname.endsWith(".actions.githubusercontent.com") ||
    url.hostname.endsWith(".blob.core.windows.net");
  if (
    url.protocol !== "https:" ||
    !allowed ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.href.length > 8192
  ) {
    invalid("github-artifact-redirect-url-invalid");
  }
  return url;
}

function decodeBase64Url(value: string, maximum: number): Uint8Array {
  const bytes = Buffer.from(value, "base64url");
  if (bytes.byteLength < 1 || bytes.byteLength > maximum || bytes.toString("base64url") !== value) {
    return invalid("github-oidc-base64url-invalid");
  }
  return bytes;
}

function requireClaim(
  record: Record<string, unknown>,
  key: string,
  maximum: number,
  allowEmpty = false,
): string {
  return exactString(record[key], `github.${key}`, maximum, allowEmpty);
}

function epoch(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    invalid(`github-oidc-${field}-invalid`);
  return value as number;
}

function positiveIntegerClaim(value: unknown, path: string): number {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,9}$/.test(value)) invalid(`${path}-invalid`);
  return Number(value);
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid(`${path}-invalid`);
  return value as number;
}

function boundedCount(value: unknown, path: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    invalid(`${path}-invalid`);
  }
  return value as number;
}

function idString(value: unknown): string {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid("github-id-invalid");
  return String(value);
}

function runStatus(value: unknown): GitHubRunEvidence["status"] {
  if (value === "queued" || value === "in_progress" || value === "completed") return value;
  return invalid("github-run-status-invalid");
}

function runConclusion(value: unknown): GitHubRunEvidence["conclusion"] {
  if (value === null || value === "success" || value === "failure" || value === "cancelled") {
    return value;
  }
  return invalid("github-run-conclusion-invalid");
}

function githubInstant(value: unknown): string {
  if (typeof value !== "string" || value.length > 64) return invalid("github-instant-invalid");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return invalid("github-instant-invalid");
  return parsed.toISOString();
}

function boundedCredential(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length < 32 || value.length > 16 * 1024) {
    return invalid(`${code}-invalid`);
  }
  return value;
}

function oidcCertificateThumbprint(value: unknown, path: string): string {
  const encoded = exactString(value, path, 64);
  if (!/^[A-Za-z0-9_-]{27}$/.test(encoded)) {
    throw new InfrastructureApprovalError("github-oidc-header-x5t-invalid");
  }
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.byteLength !== 20 || decoded.toString("base64url") !== encoded) {
    throw new InfrastructureApprovalError("github-oidc-header-x5t-invalid");
  }
  return encoded;
}

function requireReviewedKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  allowed: readonly string[],
  code: string,
): void {
  try {
    requireAllowedKeys(value, allowed, "reviewedContract");
    if (required.some((key) => !Object.hasOwn(value, key))) {
      throw new Error("reviewed-contract-required-key-absent");
    }
  } catch {
    throw new InfrastructureApprovalError(code);
  }
}

function concatenate(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function invalid(code: string): never {
  throw new InfrastructureApprovalError(code);
}
