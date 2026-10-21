#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { parseStrictJsonObject, requireExactKeys } from "@switchyard/core";

import { InfrastructureApplyEngine } from "./apply-engine.js";
import { ACTIVATION_CONFIGURATION_PATH, readActivationConfiguration } from "./activation.js";
import {
  DeterministicPlanArchiveBuilder,
  LiveLocalPlanBundlePublicationPort,
} from "./artifact-live.js";
import {
  AzureApprovalBlobTransport,
  LiveAzureApplyIntentReceiptPort,
  LiveAzureApplyLeasePort,
  LiveAzureAuthoritativeStatePort,
  LiveAzureInitialStateBootstrap,
  LiveAzurePlannerStatePort,
  LiveAzurePrivatePlanReceiptPort,
} from "./azure-live.js";
import { commitSha, decimalId, exactString, InfrastructureApprovalError } from "./contracts.js";
import { LiveGitHubOidcEntraExchange } from "./entra-live.js";
import {
  LiveGitHubOidcTokenRequester,
  LiveGitHubOidcTokenVerifier,
  LiveGitHubPlanBundleEvidence,
  LiveInfrastructureGitHubEvidence,
} from "./github-live.js";
import { InfrastructureInitialStateEngine } from "./initial-state-engine.js";
import { LiveOpenTofuRuntime } from "./opentofu-live.js";
import { InfrastructurePlanEngine } from "./plan-engine.js";

const OPERATIONS = ["plan", "apply-saved-plan", "initialise-state"] as const;
const STDIN_LIMIT = 32 * 1024;
const ENVIRONMENT_VALUE_LIMIT = 128 * 1024;

type Operation = (typeof OPERATIONS)[number];

interface CliContext {
  readonly githubSha: string;
  readonly githubRunId: string;
  readonly githubToken: string;
  readonly githubWorkflowSha: string;
  readonly oidcRequestToken: string;
  readonly oidcRequestUrl: string;
  readonly runnerTemp: string;
  readonly targetConfiguration?: Uint8Array;
  readonly functionPackagePath?: string;
  readonly workspaceRoot: string;
}

type CliRequest =
  | {
      readonly authorityClass: "bootstrap" | "foundation";
      readonly jobCheckRunId: string;
      readonly operation: "plan";
    }
  | {
      readonly approvalInputsJson: string;
      readonly jobCheckRunId: string;
      readonly operation: "apply-saved-plan";
    }
  | {
      readonly jobCheckRunId: string;
      readonly operation: "initialise-state";
    };

