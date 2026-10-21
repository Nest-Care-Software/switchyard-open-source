import { spawn } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { parseStrictJsonObject, requireExactKeys, requireRecord } from "@switchyard/core";

import {
  type ApplyExecutionPort,
  type AuthoritativeStatePort,
  EXACT_SAVED_PLAN_APPLY_COMMAND,
} from "./apply-engine.js";
import type { ActivationConfiguration } from "./activation.js";
import {
  azureUuid,
  commitSha,
  exactString,
  type InfrastructureIdentitySession,
  InfrastructureApprovalError,
  sha256,
  sha256Bytes,
  sha256Text,
  type StateIdentity,
  validateStateIdentity,
  verifyIdentitySession,
} from "./contracts.js";
import {
  assertExactOpenTofuCommand,
  EXACT_SAVED_PLAN_CREATE_COMMAND,
  EXACT_SAVED_PLAN_SHOW_JSON_COMMAND,
  EXACT_SAVED_PLAN_SHOW_TEXT_COMMAND,
  type FixedOpenTofuPlanPort,
  PINNED_OPEN_TOFU_VERSION,
  type PlannerStateReadPort,
  type SavedPlanCreation,
  type SavedPlanRendering,
} from "./opentofu.js";

export const OPEN_TOFU_BINARY_RELATIVE_PATH = "switchyard-opentofu/1.12.1/tofu" as const;
export const EXACT_OPEN_TOFU_VERSION_COMMAND = Object.freeze(["tofu", "version"] as const);
export const EXACT_OPEN_TOFU_RENDER_INIT_COMMAND = Object.freeze([
  "tofu",
  "init",
  "-backend=false",
  "-input=false",
  "-lockfile=readonly",
  "-no-color",
] as const);
export const EXACT_OPEN_TOFU_BACKEND_INIT_COMMAND = Object.freeze([
  "tofu",
  "init",
  "-input=false",
  "-lockfile=readonly",
  "-no-color",
  "-reconfigure",
  "-backend-config=backend.hcl",
] as const);

const TARGET_CONFIGURATION_KEYS = [
  "dedicated_subscription_confirmed",
  "subscription_id",
  "tenant_id",
  "deployment_principal_object_id",
  "owner_principal_object_id",
  "owner_recovery_principal_object_id",
  "function_auth_client_id",
  "github_workload_client_id",
  "runner_image_version",
  "alert_email",
  "storage_account_name",
  "key_vault_name",
  "function_app_name",
  "ledger_instance_id",
  "ledger_partition_key",
  "ledger_schema_version",
  "doppler_bootstrap_enabled",
  "function_package_deployment_enabled",
  "function_package_path",
  "function_package_sha256",
  "admission_runtime_settings",
  "tags",
] as const;
const SOURCE_FILES = Object.freeze([
  "infra/assets/azure-runner/bootstrap.sh",
  "infra/environments/azure-pilot/.terraform.lock.hcl",
  "infra/environments/azure-pilot/main.tf",
  "infra/environments/azure-pilot/outputs.tf",
  "infra/environments/azure-pilot/providers.tf",
  "infra/environments/azure-pilot/variables.tf",
  "infra/environments/azure-pilot/versions.tf",
  "infra/modules/azure-control/function.tf",
  "infra/modules/azure-control/identity.tf",
  "infra/modules/azure-control/key-vault.tf",
  "infra/modules/azure-control/main.tf",
  "infra/modules/azure-control/monitoring.tf",
  "infra/modules/azure-control/network.tf",
  "infra/modules/azure-control/outputs.tf",
  "infra/modules/azure-control/storage.tf",
  "infra/modules/azure-control/variables.tf",
  "infra/modules/azure-control/versions.tf",
  "infra/templates/azure-allocation/main.json",
]);
const ENVIRONMENT_RELATIVE_PATH = "infra/environments/azure-pilot";
const TARGET_FILE = `${ENVIRONMENT_RELATIVE_PATH}/runtime.auto.tfvars.json`;
const BACKEND_FILE = `${ENVIRONMENT_RELATIVE_PATH}/backend.hcl`;
const SAVED_PLAN_FILE = `${ENVIRONMENT_RELATIVE_PATH}/saved-plan`;
const FUNCTION_PACKAGE_FILE = `${ENVIRONMENT_RELATIVE_PATH}/function-package.zip`;
const MAX_SOURCE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TARGET_CONFIGURATION_BYTES = 128 * 1024;
const MAX_SAVED_PLAN_BYTES = 64 * 1024 * 1024;
const MAX_PLAN_JSON_BYTES = 64 * 1024 * 1024;
const MAX_PLAN_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;
const INIT_TIMEOUT_MS = 5 * 60_000;
const PLAN_TIMEOUT_MS = 10 * 60_000;
const APPLY_TIMEOUT_MS = 30 * 60_000;

