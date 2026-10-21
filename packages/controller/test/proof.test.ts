import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, it } from "node:test";

import type { TrustVerificationResult, VerifiedWorkloadTrust } from "@switchyard/core";

import {
  CachedGitHubOidcJwtVerifier,
  DualAllocationRequestProofVerifier,
  EasyAuthEntraClientProofVerifier,
  GITHUB_OIDC_ISSUER,
  GITHUB_OIDC_JWKS_URI,
  ProofVerificationError,
  type EasyAuthAncillaryClaimTypes,
  type EasyAuthSecurityClaimTypes,
  type EntraClientProofVerifier,
  type GitHubOidcFetchPort,
  type GitHubOidcProofVerifier,
  type GitHubWorkloadTrustVerifier,
  type VerifiedEntraClientProof,
  type VerifiedGitHubOidcProof,
} from "../src/index.js";
import {
  DOCUMENTED_EASY_AUTH_ANCILLARY_CLAIM_TYPES,
  DOCUMENTED_EASY_AUTH_SECURITY_CLAIM_TYPES,
  REDACTED_EASY_AUTH_APP_PRINCIPAL,
  REDACTED_EASY_AUTH_APP_PRINCIPAL_CLAIMS,
} from "./easy-auth-fixture.js";
import { REDACTED_REUSABLE_WORKFLOW_OIDC_PAYLOAD } from "./github-oidc-fixture.js";

const NOW_SECONDS = 1_787_659_200;
const NOW = new Date(NOW_SECONDS * 1000);
const CALLER_SHA = "abcdef0123456789abcdef0123456789abcdef01";
const JOB_SHA = "123456789abcdef0123456789abcdef012345678";
const AUDIENCE = "api://switchyard-allocation-proof";
const IDENTITY = {
  repository_id: "900000002",
  run_id: "81001",
  run_attempt: 1,
  allocator_check_run_id: "91001",
} as const;

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PUBLIC_JWK = {
  ...publicKey.export({ format: "jwk" }),
  alg: "RS256",
  kid: "switchyard-test-key",
  use: "sig",
};

