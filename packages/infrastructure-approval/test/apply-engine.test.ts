import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type ApplyIntentReceipt,
  assertExactSavedPlanApplyCommand,
  EXACT_SAVED_PLAN_APPLY_COMMAND,
  INFRASTRUCTURE_APPLY_CONCURRENCY_GROUP,
  InfrastructureApplyEngine,
  sha256Bytes,
  sha256Text,
  verifyPlanArchive,
} from "../src/index.js";
import {
  ACTIVATION_BYTES,
  APPLY_ENGINE_SHA,
  APPLY_JOB_CHECK_RUN_ID,
  APPROVAL_RUN_ID,
  ARTIFACT_CREATED_AT,
  ARTIFACT_EXPIRES_AT,
  ARTIFACT_ID,
  bytes,
  COMMIT_SHA,
  identitySession,
  makeBundleFixture,
  NOW,
  oidcClaims,
  PLAN_RUN_ID,
  POLICY,
  PUBLISHED_AT,
  RAW_APPLY_TOKEN,
  RAW_PLAN_TOKEN,
  REQUIRED_OIDC_SETTINGS,
  runEvidence,
  stateIdentity,
  TARGET_CONFIGURATION_DIGEST,
} from "./fixtures.js";

describe("production-disabled apply engine", () => {
  it("verifies GitHub evidence before exchange, then uses that explicit session for every private Azure operation and applies once", async () => {
    const harness = await makeHarness();
    const result = await harness.engine.apply(harness.request);
    assert.equal(result.status, "completed");
    assert.equal(result.replayed, false);
    assert.equal(harness.applies, 1);
    assert.deepEqual(harness.appliedSavedPlan, harness.fixture.savedPlan);
    assert.ok(harness.calls.indexOf("render") < harness.calls.indexOf("verify-token"));
    assert.ok(harness.calls.indexOf("exchange") < harness.calls.indexOf("download-receipt"));
    assert.ok(harness.calls.indexOf("exchange") < harness.calls.indexOf("state-after-login"));
    assert.ok(harness.calls.indexOf("exchange") < harness.calls.indexOf("read-intent"));
    assert.ok(harness.calls.indexOf("create-intent") < harness.calls.indexOf("apply"));
    assert.ok(harness.calls.lastIndexOf("state-under-lease") < harness.calls.indexOf("apply"));
    assert.ok(harness.azureSessions.every((session) => session === harness.session));
    assert.equal(harness.leaseKey, INFRASTRUCTURE_APPLY_CONCURRENCY_GROUP);
    assert.equal(
      (EXACT_SAVED_PLAN_APPLY_COMMAND as readonly string[]).includes("-lock=false"),
      false,
    );
  });

  for (const [name, runOverride] of [
    ["wrong actor", { actorId: "1" }],
    ["wrong triggering actor", { triggeringActorId: "1" }],
    ["wrong repository", { repositoryId: "1" }],
    ["wrong branch", { ref: "refs/heads/feature" }],
    ["wrong event", { eventName: "push" }],
    ["rerun", { runAttempt: 2 }],
    [
      "wrong apply engine SHA",
      {
        referencedWorkflows: [
          `example-org/switchyard/.github/workflows/infrastructure-apply-engine.yml@${"d".repeat(40)}`,
        ],
      },
    ],
    [
      "duplicate apply engine",
      {
        referencedWorkflows: [
          `example-org/switchyard/.github/workflows/infrastructure-apply-engine.yml@${APPLY_ENGINE_SHA}`,
          `example-org/switchyard/.github/workflows/infrastructure-apply-engine.yml@${APPLY_ENGINE_SHA}`,
        ],
      },
    ],
  ] as const) {
    it(`rejects approval ${name} before bundle/state/login/apply effects`, async () => {
      const harness = await makeHarness({ approvalRunOverride: runOverride });
      await assert.rejects(() => harness.engine.apply(harness.request));
      assert.equal(harness.calls.includes("download-artifact"), false);
      assert.equal(harness.applies, 0);
    });
  }

  it("rejects old, duplicate and mutable plan reusable workflow evidence", async () => {
    for (const referencedWorkflows of [
      [`example-org/switchyard/.github/workflows/infrastructure-plan-engine.yml@${"d".repeat(40)}`],
      [
        `example-org/switchyard/.github/workflows/infrastructure-plan-engine.yml@${"b".repeat(40)}`,
        `example-org/switchyard/.github/workflows/infrastructure-plan-engine.yml@${"b".repeat(40)}`,
      ],
      ["example-org/switchyard/.github/workflows/infrastructure-plan-engine.yml@refs/heads/main"],
    ]) {
      const harness = await makeHarness({ planRunOverride: { referencedWorkflows } });
      await assert.rejects(
        () => harness.engine.apply(harness.request),
        /plan-engine-provenance-mismatch/,
      );
      assert.equal(harness.applies, 0);
    }
  });

  it("rejects a substituted GitHub artefact before exchange and substituted private receipts after exchange", async () => {
    const valid = makeBundleFixture();
    const artifact = await makeHarness({ artifactBytes: mutate(valid.archive, 40) });
    await assert.rejects(() => artifact.engine.apply(artifact.request));
    assert.equal(artifact.calls.includes("exchange"), false);
    for (const options of [
      { receiptBytes: bytes("different receipt bytes") },
      { receiptDigest: "f".repeat(64) },
    ]) {
      const receipt = await makeHarness(options);
      await assert.rejects(() => receipt.engine.apply(receipt.request));
      assert.equal(receipt.calls.includes("exchange"), true);
      assert.equal(receipt.calls.includes("state-after-login"), false);
      assert.equal(receipt.applies, 0);
    }
  });

  it("rejects swapped benign JSON/text and a different saved plan before token, state, login, intent or apply", async () => {
    for (const renderOverride of [
      { planJson: bytes('{"format_version":"1.2","prior_state":{},"resource_changes":[]}') },
      { planText: bytes("another benign plan view\n") },
      { renderedSavedPlanDigest: sha256Bytes(bytes("other saved plan")) },
    ]) {
      const harness = await makeHarness({ renderOverride });
      await assert.rejects(() => harness.engine.apply(harness.request));
      assert.deepEqual(harness.calls.filter(isSensitiveEffect), []);
      assert.equal(harness.applies, 0);
    }
  });

  it("binds API run A to token run/attempt/caller B before state/login/apply", async () => {
    for (const claimsOverride of [
      { runId: "999" },
      { runAttempt: 2 },
      {
        workflowRef: "example-org/switchyard/.github/workflows/other.yml@refs/heads/main",
      },
      { audience: "api://wrong" },
      { subject: "repo:wrong" },
      {
        jobWorkflowRef: `example-org/switchyard/.github/workflows/infrastructure-apply-engine.yml@${"d".repeat(40)}`,
      },
    ]) {
      const harness = await makeHarness({ claimsOverride });
      await assert.rejects(() => harness.engine.apply(harness.request));
      assert.equal(harness.calls.includes("state-after-login"), false);
      assert.equal(harness.calls.includes("exchange"), false);
      assert.equal(harness.applies, 0);
    }
  });

  it("rejects a forged DTO request and missing token before all ports", async () => {
    for (const requestOverride of [
      { oidc: oidcClaims("foundation-applier", RAW_APPLY_TOKEN) },
      { githubOidcToken: new Uint8Array() },
    ]) {
      const harness = await makeHarness({ requestOverride });
      await assert.rejects(() => harness.engine.apply(harness.request));
      assert.deepEqual(harness.calls, []);
    }
  });

  it("rejects an Entra exchange using another token or wrong identity tuple before lease/intent/apply", async () => {
    for (const sessionOverride of [
      { assertionDigest: sha256Bytes(RAW_PLAN_TOKEN) },
      { identity: "bootstrap-applier" },
      { audience: "api://wrong" },
      { subject: "repo:wrong" },
      { ambientCredentialsUsed: true },
    ]) {
      const harness = await makeHarness({ sessionOverride });
      await assert.rejects(
        () => harness.engine.apply(harness.request),
        /identity-session-authority-mismatch/,
      );
      assert.equal(harness.calls.includes("lease"), false);
      assert.equal(harness.calls.includes("create-intent"), false);
    }
  });

  it("rejects an Entra session without its explicit credential before every private Azure port", async () => {
    const harness = await makeHarness({ sessionOverride: { credential: null } });
    await assert.rejects(
      () => harness.engine.apply(harness.request),
      /identity-session-credential-missing/,
    );
    assert.equal(harness.calls.includes("download-receipt"), false);
    assert.equal(harness.calls.includes("state-after-login"), false);
    assert.equal(harness.calls.includes("lease"), false);
  });

  it("rejects wrong backend state digest/count, subscription and backend before apply", async () => {
    for (const options of [
      { stateBefore: stateIdentity("foundation", { backendStateDigest: "f".repeat(64) }) },
      {
        stateBefore: stateIdentity("foundation", {
          managedResourceCount: 2,
          managedResourcesEmpty: false,
        }),
      },
      { policyOverride: { subscriptionId: "other-subscription" } },
      { policyOverride: { backend: { ...POLICY.backend, key: "other.tfstate" } } },
    ]) {
      const harness = await makeHarness(options);
      await assert.rejects(() => harness.engine.apply(harness.request));
      assert.equal(harness.applies, 0);
    }
  });

  it("rejects moved main, stale/expired plans and expired/deleted artifacts", async () => {
    for (const options of [
      { mainSequence: ["d".repeat(40)] },
      { approvalRunOverride: { createdAt: "2026-08-25T11:00:00.000Z" } },
      { artifactOverride: { expired: true } },
      { artifactOverride: { present: false } },
      { artifactOverride: { expiresAt: "2026-08-25T12:04:00.000Z" } },
    ]) {
      const harness = await makeHarness(options);
      await assert.rejects(() => harness.engine.apply(harness.request));
      assert.equal(harness.applies, 0);
    }
  });

  it("binds GitHub expiry to the signed manifest when artifact publication takes time", async () => {
    const harness = await makeHarness({
      artifactOverride: {
        createdAt: "2026-08-25T12:00:02.000Z",
        expiresAt: "2026-08-26T11:59:59.000Z",
        publishedAt: "2026-08-25T12:00:02.000Z",
      },
    });
    const result = await harness.engine.apply(harness.request);
    assert.equal(result.status, "completed");
    assert.equal(harness.applies, 1);
  });

  it("enforces plan/publication/approval chronology and terminal-success evidence", async () => {
    for (const options of [
      { planRunOverride: { status: "in_progress", conclusion: null, completedAt: null } },
      { planRunOverride: { conclusion: "failure" } },
      { approvalRunOverride: { createdAt: PUBLISHED_AT } },
      { artifactOverride: { publishedAt: "2026-08-25T12:01:00.000Z" } },
      { receiptOverride: { publishedAt: "2026-08-25T12:06:00.000Z" } },
      {
        artifactOverride: {
          createdAt: "2026-08-25T11:59:58.999Z",
          expiresAt: "2026-08-26T11:59:58.999Z",
        },
      },
      {
        artifactOverride: {
          createdAt: "2026-08-25T12:00:00.000Z",
          expiresAt: "2026-08-26T11:59:58.999Z",
        },
      },
      { artifactOverride: { expiresAt: "2026-08-26T12:00:00.001Z" } },
      { artifactOverride: { publishedAt: "2026-08-25T12:06:00.000Z" } },
    ]) {
      const harness = await makeHarness(options);
      await assert.rejects(() => harness.engine.apply(harness.request));
      assert.equal(harness.applies, 0);
    }
  });

  it("rejects a competing apply lease and a competing native state change", async () => {
    const lease = await makeHarness({ leaseFailure: true });
    await assert.rejects(() => lease.engine.apply(lease.request), /apply-lease-competing/);
    assert.equal(lease.calls.includes("create-intent"), false);
    const state = await makeHarness({
      stateUnderLease: stateIdentity("foundation", { serial: 8 }),
    });
    await assert.rejects(() => state.engine.apply(state.request), /state-changed-since-plan/);
    assert.equal(state.calls.includes("create-intent"), false);
  });

  for (const outcome of ["failed", "partial", "native-lock-failed", "stale-plan"] as const) {
    it(`records ${outcome} as terminal and never reapplies`, async () => {
      const harness = await makeHarness({ applyOutcome: outcome });
      await assert.rejects(
        () => harness.engine.apply(harness.request),
        new RegExp(`apply-${outcome}-replan-required`),
      );
      assert.equal(harness.intent?.status, outcome);
      await assert.rejects(
        () => harness.engine.apply(harness.request),
        new RegExp(`intent-${outcome}-requires-replan`),
      );
      assert.equal(harness.applies, 1);
    });
  }

  it("records a lost response as unknown and a durable partial outcome never double-applies", async () => {
    const harness = await makeHarness({ throwApply: true });
    await assert.rejects(() => harness.engine.apply(harness.request), /apply-result-unknown/);
    assert.equal(harness.intent?.status, "unknown");
    await assert.rejects(
      () => harness.engine.apply(harness.request),
      /intent-unknown-requires-replan/,
    );
    assert.equal(harness.applies, 1);
  });

  it("returns only a completed receipt retry after exact state proof", async () => {
    const harness = await makeHarness();
    const first = await harness.engine.apply(harness.request);
    const second = await harness.engine.apply(harness.request);
    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true);
    assert.equal(harness.applies, 1);
  });

  it("fails closed on an atomic intent race and never applies", async () => {
    const harness = await makeHarness({ intentRace: true });
    await assert.rejects(
      () => harness.engine.apply(harness.request),
      /intent-started-requires-replan/,
    );
    assert.equal(harness.applies, 0);
  });

  it("strands the started intent when main moves after intent creation", async () => {
    const harness = await makeHarness({ mainSequence: [COMMIT_SHA, COMMIT_SHA, "d".repeat(40)] });
    await assert.rejects(() => harness.engine.apply(harness.request), /main-moved/);
    assert.equal(harness.intent?.status, "started");
    assert.equal(harness.applies, 0);
    await assert.rejects(
      () => harness.engine.apply(harness.request),
      /intent-started-requires-replan|main-moved/,
    );
  });

  it("strands the started intent when state changes after chronology recheck and before apply capability", async () => {
    const harness = await makeHarness({
      stateFinal: stateIdentity("foundation", {
        backendStateDigest: "f".repeat(64),
        backendStateEtag: '"changed-after-intent"',
        serial: 8,
      }),
    });
    await assert.rejects(
      () => harness.engine.apply(harness.request),
      /state-changed-before-apply-capability/,
    );
    assert.equal(harness.intent?.status, "started");
    assert.equal(harness.applies, 0);
  });

  for (const [name, delayedNow, applies] of [
    ["just before", "2026-08-25T12:10:59.999Z", 1],
    ["exactly at", "2026-08-25T12:11:00.000Z", 1],
    ["just after", "2026-08-25T12:11:00.001Z", 0],
  ] as const) {
    it(`${name} the approval expiry boundary is checked after durable intent`, async () => {
      const harness = await makeHarness({ nowAfterIntent: new Date(delayedNow) });
      if (applies === 1) await harness.engine.apply(harness.request);
      else await assert.rejects(() => harness.engine.apply(harness.request), /approval-expired/);
      assert.equal(harness.intent?.status, applies === 1 ? "completed" : "started");
      assert.equal(harness.applies, applies);
    });
  }

  it("bootstrap requires its exact bootstrap token and cannot use the foundation identity", async () => {
    const harness = await makeHarness({
      authorityClass: "bootstrap",
      claimsIdentity: "foundation-applier",
    });
    await assert.rejects(() => harness.engine.apply(harness.request));
    assert.equal(harness.calls.includes("state-after-login"), false);
    assert.equal(harness.applies, 0);
  });

  it("accepts the bootstrap identity from the approved infrastructure apply caller", async () => {
    const harness = await makeHarness({ authorityClass: "bootstrap" });
    const result = await harness.engine.apply(harness.request);
    assert.equal(result.status, "completed");
    assert.equal(harness.applies, 1);
  });

  it("accepts only the exact saved-plan apply argv", () => {
    assert.doesNotThrow(() => assertExactSavedPlanApplyCommand(EXACT_SAVED_PLAN_APPLY_COMMAND));
    for (const command of [
      ["tofu", "apply", "-input=false", "-no-color"],
      [...EXACT_SAVED_PLAN_APPLY_COMMAND, "-target=x"],
      ["tofu", "destroy"],
      ["tofu", "apply", "-replace=x", "saved-plan"],
      ["tofu", "apply", "-lock=false", "saved-plan"],
    ])
      assert.throws(() => assertExactSavedPlanApplyCommand(command));
  });
});