export interface OpenTofuProcessRequest {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly executable: string;
  readonly stderrLimit: number;
  readonly stdoutLimit: number;
  readonly timeoutMs: number;
}

export interface OpenTofuProcessResult {
  readonly exitCode: number;
  readonly stderr: Uint8Array;
  readonly stdout: Uint8Array;
}

export interface OpenTofuProcessPort {
  run(request: OpenTofuProcessRequest): Promise<OpenTofuProcessResult>;
}

export class BoundedOpenTofuProcess implements OpenTofuProcessPort {
  async run(request: OpenTofuProcessRequest): Promise<OpenTofuProcessResult> {
    validateProcessRequest(request);
    return new Promise((resolveResult, reject) => {
      const child = spawn(request.executable, [...request.args], {
        cwd: request.cwd,
        detached: process.platform !== "win32",
        env: { ...request.env },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let failure: string | undefined;
      const terminate = () => {
        if (process.platform !== "win32" && child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGKILL");
            return;
          } catch {
            // Fall back to the direct child if the process group has already gone.
          }
        }
        child.kill("SIGKILL");
      };
      const timer = setTimeout(() => {
        failure = "opentofu-process-timeout";
        terminate();
      }, request.timeoutMs);
      const collect = (
        target: Buffer[],
        limit: number,
        value: Buffer,
        kind: "stdout" | "stderr",
      ) => {
        if (failure !== undefined) return;
        if (kind === "stdout") stdoutBytes += value.byteLength;
        else stderrBytes += value.byteLength;
        if ((kind === "stdout" ? stdoutBytes : stderrBytes) > limit) {
          failure = `opentofu-process-${kind}-overflow`;
          terminate();
          return;
        }
        target.push(Buffer.from(value));
      };
      child.stdout.on("data", (value: Buffer) =>
        collect(stdout, request.stdoutLimit, value, "stdout"),
      );
      child.stderr.on("data", (value: Buffer) =>
        collect(stderr, request.stderrLimit, value, "stderr"),
      );
      child.once("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new InfrastructureApprovalError("opentofu-process-start-failed"));
      });
      child.once("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (failure !== undefined) return reject(new InfrastructureApprovalError(failure));
        if (signal !== null || !Number.isInteger(code)) {
          return reject(new InfrastructureApprovalError("opentofu-process-result-unknown"));
        }
        resolveResult(
          Object.freeze({
            exitCode: code as number,
            stderr: Uint8Array.from(Buffer.concat(stderr)),
            stdout: Uint8Array.from(Buffer.concat(stdout)),
          }),
        );
      });
    });
  }
}

export interface LiveOpenTofuOptions {
  readonly activation: ActivationConfiguration;
  readonly authoritativeState: Pick<AuthoritativeStatePort, "readIdentity">;
  readonly functionPackagePath?: string;
  readonly process?: OpenTofuProcessPort;
  readonly runnerTemp: string;
  readonly plannerState: PlannerStateReadPort;
  readonly targetConfigurationBytes: Uint8Array;
  readonly workspaceRoot: string;
}

/** Pinned, staged and bounded OpenTofu composition for plan, rerender and saved-plan apply. */
export class LiveOpenTofuRuntime implements FixedOpenTofuPlanPort, ApplyExecutionPort {
  readonly #activation: ActivationConfiguration;
  readonly #authoritativeState: Pick<AuthoritativeStatePort, "readIdentity">;
  readonly #binaryPath: string;
  readonly #functionPackagePath: string | undefined;
  readonly #process: OpenTofuProcessPort;
  readonly #plannerState: PlannerStateReadPort;
  readonly #runnerTemp: string;
  readonly #target: ParsedTargetConfiguration;
  readonly #workspaceRoot: string;
  #verifiedBinary: Promise<void> | undefined;

