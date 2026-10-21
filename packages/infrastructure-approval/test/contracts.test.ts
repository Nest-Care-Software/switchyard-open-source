import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CURRENT_DISABLED_GITHUB_EVIDENCE,
  FUTURE_APPLY_DISPATCHER_PATH,
  futureIdentityContracts,
  INFRASTRUCTURE_APPLY_ENGINE_PATH,
  INFRASTRUCTURE_INITIAL_STATE_DISPATCHER_PATH,
  InfrastructureApprovalError,
  immutableOidcSubject,
  parseApprovalInputs,
  requireActivationOidcSettings,
  requiredOidcSettings,
  SWITCHYARD_MAIN_REF,
  SWITCHYARD_REPOSITORY,
  sha256Bytes,
  verifyIdentitySession,
  verifyOidcClaims,
  verifyReferencedWorkflow,
  verifyRunEvidence,
} from "../src/index.js";
import {
  APPLY_ENGINE_SHA,
  COMMIT_SHA,
  identitySession,
  initialStateRunEvidence,
  jobEvidence,
  oidcClaims,
  POLICY,
  RAW_APPLY_TOKEN,
  runEvidence,
} from "./fixtures.js";

describe("current disabled GitHub evidence and future immutable subjects", () => {
  it("records the observed read-only settings as explicit activation blockers", () => {
    assert.deepEqual(CURRENT_DISABLED_GITHUB_EVIDENCE, {
      actions: {
        accessLevel: "none",
        allowedActions: "all",
        enabled: true,
        shaPinningRequired: false,
      },
      defaultBranch: "main",
      ownerId: "900000004",
      private: true,
      repositoryId: "900000003",
      subject: {
        subClaimPrefix: "repo:example-org@900000004/switchyard@900000003",
        useDefault: true,
        useImmutableSubject: false,
      },
    });
    assert.throws(
      () => requireActivationOidcSettings(CURRENT_DISABLED_GITHUB_EVIDENCE.subject),
      /oidc-default-subject-active/,
    );
    assert.doesNotThrow(() => requireActivationOidcSettings(requiredOidcSettings()));
  });

  it("uses GitHub's current immutable prefix, context and pinned reusable workflow semantics", () => {
    assert.equal(
      immutableOidcSubject(INFRASTRUCTURE_APPLY_ENGINE_PATH, APPLY_ENGINE_SHA),
      `repo:example-org@900000004/switchyard@900000003:ref:refs/heads/main:job_workflow_ref:example-org/switchyard/.github/workflows/infrastructure-apply-engine.yml@${APPLY_ENGINE_SHA}`,
    );
    const identities = futureIdentityContracts(POLICY);
    assert.deepEqual(Object.keys(identities).sort(), [
      "bootstrap-applier",
      "foundation-applier",
      "planner",
    ]);
    assert.notEqual(
      identities["bootstrap-applier"].audience,
      identities["foundation-applier"].audience,
    );
    assert.equal(identities["bootstrap-applier"].subject, identities["foundation-applier"].subject);
  });
});