const REQUIRED_CLAIMS = [
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

class FakeFetch implements GitHubOidcFetchPort {
  readonly calls: string[] = [];
  readonly #responses: Array<Response | Error>;

  constructor(responses: readonly (Response | Error)[]) {
    this.#responses = [...responses];
  }

  async fetch(
    url: string,
    _init: { readonly redirect: "error"; readonly signal: AbortSignal },
  ): Promise<Response> {
    this.calls.push(url);
    const response = this.#responses.shift();
    if (response instanceof Error) {
      throw response;
    }
    if (response === undefined) {
      throw new Error("fake fetch has no response");
    }
    return response;
  }
}

describe("strict dual allocation proof", () => {
  it("requires both proofs and binds the signed GitHub identity to the request", async () => {
    const entraProof: VerifiedEntraClientProof = {
      tenantId: "tenant",
      apiAudience: "api",
      clientApplicationId: "client",
      dedicatedRole: "Switchyard.Allocate",
    };
    const githubProof = verifiedGitHubProof();
    const trust = verifiedTrust();
    const verifier = new DualAllocationRequestProofVerifier({
      entra: staticEntra(entraProof),
      github: staticGitHub(githubProof),
      trust: staticTrust({ trusted: true, evidence: trust }),
    });

    assert.deepEqual(await verifier.verify(securityInput()), {
      entra: entraProof,
      github: githubProof,
      policyInput: {
        identity: IDENTITY,
        profile: "linux-x64-large",
        backupChoice: "Keep going",
        blacksmithRunnerLabel: "blacksmith-4vcpu-ubuntu-2404",
        timeoutMinutes: 25,
      },
      trust,
    });
    const decision = await verifier.verify(securityInput());
    assert.equal(Object.isFrozen(decision.policyInput), true);
    assert.equal(Object.isFrozen(decision.policyInput.identity), true);
    await assert.rejects(
      () => verifier.verify(securityInput({ entraProof: null })),
      hasProofFailure("invalid-proof", "entra-proof-missing"),
    );
    await assert.rejects(
      () => verifier.verify(securityInput({ githubOidcJwt: null })),
      hasProofFailure("invalid-proof", "github-proof-missing"),
    );
    await assert.rejects(
      () =>
        verifier.verify(
          securityInput({
            requestBody: allocationRequestBody({ identity: { ...IDENTITY, run_id: "81002" } }),
          }),
        ),
      hasProofFailure("invalid-proof", "github-proof-request-identity-mismatch"),
    );
    await assert.rejects(
      () =>
        verifier.verify(
          securityInput({
            requestBody: allocationRequestBody({ identity: { ...IDENTITY, run_id: "not-an-id" } }),
          }),
        ),
      hasProofFailure("invalid-proof", "allocation-request-invalid"),
    );
  });

  it("accepts only the strict public request and resolves mapping-owned policy fields", async () => {
    let trustCalls = 0;
    const verifier = new DualAllocationRequestProofVerifier({
      entra: staticEntra({
        tenantId: "tenant",
        apiAudience: "api",
        clientApplicationId: "client",
        dedicatedRole: "Switchyard.Allocate",
      }),
      github: staticGitHub(verifiedGitHubProof()),
      trust: {
        verify: async () => {
          trustCalls += 1;
          return { trusted: true, evidence: verifiedTrust() };
        },
      },
    });

    for (const requestBody of [
      allocationRequestBody({ runner_label: "attacker-controlled" }),
      allocationRequestBody({ timeoutMinutes: 90 }),
      allocationRequestBody({ label: "blacksmith-4vcpu-ubuntu-2404" }),
      allocationRequestBody().replace(
        '"profile":"linux-x64-large"',
        '"profile":"linux-x64-large","profile":"linux-x64-standard"',
      ),
    ]) {
      await assert.rejects(
        () => verifier.verify(securityInput({ requestBody })),
        hasProofFailure("invalid-proof", "allocation-request-invalid"),
      );
    }
    assert.equal(trustCalls, 0);

    for (const requestBody of [
      allocationRequestBody({ profile: "linux-x64-standard" }),
      allocationRequestBody({ backupChoice: "Save money" }),
    ]) {
      await assert.rejects(
        () => verifier.verify(securityInput({ requestBody })),
        hasProofFailure("invalid-proof", "allocation-request-policy-mismatch"),
      );
    }
    assert.equal(trustCalls, 2);

    await assert.rejects(
      () => verifier.verify({ ...securityInput(), unexpected: true }),
      hasProofFailure("invalid-proof", "allocation-request-transport-invalid"),
    );
    let getterCalled = false;
    const accessorInput = securityInput();
    Object.defineProperty(accessorInput, "requestBody", {
      enumerable: true,
      get: () => {
        getterCalled = true;
        return allocationRequestBody();
      },
    });
    await assert.rejects(
      () => verifier.verify(accessorInput),
      hasProofFailure("invalid-proof", "allocation-request-transport-invalid"),
    );
    assert.equal(getterCalled, false);
  });

  it("composes proof and independent GitHub trust into one ordered pre-state decision", async () => {
    const calls: string[] = [];
    const verifier = new DualAllocationRequestProofVerifier({
      entra: {
        verify: async () => {
          calls.push("entra");
          return {
            tenantId: "tenant",
            apiAudience: "api",
            clientApplicationId: "client",
            dedicatedRole: "Switchyard.Allocate",
          };
        },
      },
      github: {
        verify: async () => {
          calls.push("github-oidc");
          return verifiedGitHubProof();
        },
      },
      trust: {
        verify: async () => {
          calls.push("github-trust");
          return { trusted: true, evidence: verifiedTrust() };
        },
      },
    });

    await verifier.verify(securityInput());
    assert.deepEqual(calls, ["entra", "github-oidc", "github-trust"]);

    const baseTrust = verifiedTrust();
    for (const mismatchedTrust of [
      {
        ...baseTrust,
        workflow: { path: ".github/workflows/other.yml", commitSha: CALLER_SHA },
      },
      { ...baseTrust, ownerActorId: "999" },
      {
        ...baseTrust,
        repository: { ...baseTrust.repository, name: "Other" },
      },
      {
        ...baseTrust,
        allocator: {
          ...baseTrust.allocator,
          reusableWorkflow: {
            ...baseTrust.allocator.reusableWorkflow,
            path: ".github/workflows/other.yml",
          },
        },
      },
    ]) {
      await assert.rejects(
        () =>
          new DualAllocationRequestProofVerifier({
            entra: staticEntra({
              tenantId: "tenant",
              apiAudience: "api",
              clientApplicationId: "client",
              dedicatedRole: "Switchyard.Allocate",
            }),
            github: staticGitHub(verifiedGitHubProof()),
            trust: staticTrust({ trusted: true, evidence: mismatchedTrust }),
          }).verify(securityInput()),
        hasProofFailure("invalid-proof", "github-proof-trust-evidence-mismatch"),
      );
    }

    for (const [classification, expected] of [
      ["security-failure", "invalid-proof"],
      ["controller-unavailable", "controller-unavailable"],
      ["invalid-configuration", "controller-unavailable"],
    ] as const) {
      await assert.rejects(
        () =>
          new DualAllocationRequestProofVerifier({
            entra: staticEntra({
              tenantId: "tenant",
              apiAudience: "api",
              clientApplicationId: "client",
              dedicatedRole: "Switchyard.Allocate",
            }),
            github: staticGitHub(verifiedGitHubProof()),
            trust: staticTrust({
              trusted: false,
              failure: { classification, code: "denied", message: "redacted" },
            }),
          }).verify(securityInput()),
        hasProofFailure(expected, "github-trust-denied"),
      );
    }

    const secretMarker = "must-not-escape-proof-verifier";
    await assert.rejects(
      () =>
        new DualAllocationRequestProofVerifier({
          entra: { verify: async () => Promise.reject(new Error(secretMarker)) },
          github: staticGitHub(verifiedGitHubProof()),
          trust: staticTrust({ trusted: true, evidence: verifiedTrust() }),
        }).verify(securityInput()),
      (error: unknown) => {
        assert.ok(error instanceof ProofVerificationError);
        assert.equal(error.message.includes(secretMarker), false);
        assert.equal(error.cause, undefined);
        return true;
      },
    );
  });

  it("accepts Microsoft's documented mapped Easy Auth tenant, object and role URI shapes", async () => {
    const verifier = easyAuthVerifier();
    const validClaims = easyAuthClaims();
    assert.deepEqual(await verifier.verify(principal(validClaims)), {
      tenantId: "11111111-1111-1111-1111-111111111111",
      apiAudience: "api://switchyard-control",
      clientApplicationId: "22222222-2222-2222-2222-222222222222",
      dedicatedRole: "Switchyard.Allocate",
    });
  });

  it("strictly validates the configured Easy Auth app-only security semantics", async () => {
    const verifier = easyAuthVerifier();
    const validClaims = easyAuthClaims();

    const requiredSecurityClaims = [
      EASY_AUTH_SECURITY_CLAIM_TYPES.tenantId,
      EASY_AUTH_SECURITY_CLAIM_TYPES.apiAudience,
      EASY_AUTH_SECURITY_CLAIM_TYPES.clientApplicationIdV2,
      EASY_AUTH_SECURITY_CLAIM_TYPES.identityType,
      EASY_AUTH_SECURITY_CLAIM_TYPES.roles,
      EASY_AUTH_SECURITY_CLAIM_TYPES.tokenVersion,
    ];
    for (const type of requiredSecurityClaims) {
      await assert.rejects(
        () => verifier.verify(principal(validClaims.filter((claim) => claim.typ !== type))),
        hasClassification("invalid-proof"),
        `missing ${type}`,
      );
      const existing = validClaims.find((claim) => claim.typ === type);
      assert.ok(existing);
      await assert.rejects(
        () => verifier.verify(principal([...validClaims, { ...existing }])),
        hasClassification("invalid-proof"),
        `duplicate ${type}`,
      );
    }

    for (const [type, value] of [
      [EASY_AUTH_SECURITY_CLAIM_TYPES.apiAudience, "api://another-api"],
      [
        EASY_AUTH_SECURITY_CLAIM_TYPES.clientApplicationIdV2,
        "44444444-4444-4444-4444-444444444444",
      ],
      [EASY_AUTH_SECURITY_CLAIM_TYPES.identityType, "user"],
      [EASY_AUTH_SECURITY_CLAIM_TYPES.roles, "Another.Role"],
      [EASY_AUTH_SECURITY_CLAIM_TYPES.tenantId, "55555555-5555-5555-5555-555555555555"],
      [EASY_AUTH_SECURITY_CLAIM_TYPES.tokenVersion, "1.0"],
    ] as const) {
      const claims = validClaims.map((claim) =>
        claim.typ === type ? { ...claim, val: value } : claim,
      );
      await assert.rejects(
        () => verifier.verify(principal(claims)),
        hasClassification("invalid-proof"),
        `wrong ${type}`,
      );
    }

    for (const claims of [
      [...validClaims, { typ: EASY_AUTH_SECURITY_CLAIM_TYPES.scopes, val: "allocate" }],
      [
        ...validClaims,
        {
          typ: EASY_AUTH_SECURITY_CLAIM_TYPES.clientApplicationIdV1,
          val: "44444444-4444-4444-4444-444444444444",
        },
      ],
      [...validClaims, { typ: "unknown", val: "unsafe" }],
      [
        ...validClaims,
        { typ: EASY_AUTH_ANCILLARY_CLAIM_TYPES.issuer, val: "https://attacker.invalid" },
      ],
      validClaims.map((claim) =>
        claim.typ === EASY_AUTH_ANCILLARY_CLAIM_TYPES.objectId
          ? { ...claim, val: "not-a-guid" }
          : claim,
      ),
      validClaims.map((claim) =>
        claim.typ === EASY_AUTH_ANCILLARY_CLAIM_TYPES.clientAuthenticationMethod
          ? { ...claim, val: "3" }
          : claim,
      ),
    ]) {
      await assert.rejects(
        () => verifier.verify(principal(claims)),
        hasClassification("invalid-proof"),
      );
    }

    const unknownPrincipalField = Buffer.from(
      JSON.stringify({
        auth_typ: "aad",
        claims: validClaims,
        name_typ: "name",
        role_typ: EASY_AUTH_SECURITY_CLAIM_TYPES.roles,
        unsafe: true,
      }),
    ).toString("base64");
    await assert.rejects(
      () => verifier.verify(unknownPrincipalField),
      hasClassification("invalid-proof"),
    );
  });

  it("rejects raw claim names under the reviewed URI mapping", async () => {
    const verifier = easyAuthVerifier();
    const validClaims = easyAuthClaims();
    for (const [mappedType, rawType] of [
      [EASY_AUTH_SECURITY_CLAIM_TYPES.tenantId, "tid"],
      [EASY_AUTH_ANCILLARY_CLAIM_TYPES.objectId, "oid"],
      [EASY_AUTH_SECURITY_CLAIM_TYPES.roles, "roles"],
    ] as const) {
      const rawClaims = validClaims.map((claim) =>
        claim.typ === mappedType ? { ...claim, typ: rawType } : claim,
      );
      await assert.rejects(
        () => verifier.verify(principal(rawClaims)),
        hasClassification("invalid-proof"),
        `raw ${rawType}`,
      );
    }
    await assert.rejects(
      () => verifier.verify(principal(validClaims, "roles")),
      hasClassification("invalid-proof"),
    );
    await assert.rejects(
      () => verifier.verify(principal([...validClaims, { typ: "scp", val: "allocate" }])),
      hasClassification("invalid-proof"),
    );
  });

  it("requires exact, unique and disjoint configured Easy Auth claim mappings", () => {
    assert.throws(() =>
      easyAuthVerifier({
        securityClaimTypes: {
          ...EASY_AUTH_SECURITY_CLAIM_TYPES,
          roles: EASY_AUTH_SECURITY_CLAIM_TYPES.tenantId,
        },
      }),
    );
    assert.throws(() =>
      easyAuthVerifier({
        ancillaryClaimTypes: {
          ...EASY_AUTH_ANCILLARY_CLAIM_TYPES,
          refreshTokenHash: EASY_AUTH_ANCILLARY_CLAIM_TYPES.authenticationInfo,
        },
      }),
    );
    assert.throws(() =>
      easyAuthVerifier({
        ancillaryClaimTypes: {
          ...EASY_AUTH_ANCILLARY_CLAIM_TYPES,
          objectId: EASY_AUTH_SECURITY_CLAIM_TYPES.tenantId,
        },
      }),
    );
    const { roles: _missingRole, ...missingSecuritySlot } = EASY_AUTH_SECURITY_CLAIM_TYPES;
    assert.throws(() =>
      easyAuthVerifier({
        securityClaimTypes: missingSecuritySlot as EasyAuthSecurityClaimTypes,
      }),
    );
    assert.throws(() =>
      easyAuthVerifier({
        securityClaimTypes: {
          ...EASY_AUTH_SECURITY_CLAIM_TYPES,
          unexpected: "unsafe",
        } as EasyAuthSecurityClaimTypes,
      }),
    );
    const { subject: _missingSubject, ...missingAncillarySlot } = EASY_AUTH_ANCILLARY_CLAIM_TYPES;
    assert.throws(() =>
      easyAuthVerifier({
        ancillaryClaimTypes: missingAncillarySlot as EasyAuthAncillaryClaimTypes,
      }),
    );
    assert.throws(() =>
      easyAuthVerifier({
        ancillaryClaimTypes: {
          ...EASY_AUTH_ANCILLARY_CLAIM_TYPES,
          unexpected: "unsafe",
        } as EasyAuthAncillaryClaimTypes,
      }),
    );
  });

  it("accepts the full redacted reusable-workflow token shape", async () => {
    const fetch = successfulFetch();
    const verifier = githubVerifier(fetch);
    const proof = await verifier.verify(jwt(payload()));

    assert.deepEqual(proof, verifiedGitHubProof());
    assert.deepEqual(fetch.calls, [
      `${GITHUB_OIDC_ISSUER}/.well-known/openid-configuration`,
      GITHUB_OIDC_JWKS_URI,
    ]);
  });

  it("treats a refreshed jti as the same bound identity and never exposes jti", async () => {
    const verifier = githubVerifier(successfulFetch());
    const first = await verifier.verify(
      jwt(payload({ jti: "00000000-0000-0000-0000-000000000001" })),
    );
    const second = await verifier.verify(
      jwt(payload({ jti: "00000000-0000-0000-0000-000000000002" })),
    );
    assert.deepEqual(first, second);
    assert.equal("jti" in first, false);
  });

  it("rejects alg confusion, none, unknown and ambiguous kids with one safe refresh", async () => {
    for (const alg of ["none", "HS256"] as const) {
      const verifier = githubVerifier(successfulFetch());
      await assert.rejects(
        () => verifier.verify(jwt(payload(), { alg })),
        hasProofFailure("invalid-proof", "github-proof-algorithm-invalid"),
      );
    }

    const unknownFetch = new FakeFetch([
      jsonResponse(metadata()),
      jsonResponse(jwks()),
      jsonResponse(jwks()),
    ]);
    await assert.rejects(
      () => githubVerifier(unknownFetch).verify(jwt(payload(), { kid: "unknown" })),
      hasProofFailure("invalid-proof", "github-proof-kid-unknown"),
    );
    assert.deepEqual(unknownFetch.calls, [
      `${GITHUB_OIDC_ISSUER}/.well-known/openid-configuration`,
      GITHUB_OIDC_JWKS_URI,
      GITHUB_OIDC_JWKS_URI,
    ]);

    const ambiguous = new FakeFetch([
      jsonResponse(metadata()),
      jsonResponse(jwks([PUBLIC_JWK, { ...PUBLIC_JWK }])),
    ]);
    await assert.rejects(
      () => githubVerifier(ambiguous).verify(jwt(payload())),
      hasProofFailure("controller-unavailable", "github-oidc-jwks-kid-ambiguous"),
    );
  });

  it("rejects duplicate or unknown claims, audience arrays and noncanonical identity claims", async () => {
    const duplicateAudience = JSON.stringify(payload()).replace(
      `"aud":"${AUDIENCE}"`,
      `"aud":"${AUDIENCE}","aud":"other"`,
    );
    const duplicateActor = JSON.stringify(payload()).replace(
      '"actor":"example-owner"',
      '"actor":"example-owner","actor":"attacker"',
    );
    for (const token of [
      jwtRaw(duplicateAudience),
      jwtRaw(duplicateActor),
      jwt({ ...payload(), aud: [AUDIENCE] }),
      jwt({ ...payload(), run_attempt: 1 }),
      jwt({ ...payload(), run_id: "081001" }),
      jwt({ ...payload(), check_run_id: "0" }),
      jwt({ ...payload(), unexpected_privilege: true }),
      jwt({ ...payload(), repo_property_environment: "production" }),
    ]) {
      await assert.rejects(
        () => githubVerifier(successfulFetch()).verify(token),
        hasClassification("invalid-proof"),
      );
    }
  });

  it("rejects missing subject and ancillary claims plus caller-only token shapes", async () => {
    for (const claim of [
      "sub",
      "actor",
      "repository_owner",
      "run_number",
      "workflow",
      "head_ref",
      "base_ref",
      "ref_protected",
      "job_workflow_ref",
      "job_workflow_sha",
    ]) {
      const incomplete = { ...payload() };
      delete incomplete[claim];
      await assert.rejects(
        () => githubVerifier(successfulFetch()).verify(jwt(incomplete)),
        hasClassification("invalid-proof"),
        claim,
      );
    }

    const callerOnly = { ...payload() };
    delete callerOnly.job_workflow_ref;
    delete callerOnly.job_workflow_sha;
    await assert.rejects(
      () => githubVerifier(successfulFetch()).verify(jwt(callerOnly)),
      hasClassification("invalid-proof"),
    );
  });

  it("rejects every required policy mismatch and caller/job workflow substitution", async () => {
    const mutations: ReadonlyArray<Record<string, unknown>> = [
      { repository: "example-org/Other" },
      { repository_id: "900000099" },
      { repository_owner_id: "999" },
      { repository_owner: "Other-Owner" },
      { actor: "other-actor" },
      { actor_id: "999" },
      { sub: "repo:example-org/example-workload:pull_request" },
      { run_number: "0" },
      { workflow: "Other workflow" },
      { event_name: "push" },
      { head_ref: "feature" },
      { base_ref: "main" },
      { ref: "refs/heads/feature" },
      { ref_protected: "true" },
      { ref_type: "tag" },
      { repository_visibility: "public" },
      { runner_environment: "self-hosted" },
      { workflow_sha: JOB_SHA },
      {
        workflow_ref: "example-org/example-workload/.github/workflows/other.yml@refs/heads/main",
      },
      { job_workflow_sha: CALLER_SHA },
      {
        job_workflow_ref: `example-org/switchyard/.github/workflows/allocate-runner.yml@${CALLER_SHA}`,
      },
      {
        workflow_ref: `example-org/switchyard/.github/workflows/allocate-runner.yml@${JOB_SHA}`,
      },
    ];
    for (const mutation of mutations) {
      await assert.rejects(
        () => githubVerifier(successfulFetch()).verify(jwt({ ...payload(), ...mutation })),
        hasClassification("invalid-proof"),
      );
    }
  });

  it("enforces exp, nbf and iat with the exact five-second skew boundaries", async () => {
    const accepted = [{ iat: NOW_SECONDS + 5 }, { nbf: NOW_SECONDS + 5 }, { exp: NOW_SECONDS - 4 }];
    for (const mutation of accepted) {
      await assert.doesNotReject(() =>
        githubVerifier(successfulFetch()).verify(jwt({ ...payload(), ...mutation })),
      );
    }
    const rejected = [{ iat: NOW_SECONDS + 6 }, { nbf: NOW_SECONDS + 6 }, { exp: NOW_SECONDS - 5 }];
    for (const mutation of rejected) {
      await assert.rejects(
        () => githubVerifier(successfulFetch()).verify(jwt({ ...payload(), ...mutation })),
        hasClassification("invalid-proof"),
      );
    }
    await assert.rejects(
      () =>
        githubVerifier(successfulFetch()).verify(
          jwt({ ...payload(), exp: NOW_SECONDS + 601, iat: NOW_SECONDS }),
        ),
      hasProofFailure("invalid-proof", "github-proof-time-shape-invalid"),
    );
  });

  it("classifies discovery/JWKS outages and oversized documents as controller unavailable", async () => {
    for (const fetch of [
      new FakeFetch([new Error("offline")]),
      new FakeFetch([
        new Response("x".repeat(64 * 1024 + 1), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ]),
      new FakeFetch([jsonResponse({ ...metadata(), issuer: "https://attacker.invalid" })]),
      new FakeFetch([jsonResponse(metadata()), new FakeResponseNeverUsed() as unknown as Response]),
    ]) {
      await assert.rejects(
        () => githubVerifier(fetch).verify(jwt(payload())),
        hasClassification("controller-unavailable"),
      );
    }
  });

  it("rejects many-megabyte and multibyte-oversized JWTs before metadata fetch", async () => {
    for (const token of ["a".repeat(8 * 1024 * 1024), "é".repeat(12 * 1024 + 1)]) {
      const fetch = new FakeFetch([]);
      await assert.rejects(
        () => githubVerifier(fetch).verify(token),
        hasProofFailure("invalid-proof", "github-proof-size-invalid"),
      );
      assert.deepEqual(fetch.calls, []);
    }
  });

  it("bounds fetch time, cache policy, token lifetime and controller clock", async () => {
    const neverFetch: GitHubOidcFetchPort = {
      fetch: async () => new Promise<Response>(() => undefined),
    };
    await assert.rejects(
      () => githubVerifier(neverFetch, { fetchTimeoutMilliseconds: 5 }).verify(jwt(payload())),
      hasProofFailure("controller-unavailable", "github-oidc-fetch-timeout"),
    );
    await assert.rejects(
      () =>
        githubVerifier(successfulFetch(), { now: () => new Date("invalid") }).verify(
          jwt(payload()),
        ),
      hasProofFailure("controller-unavailable", "proof-clock-invalid"),
    );
    for (const overrides of [
      { cacheSeconds: 0 },
      { cacheSeconds: 901 },
      { fetchTimeoutMilliseconds: 5_001 },
      { maxTokenLifetimeSeconds: 601 },
    ]) {
      assert.throws(() => githubVerifier(successfulFetch(), overrides));
    }
  });
});

class FakeResponseNeverUsed extends Error {}

const EASY_AUTH_ANCILLARY_CLAIM_TYPES = DOCUMENTED_EASY_AUTH_ANCILLARY_CLAIM_TYPES;
const EASY_AUTH_SECURITY_CLAIM_TYPES = DOCUMENTED_EASY_AUTH_SECURITY_CLAIM_TYPES;

function easyAuthVerifier(
  overrides: {
    readonly ancillaryClaimTypes?: EasyAuthAncillaryClaimTypes;
    readonly securityClaimTypes?: EasyAuthSecurityClaimTypes;
  } = {},
): EasyAuthEntraClientProofVerifier {
  return new EasyAuthEntraClientProofVerifier({
    ancillaryClaimTypes: overrides.ancillaryClaimTypes ?? EASY_AUTH_ANCILLARY_CLAIM_TYPES,
    expectedApiAudience: "api://switchyard-control",
    expectedAuthenticationType: "aad",
    expectedClientApplicationId: "22222222-2222-2222-2222-222222222222",
    expectedDedicatedRole: "Switchyard.Allocate",
    expectedIdentityTypeValue: "app",
    expectedIssuer: "https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/v2.0",
    expectedNameClaimType: "name",
    expectedTenantId: "11111111-1111-1111-1111-111111111111",
    expectedTokenVersion: "2.0",
    securityClaimTypes: overrides.securityClaimTypes ?? EASY_AUTH_SECURITY_CLAIM_TYPES,
  });
}

function easyAuthClaims(): Array<{ readonly typ: string; readonly val: string }> {
  return REDACTED_EASY_AUTH_APP_PRINCIPAL_CLAIMS.map((claim) => ({ ...claim }));
}

function principal(
  claims: readonly { readonly typ: string; readonly val: string }[],
  roleClaimType: string = REDACTED_EASY_AUTH_APP_PRINCIPAL.role_typ,
): string {
  return Buffer.from(
    JSON.stringify({
      auth_typ: REDACTED_EASY_AUTH_APP_PRINCIPAL.auth_typ,
      claims,
      name_typ: REDACTED_EASY_AUTH_APP_PRINCIPAL.name_typ,
      role_typ: roleClaimType,
    }),
  ).toString("base64");
}

function githubVerifier(
  fetch: GitHubOidcFetchPort,
  overrides: {
    readonly cacheSeconds?: number;
    readonly fetchTimeoutMilliseconds?: number;
    readonly maxTokenLifetimeSeconds?: number;
    readonly now?: () => Date;
  } = {},
): CachedGitHubOidcJwtVerifier {
  return new CachedGitHubOidcJwtVerifier({
    audience: AUDIENCE,
    cacheSeconds: overrides.cacheSeconds ?? 300,
    callerWorkflow: {
      actorLogin: "example-owner",
      repository: "example-org/example-workload",
      repositoryId: IDENTITY.repository_id,
      path: ".github/workflows/ci.yml",
      ref: "refs/heads/main",
      subject: "repo:example-org/example-workload:ref:refs/heads/main",
      workflowName: "Workload CI",
    },
    calledWorkflow: {
      repository: "example-org/switchyard",
      path: ".github/workflows/allocate-runner.yml",
      commitSha: JOB_SHA,
    },
    clockSkewSeconds: 5,
    fetch,
    fetchTimeoutMilliseconds: overrides.fetchTimeoutMilliseconds ?? 1_000,
    maxTokenLifetimeSeconds: overrides.maxTokenLifetimeSeconds ?? 600,
    now: overrides.now ?? (() => NOW),
    ownerActorId: "900000001",
    repositoryOwnerId: "12345678",
  });
}

function successfulFetch(): FakeFetch {
  return new FakeFetch([jsonResponse(metadata()), jsonResponse(jwks())]);
}

function metadata(): Record<string, unknown> {
  return {
    issuer: GITHUB_OIDC_ISSUER,
    jwks_uri: GITHUB_OIDC_JWKS_URI,
    id_token_signing_alg_values_supported: ["RS256"],
    claims_supported: REQUIRED_CLAIMS,
  };
}

function jwks(keys: readonly unknown[] = [PUBLIC_JWK]): Record<string, unknown> {
  return { keys };
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...REDACTED_REUSABLE_WORKFLOW_OIDC_PAYLOAD,
    ...overrides,
  };
}

function jwt(
  value: Record<string, unknown>,
  headerOverrides: Record<string, unknown> = {},
): string {
  return jwtRaw(JSON.stringify(value), headerOverrides);
}

function jwtRaw(payloadSource: string, headerOverrides: Record<string, unknown> = {}): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: PUBLIC_JWK.kid, typ: "JWT", ...headerOverrides }),
  ).toString("base64url");
  const encodedPayload = Buffer.from(payloadSource).toString("base64url");
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(`${header}.${encodedPayload}`),
    privateKey,
  ).toString("base64url");
  return `${header}.${encodedPayload}.${signature}`;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function verifiedGitHubProof(): VerifiedGitHubOidcProof {
  return {
    actorId: "900000001",
    callerWorkflowRef: "example-org/example-workload/.github/workflows/ci.yml@refs/heads/main",
    callerWorkflowSha: CALLER_SHA,
    identity: IDENTITY,
    issuedAt: new Date((NOW_SECONDS - 5) * 1000).toISOString(),
    jobWorkflowRef: `example-org/switchyard/.github/workflows/allocate-runner.yml@${JOB_SHA}`,
    jobWorkflowSha: JOB_SHA,
    ref: "refs/heads/main",
    repository: "example-org/example-workload",
    repositoryOwnerId: "12345678",
    sha: CALLER_SHA,
  };
}