  constructor(options: LiveOpenTofuOptions) {
    this.#activation = options.activation;
    this.#authoritativeState = options.authoritativeState;
    this.#runnerTemp = requireAbsoluteCanonicalInput(options.runnerTemp, "runner-temp");
    this.#workspaceRoot = requireAbsoluteCanonicalInput(options.workspaceRoot, "workspace-root");
    this.#binaryPath = join(this.#runnerTemp, OPEN_TOFU_BINARY_RELATIVE_PATH);
    this.#process = options.process ?? new BoundedOpenTofuProcess();
    this.#plannerState = options.plannerState;
    this.#target = parseTargetConfiguration(options.targetConfigurationBytes, options.activation);
    this.#functionPackagePath = options.functionPackagePath;
    const enabled = this.#target.value.function_package_deployment_enabled === true;
    const expectedPackagePath = join(this.#runnerTemp, "switchyard-function-package.zip");
    if (
      (enabled && options.functionPackagePath !== expectedPackagePath) ||
      (!enabled && options.functionPackagePath !== undefined)
    ) {
      invalid("opentofu-function-package-path-invalid");
    }
  }

  async getTargetConfigurationDigest(): Promise<string> {
    return this.#target.digest;
  }

  async createSavedPlan(
    input: Parameters<FixedOpenTofuPlanPort["createSavedPlan"]>[0],
  ): Promise<SavedPlanCreation> {
    assertExactOpenTofuCommand("create", input.command);
    if (input.tofuVersion !== PINNED_OPEN_TOFU_VERSION) invalid("opentofu-version-not-pinned");
    commitSha(input.commitSha, "opentofu.commitSha");
    validateStateIdentity(input.expectedState, "opentofu.expectedState");
    requireExactAuthority(input.authorityClass);
    this.#requirePolicyAuthority(input.subscriptionId, input.tenantId);
    verifyIdentitySession(
      input.plannerSession,
      "planner",
      this.#activation.policy,
      input.plannerSession.assertionDigest,
    );
    requireSameBackend(input.backend, this.#activation.policy.backend);
    requireRawToken(input.transientGitHubOidcToken, input.plannerSession.assertionDigest);
    await this.#verifyBinary();
    const stage = await this.#stage("plan");
    try {
      const env = this.#authenticatedEnvironment(
        stage,
        input.plannerSession,
        input.transientGitHubOidcToken,
      );
      try {
        await this.#runSuccess(
          EXACT_OPEN_TOFU_BACKEND_INIT_COMMAND,
          stage,
          env,
          INIT_TIMEOUT_MS,
          1024 * 1024,
        );
        const stateImmediatelyBefore = await this.#plannerState.readIdentity({
          backend: this.#activation.policy.backend,
          plannerSession: input.plannerSession,
        });
        requireSameState(
          stateImmediatelyBefore,
          input.expectedState,
          "state-changed-before-opentofu-plan",
        );
        await this.#runSuccess(
          EXACT_SAVED_PLAN_CREATE_COMMAND,
          stage,
          env,
          PLAN_TIMEOUT_MS,
          1024 * 1024,
        );
        const stateImmediatelyAfter = await this.#plannerState.readIdentity({
          backend: this.#activation.policy.backend,
          plannerSession: input.plannerSession,
        });
        requireSameState(
          stateImmediatelyAfter,
          input.expectedState,
          "state-changed-during-opentofu-plan",
        );
      } finally {
        scrubEnvironment(env);
      }
      const savedPlan = await readBoundedFile(
        join(stage.root, SAVED_PLAN_FILE),
        MAX_SAVED_PLAN_BYTES,
        "saved-plan",
      );
      return Object.freeze({ savedPlan, savedPlanDigest: sha256Bytes(savedPlan) });
    } finally {
      await removeStage(stage.root);
    }
  }

  async renderSavedPlan(
    input: Parameters<FixedOpenTofuPlanPort["renderSavedPlan"]>[0],
  ): Promise<SavedPlanRendering> {
    assertExactOpenTofuCommand("show-json", input.jsonCommand);
    assertExactOpenTofuCommand("show-text", input.textCommand);
    if (input.tofuVersion !== PINNED_OPEN_TOFU_VERSION) invalid("opentofu-version-not-pinned");
    requireSavedPlan(input.savedPlan);
    await this.#verifyBinary();
    const stage = await this.#stage("render");
    try {
      await writePrivate(join(stage.root, SAVED_PLAN_FILE), input.savedPlan);
      const env = this.#baseEnvironment(stage);
      await this.#runSuccess(
        EXACT_OPEN_TOFU_RENDER_INIT_COMMAND,
        stage,
        env,
        INIT_TIMEOUT_MS,
        1024 * 1024,
      );
      const json = await this.#runSuccess(
        EXACT_SAVED_PLAN_SHOW_JSON_COMMAND,
        stage,
        env,
        INIT_TIMEOUT_MS,
        MAX_PLAN_JSON_BYTES,
      );
      const text = await this.#runSuccess(
        EXACT_SAVED_PLAN_SHOW_TEXT_COMMAND,
        stage,
        env,
        INIT_TIMEOUT_MS,
        MAX_PLAN_TEXT_BYTES,
      );
      return Object.freeze({
        planJson: json.stdout,
        planText: text.stdout,
        renderedSavedPlanDigest: sha256Bytes(input.savedPlan),
      });
    } finally {
      await removeStage(stage.root);
    }
  }

  async applyExactSavedPlan(input: Parameters<ApplyExecutionPort["applyExactSavedPlan"]>[0]) {
    requireExactApplyCommand(input.command);
    requireExactAuthority(input.authorityClass);
    requireSavedPlan(input.savedPlan);
    const identity =
      input.authorityClass === "bootstrap" ? "bootstrap-applier" : "foundation-applier";
    verifyIdentitySession(
      input.session,
      identity,
      this.#activation.policy,
      input.session.assertionDigest,
    );
    requireRawToken(input.transientGitHubOidcToken, input.session.assertionDigest);
    await this.#verifyBinary();
    const stage = await this.#stage("apply");
    const savedPlanDigest = sha256Bytes(input.savedPlan);
    try {
      await writePrivate(join(stage.root, SAVED_PLAN_FILE), input.savedPlan);
      const env = this.#authenticatedEnvironment(
        stage,
        input.session,
        input.transientGitHubOidcToken,
      );
      let result: OpenTofuProcessResult;
      try {
        await this.#runSuccess(
          EXACT_OPEN_TOFU_BACKEND_INIT_COMMAND,
          stage,
          env,
          INIT_TIMEOUT_MS,
          1024 * 1024,
        );
        result = await this.#run(
          EXACT_SAVED_PLAN_APPLY_COMMAND,
          stage,
          env,
          APPLY_TIMEOUT_MS,
          1024 * 1024,
        );
      } finally {
        scrubEnvironment(env);
      }
      const resultDigest = processResultDigest(result);
      if (result.exitCode !== 0) {
        const classification = classifyApplyFailure(result.stderr);
        return Object.freeze({ outcome: classification, resultDigest });
      }
      const stateAfter = await this.#authoritativeState.readIdentity({
        backend: this.#activation.policy.backend,
        session: input.session,
      });
      validateStateIdentity(stateAfter, "opentofu.stateAfter");
      return Object.freeze({
        appliedPlanDigest: savedPlanDigest,
        outcome: "completed" as const,
        resultDigest,
        stateAfter,
      });
    } finally {
      await removeStage(stage.root);
    }
  }

  async #verifyBinary(): Promise<void> {
    this.#verifiedBinary ??= this.#verifyBinaryOnce();
    return this.#verifiedBinary;
  }

  async #verifyBinaryOnce(): Promise<void> {
    if (process.platform !== "linux" || process.arch !== "x64")
      invalid("opentofu-platform-invalid");
    const expected = resolve(this.#binaryPath);
    let actual: string;
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      actual = await realpath(this.#binaryPath);
      metadata = await lstat(this.#binaryPath);
    } catch {
      return invalid("opentofu-binary-absent");
    }
    if (
      actual !== expected ||
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      (metadata.mode & 0o111) === 0
    ) {
      invalid("opentofu-binary-path-or-mode-invalid");
    }
    const result = await this.#process.run({
      args: EXACT_OPEN_TOFU_VERSION_COMMAND.slice(1),
      cwd: this.#runnerTemp,
      env: Object.freeze({ LANG: "C", LC_ALL: "C" }),
      executable: this.#binaryPath,
      stderrLimit: 1024,
      stdoutLimit: 1024,
      timeoutMs: 5_000,
    });
    const output = decodeUtf8(result.stdout, "opentofu-version-output");
    if (
      result.exitCode !== 0 ||
      result.stderr.byteLength !== 0 ||
      output !== `OpenTofu v${PINNED_OPEN_TOFU_VERSION}\non linux_amd64\n`
    ) {
      invalid("opentofu-binary-version-invalid");
    }
  }

  async #stage(
    operation: "apply" | "plan" | "render",
  ): Promise<{ readonly cwd: string; readonly root: string }> {
    await requireRealDirectory(this.#runnerTemp, "runner-temp");
    await requireRealDirectory(this.#workspaceRoot, "workspace-root");
    const base = join(this.#runnerTemp, "switchyard-infrastructure-approval");
    await mkdir(base, { mode: 0o700, recursive: true });
    await requireRealDirectory(base, "working-directory-base");
    await chmod(base, 0o700);
    const root = join(base, operation);
    try {
      await mkdir(root, { mode: 0o700, recursive: false });
    } catch {
      return invalid(`opentofu-${operation}-working-directory-not-empty`);
    }
    try {
      for (const source of SOURCE_FILES) await copyBoundedSource(this.#workspaceRoot, root, source);
      await writePrivate(join(root, TARGET_FILE), this.#target.bytes);
      await writePrivate(join(root, BACKEND_FILE), backendConfiguration(this.#activation));
      if (this.#functionPackagePath !== undefined) {
        const expectedDigest = this.#target.value.function_package_sha256;
        const bytes = await readBoundedFile(
          this.#functionPackagePath,
          MAX_SAVED_PLAN_BYTES,
          "function-package",
        );
        if (typeof expectedDigest !== "string" || sha256Bytes(bytes) !== expectedDigest) {
          return invalid("opentofu-function-package-digest-mismatch");
        }
        await writePrivate(join(root, FUNCTION_PACKAGE_FILE), bytes);
        bytes.fill(0);
      }
      return Object.freeze({ cwd: join(root, ENVIRONMENT_RELATIVE_PATH), root });
    } catch (error) {
      await removeStage(root);
      throw error;
    }
  }

  #baseEnvironment(stage: { readonly cwd: string; readonly root: string }): Record<string, string> {
    return {
      CHECKPOINT_DISABLE: "1",
      LANG: "C",
      LC_ALL: "C",
      TF_DATA_DIR: join(stage.root, ".terraform-data"),
      TF_IN_AUTOMATION: "1",
      TF_INPUT: "0",
    };
  }

  #authenticatedEnvironment(
    stage: { readonly cwd: string; readonly root: string },
    session: InfrastructureIdentitySession,
    rawToken: Uint8Array,
  ): Record<string, string> {
    let assertion: string;
    try {
      assertion = new TextDecoder("ascii", { fatal: true }).decode(rawToken);
    } catch {
      return invalid("opentofu-oidc-token-not-ascii");
    }
    return {
      ...this.#baseEnvironment(stage),
      ARM_CLIENT_ID: session.clientId,
      ARM_OIDC_TOKEN: assertion,
      ARM_SUBSCRIPTION_ID: session.subscriptionId,
      ARM_TENANT_ID: session.tenantId,
      ARM_USE_AKS_WORKLOAD_IDENTITY: "false",
      ARM_USE_CLI: "false",
      ARM_USE_MSI: "false",
      ARM_USE_OIDC: "true",
    };
  }

  async #runSuccess(
    command: readonly string[],
    stage: { readonly cwd: string; readonly root: string },
    env: Readonly<Record<string, string>>,
    timeoutMs: number,
    stdoutLimit: number,
  ): Promise<OpenTofuProcessResult> {
    const result = await this.#run(command, stage, env, timeoutMs, stdoutLimit);
    if (result.exitCode !== 0) {
      if (command[1] === "plan") invalid(classifyPlanFailure(result.stdout, result.stderr));
      invalid(`opentofu-${command[1] ?? "command"}-failed`);
    }
    return result;
  }

  async #run(
    command: readonly string[],
    stage: { readonly cwd: string; readonly root: string },
    env: Readonly<Record<string, string>>,
    timeoutMs: number,
    stdoutLimit: number,
  ): Promise<OpenTofuProcessResult> {
    if (command[0] !== "tofu") invalid("opentofu-command-prefix-invalid");
    return this.#process.run({
      args: command.slice(1),
      cwd: stage.cwd,
      env,
      executable: this.#binaryPath,
      stderrLimit: MAX_STDERR_BYTES,
      stdoutLimit,
      timeoutMs,
    });
  }

  #requirePolicyAuthority(subscriptionId: string, tenantId: string): void {
    if (
      subscriptionId !== this.#activation.policy.subscriptionId ||
      tenantId !== this.#activation.policy.tenantId
    ) {
      invalid("opentofu-authority-mismatch");
    }
  }
}

