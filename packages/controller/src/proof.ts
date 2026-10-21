import {
  exceedsUtf8ByteLimit,
  parseBackupChoice,
  parseCapabilityProfile,
  parseAllocationIdentity,
  parseStrictJson,
  parseStrictJsonObject,
  parseVerifiedWorkloadTrust,
  requireExactKeys,
  requireNonEmptyString,
  requireRecord,
  type AllocationIdentity,
  type BackupChoice,
  type CapabilityProfile,
  type TrustVerificationResult,
  type VerifiedWorkloadTrust,
} from "@switchyard/core";

export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com" as const;
export const GITHUB_OIDC_JWKS_URI =
  "https://token.actions.githubusercontent.com/.well-known/jwks" as const;

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

const MAX_JWT_BYTES = 24 * 1024;
const MAX_JWT_HEADER_BYTES = 4 * 1024;
const MAX_JWT_PAYLOAD_BYTES = 16 * 1024;
const MAX_JWT_SIGNATURE_BYTES = 1024;
const MAX_EASY_AUTH_PRINCIPAL_BYTES = 16 * 1024;
export const MAX_ALLOCATION_REQUEST_BYTES = 4 * 1024;
const MAX_DISCOVERY_OR_JWKS_BYTES = 64 * 1024;
const MAX_FETCH_TIMEOUT_MILLISECONDS = 5_000;
const MAX_CACHE_SECONDS = 15 * 60;
const MAX_TOKEN_LIFETIME_SECONDS = 10 * 60;

export type ProofFailureClassification = "controller-unavailable" | "invalid-proof";

export class ProofVerificationError extends Error {
  readonly classification: ProofFailureClassification;
  readonly code: string;

  constructor(classification: ProofFailureClassification, code: string) {
    super(
      classification === "invalid-proof"
        ? "Allocation proof was rejected"
        : "Allocation proof verification is unavailable",
    );
    this.name = "ProofVerificationError";
    this.classification = classification;
    this.code = code;
  }
}

export interface VerifiedEntraClientProof {
  readonly apiAudience: string;
  readonly clientApplicationId: string;
  readonly dedicatedRole: string;
  readonly tenantId: string;
}

export interface VerifiedGitHubOidcProof {
  readonly actorId: string;
  readonly callerWorkflowRef: string;
  readonly callerWorkflowSha: string;
  readonly identity: AllocationIdentity;
  readonly issuedAt: string;
  readonly jobWorkflowRef: string;
  readonly jobWorkflowSha: string;
  readonly ref: "refs/heads/main";
  readonly repository: string;
  readonly repositoryOwnerId: string;
  readonly sha: string;
}

export interface VerifiedAllocationRequestSecurityDecision {
  readonly entra: VerifiedEntraClientProof;
  readonly github: VerifiedGitHubOidcProof;
  readonly policyInput: ResolvedAllocationPolicyInput;
  readonly trust: VerifiedWorkloadTrust;
}

export interface ResolvedAllocationPolicyInput {
  readonly backupChoice: BackupChoice;
  readonly blacksmithRunnerLabel: string;
  readonly identity: AllocationIdentity;
  readonly profile: CapabilityProfile;
  readonly timeoutMinutes: number;
}

export interface EntraClientProofVerifier {
  verify(proof: unknown): Promise<VerifiedEntraClientProof>;
}

export interface GitHubOidcProofVerifier {
  verify(jwt: unknown): Promise<VerifiedGitHubOidcProof>;
}

export interface GitHubWorkloadTrustVerifier {
  verify(identity: unknown): Promise<TrustVerificationResult>;
}

export interface AllocationRequestSecurityVerifier {
  verify(input: unknown): Promise<VerifiedAllocationRequestSecurityDecision>;
}

export class DualAllocationRequestProofVerifier implements AllocationRequestSecurityVerifier {
  readonly #entra: EntraClientProofVerifier;
  readonly #github: GitHubOidcProofVerifier;
  readonly #trust: GitHubWorkloadTrustVerifier;

  constructor(options: {
    readonly entra: EntraClientProofVerifier;
    readonly github: GitHubOidcProofVerifier;
    readonly trust: GitHubWorkloadTrustVerifier;
  }) {
    this.#entra = options.entra;
    this.#github = options.github;
    this.#trust = options.trust;
  }

