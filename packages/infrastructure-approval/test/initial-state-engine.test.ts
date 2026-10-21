import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InfrastructureInitialStateEngine } from "../src/index.js";
import {
  ACTIVATION_BYTES,
  APPLY_ENGINE_SHA,
  APPLY_JOB_CHECK_RUN_ID,
  APPROVAL_RUN_ID,
  COMMIT_SHA,
  identitySession,
  initialStateRunEvidence,
  oidcClaims,
  POLICY,
  RAW_APPLY_TOKEN,
  REQUIRED_OIDC_SETTINGS,
  runEvidence,
  stateIdentity,
} from "./fixtures.js";

describe("one-time initial state engine", () => {
  it("selects only the bootstrap identity after immutable evidence succeeds", async () => {
    const calls: string[] = [];
    const run = initialStateRunEvidence();
    const engine = new InfrastructureInitialStateEngine(
      POLICY,
      githubEvidence(calls),
      {
        async requestToken({ audience }) {
          calls.push("request-token");
          assert.equal(audience, POLICY.bootstrapAudience);
          return Uint8Array.from(RAW_APPLY_TOKEN);
        },
      },
      {
        async verifyCryptographically(rawToken) {
          calls.push("verify-token");
          return oidcClaims("bootstrap-applier", rawToken, run);
        },
      },
      {
        async exchangeExactToken(input) {
          calls.push("exchange");
          assert.equal(input.identity, "bootstrap-applier");
          assert.equal(input.clientId, POLICY.bootstrapIdentityClientId);
          return identitySession("bootstrap-applier", input.rawToken);
        },
      },
      {
        async initialise(session) {
          calls.push("initialise");
          assert.equal(session.identity, "bootstrap-applier");
          return { identity: stateIdentity("bootstrap"), recordEtag: '"record-etag"' };
        },
      },
    );
    const result = await engine.initialise(validRequest());
    assert.equal(result.status, "initialised");
    assert.equal(result.serial, 0);
    assert.deepEqual(calls, [
      "run",
      "main",
      "settings",
      "job",
      "activation",
      "request-token",
      "verify-token",
      "exchange",
      "initialise",
    ]);
  });

  it("rejects the old commit-pinned caller ref before Entra exchange or Azure state", async () => {
    const calls: string[] = [];
    const run = initialStateRunEvidence();
    const engine = new InfrastructureInitialStateEngine(
      POLICY,
      githubEvidence(calls, { run }),
      {
        async requestToken() {
          calls.push("request-token");
          return Uint8Array.from(RAW_APPLY_TOKEN);
        },
      },
      {
        async verifyCryptographically(raw) {
          calls.push("verify-token");
          return oidcClaims("bootstrap-applier", raw, run, {
            workflowRef: `example-org/switchyard/.github/workflows/infrastructure-initialise-state.yml@${COMMIT_SHA}`,
          });
        },
      },
      {
        async exchangeExactToken(input) {
          calls.push("exchange");
          return identitySession("bootstrap-applier", input.rawToken);
        },
      },
      {
        async initialise() {
          calls.push("initialise");
          return { identity: stateIdentity("bootstrap"), recordEtag: '"record-etag"' };
        },
      },
    );

    await assert.rejects(
      () => engine.initialise(validRequest()),
      (error: unknown) => error instanceof Error && error.message === "oidc-workflow-ref-mismatch",
    );
    assert.equal(calls.includes("exchange"), false);
    assert.equal(calls.includes("initialise"), false);
  });

  it("does not request a token for caller, main, attempt, actor, activation or OIDC drift", async () => {
    for (const overrides of [
      { run: runEvidence("apply") },
      { main: "d".repeat(40) },
      { run: initialStateRunEvidence({ runAttempt: 2 }) },
      { run: initialStateRunEvidence({ triggeringActorId: "1" }) },
      { activation: new TextEncoder().encode("{}\n") },
      { oidcSettings: { ...REQUIRED_OIDC_SETTINGS, useDefault: true } },
    ]) {
      const calls: string[] = [];
      const engine = new InfrastructureInitialStateEngine(
        POLICY,
        githubEvidence(calls, overrides),
        {
          async requestToken() {
            calls.push("request-token");
            return Uint8Array.from(RAW_APPLY_TOKEN);
          },
        },
        {
          async verifyCryptographically(raw) {
            return oidcClaims("bootstrap-applier", raw);
          },
        },
        {
          async exchangeExactToken(input) {
            return identitySession("bootstrap-applier", input.rawToken);
          },
        },
        {
          async initialise() {
            throw new Error("must-not-run");
          },
        },
      );
      await assert.rejects(() => engine.initialise(validRequest()));
      assert.equal(calls.includes("request-token"), false);
    }
  });

  it("rejects public raw token fields before evidence or storage", async () => {
    const calls: string[] = [];
    const engine = new InfrastructureInitialStateEngine(
      POLICY,
      githubEvidence(calls),
      {
        async requestToken() {
          return Uint8Array.from(RAW_APPLY_TOKEN);
        },
      },
      {
        async verifyCryptographically(raw) {
          return oidcClaims("bootstrap-applier", raw);
        },
      },
      {
        async exchangeExactToken(input) {
          return identitySession("bootstrap-applier", input.rawToken);
        },
      },
      {
        async initialise() {
          return { identity: stateIdentity("bootstrap"), recordEtag: '"record"' };
        },
      },
    );
    await assert.rejects(() =>
      engine.initialise({ ...validRequest(), githubOidcToken: RAW_APPLY_TOKEN } as ReturnType<
        typeof validRequest
      >),
    );
    assert.deepEqual(calls, []);
  });

  it("classifies unexpected identity failures by bounded stage before Azure work", async () => {
    for (const [expectedCode, verifierFailure, exchangeFailure] of [
      ["identity-oidc-verification-unexpected", true, false],
      ["identity-entra-exchange-unexpected", false, true],
    ] as const) {
      const calls: string[] = [];
      const run = initialStateRunEvidence();
      const engine = new InfrastructureInitialStateEngine(
        POLICY,
        githubEvidence(calls),
        {
          async requestToken() {
            calls.push("request-token");
            return Uint8Array.from(RAW_APPLY_TOKEN);
          },
        },
        {
          async verifyCryptographically(raw) {
            calls.push("verify-token");
            if (verifierFailure) throw new Error("untrusted verifier detail");
            return oidcClaims("bootstrap-applier", raw, run);
          },
        },
        {
          async exchangeExactToken(input) {
            calls.push("exchange");
            if (exchangeFailure) throw new Error("untrusted Entra detail");
            return identitySession("bootstrap-applier", input.rawToken);
          },
        },
        {
          async initialise() {
            calls.push("initialise");
            return { identity: stateIdentity("bootstrap"), recordEtag: '"record-etag"' };
          },
        },
      );

      await assert.rejects(
        () => engine.initialise(validRequest()),
        (error: unknown) =>
          error instanceof Error &&
          error.message === expectedCode &&
          !error.message.includes("untrusted"),
      );
      assert.equal(calls.includes("initialise"), false);
    }
  });
});