interface ParsedTargetConfiguration {
  readonly bytes: Uint8Array;
  readonly digest: string;
  readonly value: Record<string, unknown>;
}

export function parseTargetConfiguration(
  bytes: Uint8Array,
  activation: ActivationConfiguration,
): ParsedTargetConfiguration {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength < 2 ||
    bytes.byteLength > MAX_TARGET_CONFIGURATION_BYTES
  ) {
    invalid("target-configuration-size-invalid");
  }
  const source = decodeUtf8(bytes, "target-configuration");
  if (/-----BEGIN |eyJ[A-Za-z0-9_-]{8,}\.|[A-Za-z0-9+/]{80,}={0,2}/.test(source)) {
    invalid("target-configuration-secret-like-value");
  }
  const value = parseStrictJsonObject(source, TARGET_CONFIGURATION_KEYS, {
    maxBytes: MAX_TARGET_CONFIGURATION_BYTES,
    maxDepth: 5,
    path: "targetConfiguration",
  });
  requireExactKeys(value, TARGET_CONFIGURATION_KEYS, "targetConfiguration");
  if (value.dedicated_subscription_confirmed !== true) invalid("target-subscription-not-confirmed");
  if (
    value.subscription_id !== activation.policy.subscriptionId ||
    value.tenant_id !== activation.policy.tenantId ||
    value.deployment_principal_object_id !== activation.policy.foundationIdentityPrincipalId
  ) {
    invalid("target-configuration-activation-mismatch");
  }
  for (const key of [
    "deployment_principal_object_id",
    "owner_principal_object_id",
    "owner_recovery_principal_object_id",
    "function_auth_client_id",
    "github_workload_client_id",
    "ledger_instance_id",
  ] as const)
    azureUuid(value[key], `targetConfiguration.${key}`);
  for (const [key, maximum] of [
    ["runner_image_version", 64],
    ["alert_email", 320],
    ["storage_account_name", 24],
    ["key_vault_name", 24],
    ["function_app_name", 60],
  ] as const)
    exactString(value[key], `targetConfiguration.${key}`, maximum);
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(String(value.runner_image_version))) {
    invalid("target-runner-image-version-invalid");
  }
  if (value.ledger_partition_key !== "control-v10" || value.ledger_schema_version !== 10) {
    invalid("target-ledger-contract-invalid");
  }
  if (typeof value.doppler_bootstrap_enabled !== "boolean") invalid("target-doppler-flag-invalid");
  if (typeof value.function_package_deployment_enabled !== "boolean")
    invalid("target-package-flag-invalid");
  if (value.function_package_deployment_enabled === true) {
    if (value.function_package_path !== "./function-package.zip")
      invalid("target-package-path-invalid");
    sha256(value.function_package_sha256, "targetConfiguration.function_package_sha256");
  } else if (value.function_package_path !== null || value.function_package_sha256 !== null) {
    invalid("target-disabled-package-fields-invalid");
  }
  validateStringMap(
    value.admission_runtime_settings,
    "targetConfiguration.admission_runtime_settings",
    64,
    4096,
  );
  validateStringMap(value.tags, "targetConfiguration.tags", 32, 256);
  const canonical = `${canonicalJson(value)}\n`;
  if (source !== canonical) invalid("target-configuration-not-canonical");
  const canonicalBytes = new TextEncoder().encode(canonical);
  return Object.freeze({ bytes: canonicalBytes, digest: sha256Bytes(canonicalBytes), value });
}