  async verify(input: unknown): Promise<VerifiedAllocationRequestSecurityDecision> {
    let transport: Record<string, unknown>;
    try {
      transport = requireRecord(input, "allocationSecurityInput");
      requireExactKeys(
        transport,
        ["entraProof", "githubOidcJwt", "requestBody"],
        "allocationSecurityInput",
      );
    } catch (error) {
      throw invalidProof("allocation-request-transport-invalid", error);
    }
    if (transport.entraProof === null) {
      throw invalidProof("entra-proof-missing");
    }
    if (transport.githubOidcJwt === null) {
      throw invalidProof("github-proof-missing");
    }
    let request: {
      readonly backupChoice: BackupChoice;
      readonly identity: AllocationIdentity;
      readonly profile: CapabilityProfile;
    };
    try {
      request = parseAllocationRequestBody(transport.requestBody);
    } catch (error) {
      throw invalidProof("allocation-request-invalid", error);
    }
    const entra = await normaliseProofFailure(() => this.#entra.verify(transport.entraProof));
    const github = await normaliseProofFailure(() => this.#github.verify(transport.githubOidcJwt));
    if (!sameIdentity(github.identity, request.identity)) {
      throw invalidProof("github-proof-request-identity-mismatch");
    }
    const trustResult = await normaliseProofFailure(() => this.#trust.verify(request.identity));
    if (!trustResult.trusted) {
      if (trustResult.failure.classification === "security-failure") {
        throw invalidProof(`github-trust-${trustResult.failure.code}`);
      }
      throw unavailableProof(`github-trust-${trustResult.failure.code}`);
    }
    let trust: VerifiedWorkloadTrust;
    try {
      trust = parseVerifiedWorkloadTrust(trustResult.evidence);
    } catch (error) {
      throw unavailableProof("github-trust-evidence-invalid", error);
    }
    requireProofMatchesTrust(github, trust);
    if (
      request.profile !== trust.workload.profile ||
      request.backupChoice !== trust.workload.backupChoice
    ) {
      throw invalidProof("allocation-request-policy-mismatch");
    }
    const identity = Object.freeze({ ...request.identity });
    const policyInput = Object.freeze({
      identity,
      profile: trust.workload.profile,
      backupChoice: trust.workload.backupChoice,
      blacksmithRunnerLabel: trust.workload.blacksmithRunnerLabel,
      timeoutMinutes: trust.workload.timeoutMinutes,
    });
    return { entra, github, policyInput, trust };
  }
}

const EASY_AUTH_SECURITY_CLAIM_TYPE_KEYS = [
  "apiAudience",
  "clientApplicationIdV1",
  "clientApplicationIdV2",
  "identityType",
  "roles",
  "scopes",
  "tenantId",
  "tokenVersion",
] as const;

const EASY_AUTH_ANCILLARY_CLAIM_TYPE_KEYS = [
  "authenticationInfo",
  "clientAuthenticationMethod",
  "expiresAt",
  "issuedAt",
  "issuer",
  "notBefore",
  "objectId",
  "refreshTokenHash",
  "subject",
  "tokenIdentifier",
] as const;

export interface EasyAuthAncillaryClaimTypes {
  readonly authenticationInfo: string;
  readonly clientAuthenticationMethod: string;
  readonly expiresAt: string;
  readonly issuedAt: string;
  readonly issuer: string;
  readonly notBefore: string;
  readonly objectId: string;
  readonly refreshTokenHash: string;
  readonly subject: string;
  readonly tokenIdentifier: string;
}

export interface EasyAuthSecurityClaimTypes {
  readonly apiAudience: string;
  readonly clientApplicationIdV1: string;
  readonly clientApplicationIdV2: string;
  readonly identityType: string;
  readonly roles: string;
  readonly scopes: string;
  readonly tenantId: string;
  readonly tokenVersion: string;
}

export interface EasyAuthEntraProofVerifierOptions {
  readonly ancillaryClaimTypes: EasyAuthAncillaryClaimTypes;
  readonly expectedApiAudience: string;
  readonly expectedAuthenticationType: string;
  readonly expectedClientApplicationId: string;
  readonly expectedDedicatedRole: string;
  readonly expectedIdentityTypeValue: string;
  readonly expectedIssuer: string;
  readonly expectedNameClaimType: string;
  readonly expectedTenantId: string;
  readonly expectedTokenVersion: "1.0" | "2.0";
  readonly securityClaimTypes: EasyAuthSecurityClaimTypes;
}

function requireExactEasyAuthClaimTypeMapping<Key extends string>(
  value: unknown,
  keys: readonly Key[],
  path: string,
): Readonly<Record<Key, string>> {
  const record = requireRecord(value, path);
  requireExactKeys(record, keys, path);
  const mapping = Object.create(null) as Record<Key, string>;
  for (const key of keys) {
    mapping[key] = requireNonEmptyString(record[key], `${path}.${key}`);
  }
  return Object.freeze(mapping);
}

/**
 * Validates only Easy Auth's already-authenticated, mapped principal. Required
 * security semantics and ancillary slots are fixed; their exact mapped claim names
 * are configured from an approved preflight fixture.
 */
export class EasyAuthEntraClientProofVerifier implements EntraClientProofVerifier {
  readonly #options: EasyAuthEntraProofVerifierOptions;

  constructor(options: EasyAuthEntraProofVerifierOptions) {
    const securityClaimTypes = requireExactEasyAuthClaimTypeMapping(
      options.securityClaimTypes,
      EASY_AUTH_SECURITY_CLAIM_TYPE_KEYS,
      "easyAuth.securityClaimTypes",
    );
    const ancillaryClaimTypes = requireExactEasyAuthClaimTypeMapping(
      options.ancillaryClaimTypes,
      EASY_AUTH_ANCILLARY_CLAIM_TYPE_KEYS,
      "easyAuth.ancillaryClaimTypes",
    );
    const securityTypes = Object.values(securityClaimTypes);
    const ancillaryTypes = Object.values(ancillaryClaimTypes);
    if (new Set(securityTypes).size !== securityTypes.length) {
      throw new TypeError("Easy Auth security claim types must be unique");
    }
    if (new Set(ancillaryTypes).size !== ancillaryTypes.length) {
      throw new TypeError("Easy Auth ancillary claim types must be unique");
    }
    const securitySet = new Set(securityTypes);
    if (ancillaryTypes.some((claimType) => securitySet.has(claimType))) {
      throw new TypeError("Easy Auth security and ancillary claim types must be disjoint");
    }
    if (
      (options.expectedTokenVersion !== "1.0" && options.expectedTokenVersion !== "2.0") ||
      typeof options.expectedIssuer !== "string" ||
      options.expectedIssuer.length === 0
    ) {
      throw new TypeError("Easy Auth token version, issuer and role mapping must be explicit");
    }
    this.#options = structuredClone({ ...options, ancillaryClaimTypes, securityClaimTypes });
  }

  async verify(proof: unknown): Promise<VerifiedEntraClientProof> {
    try {
      return await this.#verify(proof);
    } catch (error) {
      if (error instanceof ProofVerificationError) {
        throw error;
      }
      throw invalidProof("entra-principal-invalid");
    }
  }

  async #verify(proof: unknown): Promise<VerifiedEntraClientProof> {
    if (typeof proof !== "string" || proof.length === 0 || proof.length > 24 * 1024) {
      throw invalidProof("entra-principal-header-invalid");
    }
    const bytes = decodeBase64(proof, MAX_EASY_AUTH_PRINCIPAL_BYTES, "entra-principal");
    const principal = parseProofRecord(decodeUtf8(bytes, "entra-principal"), "entraPrincipal", 8, [
      "auth_typ",
      "claims",
      "name_typ",
      "role_typ",
    ]);
    if (
      principal.auth_typ !== this.#options.expectedAuthenticationType ||
      principal.name_typ !== this.#options.expectedNameClaimType ||
      principal.role_typ !== this.#options.securityClaimTypes.roles
    ) {
      throw invalidProof("entra-principal-shape-mismatch");
    }
    if (
      !Array.isArray(principal.claims) ||
      principal.claims.length === 0 ||
      principal.claims.length > 64
    ) {
      throw invalidProof("entra-principal-claims-invalid");
    }

    const claims = new Map<string, string[]>();
    const allowed = new Set([
      ...Object.values(this.#options.securityClaimTypes),
      ...Object.values(this.#options.ancillaryClaimTypes),
    ]);
    for (const [index, value] of principal.claims.entries()) {
      const claim = requireRecord(value, `entraPrincipal.claims[${index}]`);
      requireExactKeys(claim, ["typ", "val"], `entraPrincipal.claims[${index}]`);
      const type = requireNonEmptyString(claim.typ, `entraPrincipal.claims[${index}].typ`);
      const valueString = requireNonEmptyString(claim.val, `entraPrincipal.claims[${index}].val`);
      if (!allowed.has(type)) {
        throw invalidProof("entra-principal-claim-not-allowlisted");
      }
      claims.set(type, [...(claims.get(type) ?? []), valueString]);
    }

    const claimTypes = this.#options.securityClaimTypes;
    const tenantId = singletonClaim(claims, claimTypes.tenantId, "entra-tenant-ambiguous");
    const audience = singletonClaim(claims, claimTypes.apiAudience, "entra-audience-ambiguous");
    const tokenVersion = singletonClaim(
      claims,
      claimTypes.tokenVersion,
      "entra-token-version-ambiguous",
    );
    const selectedClientClaim =
      this.#options.expectedTokenVersion === "2.0"
        ? claimTypes.clientApplicationIdV2
        : claimTypes.clientApplicationIdV1;
    const conflictingClientClaim =
      this.#options.expectedTokenVersion === "2.0"
        ? claimTypes.clientApplicationIdV1
        : claimTypes.clientApplicationIdV2;
    const clientApplicationId = singletonClaim(
      claims,
      selectedClientClaim,
      "entra-client-application-ambiguous",
    );
    const identityType = singletonClaim(
      claims,
      claimTypes.identityType,
      "entra-identity-type-ambiguous",
    );
    const roles = claims.get(claimTypes.roles) ?? [];
    if (claims.has(claimTypes.scopes)) {
      throw invalidProof("entra-delegated-scope-forbidden");
    }
    if (claims.has(conflictingClientClaim)) {
      throw invalidProof("entra-client-token-version-ambiguous");
    }
    if (
      tenantId !== this.#options.expectedTenantId ||
      audience !== this.#options.expectedApiAudience ||
      clientApplicationId !== this.#options.expectedClientApplicationId ||
      identityType !== this.#options.expectedIdentityTypeValue ||
      tokenVersion !== this.#options.expectedTokenVersion ||
      roles.length !== 1 ||
      roles[0] !== this.#options.expectedDedicatedRole
    ) {
      throw invalidProof("entra-application-proof-mismatch");
    }
    validateEasyAuthAncillaryClaims(
      claims,
      this.#options.ancillaryClaimTypes,
      this.#options.expectedIssuer,
    );

    return {
      tenantId,
      apiAudience: audience,
      clientApplicationId,
      dedicatedRole: roles[0],
    };
  }
}

export interface GitHubOidcFetchPort {
  fetch(
    url: string,
    init: { readonly redirect: "error"; readonly signal: AbortSignal },
  ): Promise<Response>;
}

export interface GitHubOidcJwtVerifierOptions {
  readonly audience: string;
  readonly cacheSeconds: number;
  readonly callerWorkflow: {
    readonly actorLogin: string;
    readonly path: string;
    readonly ref: "refs/heads/main";
    readonly repository: string;
    readonly repositoryId: string;
    readonly subject: string;
    readonly workflowName: string;
  };
  readonly calledWorkflow: {
    readonly commitSha: string;
    readonly path: string;
    readonly repository: string;
  };
  readonly clockSkewSeconds: number;
  readonly fetch: GitHubOidcFetchPort;
  readonly fetchTimeoutMilliseconds: number;
  readonly maxTokenLifetimeSeconds: number;
  readonly now?: () => Date;
  readonly ownerActorId: string;
  readonly repositoryOwnerId: string;
}

interface CachedDocument<T> {
  readonly expiresAt: number;
  readonly value: T;
}

interface GitHubOidcMetadata {
  readonly issuer: string;
  readonly jwksUri: string;
}

interface JsonWebKeySet {
  readonly keys: readonly GitHubJsonWebKey[];
}

interface GitHubJsonWebKey extends JsonWebKey {
  readonly alg: "RS256";
  readonly kid: string;
  readonly kty: "RSA";
  readonly use: "sig";
}

export class CachedGitHubOidcJwtVerifier implements GitHubOidcProofVerifier {
  readonly #audience: string;
  readonly #cacheMilliseconds: number;
  readonly #callerWorkflow: GitHubOidcJwtVerifierOptions["callerWorkflow"];
  readonly #calledWorkflow: GitHubOidcJwtVerifierOptions["calledWorkflow"];
  readonly #clockSkewSeconds: number;
  readonly #fetch: GitHubOidcFetchPort;
  readonly #fetchTimeoutMilliseconds: number;
  readonly #maxTokenLifetimeSeconds: number;
  readonly #now: () => Date;
  readonly #ownerActorId: string;
  readonly #repositoryOwnerId: string;
  #jwks: CachedDocument<JsonWebKeySet> | undefined;
  #metadata: CachedDocument<GitHubOidcMetadata> | undefined;

  constructor(options: GitHubOidcJwtVerifierOptions) {
    this.#audience = requireConfigured(options.audience, "audience");
    if (!/^api:\/\/[A-Za-z0-9._:/-]+$/.test(this.#audience)) {
      throw new TypeError("GitHub proof audience must be an explicit api:// URI");
    }
    if (
      !Number.isSafeInteger(options.clockSkewSeconds) ||
      options.clockSkewSeconds < 0 ||
      options.clockSkewSeconds > 60
    ) {
      throw new TypeError("clockSkewSeconds must be an integer from 0 to 60");
    }
    if (
      !Number.isSafeInteger(options.cacheSeconds) ||
      options.cacheSeconds < 1 ||
      options.cacheSeconds > MAX_CACHE_SECONDS
    ) {
      throw new TypeError(`cacheSeconds must be from 1 to ${MAX_CACHE_SECONDS}`);
    }
    if (
      !Number.isSafeInteger(options.fetchTimeoutMilliseconds) ||
      options.fetchTimeoutMilliseconds < 1 ||
      options.fetchTimeoutMilliseconds > MAX_FETCH_TIMEOUT_MILLISECONDS
    ) {
      throw new TypeError(
        `fetchTimeoutMilliseconds must be from 1 to ${MAX_FETCH_TIMEOUT_MILLISECONDS}`,
      );
    }
    if (
      !Number.isSafeInteger(options.maxTokenLifetimeSeconds) ||
      options.maxTokenLifetimeSeconds < 1 ||
      options.maxTokenLifetimeSeconds > MAX_TOKEN_LIFETIME_SECONDS
    ) {
      throw new TypeError(
        `maxTokenLifetimeSeconds must be from 1 to ${MAX_TOKEN_LIFETIME_SECONDS}`,
      );
    }
    this.#calledWorkflow = {
      repository: requireRepository(options.calledWorkflow.repository, "calledWorkflow.repository"),
      path: requireWorkflowPath(options.calledWorkflow.path, "calledWorkflow.path"),
      commitSha: requireCommitSha(options.calledWorkflow.commitSha, "calledWorkflow.commitSha"),
    };
    if (options.callerWorkflow.ref !== "refs/heads/main") {
      throw new TypeError("callerWorkflow.ref must be the exact refs/heads/main ref");
    }
    this.#ownerActorId = requirePositiveDecimal(options.ownerActorId, "ownerActorId");
    this.#repositoryOwnerId = requirePositiveDecimal(
      options.repositoryOwnerId,
      "repositoryOwnerId",
    );
    const callerRepository = requireRepository(
      options.callerWorkflow.repository,
      "callerWorkflow.repository",
    );
    const callerRepositoryId = requirePositiveDecimal(
      options.callerWorkflow.repositoryId,
      "callerWorkflow.repositoryId",
    );
    const [repositoryOwner, repositoryName] = callerRepository.split("/") as [string, string];
    const legacySubject = `repo:${callerRepository}:ref:refs/heads/main`;
    const immutableSubject = `repo:${repositoryOwner}@${this.#repositoryOwnerId}/${repositoryName}@${callerRepositoryId}:ref:refs/heads/main`;
    if (
      options.callerWorkflow.subject !== legacySubject &&
      options.callerWorkflow.subject !== immutableSubject
    ) {
      throw new TypeError("callerWorkflow.subject must be one reviewed exact default subject");
    }
    this.#callerWorkflow = {
      actorLogin: requireGitHubLogin(
        options.callerWorkflow.actorLogin,
        "callerWorkflow.actorLogin",
      ),
      repository: callerRepository,
      repositoryId: callerRepositoryId,
      path: requireWorkflowPath(options.callerWorkflow.path, "callerWorkflow.path"),
      ref: "refs/heads/main",
      subject: options.callerWorkflow.subject,
      workflowName: requireConfigured(
        options.callerWorkflow.workflowName,
        "callerWorkflow.workflowName",
      ),
    };
    if (this.#calledWorkflow.repository === this.#callerWorkflow.repository) {
      throw new TypeError("caller and called workflows must use distinct repositories");
    }
    this.#clockSkewSeconds = options.clockSkewSeconds;
    this.#cacheMilliseconds = options.cacheSeconds * 1000;
    this.#fetch = options.fetch;
    this.#fetchTimeoutMilliseconds = options.fetchTimeoutMilliseconds;
    this.#maxTokenLifetimeSeconds = options.maxTokenLifetimeSeconds;
    this.#now = options.now ?? (() => new Date());
  }

  async verify(jwtValue: unknown): Promise<VerifiedGitHubOidcProof> {
    try {
      return await this.#verify(jwtValue);
    } catch (error) {
      if (error instanceof ProofVerificationError) {
        throw error;
      }
      throw invalidProof("github-proof-malformed");
    }
  }

  async #verify(jwtValue: unknown): Promise<VerifiedGitHubOidcProof> {
    if (
      typeof jwtValue !== "string" ||
      jwtValue.length === 0 ||
      exceedsUtf8ByteLimit(jwtValue, MAX_JWT_BYTES)
    ) {
      throw invalidProof("github-proof-size-invalid");
    }
    const segments = jwtValue.split(".");
    if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) {
      throw invalidProof("github-proof-jwt-malformed");
    }
    const [encodedHeader, encodedPayload, encodedSignature] = segments as [string, string, string];
    const headerBytes = decodeBase64Url(encodedHeader, MAX_JWT_HEADER_BYTES, "github-proof-header");
    const payloadBytes = decodeBase64Url(
      encodedPayload,
      MAX_JWT_PAYLOAD_BYTES,
      "github-proof-payload",
    );
    const signature = decodeBase64Url(
      encodedSignature,
      MAX_JWT_SIGNATURE_BYTES,
      "github-proof-signature",
    );
    const header = parseProofRecord(
      decodeUtf8(headerBytes, "github-proof-header"),
      "githubProof.header",
      4,
      ["alg", "kid", "typ"],
    );
    if (header.alg !== "RS256" || header.typ !== "JWT") {
      throw invalidProof("github-proof-algorithm-invalid");
    }
    const kid = requireNonEmptyString(header.kid, "githubProof.header.kid");
    if (kid.length > 256) {
      throw invalidProof("github-proof-kid-invalid");
    }

    await this.#metadataDocument();
    let key = await this.#findKey(kid, false);
    if (key === undefined) {
      key = await this.#findKey(kid, true);
    }
    if (key === undefined) {
      throw invalidProof("github-proof-kid-unknown");
    }
    const verified = await verifyRs256(
      key,
      new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
      signature,
    );
    if (!verified) {
      throw invalidProof("github-proof-signature-invalid");
    }

    const payload = parseProofRecord(
      decodeUtf8(payloadBytes, "github-proof-payload"),
      "githubProof.payload",
      8,
      REQUIRED_GITHUB_CLAIMS,
    );
    return this.#validatePayload(payload);
  }

