import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, it } from "node:test";

import {
  FUTURE_APPLY_DISPATCHER_PATH,
  GITHUB_API_VERSION,
  GITHUB_OIDC_ISSUER,
  GITHUB_OIDC_JWKS_URI,
  immutableOidcSubject,
  LiveGitHubOidcTokenRequester,
  LiveGitHubOidcTokenVerifier,
  LiveGitHubPlanBundleEvidence,
  LiveInfrastructureGitHubEvidence,
  SWITCHYARD_OWNER_ACTOR_ID,
  SWITCHYARD_OWNER_ID,
  SWITCHYARD_REPOSITORY_ID,
  sha256Bytes,
  verifyOidcClaims,
} from "../src/index.js";
import {
  ACTIVATION_BYTES,
  APPLY_ENGINE_SHA,
  APPLY_JOB_CHECK_RUN_ID,
  APPROVAL_RUN_ID,
  ARTIFACT_ID,
  COMMIT_SHA,
  createZip,
  jobEvidence,
  makeBundleFixture,
  POLICY,
  REQUIRED_OIDC_SETTINGS,
  runEvidence,
} from "./fixtures.js";

const API_ROOT = "https://api.github.com/repos/example-org/switchyard";
const WORKFLOW_TOKEN = "github-workflow-token.".repeat(4);