export async function runInfrastructureApprovalCli(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
  inputBytes: Uint8Array,
): Promise<Record<string, unknown>> {
  if (argv.length !== 1 || !OPERATIONS.includes(argv[0] as Operation)) {
    throw new InfrastructureApprovalError("cli-operation-invalid");
  }
  const transportOperation = argv[0] as Operation;
  const request = parseCliRequest(inputBytes, transportOperation);
  const context = readCliContext(environment, request.operation);
  const activationPath = resolve(context.workspaceRoot, ACTIVATION_CONFIGURATION_PATH);
  if (activationPath !== `${context.workspaceRoot}/${ACTIVATION_CONFIGURATION_PATH}`) {
    throw new InfrastructureApprovalError("cli-activation-path-invalid");
  }
  const activation = await readActivationConfiguration(activationPath);
  const github = new LiveInfrastructureGitHubEvidence({ token: context.githubToken });
  const requester = new LiveGitHubOidcTokenRequester({
    requestToken: context.oidcRequestToken,
    requestUrl: context.oidcRequestUrl,
  });
  const verifier = new LiveGitHubOidcTokenVerifier();
  const entra = new LiveGitHubOidcEntraExchange();
  const transport = new AzureApprovalBlobTransport();
  const plannerState = new LiveAzurePlannerStatePort({
    config: activation.storage,
    policy: activation.policy,
    transport,
  });
  const authoritativeState = new LiveAzureAuthoritativeStatePort({
    config: activation.storage,
    policy: activation.policy,
    transport,
  });

  if (request.operation === "initialise-state") {
    const bootstrap = new LiveAzureInitialStateBootstrap({
      config: activation.storage,
      policy: activation.policy,
      transport,
    });
    const engine = new InfrastructureInitialStateEngine(
      activation.policy,
      github,
      requester,
      verifier,
      entra,
      bootstrap,
    );
    const result = await engine.initialise({
      commitSha: context.githubSha,
      jobCheckRunId: request.jobCheckRunId,
      jobWorkflowSha: context.githubWorkflowSha,
      runId: context.githubRunId,
    });
    return Object.freeze({
      backend_state_sha256: result.backendStateDigest,
      backend_state_etag: result.backendStateEtag,
      lineage: result.lineage,
      record_etag: result.recordEtag,
      serial: result.serial,
      status: result.status,
    });
  }

  if (context.targetConfiguration === undefined) {
    throw new InfrastructureApprovalError("cli-target-configuration-absent");
  }
  const tofu = new LiveOpenTofuRuntime({
    activation,
    authoritativeState,
    ...(context.functionPackagePath === undefined
      ? {}
      : { functionPackagePath: context.functionPackagePath }),
    plannerState,
    runnerTemp: context.runnerTemp,
    targetConfigurationBytes: context.targetConfiguration,
    workspaceRoot: context.workspaceRoot,
  });
  if (request.operation === "plan") {
    const publisher = new LiveLocalPlanBundlePublicationPort(
      `${context.runnerTemp}/switchyard-plan-publication`,
    );
    const engine = new InfrastructurePlanEngine(
      activation.policy,
      github,
      requester,
      verifier,
      entra,
      tofu,
      plannerState,
      new DeterministicPlanArchiveBuilder(),
      publisher,
    );
    const result = await engine.createBundle({
      authorityClass: request.authorityClass,
      commitSha: context.githubSha,
      jobCheckRunId: request.jobCheckRunId,
      jobWorkflowSha: context.githubWorkflowSha,
      runId: context.githubRunId,
    });
    return Object.freeze({
      artifact_name: result.artifactName,
      artifact_path: result.artifactPath,
      artifact_sha256: result.artifactDigest,
      manifest_sha256: result.manifestDigest,
      plan_sha256: result.planDigest,
      status: "planned",
    });
  }

  const bundles = new LiveGitHubPlanBundleEvidence({ token: context.githubToken });
  const receipts = new LiveAzurePrivatePlanReceiptPort({
    config: activation.storage,
    policy: activation.policy,
    transport,
  });
  const lease = new LiveAzureApplyLeasePort({
    config: activation.storage,
    policy: activation.policy,
    transport,
  });
  const intents = new LiveAzureApplyIntentReceiptPort({
    config: activation.storage,
    policy: activation.policy,
    transport,
  });
  const engine = new InfrastructureApplyEngine(
    activation.policy,
    github,
    bundles,
    receipts,
    requester,
    verifier,
    tofu,
    entra,
    authoritativeState,
    lease,
    intents,
    tofu,
  );
  const result = await engine.apply({
    approvalInputsJson: request.approvalInputsJson,
    approvalRunId: context.githubRunId,
    jobCheckRunId: request.jobCheckRunId,
    jobWorkflowSha: context.githubWorkflowSha,
  });
  return Object.freeze({
    plan_sha256: result.planDigest,
    receipt_sha256: result.receiptDigest,
    replayed: result.replayed,
    result_sha256: result.resultDigest,
    status: result.status,
  });
}

export function parseCliRequest(inputBytes: Uint8Array, operation: Operation): CliRequest {
  if (
    !(inputBytes instanceof Uint8Array) ||
    inputBytes.byteLength < 2 ||
    inputBytes.byteLength > STDIN_LIMIT
  ) {
    throw new InfrastructureApprovalError("cli-input-size-invalid");
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(inputBytes);
  } catch {
    throw new InfrastructureApprovalError("cli-input-not-utf8");
  }
  const planKeys = ["operation", "authorityClass", "jobCheckRunId"] as const;
  const applyKeys = ["operation", "approvalInputsJson", "jobCheckRunId"] as const;
  const initialStateKeys = ["operation", "jobCheckRunId"] as const;
  let value: Record<string, unknown>;
  let keys: readonly string[];
  if (operation === "apply-saved-plan") {
    try {
      value = parseStrictJsonObject(source, applyKeys, {
        maxBytes: STDIN_LIMIT,
        maxDepth: 3,
        path: "cliInput",
      });
      keys = applyKeys;
    } catch (applyError) {
      try {
        value = parseStrictJsonObject(source, initialStateKeys, {
          maxBytes: STDIN_LIMIT,
          maxDepth: 2,
          path: "cliInput",
        });
        keys = initialStateKeys;
      } catch {
        throw applyError;
      }
    }
  } else {
    keys = operation === "plan" ? planKeys : initialStateKeys;
    value = parseStrictJsonObject(source, keys, {
      maxBytes: STDIN_LIMIT,
      maxDepth: 2,
      path: "cliInput",
    });
  }
  if (operation === "apply-saved-plan" && value.operation === "initialise-state") {
    requireExactKeys(value, ["operation", "jobCheckRunId"], "cliInput");
    return Object.freeze({
      jobCheckRunId: decimalId(value.jobCheckRunId, "cliInput.jobCheckRunId"),
      operation: "initialise-state" as const,
    });
  }
  requireExactKeys(value, keys, "cliInput");
  if (value.operation !== operation)
    throw new InfrastructureApprovalError("cli-operation-mismatch");
  const jobCheckRunId = decimalId(value.jobCheckRunId, "cliInput.jobCheckRunId");
  if (operation === "plan") {
    if (value.authorityClass !== "bootstrap" && value.authorityClass !== "foundation") {
      throw new InfrastructureApprovalError("cli-authority-class-invalid");
    }
    return Object.freeze({ authorityClass: value.authorityClass, jobCheckRunId, operation });
  }
  if (operation === "apply-saved-plan") {
    return Object.freeze({
      approvalInputsJson: exactString(
        value.approvalInputsJson,
        "cliInput.approvalInputsJson",
        8 * 1024,
      ),
      jobCheckRunId,
      operation,
    });
  }
  return Object.freeze({ jobCheckRunId, operation });
}