  #validatePayload(payload: Record<string, unknown>): VerifiedGitHubOidcProof {
    const issuer = requiredStringClaim(payload, "iss");
    const audience = requiredStringClaim(payload, "aud");
    if (issuer !== GITHUB_OIDC_ISSUER || audience !== this.#audience) {
      throw invalidProof("github-proof-issuer-or-audience-mismatch");
    }
    const now = this.#nowMilliseconds();
    const nowSeconds = now / 1000;
    const issuedAt = requiredEpochClaim(payload, "iat");
    const notBefore = requiredEpochClaim(payload, "nbf");
    const expiresAt = requiredEpochClaim(payload, "exp");
    if (
      expiresAt <= issuedAt ||
      expiresAt <= notBefore ||
      expiresAt - issuedAt > this.#maxTokenLifetimeSeconds
    ) {
      throw invalidProof("github-proof-time-shape-invalid");
    }
    if (issuedAt > nowSeconds + this.#clockSkewSeconds) {
      throw invalidProof("github-proof-issued-in-future");
    }
    if (notBefore > nowSeconds + this.#clockSkewSeconds) {
      throw invalidProof("github-proof-not-yet-valid");
    }
    if (expiresAt <= nowSeconds - this.#clockSkewSeconds) {
      throw invalidProof("github-proof-expired");
    }