function validateStringMap(
  value: unknown,
  path: string,
  maximumKeys: number,
  maximumValue: number,
): void {
  const record = requireRecord(value, path);
  const keys = Object.keys(record);
  if (keys.length > maximumKeys) invalid(`${path}-too-many-keys`);
  for (const key of keys) {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(key)) invalid(`${path}-key-invalid`);
    const entry = exactString(record[key], `${path}.${key}`, maximumValue);
    requireAllowedUrl(entry, `${path}.${key}`);
    if (/-----BEGIN |eyJ[A-Za-z0-9_-]{8,}\.|[A-Za-z0-9+/]{80,}={0,2}/.test(entry)) {
      invalid(`${path}-secret-like-value`);
    }
  }
}

function requireAllowedUrl(value: string, path: string): void {
  const matches = value.matchAll(/https?:\/\/[^\s,;]+/g);
  for (const match of matches) {
    let hostname: string;
    try {
      hostname = new URL(match[0]).hostname.toLowerCase();
    } catch {
      invalid(`${path}-url-invalid`);
    }
    if (
      hostname !== "github.com" &&
      !hostname.endsWith(".github.com") &&
      !hostname.endsWith(".githubusercontent.com") &&
      !hostname.endsWith(".azure.com") &&
      hostname !== "login.microsoftonline.com"
    ) {
      invalid(`${path}-url-host-invalid`);
    }
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid("target-configuration-number-invalid");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = requireRecord(value, "targetConfiguration");
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function backendConfiguration(activation: ActivationConfiguration): Uint8Array {
  const backend = activation.policy.backend;
  return new TextEncoder().encode(
    `resource_group_name  = ${JSON.stringify(backend.resourceGroupName)}\n` +
      `storage_account_name = ${JSON.stringify(backend.storageAccountName)}\n` +
      `container_name       = ${JSON.stringify(backend.containerName)}\n` +
      `key                  = ${JSON.stringify(backend.key)}\n` +
      "use_azuread_auth     = true\n",
  );
}

async function copyBoundedSource(
  workspace: string,
  stage: string,
  relativePath: string,
): Promise<void> {
  if (
    relativePath.startsWith("/") ||
    relativePath.includes("..") ||
    !SOURCE_FILES.includes(relativePath)
  ) {
    invalid("opentofu-source-path-invalid");
  }
  const source = join(workspace, relativePath);
  const destination = join(stage, relativePath);
  const metadata = await lstat(source).catch(() => invalid("opentofu-source-absent"));
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_SOURCE_FILE_BYTES) {
    invalid("opentofu-source-type-or-size-invalid");
  }
  const sourceRealpath = await realpath(source);
  if (relative(workspace, sourceRealpath).startsWith(".."))
    invalid("opentofu-source-escaped-workspace");
  await mkdir(dirname(destination), { mode: 0o700, recursive: true });
  await copyFile(source, destination);
  await chmod(destination, 0o600);
}

async function writePrivate(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
}

async function readBoundedFile(path: string, maximum: number, code: string): Promise<Uint8Array> {
  const metadata = await lstat(path).catch(() => invalid(`opentofu-${code}-absent`));
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 1 ||
    metadata.size > maximum
  ) {
    invalid(`opentofu-${code}-type-or-size-invalid`);
  }
  return Uint8Array.from(await readFile(path));
}

