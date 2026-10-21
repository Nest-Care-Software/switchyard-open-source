import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildCanonicalZip,
  type FixedOpenTofuPlanPort,
  type GitHubOidcEntraExchangePort,
  type GitHubOidcTokenRequestPort,
  type GitHubOidcTokenVerifierPort,
  InfrastructurePlanEngine,
  type PlanArchiveBuilderPort,
  type PlanBundlePublicationPort,
  sha256Bytes,
} from "../src/index.js";
import {
  ACTIVATION_BYTES,
  activePlanRun,
  bytes,
  COMMIT_SHA,
  identitySession,
  MANIFEST_CREATED_AT,
  oidcClaims,
  PLAN_ENGINE_SHA,
  PLAN_JOB_CHECK_RUN_ID,
  PLAN_RUN_ID,
  planJson,
  POLICY,
  RAW_APPLY_TOKEN,
  RAW_PLAN_TOKEN,
  REQUIRED_OIDC_SETTINGS,
  stateIdentity,
  TARGET_CONFIGURATION_DIGEST,
} from "./fixtures.js";

describe("infrastructure plan engine runtime", () => {
  it("validates immutable GitHub evidence before requesting the exact planner token", async () => {
    const harness = makeHarness();
    const result = await harness.engine.createBundle(validRequest());
    assert.equal(result.planDigest, sha256Bytes(harness.savedPlan));
    assert.equal(result.artifactName, `switchyard-infrastructure-plan-${result.planDigest}`);
    assert.deepEqual(harness.calls, [
      "run",
      "main",
      "settings",
      "job",
      "activation",
      "target-digest",
      "request-token",
      "verify-token",
      "exchange",
      "state-before",
      "create-plan",
      "state-after",
      "render",
      "archive",
      "publish",
    ]);
    assert.equal(harness.requestedAudience, POLICY.plannerAudience);
    assert.deepEqual(harness.plannerInput?.expectedState, stateIdentity());
    assert.deepEqual(harness.plannerInput?.command, [
      "tofu",
      "plan",
      "-input=false",
      "-lock=false",
      "-no-color",
      "-out=saved-plan",
    ]);
  });

  for (const [name, options] of [
    ["wrong actor", { runOverride: { actorId: "1" } }],
    ["wrong triggering actor", { runOverride: { triggeringActorId: "1" } }],
    ["rerun", { runOverride: { runAttempt: 2 } }],
    ["moved main", { mainSha: "d".repeat(40) }],
    ["OIDC settings drift", { oidcSettings: { ...REQUIRED_OIDC_SETTINGS, useDefault: true } }],
    ["wrong job check", { jobOverride: { checkRunId: "999" } }],
    ["committed activation drift", { activationBytes: bytes("{}\n") }],
  ] as const) {
    it(`does not request a token when ${name} is observed`, async () => {
      const harness = makeHarness(options);
      await assert.rejects(() => harness.engine.createBundle(validRequest()));
      assert.equal(harness.calls.includes("request-token"), false);
      assert.equal(harness.calls.includes("create-plan"), false);
    });
  }

  it("rejects wrong audience, identity and job workflow SHA before Entra exchange", async () => {
    for (const claimsOverride of [
      { audience: "api://wrong" },
      { subject: "repo:wrong" },
      { jobWorkflowSha: "d".repeat(40) },
      {
        jobWorkflowRef:
          "example-org/switchyard/.github/workflows/infrastructure-plan-engine.yml@" +
          "d".repeat(40),
      },
    ]) {
      const harness = makeHarness({ claimsOverride });
      await assert.rejects(() => harness.engine.createBundle(validRequest()));
      assert.equal(harness.calls.includes("exchange"), false);
    }
  });

  it("detects token bytes changed by the verifier before exchange", async () => {
    const harness = makeHarness({ mutateTokenDuringVerification: true });
    await assert.rejects(() => harness.engine.createBundle(validRequest()), /oidc-token-mutated/);
    assert.equal(harness.calls.includes("exchange"), false);
  });

  it("detects an Entra session created from different assertion bytes", async () => {
    const harness = makeHarness({
      sessionOverride: { assertionDigest: sha256Bytes(RAW_APPLY_TOKEN) },
    });
    await assert.rejects(
      () => harness.engine.createBundle(validRequest()),
      /identity-session-authority-mismatch/,
    );
    assert.equal(harness.calls.includes("create-plan"), false);
  });

  it("fails closed when state changes around the unlocked plan", async () => {
    const harness = makeHarness({
      stateAfter: stateIdentity("foundation", { backendStateEtag: '"changed"' }),
    });
    await assert.rejects(
      () => harness.engine.createBundle(validRequest()),
      /state-changed-during-unlocked-plan/,
    );
    assert.equal(harness.calls.includes("publish"), false);
  });

  it("rejects raw token material and normalised OIDC evidence in public requests", async () => {
    for (const extra of [
      { githubOidcToken: RAW_PLAN_TOKEN },
      { oidc: oidcClaims("planner", RAW_PLAN_TOKEN) },
    ]) {
      const harness = makeHarness();
      await assert.rejects(() =>
        harness.engine.createBundle({ ...validRequest(), ...extra } as ReturnType<
          typeof validRequest
        >),
      );
      assert.deepEqual(harness.calls, []);
    }
  });

  it("self-decodes the deterministic archive and rejects builder substitution", async () => {
    const harness = makeHarness({ substituteArchiveEntry: true });
    await assert.rejects(() => harness.engine.createBundle(validRequest()));
    assert.equal(harness.calls.includes("publish"), false);
  });
});