    const jti = requiredStringClaim(payload, "jti");
    if (jti.length > 256 || !/^[A-Za-z0-9._:-]+$/.test(jti)) {
      throw invalidProof("github-proof-jti-invalid");
    }
    const identity = parseAllocationIdentity({
      repository_id: requiredPositiveDecimalClaim(payload, "repository_id"),
      run_id: requiredPositiveDecimalClaim(payload, "run_id"),
      run_attempt: requiredPositiveIntegerClaim(payload, "run_attempt"),
      allocator_check_run_id: requiredPositiveDecimalClaim(payload, "check_run_id"),
    });
    const repository = requireRepository(requiredStringClaim(payload, "repository"), "repository");
    const repositoryOwnerId = requiredPositiveDecimalClaim(payload, "repository_owner_id");
    const actorId = requiredPositiveDecimalClaim(payload, "actor_id");
    requiredPositiveDecimalClaim(payload, "run_number");
    const actor = requireGitHubLogin(requiredStringClaim(payload, "actor"), "actor");
    const repositoryOwner = requiredStringClaim(payload, "repository_owner");
    const subject = requiredStringClaim(payload, "sub");
    const workflowName = requiredStringClaim(payload, "workflow");
    const headRef = requiredTextClaim(payload, "head_ref");
    const baseRef = requiredTextClaim(payload, "base_ref");
    const ref = requiredStringClaim(payload, "ref");
    const sha = requireCommitSha(requiredStringClaim(payload, "sha"), "sha");
    const expectedRepositoryOwner = this.#callerWorkflow.repository.split("/")[0];
    if (
      identity.repository_id !== this.#callerWorkflow.repositoryId ||
      repository !== this.#callerWorkflow.repository ||
      repositoryOwner !== expectedRepositoryOwner ||
      repositoryOwnerId !== this.#repositoryOwnerId ||
      actor !== this.#callerWorkflow.actorLogin ||
      actorId !== this.#ownerActorId ||
      subject !== this.#callerWorkflow.subject ||
      workflowName !== this.#callerWorkflow.workflowName ||
      requiredStringClaim(payload, "event_name") !== "workflow_dispatch" ||
      ref !== "refs/heads/main" ||
      requiredStringClaim(payload, "ref_type") !== "branch" ||
      requiredStringClaim(payload, "ref_protected") !== "false" ||
      headRef !== "" ||
      baseRef !== "" ||
      requiredStringClaim(payload, "repository_visibility") !== "private" ||
      requiredStringClaim(payload, "runner_environment") !== "github-hosted"
    ) {
      throw invalidProof("github-proof-workload-policy-mismatch");
    }