async function removeStage(path: string): Promise<void> {
  await rm(path, { force: true, recursive: true, maxRetries: 2 }).catch(() => {
    throw new InfrastructureApprovalError("opentofu-working-directory-cleanup-failed");
  });
}

async function requireRealDirectory(path: string, code: string): Promise<void> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  let actual: string;
  try {
    metadata = await lstat(path);
    actual = await realpath(path);
  } catch {
    return invalid(`${code}-absent`);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || actual !== resolve(path)) {
    invalid(`${code}-not-real-directory`);
  }
}

function requireAbsoluteCanonicalInput(path: string, code: string): string {
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    path !== resolve(path) ||
    path.length > 4096
  ) {
    invalid(`${code}-path-invalid`);
  }
  return path;
}

function validateProcessRequest(request: OpenTofuProcessRequest): void {
  if (
    !isAbsolute(request.executable) ||
    !isAbsolute(request.cwd) ||
    request.args.length < 1 ||
    request.args.length > 16
  ) {
    invalid("opentofu-process-request-invalid");
  }
  if (
    request.args.some(
      (arg) =>
        typeof arg !== "string" || arg.length < 1 || arg.length > 256 || arg.includes("\u0000"),
    )
  ) {
    invalid("opentofu-process-argument-invalid");
  }
  const commands = [
    EXACT_OPEN_TOFU_VERSION_COMMAND,
    EXACT_OPEN_TOFU_RENDER_INIT_COMMAND,
    EXACT_OPEN_TOFU_BACKEND_INIT_COMMAND,
    EXACT_SAVED_PLAN_CREATE_COMMAND,
    EXACT_SAVED_PLAN_SHOW_JSON_COMMAND,
    EXACT_SAVED_PLAN_SHOW_TEXT_COMMAND,
    EXACT_SAVED_PLAN_APPLY_COMMAND,
  ].map((command) => command.slice(1));
  if (
    !request.executable.endsWith(`/${OPEN_TOFU_BINARY_RELATIVE_PATH}`) ||
    !commands.some(
      (command) =>
        command.length === request.args.length &&
        command.every((part, index) => part === request.args[index]),
    )
  ) {
    invalid("opentofu-process-command-not-allowlisted");
  }
  const allowedEnvironment = new Set([
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
  ]);
  if (Object.keys(request.env).some((key) => !allowedEnvironment.has(key)))
    invalid("opentofu-process-environment-invalid");
  if (
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs < 1 ||
    request.timeoutMs > APPLY_TIMEOUT_MS ||
    !Number.isSafeInteger(request.stdoutLimit) ||
    request.stdoutLimit < 1 ||
    request.stdoutLimit > MAX_PLAN_JSON_BYTES ||
    !Number.isSafeInteger(request.stderrLimit) ||
    request.stderrLimit < 1 ||
    request.stderrLimit > MAX_STDERR_BYTES
  )
    invalid("opentofu-process-bound-invalid");
}

