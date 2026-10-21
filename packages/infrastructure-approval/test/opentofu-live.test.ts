import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

import {
  BoundedOpenTofuProcess,
  EXACT_SAVED_PLAN_APPLY_COMMAND,
  EXACT_SAVED_PLAN_CREATE_COMMAND,
  EXACT_SAVED_PLAN_SHOW_JSON_COMMAND,
  EXACT_SAVED_PLAN_SHOW_TEXT_COMMAND,
  LiveOpenTofuRuntime,
  OPEN_TOFU_BINARY_RELATIVE_PATH,
  type OpenTofuProcessPort,
  parseTargetConfiguration,
  PINNED_OPEN_TOFU_VERSION,
  sha256Bytes,
} from "../src/index.js";
import {
  ACTIVATION,
  bytes,
  COMMIT_SHA,
  identitySession,
  planJson,
  RAW_APPLY_TOKEN,
  RAW_PLAN_TOKEN,
  stateIdentity,
} from "./fixtures.js";

describe("pinned live OpenTofu runtime", () => {
  it("uses fixed directories, commands and an allowlisted environment around exact state reads", async () => {
    const fixture = await runtimeFixture();
    try {
      const creation = await fixture.runtime.createSavedPlan({
        authorityClass: "foundation",
        backend: ACTIVATION.policy.backend,
        command: EXACT_SAVED_PLAN_CREATE_COMMAND,
        commitSha: COMMIT_SHA,
        expectedState: fixture.stateBefore,
        plannerSession: identitySession("planner", RAW_PLAN_TOKEN) as ReturnType<
          typeof identitySession
        > & { readonly identity: "planner" },
        subscriptionId: ACTIVATION.policy.subscriptionId,
        tenantId: ACTIVATION.policy.tenantId,
        tofuVersion: PINNED_OPEN_TOFU_VERSION,
        transientGitHubOidcToken: Uint8Array.from(RAW_PLAN_TOKEN),
      });
      assert.equal(creation.savedPlanDigest, sha256Bytes(fixture.savedPlan));
      assert.deepEqual(fixture.stateReads, ["planner", "planner"]);
      const rendering = await fixture.runtime.renderSavedPlan({
        jsonCommand: EXACT_SAVED_PLAN_SHOW_JSON_COMMAND,
        savedPlan: creation.savedPlan,
        textCommand: EXACT_SAVED_PLAN_SHOW_TEXT_COMMAND,
        tofuVersion: PINNED_OPEN_TOFU_VERSION,
      });
      assert.deepEqual(rendering.planJson, fixture.planJsonBytes);
      const applied = await fixture.runtime.applyExactSavedPlan({
        authorityClass: "foundation",
        command: EXACT_SAVED_PLAN_APPLY_COMMAND,
        savedPlan: creation.savedPlan,
        session: identitySession("foundation-applier", RAW_APPLY_TOKEN),
        transientGitHubOidcToken: Uint8Array.from(RAW_APPLY_TOKEN),
      });
      assert.equal(applied.outcome, "completed");
      assert.equal(fixture.stateReads.at(-1), "apply");
      assert.deepEqual(
        fixture.requests.map(({ args }) => args),
        [
          ["version"],
          [
            "init",
            "-input=false",
            "-lockfile=readonly",
            "-no-color",
            "-reconfigure",
            "-backend-config=backend.hcl",
          ],
          ["plan", "-input=false", "-lock=false", "-no-color", "-out=saved-plan"],
          ["init", "-backend=false", "-input=false", "-lockfile=readonly", "-no-color"],
          ["show", "-json", "saved-plan"],
          ["show", "-no-color", "saved-plan"],
          [
            "init",
            "-input=false",
            "-lockfile=readonly",
            "-no-color",
            "-reconfigure",
            "-backend-config=backend.hcl",
          ],
          ["apply", "-input=false", "-no-color", "saved-plan"],
        ],
      );
      for (const request of fixture.requests.slice(1)) {
        assert.ok(
          request.cwd.startsWith(`${fixture.runnerTemp}/switchyard-infrastructure-approval/`),
        );
        assert.equal(request.executable, join(fixture.runnerTemp, OPEN_TOFU_BINARY_RELATIVE_PATH));
        assert.deepEqual(
          Object.keys(request.env).sort(),
          (request.env.ARM_OIDC_TOKEN === undefined
            ? [
                "CHECKPOINT_DISABLE",
                "LANG",
                "LC_ALL",
                "TF_DATA_DIR",
                "TF_IN_AUTOMATION",
                "TF_INPUT",
              ]
            : [
                "ARM_CLIENT_ID",
                "ARM_OIDC_TOKEN",
                "ARM_SUBSCRIPTION_ID",
                "ARM_TENANT_ID",
                "ARM_USE_AKS_WORKLOAD_IDENTITY",
                "ARM_USE_CLI",
                "ARM_USE_MSI",
                "ARM_USE_OIDC",
                "CHECKPOINT_DISABLE",
                "LANG",
                "LC_ALL",
                "TF_DATA_DIR",
                "TF_IN_AUTOMATION",
                "TF_INPUT",
              ]
          ).sort(),
        );
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects wrong binary version before init, plan or cloud state access", async () => {
    const fixture = await runtimeFixture({ wrongVersion: true });
    try {
      await assert.rejects(
        () =>
          fixture.runtime.renderSavedPlan({
            jsonCommand: EXACT_SAVED_PLAN_SHOW_JSON_COMMAND,
            savedPlan: fixture.savedPlan,
            textCommand: EXACT_SAVED_PLAN_SHOW_TEXT_COMMAND,
            tofuVersion: PINNED_OPEN_TOFU_VERSION,
          }),
        /opentofu-binary-version-invalid/,
      );
      assert.equal(fixture.requests.length, 1);
      assert.deepEqual(fixture.stateReads, []);
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects a binary symlink before any OpenTofu command", async () => {
    const fixture = await runtimeFixture();
    try {
      const target = join(fixture.runnerTemp, "unreviewed-tofu");
      await writeFile(target, "fake unreviewed binary", { mode: 0o700 });
      await rm(fixture.binaryPath);
      await symlink(target, fixture.binaryPath);
      await assert.rejects(
        () =>
          fixture.runtime.renderSavedPlan({
            jsonCommand: EXACT_SAVED_PLAN_SHOW_JSON_COMMAND,
            savedPlan: fixture.savedPlan,
            textCommand: EXACT_SAVED_PLAN_SHOW_TEXT_COMMAND,
            tofuVersion: PINNED_OPEN_TOFU_VERSION,
          }),
        /opentofu-binary-path-or-mode-invalid/,
      );
      assert.deepEqual(fixture.requests, []);
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects arbitrary process arguments and environment before spawn", async () => {
    const executable = join("/tmp", OPEN_TOFU_BINARY_RELATIVE_PATH);
    const base = {
      args: ["version"],
      cwd: "/tmp",
      env: { LANG: "C", LC_ALL: "C" },
      executable,
      stderrLimit: 1024,
      stdoutLimit: 1024,
      timeoutMs: 1_000,
    } as const;
    const process = new BoundedOpenTofuProcess();
    await assert.rejects(
      () => process.run({ ...base, args: ["apply", "-destroy"] }),
      /opentofu-process-command-not-allowlisted/,
    );
    await assert.rejects(
      () => process.run({ ...base, env: { ...base.env, PATH: "/bin" } }),
      /opentofu-process-environment-invalid/,
    );
  });

  it("bounds real fake-child timeout, output and nonzero results", async () => {
    const root = await mkdtemp(join(tmpdir(), "switchyard-tofu-process-"));
    const executable = join(root, OPEN_TOFU_BINARY_RELATIVE_PATH);
    await mkdir(resolve(executable, ".."), { mode: 0o700, recursive: true });
    const process = new BoundedOpenTofuProcess();
    const request = {
      args: ["version"],
      cwd: root,
      env: { LANG: "C", LC_ALL: "C" },
      executable,
      stderrLimit: 32,
      stdoutLimit: 32,
      timeoutMs: 1_000,
    } as const;
    try {
      await fakeExecutable(executable, "while :; do :; done");
      await assert.rejects(
        () => process.run({ ...request, timeoutMs: 25 }),
        /opentofu-process-timeout/,
      );
      await fakeExecutable(executable, "while :; do printf '0123456789'; done");
      await assert.rejects(() => process.run(request), /opentofu-process-stdout-overflow/);
      await fakeExecutable(executable, "while :; do printf '0123456789' >&2; done");
      await assert.rejects(() => process.run(request), /opentofu-process-stderr-overflow/);
      await fakeExecutable(executable, "exit 7");
      assert.equal((await process.run(request)).exitCode, 7);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  for (const failure of [
    "opentofu-process-timeout",
    "opentofu-process-stdout-overflow",
    "opentofu-process-stderr-overflow",
  ]) {
    it(`propagates redacted ${failure} without outputs or tokens`, async () => {
      const fixture = await runtimeFixture({ processFailure: failure });
      try {
        await assert.rejects(
          () =>
            fixture.runtime.renderSavedPlan({
              jsonCommand: EXACT_SAVED_PLAN_SHOW_JSON_COMMAND,
              savedPlan: fixture.savedPlan,
              textCommand: EXACT_SAVED_PLAN_SHOW_TEXT_COMMAND,
              tofuVersion: PINNED_OPEN_TOFU_VERSION,
            }),
          (error: unknown) =>
            error instanceof Error &&
            error.message === failure &&
            !error.message.includes(new TextDecoder().decode(RAW_PLAN_TOKEN)),
        );
      } finally {
        await fixture.cleanup();
      }
    });
  }

  it("classifies nonzero native lock and stale-plan results without returning stderr", async () => {
    for (const [stderr, expected] of [
      ["Error acquiring the state lock", "native-lock-failed"],
      ["Saved plan is stale", "stale-plan"],
      ["provider returned an ordinary error", "failed"],
    ] as const) {
      const fixture = await runtimeFixture({ applyStderr: stderr });
      try {
        const result = await fixture.runtime.applyExactSavedPlan({
          authorityClass: "foundation",
          command: EXACT_SAVED_PLAN_APPLY_COMMAND,
          savedPlan: fixture.savedPlan,
          session: identitySession("foundation-applier", RAW_APPLY_TOKEN),
          transientGitHubOidcToken: Uint8Array.from(RAW_APPLY_TOKEN),
        });
        assert.equal(result.outcome, expected);
        assert.equal(JSON.stringify(result).includes(stderr), false);
      } finally {
        await fixture.cleanup();
      }
    }
  });

  it("classifies plan failures into predefined redacted recovery codes", async () => {
    for (const [diagnostic, expected] of [
      [
        "AuthorizationFailed for Microsoft.OperationalInsights/workspaces/query/read",
        "opentofu-plan-log-query-permission-denied",
      ],
      ["Error acquiring the state lock", "opentofu-plan-native-lock-failed"],
      ["MissingSubscriptionRegistration", "opentofu-plan-provider-not-registered"],
      ["ResourceNotFound with status code 404", "opentofu-plan-resource-not-found"],
      ["StatusCode=429 TooManyRequests", "opentofu-plan-transient-service-failure"],
      ["context deadline exceeded", "opentofu-plan-network-failure"],
      ["Error: Plugin did not respond", "opentofu-plan-provider-runtime-failure"],
      ["Error: Invalid function argument", "opentofu-plan-configuration-failed"],
      ["Error: retrieving Workspace", "opentofu-plan-resource-refresh-failed"],
      ["provider returned an ordinary error", "opentofu-plan-failed"],
    ] as const) {
      const fixture = await runtimeFixture({ planStdout: diagnostic });
      try {
        await assert.rejects(
          () =>
            fixture.runtime.createSavedPlan({
              authorityClass: "foundation",
              backend: ACTIVATION.policy.backend,
              command: EXACT_SAVED_PLAN_CREATE_COMMAND,
              commitSha: COMMIT_SHA,
              expectedState: fixture.stateBefore,
              plannerSession: identitySession("planner", RAW_PLAN_TOKEN) as ReturnType<
                typeof identitySession
              > & { readonly identity: "planner" },
              subscriptionId: ACTIVATION.policy.subscriptionId,
              tenantId: ACTIVATION.policy.tenantId,
              tofuVersion: PINNED_OPEN_TOFU_VERSION,
              transientGitHubOidcToken: Uint8Array.from(RAW_PLAN_TOKEN),
            }),
          (error: unknown) =>
            error instanceof Error &&
            error.message === expected &&
            !error.message.includes(diagnostic),
        );
      } finally {
        await fixture.cleanup();
      }
    }
  });

  it("parses only canonical non-secret target configuration consistent with activation", () => {
    const valid = targetConfigurationBytes();
    assert.equal(parseTargetConfiguration(valid, ACTIVATION).digest, sha256Bytes(valid));
    const source = new TextDecoder().decode(valid);
    for (const changed of [
      source.replace(/}\n$/, ',"extra":true}\n'),
      source.replace(ACTIVATION.policy.subscriptionId, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
      source.replace("owner@example.invalid", "eyJabcdefgh.payload.signature"),
      ` ${source}`,
      source.replace(
        '"function_package_deployment_enabled":false',
        '"function_package_deployment_enabled":true',
      ),
    ]) {
      assert.throws(() => parseTargetConfiguration(bytes(changed), ACTIVATION));
    }
  });
});

async function runtimeFixture(
  options: {
    readonly applyStderr?: string;
    readonly planStderr?: string;
    readonly planStdout?: string;
    readonly processFailure?: string;
    readonly wrongVersion?: boolean;
  } = {},
) {
  const runnerTemp = await mkdtemp(join(tmpdir(), "switchyard-tofu-runtime-"));
  const binaryPath = join(runnerTemp, OPEN_TOFU_BINARY_RELATIVE_PATH);
  await mkdir(resolve(binaryPath, ".."), { mode: 0o700, recursive: true });
  await writeFile(binaryPath, "fake pinned binary", { mode: 0o700 });
  await chmod(binaryPath, 0o700);
  const requests: Array<{
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly executable: string;
  }> = [];
  const savedPlan = bytes("opaque exact fake saved plan");
  const planJsonBytes = planJson();
  const process: OpenTofuProcessPort = {
    async run(request) {
      requests.push({
        args: [...request.args],
        cwd: request.cwd,
        env: { ...request.env },
        executable: request.executable,
      });
      if (request.args[0] === "version") {
        return result(
          options.wrongVersion
            ? "OpenTofu v1.12.0\non linux_amd64\n"
            : "OpenTofu v1.12.1\non linux_amd64\n",
        );
      }
      if (options.processFailure !== undefined) throw new ErrorWithCode(options.processFailure);
      if (request.args[0] === "plan") {
        if (options.planStdout !== undefined) return result(options.planStdout, "", 1);
        if (options.planStderr !== undefined) return result("", options.planStderr, 1);
        await writeFile(join(request.cwd, "saved-plan"), savedPlan, { mode: 0o600 });
      }
      if (request.args[0] === "show" && request.args[1] === "-json") return result(planJsonBytes);
      if (request.args[0] === "show") return result("reviewed plan text\n");
      if (request.args[0] === "apply" && options.applyStderr !== undefined) {
        return result("", options.applyStderr, 1);
      }
      return result("");
    },
  };
  const stateBefore = stateIdentity();
  const stateReads: string[] = [];
  const runtime = new LiveOpenTofuRuntime({
    activation: ACTIVATION,
    authoritativeState: {
      async readIdentity() {
        stateReads.push("apply");
        return stateIdentity("foundation", {
          backendStateDigest: "e".repeat(64),
          backendStateEtag: '"state-etag-8"',
          serial: 8,
        });
      },
    },
    plannerState: {
      async readIdentity() {
        stateReads.push("planner");
        return stateBefore;
      },
    },
    process,
    runnerTemp,
    targetConfigurationBytes: targetConfigurationBytes(),
    workspaceRoot: resolve("../.."),
  });
  return {
    binaryPath,
    cleanup: () => rm(runnerTemp, { force: true, recursive: true }),
    planJsonBytes,
    requests,
    runnerTemp,
    runtime,
    savedPlan,
    stateBefore,
    stateReads,
  };
}

function targetConfigurationBytes(): Uint8Array {
  const value = {
    dedicated_subscription_confirmed: true,
    subscription_id: ACTIVATION.policy.subscriptionId,
    tenant_id: ACTIVATION.policy.tenantId,
    deployment_principal_object_id: ACTIVATION.policy.foundationIdentityPrincipalId,
    owner_principal_object_id: "77777777-7777-7777-7777-777777777777",
    owner_recovery_principal_object_id: "88888888-8888-4888-8888-888888888888",
    function_auth_client_id: "99999999-9999-9999-9999-999999999999",
    github_workload_client_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    runner_image_version: "24.04.20260801",
    alert_email: "owner@example.invalid",
    storage_account_name: "stswydcontrolfixture",
    key_vault_name: "kv-switchyard-fixture",
    function_app_name: "func-switchyard-fixture",
    ledger_instance_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ledger_partition_key: "control-v10",
    ledger_schema_version: 10,
    doppler_bootstrap_enabled: false,
    function_package_deployment_enabled: false,
    function_package_path: null,
    function_package_sha256: null,
    admission_runtime_settings: {},
    tags: { owner: "example-owner" },
  };
  return bytes(`${canonicalJson(value)}\n`);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function result(stdout: string | Uint8Array, stderr = "", exitCode = 0) {
  return {
    exitCode,
    stderr: bytes(stderr),
    stdout: typeof stdout === "string" ? bytes(stdout) : stdout,
  };
}

class ErrorWithCode extends Error {}

async function fakeExecutable(path: string, body: string): Promise<void> {
  await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  await chmod(path, 0o700);
}