    const callerWorkflowRef = requiredStringClaim(payload, "workflow_ref");
    const callerWorkflowSha = requireCommitSha(
      requiredStringClaim(payload, "workflow_sha"),
      "workflow_sha",
    );
    const expectedCallerWorkflowRef = `${this.#callerWorkflow.repository}/${this.#callerWorkflow.path}@${this.#callerWorkflow.ref}`;
    if (callerWorkflowRef !== expectedCallerWorkflowRef || callerWorkflowSha !== sha) {
      throw invalidProof("github-proof-caller-workflow-mismatch");
    }

    const jobWorkflowRef = requiredStringClaim(payload, "job_workflow_ref");
    const jobWorkflowSha = requireCommitSha(
      requiredStringClaim(payload, "job_workflow_sha"),
      "job_workflow_sha",
    );
    const expectedJobWorkflowRef = `${this.#calledWorkflow.repository}/${this.#calledWorkflow.path}@${this.#calledWorkflow.commitSha}`;
    if (
      jobWorkflowRef !== expectedJobWorkflowRef ||
      jobWorkflowSha !== this.#calledWorkflow.commitSha ||
      jobWorkflowRef === callerWorkflowRef
    ) {
      throw invalidProof("github-proof-called-workflow-mismatch");
    }

    return {
      actorId,
      callerWorkflowRef,
      callerWorkflowSha,
      identity,
      issuedAt: new Date(issuedAt * 1000).toISOString(),
      jobWorkflowRef,
      jobWorkflowSha,
      ref: "refs/heads/main",
      repository,
      repositoryOwnerId,
      sha,
    };
  }

  async #metadataDocument(): Promise<GitHubOidcMetadata> {
    const now = this.#nowMilliseconds();
    if (this.#metadata !== undefined && this.#metadata.expiresAt > now) {
      return this.#metadata.value;
    }
    const value = await this.#fetchJson(`${GITHUB_OIDC_ISSUER}/.well-known/openid-configuration`);
    const document = requireRecord(value, "githubOidcMetadata");
    if (
      document.issuer !== GITHUB_OIDC_ISSUER ||
      document.jwks_uri !== GITHUB_OIDC_JWKS_URI ||
      !Array.isArray(document.id_token_signing_alg_values_supported) ||
      document.id_token_signing_alg_values_supported.length !== 1 ||
      document.id_token_signing_alg_values_supported[0] !== "RS256" ||
      !Array.isArray(document.claims_supported)
    ) {
      throw unavailableProof("github-oidc-metadata-invalid");
    }
    const claims = document.claims_supported;
    if (
      claims.some((claim) => typeof claim !== "string") ||
      new Set(claims).size !== claims.length ||
      REQUIRED_GITHUB_CLAIMS.some((claim) => !claims.includes(claim))
    ) {
      throw unavailableProof("github-oidc-metadata-claims-invalid");
    }
    const metadata = { issuer: GITHUB_OIDC_ISSUER, jwksUri: GITHUB_OIDC_JWKS_URI };
    this.#metadata = { value: metadata, expiresAt: now + this.#cacheMilliseconds };
    return metadata;
  }

  async #findKey(kid: string, forceRefresh: boolean): Promise<GitHubJsonWebKey | undefined> {
    const keys = await this.#keySet(forceRefresh);
    const matches = keys.keys.filter(
      (key) => key.kid === kid && key.kty === "RSA" && key.use === "sig" && key.alg === "RS256",
    );
    if (matches.length > 1) {
      throw unavailableProof("github-oidc-jwks-kid-ambiguous");
    }
    return matches[0];
  }

  async #keySet(forceRefresh: boolean): Promise<JsonWebKeySet> {
    const now = this.#nowMilliseconds();
    if (!forceRefresh && this.#jwks !== undefined && this.#jwks.expiresAt > now) {
      return this.#jwks.value;
    }
    const document = requireRecord(await this.#fetchJson(GITHUB_OIDC_JWKS_URI), "githubOidcJwks");
    if (!Array.isArray(document.keys) || document.keys.length === 0 || document.keys.length > 32) {
      throw unavailableProof("github-oidc-jwks-invalid");
    }
    const keys = document.keys.map((entry, index) => {
      const key = requireRecord(entry, `githubOidcJwks.keys[${index}]`);
      for (const field of ["kid", "kty", "use", "alg", "n", "e"] as const) {
        requireNonEmptyString(key[field], `githubOidcJwks.keys[${index}].${field}`);
      }
      return key as unknown as GitHubJsonWebKey;
    });
    const result = { keys };
    this.#jwks = { value: result, expiresAt: now + this.#cacheMilliseconds };
    return result;
  }

  async #fetchJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const operation = async (): Promise<string> => {
        const response = await this.#fetch.fetch(url, {
          redirect: "error",
          signal: controller.signal,
        });
        if (!response.ok || response.redirected) {
          throw unavailableProof("github-oidc-fetch-failed");
        }
        const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
        if (contentType !== "application/json") {
          throw unavailableProof("github-oidc-document-content-type-invalid");
        }
        const contentLength = response.headers.get("content-length");
        if (
          contentLength !== null &&
          (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_DISCOVERY_OR_JWKS_BYTES)
        ) {
          throw unavailableProof("github-oidc-document-size-invalid");
        }
        return readBoundedResponseText(response, MAX_DISCOVERY_OR_JWKS_BYTES);
      };
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(unavailableProof("github-oidc-fetch-timeout"));
        }, this.#fetchTimeoutMilliseconds);
      });
      const text = await Promise.race([operation(), timeoutPromise]);
      return parseStrictJson(text, { maxDepth: 12 });
    } catch (error) {
      if (error instanceof ProofVerificationError) {
        throw error;
      }
      throw unavailableProof("github-oidc-fetch-unavailable", error);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }

  #nowMilliseconds(): number {
    let now: Date;
    try {
      now = this.#now();
    } catch (error) {
      throw unavailableProof("proof-clock-invalid", error);
    }
    const milliseconds = now instanceof Date ? now.valueOf() : Number.NaN;
    if (!Number.isFinite(milliseconds)) {
      throw unavailableProof("proof-clock-invalid");
    }
    return milliseconds;
  }
}