function readCliContext(environment: NodeJS.ProcessEnv, operation: Operation): CliContext {
  if (environment.GITHUB_RUN_ATTEMPT !== "1") {
    throw new InfrastructureApprovalError("cli-rerun-rejected");
  }
  const githubToken = environmentValue(environment, "GITHUB_TOKEN", 16 * 1024, 32);
  const oidcRequestToken = environmentValue(
    environment,
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    16 * 1024,
    32,
  );
  const targetSource =
    operation === "initialise-state"
      ? undefined
      : environmentValue(
          environment,
          "SWITCHYARD_TARGET_CONFIGURATION_JSON",
          ENVIRONMENT_VALUE_LIMIT,
          2,
        );
  const functionPackagePath = optionalEnvironmentValue(
    environment,
    "SWITCHYARD_FUNCTION_PACKAGE_PATH",
    4096,
  );
  const context = Object.freeze({
    githubRunId: decimalId(
      environmentValue(environment, "GITHUB_RUN_ID", 20),
      "environment.GITHUB_RUN_ID",
    ),
    githubSha: commitSha(environmentValue(environment, "GITHUB_SHA", 40), "environment.GITHUB_SHA"),
    githubToken,
    githubWorkflowSha: commitSha(
      environmentValue(environment, "SWITCHYARD_JOB_WORKFLOW_SHA", 40),
      "environment.SWITCHYARD_JOB_WORKFLOW_SHA",
    ),
    oidcRequestToken,
    oidcRequestUrl: environmentValue(environment, "ACTIONS_ID_TOKEN_REQUEST_URL", 2048),
    runnerTemp: absoluteEnvironmentPath(environment, "RUNNER_TEMP"),
    ...(targetSource === undefined
      ? {}
      : { targetConfiguration: new TextEncoder().encode(targetSource) }),
    ...(functionPackagePath === undefined ? {} : { functionPackagePath }),
    workspaceRoot: absoluteEnvironmentPath(environment, "GITHUB_WORKSPACE"),
  });
  for (const key of [
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "GITHUB_TOKEN",
    "SWITCHYARD_JOB_WORKFLOW_SHA",
    "SWITCHYARD_TARGET_CONFIGURATION_JSON",
  ])
    delete environment[key];
  return context;
}

function environmentValue(
  environment: NodeJS.ProcessEnv,
  key: string,
  maximum: number,
  minimum = 1,
): string {
  const value = environment[key];
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    value.includes("\u0000")
  ) {
    throw new InfrastructureApprovalError(`cli-environment-${key.toLowerCase()}-invalid`);
  }
  return value;
}

function optionalEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  key: string,
  maximum: number,
): string | undefined {
  const value = environment[key];
  if (value === undefined) return undefined;
  return environmentValue(environment, key, maximum);
}

function absoluteEnvironmentPath(environment: NodeJS.ProcessEnv, key: string): string {
  const value = environmentValue(environment, key, 4096);
  if (!value.startsWith("/") || resolve(value) !== value) {
    throw new InfrastructureApprovalError(`cli-environment-${key.toLowerCase()}-path-invalid`);
  }
  return value;
}

async function readStdin(): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > STDIN_LIMIT) throw new InfrastructureApprovalError("cli-input-size-invalid");
    chunks.push(bytes);
  }
  return Uint8Array.from(Buffer.concat(chunks));
}

async function main(): Promise<void> {
  try {
    const result = await runInfrastructureApprovalCli(
      process.argv.slice(2),
      process.env,
      await readStdin(),
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code =
      error instanceof InfrastructureApprovalError ? error.code : "runtime-unexpected-failure";
    process.stderr.write(`${JSON.stringify({ error: code, status: "failed" })}\n`);
    process.exitCode = 1;
  }
}

const invokedPath =
  process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) await main();