type Identity = "bootstrap-applier" | "foundation-applier";

async function makeHarness(
  options: {
    readonly approvalRunOverride?: Record<string, unknown>;
    readonly applyOutcome?: "failed" | "native-lock-failed" | "partial" | "stale-plan";
    readonly artifactBytes?: Uint8Array;
    readonly artifactOverride?: Record<string, unknown>;
    readonly authorityClass?: "bootstrap" | "foundation";
    readonly claimsIdentity?: Identity;
    readonly claimsOverride?: Record<string, unknown>;
    readonly intentRace?: boolean;
    readonly leaseFailure?: boolean;
    readonly mainSequence?: readonly string[];
    readonly nowAfterIntent?: Date;
    readonly planRunOverride?: Record<string, unknown>;
    readonly policyOverride?: Record<string, unknown>;
    readonly receiptBytes?: Uint8Array;
    readonly receiptDigest?: string;
    readonly receiptOverride?: Record<string, unknown>;
    readonly renderOverride?: Record<string, unknown>;
    readonly requestOverride?: Record<string, unknown>;
    readonly sessionOverride?: Record<string, unknown>;
    readonly stateFinal?: ReturnType<typeof stateIdentity>;
    readonly stateBefore?: ReturnType<typeof stateIdentity>;
    readonly stateUnderLease?: ReturnType<typeof stateIdentity>;
    readonly throwApply?: boolean;
  } = {},
) {
  const authorityClass = options.authorityClass ?? "foundation";
  const expectedIdentity: Identity =
    authorityClass === "bootstrap" ? "bootstrap-applier" : "foundation-applier";
  const fixture = makeBundleFixture({ authorityClass });
  const verified = await verifyPlanArchive(fixture.archive);
  const calls: string[] = [];
  const azureSessions: unknown[] = [];
  let applies = 0;
  let intent: ApplyIntentReceipt | null = null;
  let mainIndex = 0;
  let mutableNow = NOW;
  let state = options.stateBefore ?? fixture.state;
  let appliedSavedPlan: Uint8Array | undefined;
  let leaseKey: string | undefined;
  const approvalRun = runEvidence("apply", options.approvalRunOverride);
  const planRun = runEvidence("plan", options.planRunOverride);
  const policy = deepMerge(POLICY, options.policyOverride);
  const artifactBytes = options.artifactBytes ?? fixture.archive;
  const receiptBytes = options.receiptBytes ?? artifactBytes;

  const github = {
    async getActivationConfiguration() {
      calls.push("activation");
      return ACTIVATION_BYTES;
    },
    async getCurrentMainSha() {
      calls.push("main");
      const sequence = options.mainSequence ?? [COMMIT_SHA];
      const main = sequence[Math.min(mainIndex++, sequence.length - 1)];
      if (main === undefined) throw new Error("empty-main-sequence-fixture");
      return main;
    },
    async getOidcSettings() {
      calls.push("settings");
      return REQUIRED_OIDC_SETTINGS;
    },
    async getJob() {
      calls.push("job");
      return {
        checkRunId: APPLY_JOB_CHECK_RUN_ID,
        commitSha: COMMIT_SHA,
        jobId: "707",
        name: "apply",
        runAttempt: 1,
        runId: APPROVAL_RUN_ID,
        status: "in_progress" as const,
        workflowName: "Infrastructure apply",
      };
    },
    async getRun(runId: string) {
      calls.push(`run-${runId}`);
      return runId === APPROVAL_RUN_ID ? approvalRun : planRun;
    },
  };
  const artifactBase = {
    artifactId: ARTIFACT_ID,
    bytes: artifactBytes,
    createdAt: ARTIFACT_CREATED_AT,
    expired: false,
    expiresAt: ARTIFACT_EXPIRES_AT,
    immutable: true,
    planRunId: PLAN_RUN_ID,
    present: true,
    publishedAt: PUBLISHED_AT,
  };
  const receiptBase = {
    bytes: receiptBytes,
    contentAddressedKey: `plans/${verified.planDigest}/${verified.archiveDigest}.zip`,
    created: true,
    createdAt: ARTIFACT_CREATED_AT,
    etag: '"receipt-etag"',
    publishedAt: PUBLISHED_AT,
    sha256: options.receiptDigest ?? sha256Bytes(receiptBytes),
  };
  const bundles = {
    async downloadArtifact() {
      calls.push("download-artifact");
      return deepMerge(artifactBase, options.artifactOverride);
    },
  };
  const receipts = {
    async ensurePrivateReceipt(input: { session: unknown }) {
      calls.push("download-receipt");
      azureSessions.push(input.session);
      return deepMerge(receiptBase, options.receiptOverride);
    },
  };
  const renderer = {
    async getTargetConfigurationDigest() {
      calls.push("target-digest");
      return TARGET_CONFIGURATION_DIGEST;
    },
    async renderSavedPlan(input: { savedPlan: Uint8Array }) {
      calls.push("render");
      assert.deepEqual(input.savedPlan, fixture.savedPlan);
      return deepMerge(
        {
          planJson: fixture.planJson,
          planText: fixture.planText,
          renderedSavedPlanDigest: sha256Bytes(fixture.savedPlan),
        },
        options.renderOverride,
      );
    },
  };
  const tokens = {
    async verifyCryptographically(rawToken: Uint8Array) {
      calls.push("verify-token");
      assert.deepEqual(rawToken, RAW_APPLY_TOKEN);
      return oidcClaims(
        options.claimsIdentity ?? expectedIdentity,
        RAW_APPLY_TOKEN,
        approvalRun,
        options.claimsOverride,
      );
    },
  };
  const tokenRequester = {
    async requestToken(input: { audience: string }) {
      calls.push("request-token");
      assert.equal(
        input.audience,
        authorityClass === "bootstrap" ? policy.bootstrapAudience : policy.foundationAudience,
      );
      return Uint8Array.from(RAW_APPLY_TOKEN);
    },
  };
  const entra = {
    session: identitySession(expectedIdentity, RAW_APPLY_TOKEN, options.sessionOverride),
    async exchangeExactToken(input: { rawToken: Uint8Array }) {
      calls.push("exchange");
      assert.deepEqual(input.rawToken, RAW_APPLY_TOKEN);
      return this.session;
    },
  };
  let stateReadUnderLease = 0;
  const statePort = {
    async readIdentity(input: { session: unknown }) {
      calls.push("state-after-login");
      azureSessions.push(input.session);
      return state;
    },
    async readIdentityUnderLease(input: { session: unknown }) {
      calls.push("state-under-lease");
      azureSessions.push(input.session);
      stateReadUnderLease += 1;
      return stateReadUnderLease > 1
        ? (options.stateFinal ?? options.stateUnderLease ?? state)
        : (options.stateUnderLease ?? state);
    },
  };
  const lease = {
    async withLease<T>(input: {
      key: typeof INFRASTRUCTURE_APPLY_CONCURRENCY_GROUP;
      work: (proof: {
        acquired: true;
        key: typeof INFRASTRUCTURE_APPLY_CONCURRENCY_GROUP;
        leaseId: string;
      }) => Promise<T>;
      session: unknown;
    }) {
      calls.push("lease");
      azureSessions.push(input.session);
      leaseKey = input.key;
      if (options.leaseFailure) throw new Error("apply-lease-competing");
      return input.work({
        acquired: true,
        key: INFRASTRUCTURE_APPLY_CONCURRENCY_GROUP,
        leaseId: "44444444-4444-4444-8444-444444444444",
      });
    },
  };
  const intents = {
    async read(input: { session: unknown }) {
      calls.push("read-intent");
      azureSessions.push(input.session);
      return intent;
    },
    async createStarted(input: { proposed: ApplyIntentReceipt; session: unknown }) {
      calls.push("create-intent");
      azureSessions.push(input.session);
      const proposed = input.proposed;
      if (options.intentRace) {
        intent = proposed;
        return { outcome: "exists" as const, receipt: proposed };
      }
      intent = proposed;
      if (options.nowAfterIntent !== undefined) mutableNow = options.nowAfterIntent;
      return { outcome: "created" as const, receipt: proposed };
    },
    async replace(input: { next: ApplyIntentReceipt; session: unknown }) {
      calls.push("replace-intent");
      azureSessions.push(input.session);
      intent = input.next;
      return input.next;
    },
  };
  const applier = {
    async applyExactSavedPlan(input: { command: readonly string[]; savedPlan: Uint8Array }) {
      calls.push("apply");
      applies += 1;
      appliedSavedPlan = input.savedPlan;
      assert.deepEqual(input.command, EXACT_SAVED_PLAN_APPLY_COMMAND);
      if (options.throwApply) throw new Error("lost response");
      if (options.applyOutcome !== undefined) {
        return { outcome: options.applyOutcome, resultDigest: sha256Text(options.applyOutcome) };
      }
      state = {
        ...fixture.state,
        backendStateDigest: "e".repeat(64),
        backendStateEtag: '"state-etag-8"',
        managedResourceCount: fixture.state.managedResourceCount + 1,
        managedResourcesEmpty: false,
        serial: fixture.state.serial + 1,
      };
      return {
        appliedPlanDigest: verified.planDigest,
        outcome: "completed" as const,
        resultDigest: sha256Text("completed"),
        stateAfter: state,
      };
    },
  };
  const requestBase = {
    approvalInputsJson: JSON.stringify({
      plan_run_id: PLAN_RUN_ID,
      artifact_id: ARTIFACT_ID,
      commit_sha: COMMIT_SHA,
      plan_digest: verified.planDigest,
      destructive_acknowledgement: "",
    }),
    approvalRunId: APPROVAL_RUN_ID,
    jobCheckRunId: APPLY_JOB_CHECK_RUN_ID,
    jobWorkflowSha: APPLY_ENGINE_SHA,
  };
  const request = { ...requestBase, ...options.requestOverride };
  const engine = new InfrastructureApplyEngine(
    policy,
    github,
    bundles,
    receipts,
    tokenRequester,
    tokens,
    renderer,
    entra,
    statePort,
    lease,
    intents,
    applier,
    () => mutableNow,
  );
  return {
    calls,
    azureSessions,
    engine,
    fixture,
    get applies() {
      return applies;
    },
    get appliedSavedPlan() {
      return appliedSavedPlan;
    },
    get intent() {
      return intent;
    },
    get leaseKey() {
      return leaseKey;
    },
    request,
    session: entra.session,
  };
}

function deepMerge<T>(base: T, override: unknown): T {
  if (override === undefined || override === null || typeof override !== "object") return base;
  const result = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    const current = result[key];
    result[key] =
      current !== null &&
      typeof current === "object" &&
      !Array.isArray(current) &&
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value)
        ? deepMerge(current, value)
        : value;
  }
  return result as T;
}

function mutate(value: Uint8Array, offset: number): Uint8Array {
  const result = Uint8Array.from(value);
  const original = result[offset];
  if (original === undefined) throw new Error("mutation-offset-out-of-range");
  result[offset] = original ^ 1;
  return result;
}

function isSensitiveEffect(value: string): boolean {
  return [
    "verify-token",
    "exchange",
    "download-receipt",
    "state-after-login",
    "lease",
    "read-intent",
    "create-intent",
    "apply",
  ].includes(value);
}