async function readBoundedResponseText(response: Response, maximumBytes: number): Promise<string> {
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      total += result.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw unavailableProof("github-oidc-document-size-invalid");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw unavailableProof("github-oidc-document-utf8-invalid", error);
  }
}

function singletonClaim(claims: Map<string, string[]>, type: string, code: string): string {
  const values = claims.get(type) ?? [];
  if (values.length !== 1 || values[0] === undefined) {
    throw invalidProof(code);
  }
  return values[0];
}

function validateEasyAuthAncillaryClaims(
  claims: Map<string, string[]>,
  claimTypes: EasyAuthAncillaryClaimTypes,
  expectedIssuer: string,
): void {
  const issuer = optionalSingletonClaim(claims, claimTypes.issuer);
  if (issuer !== undefined && issuer !== expectedIssuer) {
    throw invalidProof("entra-issuer-mismatch");
  }

  const issuedAt = optionalEpochStringClaim(claims, claimTypes.issuedAt);
  const notBefore = optionalEpochStringClaim(claims, claimTypes.notBefore);
  const expiresAt = optionalEpochStringClaim(claims, claimTypes.expiresAt);
  if (
    (issuedAt !== undefined && expiresAt !== undefined && issuedAt >= expiresAt) ||
    (notBefore !== undefined && expiresAt !== undefined && notBefore >= expiresAt)
  ) {
    throw invalidProof("entra-ancillary-time-shape-invalid");
  }

  const subject = optionalSingletonClaim(claims, claimTypes.subject);
  if (subject !== undefined && (subject.length > 512 || !/^[\x21-\x7e]+$/.test(subject))) {
    throw invalidProof("entra-subject-invalid");
  }
  const objectId = optionalSingletonClaim(claims, claimTypes.objectId);
  if (objectId !== undefined && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(objectId)) {
    throw invalidProof("entra-object-id-invalid");
  }

  optionalBoundedAsciiClaim(claims, claimTypes.authenticationInfo, 1_024);
  optionalBoundedAsciiClaim(claims, claimTypes.refreshTokenHash, 1_024);
  optionalBoundedAsciiClaim(claims, claimTypes.tokenIdentifier, 256);
  const clientAuthenticationMethod = optionalSingletonClaim(
    claims,
    claimTypes.clientAuthenticationMethod,
  );
  if (clientAuthenticationMethod !== undefined && !/^[012]$/.test(clientAuthenticationMethod)) {
    throw invalidProof("entra-client-authentication-method-invalid");
  }
}