describe("bounded live GitHub evidence", () => {
  it("accepts the bare caller workflow path returned by the live initial-state run", async () => {
    const regressionRunId = "700000001";
    const liveCommitSha = "4e32a7854fcf742584e13383954a7700f17d1d15";
    const liveEngineSha = "5c9b286fcb5761a3fcf4b4c87882ec56103333e7";
    const liveWorkflowPath = ".github/workflows/infrastructure-initialise-state.yml";
    const evidence = new LiveInfrastructureGitHubEvidence({
      fetch: async () =>
        jsonResponse({
          ...runResponse(),
          head_sha: liveCommitSha,
          id: Number(regressionRunId),
          path: liveWorkflowPath,
          referenced_workflows: [
            {
              path: `example-org/switchyard/.github/workflows/infrastructure-apply-engine.yml@${liveEngineSha}`,
              sha: liveEngineSha,
            },
          ],
        }),
      token: WORKFLOW_TOKEN,
    });

    const run = await evidence.getRun(regressionRunId);

    assert.equal(run.workflowPath, liveWorkflowPath);
    assert.equal(run.workflowRef, `example-org/switchyard/${liveWorkflowPath}@refs/heads/main`);
    assert.deepEqual(run.referencedWorkflows, [
      `example-org/switchyard/.github/workflows/infrastructure-apply-engine.yml@${liveEngineSha}`,
    ]);
  });

  it("rejects synthetic refs and malformed caller workflow paths in run evidence", async () => {
    for (const path of [
      ".github/workflows/infrastructure-initialise-state.yml@main",
      `.github/workflows/infrastructure-initialise-state.yml@${"a".repeat(40)}`,
      "/.github/workflows/infrastructure-initialise-state.yml",
      ".github/workflows/infrastructure-initialise-state.yaml",
    ]) {
      const evidence = new LiveInfrastructureGitHubEvidence({
        fetch: async () => jsonResponse({ ...runResponse(), path }),
        token: WORKFLOW_TOKEN,
      });

      await assert.rejects(
        () => evidence.getRun(APPROVAL_RUN_ID),
        (error: unknown) =>
          error instanceof Error && error.message === "github-run-workflow-path-invalid",
      );
    }
  });

  it("reads exact main, activation, run, OIDC settings and a unique allocator job", async () => {
    const seen: Array<{ readonly init?: RequestInit; readonly url: string }> = [];
    const evidence = new LiveInfrastructureGitHubEvidence({
      fetch: async (input, init) => {
        const url = String(input);
        seen.push({ ...(init === undefined ? {} : { init }), url });
        if (url.endsWith("/git/ref/heads/main")) {
          return jsonResponse({
            ref: "refs/heads/main",
            object: { type: "commit", sha: COMMIT_SHA },
          });
        }
        if (url.includes("/contents/infra/foundation/activation.json?ref=")) {
          return new Response(Buffer.from(ACTIVATION_BYTES), { status: 200 });
        }
        if (url.endsWith("/actions/oidc/customization/sub")) {
          return jsonResponse({
            include_claim_keys: REQUIRED_OIDC_SETTINGS.includeClaimKeys,
            use_default: false,
            use_immutable_subject: true,
          });
        }
        if (url.includes(`/actions/runs/${APPROVAL_RUN_ID}/attempts/1/jobs`)) {
          return jsonResponse({ total_count: 1, jobs: [jobResponse()] });
        }
        if (url.endsWith(`/actions/runs/${APPROVAL_RUN_ID}/attempts/1`))
          return jsonResponse(runResponse());
        throw new Error("unexpected-fake-request");
      },
      token: WORKFLOW_TOKEN,
    });
    assert.equal(await evidence.getCurrentMainSha(), COMMIT_SHA);
    assert.deepEqual(await evidence.getActivationConfiguration(COMMIT_SHA), ACTIVATION_BYTES);
    assert.deepEqual(await evidence.getOidcSettings(), REQUIRED_OIDC_SETTINGS);
    const run = await evidence.getRun(APPROVAL_RUN_ID);
    assert.equal(run.actorId, SWITCHYARD_OWNER_ACTOR_ID);
    assert.equal(run.referencedWorkflows[0]?.endsWith(`@${APPLY_ENGINE_SHA}`), true);
    const job = await evidence.getJob({
      checkRunId: APPLY_JOB_CHECK_RUN_ID,
      runId: APPROVAL_RUN_ID,
    });
    assert.equal(job.commitSha, COMMIT_SHA);
    assert.ok(
      seen.every(
        ({ init }) =>
          new Headers(init?.headers).get("x-github-api-version") === GITHUB_API_VERSION &&
          new Headers(init?.headers).get("authorization") === `Bearer ${WORKFLOW_TOKEN}` &&
          init?.redirect === "error",
      ),
    );
  });

  it("rejects pagination duplicates and incomplete or ambiguous job evidence", async () => {
    for (const body of [
      { total_count: 2, jobs: [jobResponse(), jobResponse()] },
      { total_count: 2, jobs: [jobResponse()] },
      { total_count: 401, jobs: [] },
    ]) {
      const evidence = new LiveInfrastructureGitHubEvidence({
        fetch: async () => jsonResponse(body),
        token: WORKFLOW_TOKEN,
      });
      await assert.rejects(() =>
        evidence.getJob({ checkRunId: APPLY_JOB_CHECK_RUN_ID, runId: APPROVAL_RUN_ID }),
      );
    }
  });

  it("maps timeout, redirect, oversize and malformed duplicate JSON to redacted failures", async () => {
    const cases = [
      async () => {
        throw new Error(`network failed ${WORKFLOW_TOKEN}`);
      },
      async () => Response.redirect("https://example.com/untrusted", 302),
      async () => new Response("{}", { headers: { "content-length": "1048577" }, status: 200 }),
      async () => new Response('{"ref":1,"ref":2}', { status: 200 }),
    ];
    for (const fake of cases) {
      const evidence = new LiveInfrastructureGitHubEvidence({ fetch: fake, token: WORKFLOW_TOKEN });
      await assert.rejects(
        () => evidence.getCurrentMainSha(),
        (error: unknown) => error instanceof Error && !error.message.includes(WORKFLOW_TOKEN),
      );
    }
  });

  it("requires one immutable referenced reusable workflow rather than caller substitution", async () => {
    for (const referenced_workflows of [
      [
        {
          path: `example-org/switchyard/.github/workflows/other.yml@${APPLY_ENGINE_SHA}`,
          sha: APPLY_ENGINE_SHA,
        },
      ],
      [
        {
          path: "example-org/switchyard/.github/workflows/infrastructure-apply-engine.yml@main",
          sha: APPLY_ENGINE_SHA,
          ref: "refs/heads/main",
        },
      ],
      [
        {
          path: `example-org/switchyard/.github/workflows/infrastructure-apply-engine.yml@${APPLY_ENGINE_SHA}`,
          sha: APPLY_ENGINE_SHA,
        },
        {
          path: `example-org/switchyard/.github/workflows/infrastructure-apply-engine.yml@${APPLY_ENGINE_SHA}`,
          sha: APPLY_ENGINE_SHA,
        },
      ],
    ]) {
      const evidence = new LiveInfrastructureGitHubEvidence({
        fetch: async () => jsonResponse({ ...runResponse(), referenced_workflows }),
        token: WORKFLOW_TOKEN,
      });
      const result = await evidence.getRun(APPROVAL_RUN_ID).catch((error: unknown) => error);
      if (
        referenced_workflows.length === 1 &&
        !Object.hasOwn(referenced_workflows[0] ?? {}, "ref")
      ) {
        assert.equal(
          (result as { referencedWorkflows: readonly string[] }).referencedWorkflows[0]?.includes(
            "other.yml",
          ),
          true,
        );
      } else {
        assert.ok(result instanceof Error);
      }
    }
  });

  it("requests one exact audience once and rejects preconfigured or redirected OIDC URLs", async () => {
    let requested = "";
    const requester = new LiveGitHubOidcTokenRequester({
      fetch: async (input, init) => {
        requested = String(input);
        assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${WORKFLOW_TOKEN}`);
        return jsonResponse({ value: "header.payload.signature".repeat(3) });
      },
      requestToken: WORKFLOW_TOKEN,
      requestUrl: "https://pipelines.actions.githubusercontent.com/token?id=1",
    });
    await requester.requestToken({ audience: POLICY.plannerAudience });
    assert.equal(new URL(requested).searchParams.get("audience"), POLICY.plannerAudience);
    await assert.rejects(() => requester.requestToken({ audience: POLICY.plannerAudience }));
    assert.throws(
      () =>
        new LiveGitHubOidcTokenRequester({
          requestToken: WORKFLOW_TOKEN,
          requestUrl: "https://pipelines.actions.githubusercontent.com/token?audience=wrong",
        }),
    );
  });

  it("downloads only one approved redirect and verifies the outer content digest", async () => {
    const inner = makeBundleFixture().archive;
    const outer = createZip([
      { contents: inner, dataDescriptor: true, method: 0, path: "switchyard-plan-bundle.zip" },
    ]);
    const evidence = new LiveGitHubPlanBundleEvidence({
      fetch: artifactFetch(outer, "2026-08-26T11:59:59.000Z"),
      token: WORKFLOW_TOKEN,
    });
    const result = await evidence.downloadArtifact({ artifactId: ARTIFACT_ID, planRunId: "101" });
    assert.deepEqual(result.bytes, inner);
    assert.equal(result.createdAt, "2026-08-25T12:00:00.000Z");
    assert.equal(result.expiresAt, "2026-08-26T11:59:59.000Z");
  });
});

describe("live GitHub OIDC cryptographic verifier", () => {
  it("accepts GitHub's reviewed x5t header only when it matches the signing key", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = publicKey.export({ format: "jwk" });
    const x5t = Buffer.alloc(20, 7).toString("base64url");
    const nowSeconds = Math.floor(Date.now() / 1000);
    const payload = oidcPayload(nowSeconds);
    const verifier = new LiveGitHubOidcTokenVerifier({
      fetch: async (input) =>
        String(input).endsWith("openid-configuration")
          ? jsonResponse({
              claims_supported: Object.keys(payload),
              id_token_signing_alg_values_supported: ["RS256"],
              issuer: GITHUB_OIDC_ISSUER,
              jwks_uri: GITHUB_OIDC_JWKS_URI,
            })
          : jsonResponse({
              keys: [{ ...jwk, alg: "RS256", kid: "fixture-key", use: "sig", x5t }],
            }),
    });

    const reviewed = signedToken(payload, privateKey, { x5t });
    await assert.doesNotReject(() =>
      verifier.verifyCryptographically(new TextEncoder().encode(reviewed)),
    );

    for (const header of [
      { x5t: Buffer.alloc(20, 8).toString("base64url") },
      { x5t: "not-a-thumbprint" },
      { "x5t#S256": Buffer.alloc(32, 7).toString("base64url") },
    ]) {
      const token = signedToken(payload, privateKey, header);
      await assert.rejects(() => verifier.verifyCryptographically(new TextEncoder().encode(token)));
    }
  });

  it("binds the exact check and job workflow SHA to the immutable job", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = publicKey.export({ format: "jwk" });
    const nowSeconds = Math.floor(Date.now() / 1000);
    const base = oidcPayload(nowSeconds);
    for (const payload of [
      base,
      { ...base, check_run_id: "999" },
      { ...base, job_workflow_sha: "d".repeat(40) },
      {
        ...base,
        job_workflow_ref: String(base.job_workflow_ref).replace(APPLY_ENGINE_SHA, "d".repeat(40)),
      },
    ]) {
      const token = signedToken(payload, privateKey);
      const verifier = new LiveGitHubOidcTokenVerifier({
        fetch: async (input) =>
          String(input).endsWith("openid-configuration")
            ? jsonResponse({
                claims_supported: Object.keys(base),
                id_token_signing_alg_values_supported: ["RS256"],
                issuer: GITHUB_OIDC_ISSUER,
                jwks_uri: GITHUB_OIDC_JWKS_URI,
              })
            : jsonResponse({ keys: [{ ...jwk, alg: "RS256", kid: "fixture-key", use: "sig" }] }),
      });
      const rawToken = new TextEncoder().encode(token);
      const claims = await verifier.verifyCryptographically(rawToken);
      if (payload === base) {
        assert.equal(claims.jobWorkflowSha, APPLY_ENGINE_SHA);
        assert.doesNotThrow(() =>
          verifyOidcClaims(
            claims,
            "foundation-applier",
            FUTURE_APPLY_DISPATCHER_PATH,
            jobEvidence("apply"),
            runEvidence("apply"),
            POLICY,
            sha256Bytes(rawToken),
          ),
        );
      } else {
        assert.throws(() =>
          verifyOidcClaims(
            claims,
            "foundation-applier",
            FUTURE_APPLY_DISPATCHER_PATH,
            jobEvidence("apply"),
            runEvidence("apply"),
            POLICY,
            sha256Bytes(rawToken),
          ),
        );
      }
    }
  });
});

function runResponse(): Record<string, unknown> {
  return {
    actor: { id: Number(SWITCHYARD_OWNER_ACTOR_ID) },
    conclusion: null,
    created_at: "2026-08-25T12:00:00Z",
    event: "workflow_dispatch",
    head_branch: "main",
    head_sha: COMMIT_SHA,
    id: Number(APPROVAL_RUN_ID),
    path: ".github/workflows/infrastructure-apply.yml",
    referenced_workflows: [
      {
        path: `example-org/switchyard/.github/workflows/infrastructure-apply-engine.yml@${APPLY_ENGINE_SHA}`,
        sha: APPLY_ENGINE_SHA,
      },
    ],
    repository: {
      id: Number(SWITCHYARD_REPOSITORY_ID),
      owner: { id: Number(SWITCHYARD_OWNER_ID) },
    },
    run_attempt: 1,
    status: "in_progress",
    triggering_actor: { id: Number(SWITCHYARD_OWNER_ACTOR_ID) },
    updated_at: "2026-08-25T12:00:01Z",
  };
}

function jobResponse(): Record<string, unknown> {
  return {
    check_run_url: `${API_ROOT}/check-runs/${APPLY_JOB_CHECK_RUN_ID}`,
    head_sha: COMMIT_SHA,
    id: 707,
    name: "apply",
    run_attempt: 1,
    run_id: Number(APPROVAL_RUN_ID),
    status: "in_progress",
    workflow_name: "Infrastructure apply",
  };
}

function oidcPayload(now: number): Record<string, unknown> {
  return {
    actor: "example-owner",
    actor_id: SWITCHYARD_OWNER_ACTOR_ID,
    aud: POLICY.foundationAudience,
    base_ref: "",
    check_run_id: APPLY_JOB_CHECK_RUN_ID,
    event_name: "workflow_dispatch",
    exp: now + 300,
    head_ref: "",
    iat: now,
    iss: GITHUB_OIDC_ISSUER,
    job_workflow_ref: `example-org/switchyard/.github/workflows/infrastructure-apply-engine.yml@${APPLY_ENGINE_SHA}`,
    job_workflow_sha: APPLY_ENGINE_SHA,
    jti: "unique-token-id",
    nbf: now - 1,
    ref: "refs/heads/main",
    ref_protected: "false",
    ref_type: "branch",
    repository: "example-org/switchyard",
    repository_id: SWITCHYARD_REPOSITORY_ID,
    repository_owner: "example-org",
    repository_owner_id: SWITCHYARD_OWNER_ID,
    repository_visibility: "private",
    run_attempt: "1",
    run_id: APPROVAL_RUN_ID,
    run_number: "42",
    runner_environment: "github-hosted",
    sha: COMMIT_SHA,
    sub: immutableOidcSubject(
      ".github/workflows/infrastructure-apply-engine.yml",
      APPLY_ENGINE_SHA,
    ),
    workflow: "Infrastructure apply",
    workflow_ref:
      "example-org/switchyard/.github/workflows/infrastructure-apply.yml@refs/heads/main",
    workflow_sha: COMMIT_SHA,
  };
}

function signedToken(
  payload: Record<string, unknown>,
  privateKey: import("node:crypto").KeyObject,
  extraHeader: Record<string, unknown> = {},
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: "fixture-key", typ: "JWT", ...extraHeader }),
  ).toString("base64url");
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(`${header}.${encoded}`, "ascii"),
    privateKey,
  ).toString("base64url");
  return `${header}.${encoded}.${signature}`;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

function artifactFetch(outer: Uint8Array, expiresAt: string) {
  return async (input: string | URL): Promise<Response> => {
    const url = String(input);
    if (url.endsWith(`/actions/artifacts/${ARTIFACT_ID}`)) {
      return jsonResponse({
        created_at: "2026-08-25T12:00:00.000Z",
        digest: `sha256:${sha256Bytes(outer)}`,
        expired: false,
        expires_at: expiresAt,
        id: Number(ARTIFACT_ID),
        name: `switchyard-infrastructure-plan-${sha256Bytes(makeBundleFixture().savedPlan)}`,
        updated_at: "2026-08-25T12:00:01.000Z",
        workflow_run: { id: 101, repository_id: Number(SWITCHYARD_REPOSITORY_ID) },
      });
    }
    if (url.endsWith(`/actions/artifacts/${ARTIFACT_ID}/zip`)) {
      return new Response(null, {
        headers: { location: "https://download.actions.githubusercontent.com/one.zip?sig=fake" },
        status: 302,
      });
    }
    if (url.startsWith("https://download.actions.githubusercontent.com/")) {
      return new Response(Buffer.from(outer));
    }
    throw new Error("unexpected-fake-request");
  };
}