function requireRawToken(token: Uint8Array, digest: string): void {
  if (
    !(token instanceof Uint8Array) ||
    token.byteLength < 32 ||
    token.byteLength > 16 * 1024 ||
    sha256Bytes(token) !== digest
  ) {
    invalid("opentofu-oidc-token-invalid");
  }
}

function requireSavedPlan(savedPlan: Uint8Array): void {
  if (
    !(savedPlan instanceof Uint8Array) ||
    savedPlan.byteLength < 1 ||
    savedPlan.byteLength > MAX_SAVED_PLAN_BYTES
  ) {
    invalid("opentofu-saved-plan-size-invalid");
  }
}

function requireExactAuthority(value: unknown): asserts value is "bootstrap" | "foundation" {
  if (value !== "bootstrap" && value !== "foundation") invalid("opentofu-authority-class-invalid");
}

function requireExactApplyCommand(command: readonly string[]): void {
  if (
    command.length !== EXACT_SAVED_PLAN_APPLY_COMMAND.length ||
    command.some((value, index) => value !== EXACT_SAVED_PLAN_APPLY_COMMAND[index])
  ) {
    invalid("opentofu-apply-command-not-exact");
  }
}

function requireSameBackend(
  actual: ActivationConfiguration["policy"]["backend"],
  expected: ActivationConfiguration["policy"]["backend"],
): void {
  if (
    actual.type !== expected.type ||
    actual.resourceGroupName !== expected.resourceGroupName ||
    actual.storageAccountName !== expected.storageAccountName ||
    actual.containerName !== expected.containerName ||
    actual.key !== expected.key
  )
    invalid("opentofu-backend-mismatch");
}