function validRequest() {
  return {
    commitSha: COMMIT_SHA,
    jobCheckRunId: APPLY_JOB_CHECK_RUN_ID,
    jobWorkflowSha: APPLY_ENGINE_SHA,
    runId: APPROVAL_RUN_ID,
  };
}

function githubEvidence(
  calls: string[],
  overrides: {
    readonly activation?: Uint8Array;
    readonly main?: string;
    readonly oidcSettings?: typeof REQUIRED_OIDC_SETTINGS;
    readonly run?: ReturnType<typeof runEvidence>;
  } = {},
) {
  return {
    async getActivationConfiguration() {
      calls.push("activation");
      return overrides.activation ?? ACTIVATION_BYTES;
    },
    async getCurrentMainSha() {
      calls.push("main");
      return overrides.main ?? COMMIT_SHA;
    },
    async getJob() {
      calls.push("job");
      return {
        checkRunId: APPLY_JOB_CHECK_RUN_ID,
        commitSha: COMMIT_SHA,
        jobId: "808",
        name: "initialise",
        runAttempt: 1,
        runId: APPROVAL_RUN_ID,
        status: "in_progress" as const,
        workflowName: "Infrastructure apply",
      };
    },
    async getOidcSettings() {
      calls.push("settings");
      return overrides.oidcSettings ?? REQUIRED_OIDC_SETTINGS;
    },
    async getRun() {
      calls.push("run");
      return overrides.run ?? initialStateRunEvidence();
    },
  };
}