function validRequest() {
  return {
    authorityClass: "foundation" as const,
    commitSha: COMMIT_SHA,
    jobCheckRunId: PLAN_JOB_CHECK_RUN_ID,
    jobWorkflowSha: PLAN_ENGINE_SHA,
    runId: PLAN_RUN_ID,
  };
}

function makeHarness(
  options: {
    readonly activationBytes?: Uint8Array;
    readonly claimsOverride?: Record<string, unknown>;
    readonly jobOverride?: Record<string, unknown>;
    readonly mainSha?: string;
    readonly mutateTokenDuringVerification?: boolean;
    readonly oidcSettings?: typeof REQUIRED_OIDC_SETTINGS;
    readonly runOverride?: Record<string, unknown>;
    readonly sessionOverride?: Record<string, unknown>;
    readonly stateAfter?: ReturnType<typeof stateIdentity>;
    readonly substituteArchiveEntry?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const savedPlan = bytes("one exact opaque saved plan");
  const json = planJson();
  const text = bytes("reviewed no-colour plan\n");
  const sourceState = stateIdentity();
  const run = activePlanRun(options.runOverride);
  let plannerInput: Parameters<FixedOpenTofuPlanPort["createSavedPlan"]>[0] | undefined;
  let requestedAudience: string | undefined;
  const github = {
    async getActivationConfiguration() {
      calls.push("activation");
      return options.activationBytes ?? ACTIVATION_BYTES;
    },
    async getCurrentMainSha() {
      calls.push("main");
      return options.mainSha ?? COMMIT_SHA;
    },
    async getJob() {
      calls.push("job");
      return {
        checkRunId: PLAN_JOB_CHECK_RUN_ID,
        commitSha: COMMIT_SHA,
        jobId: "606",
        name: "plan",
        runAttempt: 1,
        runId: PLAN_RUN_ID,
        status: "in_progress" as const,
        workflowName: "Infrastructure plan",
        ...options.jobOverride,
      };
    },
    async getOidcSettings() {
      calls.push("settings");
      return options.oidcSettings ?? REQUIRED_OIDC_SETTINGS;
    },
    async getRun() {
      calls.push("run");
      return run;
    },
  };
  const requester: GitHubOidcTokenRequestPort = {
    async requestToken(input) {
      calls.push("request-token");
      requestedAudience = input.audience;
      return Uint8Array.from(RAW_PLAN_TOKEN);
    },
  };
  const tokens: GitHubOidcTokenVerifierPort = {
    async verifyCryptographically(rawToken) {
      calls.push("verify-token");
      assert.deepEqual(rawToken, RAW_PLAN_TOKEN);
      const claims = oidcClaims("planner", RAW_PLAN_TOKEN, run, options.claimsOverride);
      if (options.mutateTokenDuringVerification) rawToken[0] = (rawToken[0] ?? 0) ^ 1;
      return claims;
    },
  };
  const entra: GitHubOidcEntraExchangePort = {
    async exchangeExactToken(input) {
      calls.push("exchange");
      assert.deepEqual(input.rawToken, RAW_PLAN_TOKEN);
      return identitySession("planner", RAW_PLAN_TOKEN, options.sessionOverride);
    },
  };
  const planner: FixedOpenTofuPlanPort = {
    async getTargetConfigurationDigest() {
      calls.push("target-digest");
      return TARGET_CONFIGURATION_DIGEST;
    },
    async createSavedPlan(input) {
      calls.push("create-plan");
      plannerInput = input;
      return { savedPlan, savedPlanDigest: sha256Bytes(savedPlan) };
    },
    async renderSavedPlan(input) {
      calls.push("render");
      assert.deepEqual(input.savedPlan, savedPlan);
      return {
        planJson: json,
        planText: text,
        renderedSavedPlanDigest: sha256Bytes(savedPlan),
      };
    },
  };
  let stateRead = 0;
  const state = {
    async readIdentity() {
      calls.push(stateRead++ === 0 ? "state-before" : "state-after");
      return stateRead === 1 ? sourceState : (options.stateAfter ?? sourceState);
    },
  };
  const archives: PlanArchiveBuilderPort = {
    async build(entries) {
      calls.push("archive");
      const actual = options.substituteArchiveEntry
        ? entries.map((entry) =>
            entry.path === "plan.txt" ? { ...entry, contents: bytes("substitution") } : entry,
          )
        : entries;
      return buildCanonicalZip(actual);
    },
  };
  const publisher: PlanBundlePublicationPort = {
    async publishLocalArtifact(input) {
      calls.push("publish");
      return {
        artifactName: input.artifact.name,
        artifactPath: "/tmp/switchyard-plan-publication/switchyard-plan-bundle.zip",
        byteLength: input.archiveBytes.byteLength,
        fileName: input.artifact.fileName,
        retentionDays: input.artifact.retentionDays,
        sha256: sha256Bytes(input.archiveBytes),
      };
    },
  };
  return {
    calls,
    engine: new InfrastructurePlanEngine(
      POLICY,
      github,
      requester,
      tokens,
      entra,
      planner,
      state,
      archives,
      publisher,
      () => new Date(MANIFEST_CREATED_AT),
    ),
    get plannerInput() {
      return plannerInput;
    },
    get requestedAudience() {
      return requestedAudience;
    },
    savedPlan,
  };
}