describe("strict GitHub API, raw-token and approval evidence", () => {
  it("binds the live reusable caller ref and immutable caller SHA as separate claims", () => {
    const regressionRunId = "700000002";
    const regressionJobCheckRunId = "700000003";
    const liveCommitSha = "972b49c8a2b037865b145174786f40ac2d989310";
    const liveWorkflowRef = `${SWITCHYARD_REPOSITORY}/${INFRASTRUCTURE_INITIAL_STATE_DISPATCHER_PATH}@${SWITCHYARD_MAIN_REF}`;
    const run = initialStateRunEvidence({
      commitSha: liveCommitSha,
      runId: regressionRunId,
      workflowRef: liveWorkflowRef,
    });
    const job = jobEvidence("apply", {
      checkRunId: regressionJobCheckRunId,
      commitSha: liveCommitSha,
      runId: regressionRunId,
    });
    const claims = oidcClaims("bootstrap-applier", RAW_APPLY_TOKEN, run, {
      checkRunId: regressionJobCheckRunId,
    });

    assert.doesNotThrow(() =>
      verifyOidcClaims(
        claims,
        "bootstrap-applier",
        INFRASTRUCTURE_INITIAL_STATE_DISPATCHER_PATH,
        job,
        run,
        POLICY,
        sha256Bytes(RAW_APPLY_TOKEN),
      ),
    );
    for (const override of [
      {
        workflowRef: `${SWITCHYARD_REPOSITORY}/${INFRASTRUCTURE_INITIAL_STATE_DISPATCHER_PATH}@${liveCommitSha}`,
      },
      {
        workflowRef: `${SWITCHYARD_REPOSITORY}/${INFRASTRUCTURE_INITIAL_STATE_DISPATCHER_PATH}@main`,
      },
      { workflowSha: "d".repeat(40) },
    ]) {
      assert.throws(
        () =>
          verifyOidcClaims(
            { ...claims, ...override },
            "bootstrap-applier",
            INFRASTRUCTURE_INITIAL_STATE_DISPATCHER_PATH,
            job,
            run,
            POLICY,
            sha256Bytes(RAW_APPLY_TOKEN),
          ),
        InfrastructureApprovalError,
      );
    }
  });

  for (const [name, override] of [
    ["actor", { actorId: "1" }],
    ["triggering actor", { triggeringActorId: "1" }],
    ["repository", { repositoryId: "1" }],
    ["owner", { repositoryOwnerId: "1" }],
    ["branch", { ref: "refs/heads/feature" }],
    ["event", { eventName: "push" }],
    ["rerun", { runAttempt: 2 }],
    [
      "workflow ref",
      {
        workflowRef:
          "example-org/switchyard/.github/workflows/infrastructure-apply.yml@refs/heads/feature",
      },
    ],
  ] as const) {
    it(`rejects the wrong API ${name}`, () => {
      const evidence = runEvidence("apply", override);
      assert.throws(
        () =>
          verifyRunEvidence(evidence, {
            commitSha: COMMIT_SHA,
            runId: evidence.runId,
            workflowPath: ".github/workflows/infrastructure-apply.yml",
          }),
        InfrastructureApprovalError,
      );
    });
  }

  for (const [name, refs] of [
    [
      "old SHA",
      [
        `example-org/switchyard/.github/workflows/infrastructure-apply-engine.yml@${"d".repeat(40)}`,
      ],
    ],
    ["wrong workflow", [`example-org/switchyard/.github/workflows/other.yml@${APPLY_ENGINE_SHA}`]],
    [
      "duplicate",
      [
        `example-org/switchyard/.github/workflows/infrastructure-apply-engine.yml@${APPLY_ENGINE_SHA}`,
        `example-org/switchyard/.github/workflows/infrastructure-apply-engine.yml@${APPLY_ENGINE_SHA}`,
      ],
    ],
    [
      "mutable ref",
      ["example-org/switchyard/.github/workflows/infrastructure-apply-engine.yml@refs/heads/main"],
    ],
  ] as const) {
    it(`rejects ${name} referenced workflow provenance`, () => {
      assert.throws(() =>
        verifyReferencedWorkflow(
          runEvidence("apply", { referencedWorkflows: refs }),
          APPLY_ENGINE_SHA,
          "apply",
        ),
      );
    });
  }

  for (const [name, override] of [
    ["actor ID", { actorId: "1" }],
    ["audience", { audience: "api://wrong" }],
    ["job check", { checkRunId: "999" }],
    ["branch", { ref: "refs/heads/feature" }],
    ["run", { runId: "999" }],
    ["attempt", { runAttempt: 2 }],
    [
      "caller",
      {
        workflowRef: "example-org/switchyard/.github/workflows/other.yml@refs/heads/main",
      },
    ],
    [
      "engine SHA",
      {
        jobWorkflowRef: `example-org/switchyard/.github/workflows/infrastructure-apply-engine.yml@${"d".repeat(40)}`,
      },
    ],
    ["subject", { subject: "repo:wrong" }],
    ["token digest", { tokenDigest: "f".repeat(64) }],
  ] as const) {
    it(`rejects cryptographically parsed claims with wrong ${name}`, () => {
      assert.throws(
        () =>
          verifyOidcClaims(
            oidcClaims("foundation-applier", RAW_APPLY_TOKEN, runEvidence("apply"), override),
            "foundation-applier",
            FUTURE_APPLY_DISPATCHER_PATH,
            jobEvidence("apply"),
            runEvidence("apply"),
            POLICY,
            sha256Bytes(RAW_APPLY_TOKEN),
          ),
        InfrastructureApprovalError,
      );
    });
  }

  it("rejects a forged normalised DTO field even alongside otherwise valid claims", () => {
    const claims = { ...oidcClaims("foundation-applier", RAW_APPLY_TOKEN), forged: true };
    assert.throws(() =>
      verifyOidcClaims(
        claims,
        "foundation-applier",
        FUTURE_APPLY_DISPATCHER_PATH,
        jobEvidence("apply"),
        runEvidence("apply"),
        POLICY,
        sha256Bytes(RAW_APPLY_TOKEN),
      ),
    );
  });

  it("binds the Entra session to the digest of the same token and rejects ambient credentials", () => {
    assert.doesNotThrow(() =>
      verifyIdentitySession(
        identitySession("foundation-applier", RAW_APPLY_TOKEN),
        "foundation-applier",
        POLICY,
        sha256Bytes(RAW_APPLY_TOKEN),
      ),
    );
    for (const session of [
      identitySession("foundation-applier", RAW_APPLY_TOKEN, { assertionDigest: "f".repeat(64) }),
      identitySession("foundation-applier", RAW_APPLY_TOKEN, { audience: "api://wrong" }),
      identitySession("foundation-applier", RAW_APPLY_TOKEN, { identity: "bootstrap-applier" }),
      { ...identitySession("foundation-applier", RAW_APPLY_TOKEN), ambientCredentialsUsed: true },
    ]) {
      assert.throws(() =>
        verifyIdentitySession(
          session as ReturnType<typeof identitySession>,
          "foundation-applier",
          POLICY,
          sha256Bytes(RAW_APPLY_TOKEN),
        ),
      );
    }
  });

  it("parses only exact duplicate-free bounded approval inputs", () => {
    const valid = JSON.stringify({
      plan_run_id: "101",
      artifact_id: "303",
      commit_sha: COMMIT_SHA,
      plan_digest: "d".repeat(64),
      destructive_acknowledgement: "",
    });
    assert.equal(parseApprovalInputs(valid).artifactId, "303");
    for (const source of [
      valid.replace(/}$/, ',"unknown":true}'),
      valid.replace('"artifact_id":"303"', '"artifact_id":"303","artifact_id":"304"'),
      valid.replace('"plan_digest":"', '"plan_digest":"D'),
      `${" ".repeat(8 * 1_024)}${valid}`,
      "{",
    ])
      assert.throws(() => parseApprovalInputs(source));
  });
});