function verifiedTrust(): VerifiedWorkloadTrust {
  return {
    identity: IDENTITY,
    approvedBranch: {
      kind: "approved-branch-evidence",
      repositoryId: IDENTITY.repository_id,
      runId: IDENTITY.run_id,
      approvedRunAttempt: 1,
      ref: "refs/heads/main",
      commitSha: CALLER_SHA,
    },
    mappingPointer: "example-workload/example-build",
    repository: {
      id: IDENTITY.repository_id,
      owner: "example-org",
      name: "example-workload",
    },
    workflow: { path: ".github/workflows/ci.yml", commitSha: CALLER_SHA },
    ownerActorId: "900000001",
    allocator: {
      jobKey: "allocate-example-build",
      checkName: "Allocate example runner / allocate",
      checkRunId: IDENTITY.allocator_check_run_id,
      jobId: "92001",
      reusableWorkflow: {
        repository: { owner: "example-org", name: "switchyard" },
        path: ".github/workflows/allocate-runner.yml",
        commitSha: JOB_SHA,
      },
    },
    workload: {
      backupChoice: "Keep going",
      blacksmithRunnerLabel: "blacksmith-4vcpu-ubuntu-2404",
      jobKey: "example-build",
      jobName: "Example approved build",
      profile: "linux-x64-large",
      timeoutMinutes: 25,
      production: true,
    },
  };
}

function allocationRequestBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    identity: IDENTITY,
    profile: "linux-x64-large",
    backupChoice: "Keep going",
    ...overrides,
  });
}

function securityInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    entraProof: "opaque-entra-proof",
    githubOidcJwt: "opaque-github-proof",
    requestBody: allocationRequestBody(),
    ...overrides,
  };
}

function staticEntra(value: VerifiedEntraClientProof): EntraClientProofVerifier {
  return { verify: async () => value };
}

function staticGitHub(value: VerifiedGitHubOidcProof): GitHubOidcProofVerifier {
  return { verify: async () => value };
}

function staticTrust(value: TrustVerificationResult): GitHubWorkloadTrustVerifier {
  return { verify: async () => value };
}

function hasClassification(classification: ProofVerificationError["classification"]) {
  return (error: unknown): boolean =>
    error instanceof ProofVerificationError && error.classification === classification;
}

function hasProofFailure(classification: ProofVerificationError["classification"], code: string) {
  return (error: unknown): boolean =>
    error instanceof ProofVerificationError &&
    error.classification === classification &&
    error.code === code;
}