function requireSameState(actual: StateIdentity, expected: StateIdentity, code: string): void {
  validateStateIdentity(actual, "opentofu.state");
  if (
    actual.backendStateDigest !== expected.backendStateDigest ||
    actual.backendStateEtag !== expected.backendStateEtag ||
    actual.lineage !== expected.lineage ||
    actual.serial !== expected.serial ||
    actual.managedResourceCount !== expected.managedResourceCount ||
    actual.managedResourcesEmpty !== expected.managedResourcesEmpty
  )
    invalid(code);
}

function processResultDigest(result: OpenTofuProcessResult): string {
  return sha256Text(
    `${JSON.stringify({
      exit_code: result.exitCode,
      stderr_sha256: sha256Bytes(result.stderr),
      stdout_sha256: sha256Bytes(result.stdout),
    })}\n`,
  );
}

function classifyApplyFailure(stderr: Uint8Array): "failed" | "native-lock-failed" | "stale-plan" {
  const text = decodeUtf8(stderr, "opentofu-apply-stderr");
  if (/Error acquiring the state lock|state blob is already locked/i.test(text))
    return "native-lock-failed";
  if (/Saved plan is stale|Saved plan does not match the given state/i.test(text))
    return "stale-plan";
  return "failed";
}

function classifyPlanFailure(stdout: Uint8Array, stderr: Uint8Array): string {
  const text = `${decodeUtf8(stdout, "opentofu-plan-stdout")}\n${decodeUtf8(
    stderr,
    "opentofu-plan-stderr",
  )}`;
  if (/Microsoft\.OperationalInsights\/workspaces\/query\/read/i.test(text)) {
    return "opentofu-plan-log-query-permission-denied";
  }
  if (/Microsoft\.OperationalInsights\/workspaces\/sharedKeys\/action/i.test(text)) {
    return "opentofu-plan-log-shared-key-permission-denied";
  }
  if (/Microsoft\.Web\/sites\/config\/list\/action/i.test(text)) {
    return "opentofu-plan-function-config-permission-denied";
  }
  if (/Microsoft\.Storage\/storageAccounts\/listKeys\/action/i.test(text)) {
    return "opentofu-plan-storage-key-permission-denied";
  }
  if (
    /AuthorizationFailed|does not have authorization to perform action|(?:status|status code)\D*403/i.test(
      text,
    )
  ) {
    return "opentofu-plan-authorization-failed";
  }
  if (/Error acquiring the state lock|LeaseIdMissing|state blob is locked/i.test(text)) {
    return "opentofu-plan-native-lock-failed";
  }
  if (/MissingSubscriptionRegistration/i.test(text)) {
    return "opentofu-plan-provider-not-registered";
  }
  if (/ResourceNotFound|ResourceGroupNotFound|(?:status|status code)\D*404/i.test(text)) {
    return "opentofu-plan-resource-not-found";
  }
  if (/Provider produced inconsistent|inconsistent result/i.test(text)) {
    return "opentofu-plan-provider-inconsistent";
  }
  if (/TooManyRequests|(?:status|status code)\D*429|temporarily unavailable/i.test(text)) {
    return "opentofu-plan-transient-service-failure";
  }
  if (
    /connection reset|context deadline exceeded|TLS handshake timeout|dial tcp|no such host/i.test(
      text,
    )
  ) {
    return "opentofu-plan-network-failure";
  }
  if (
    /Failed to load plugin schemas|Plugin did not respond|failed to instantiate provider/i.test(
      text,
    )
  ) {
    return "opentofu-plan-provider-runtime-failure";
  }
  if (
    /Error:\s*(?:Invalid|Unsupported|Missing required|Duplicate|Cycle|Reference to undeclared|Inconsistent dependency lock file)/i.test(
      text,
    )
  ) {
    return "opentofu-plan-configuration-failed";
  }
  if (
    /Error:\s*(?:reading|retrieving|getting|listing|checking|looking up|querying|loading)\b/i.test(
      text,
    )
  ) {
    return "opentofu-plan-resource-refresh-failed";
  }
  return "opentofu-plan-failed";
}

function decodeUtf8(bytes: Uint8Array, code: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return invalid(`${code}-not-utf8`);
  }
}

function scrubEnvironment(env: Record<string, string>): void {
  if (Object.hasOwn(env, "ARM_OIDC_TOKEN")) env.ARM_OIDC_TOKEN = "";
  for (const key of Object.keys(env)) delete env[key];
}

function invalid(code: string): never {
  throw new InfrastructureApprovalError(code);
}