function optionalBoundedAsciiClaim(
  claims: Map<string, string[]>,
  type: string,
  maximumLength: number,
): void {
  const value = optionalSingletonClaim(claims, type);
  if (value !== undefined && (value.length > maximumLength || !/^[\x21-\x7e]+$/.test(value))) {
    throw invalidProof("entra-ancillary-opaque-claim-invalid");
  }
}

function optionalSingletonClaim(claims: Map<string, string[]>, type: string): string | undefined {
  const values = claims.get(type);
  if (values === undefined) {
    return undefined;
  }
  if (values.length !== 1 || values[0] === undefined) {
    throw invalidProof("entra-ancillary-claim-ambiguous");
  }
  return values[0];
}

function optionalEpochStringClaim(claims: Map<string, string[]>, type: string): number | undefined {
  const value = optionalSingletonClaim(claims, type);
  if (value === undefined) {
    return undefined;
  }
  const parsed = /^[1-9]\d{0,15}$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed)) {
    throw invalidProof("entra-ancillary-time-invalid");
  }
  return parsed;
}

async function verifyRs256(
  jwk: GitHubJsonWebKey,
  signed: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      Uint8Array.from(signature),
      Uint8Array.from(signed),
    );
  } catch (error) {
    throw unavailableProof("github-oidc-key-invalid", error);
  }
}

function requiredStringClaim(payload: Record<string, unknown>, name: string): string {
  return requireNonEmptyString(payload[name], `githubProof.payload.${name}`);
}

function requiredTextClaim(payload: Record<string, unknown>, name: string): string {
  const value = payload[name];
  if (typeof value !== "string") {
    throw invalidProof(`github-proof-${name}-invalid`);
  }
  return value;
}

function requiredEpochClaim(payload: Record<string, unknown>, name: string): number {
  const value = payload[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw invalidProof(`github-proof-${name}-invalid`);
  }
  return value;
}

function requiredPositiveDecimalClaim(payload: Record<string, unknown>, name: string): string {
  return requirePositiveDecimal(requiredStringClaim(payload, name), name);
}

function requiredPositiveIntegerClaim(payload: Record<string, unknown>, name: string): number {
  const value = payload[name];
  const number = typeof value === "string" && /^[1-9]\d*$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(number) || number < 1) {
    throw invalidProof(`github-proof-${name}-invalid`);
  }
  return number;
}

function requireConfigured(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

function requirePositiveDecimal(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[1-9]\d{0,63}$/.test(value)) {
    throw invalidProof(`${name}-invalid`);
  }
  return value;
}

function requireCommitSha(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) {
    throw invalidProof(`${name}-invalid`);
  }
  return value;
}

function requireRepository(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw invalidProof(`${name}-invalid`);
  }
  return value;
}

function requireGitHubLogin(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.length > 39 ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(value) ||
    value.includes("--")
  ) {
    throw invalidProof(`${name}-invalid`);
  }
  return value;
}

function requireWorkflowPath(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !/^\.github\/workflows\/[A-Za-z0-9_./-]+\.ya?ml$/.test(value) ||
    value.includes("..") ||
    value.includes("//")
  ) {
    throw invalidProof(`${name}-invalid`);
  }
  return value;
}

function decodeBase64(value: string, maximumBytes: number, code: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw invalidProof(`${code}-encoding-invalid`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > maximumBytes || bytes.toString("base64") !== value) {
    throw invalidProof(`${code}-size-or-canonical-form-invalid`);
  }
  return bytes;
}

function decodeBase64Url(value: string, maximumBytes: number, code: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw invalidProof(`${code}-encoding-invalid`);
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length > maximumBytes || bytes.toString("base64url") !== value) {
    throw invalidProof(`${code}-size-or-canonical-form-invalid`);
  }
  return bytes;
}

function decodeUtf8(value: Uint8Array, code: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw invalidProof(`${code}-utf8-invalid`);
  }
}

function parseProofRecord(
  source: string,
  path: string,
  maxDepth: number,
  allowedKeys?: readonly string[],
): Record<string, unknown> {
  try {
    return allowedKeys === undefined
      ? requireRecord(parseStrictJson(source, { maxDepth }), path)
      : parseStrictJsonObject(source, allowedKeys, { maxDepth, path });
  } catch (error) {
    if (error instanceof ProofVerificationError) {
      throw error;
    }
    throw invalidProof(`${path}-json-invalid`);
  }
}

export function parseAllocationRequestBody(value: unknown): {
  readonly backupChoice: BackupChoice;
  readonly identity: AllocationIdentity;
  readonly profile: CapabilityProfile;
} {
  if (typeof value !== "string") {
    throw new TypeError("allocation request body must be JSON text");
  }
  const record = parseStrictJsonObject(value, ["identity", "profile", "backupChoice"], {
    maxBytes: MAX_ALLOCATION_REQUEST_BYTES,
    maxDepth: 4,
    path: "allocationRequest",
  });
  return {
    identity: parseAllocationIdentity(record.identity),
    profile: parseCapabilityProfile(record.profile, "allocationRequest.profile"),
    backupChoice: parseBackupChoice(record.backupChoice, "allocationRequest.backupChoice"),
  };
}

function sameIdentity(left: AllocationIdentity, right: AllocationIdentity): boolean {
  return (
    left.repository_id === right.repository_id &&
    left.run_id === right.run_id &&
    left.run_attempt === right.run_attempt &&
    left.allocator_check_run_id === right.allocator_check_run_id
  );
}

function requireProofMatchesTrust(
  proof: VerifiedGitHubOidcProof,
  trust: VerifiedWorkloadTrust,
): void {
  const callerRepository = `${trust.repository.owner}/${trust.repository.name}`;
  const expectedCallerWorkflowRef = `${callerRepository}/${trust.workflow.path}@${trust.approvedBranch.ref}`;
  const reusable = trust.allocator.reusableWorkflow;
  const expectedReusableWorkflowRef = `${reusable.repository.owner}/${reusable.repository.name}/${reusable.path}@${reusable.commitSha}`;
  if (
    !sameIdentity(proof.identity, trust.identity) ||
    proof.repository !== callerRepository ||
    proof.actorId !== trust.ownerActorId ||
    proof.ref !== trust.approvedBranch.ref ||
    proof.sha !== trust.workflow.commitSha ||
    proof.callerWorkflowRef !== expectedCallerWorkflowRef ||
    proof.callerWorkflowSha !== trust.workflow.commitSha ||
    proof.jobWorkflowRef !== expectedReusableWorkflowRef ||
    proof.jobWorkflowSha !== reusable.commitSha
  ) {
    throw invalidProof("github-proof-trust-evidence-mismatch");
  }
}

async function normaliseProofFailure<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ProofVerificationError) {
      throw error;
    }
    throw unavailableProof("proof-verifier-unavailable", error);
  }
}

function invalidProof(code: string, _cause?: unknown): ProofVerificationError {
  return new ProofVerificationError("invalid-proof", code);
}

function unavailableProof(code: string, _cause?: unknown): ProofVerificationError {
  return new ProofVerificationError("controller-unavailable", code);
}
