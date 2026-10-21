#!/usr/bin/env node
import { constants } from "node:fs";
import { open } from "node:fs/promises";

import {
  AzureCliRecoveryTransport,
  recoverAzureAllocation,
  RecoverySafetyError,
  ReducedGitHubRecoveryPort,
} from "./index.js";

let auditContext: { readonly allocationId: string; readonly auditFile: string } | null = null;
try {
  const options = parseArguments(process.argv.slice(2));
  auditContext = { allocationId: options.allocationId, auditFile: options.auditFile };
  if (options.subscriptionId !== requiredRecoverySubscription(process.env)) {
    throw new RecoverySafetyError(
      "subscription does not match the reviewed recovery configuration",
    );
  }
  await writeAudit(options.auditFile, {
    allocation_id: options.allocationId,
    event: "switchyard-owner-recovery",
    ledger_settlement_required: true,
    result_code: options.execute ? "execute-started" : "dry-run-started",
  });
  const result = await recoverAzureAllocation(
    options,
    new AzureCliRecoveryTransport({ subscriptionId: options.subscriptionId }),
    options.execute
      ? new ReducedGitHubRecoveryPort({ token: requiredRunnerToken(process.env) })
      : {
          fenceExactRunnerLabel: async () => {
            throw new RecoverySafetyError("dry run cannot mutate GitHub");
          },
        },
  );
  await writeAudit(options.auditFile, {
    allocation_id: options.allocationId,
    event: "switchyard-owner-recovery",
    ledger_settlement_required: true,
    plan_hash: result.planHash,
    result_code: result.status,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!options.execute) {
    process.stderr.write(
      "Dry run only. Re-run through Doppler with --execute, the plan hash, provider VM ID and literal confirmation.\n",
    );
  }
} catch (error) {
  const message =
    error instanceof RecoverySafetyError ? error.message : "unexpected recovery failure";
  process.stderr.write(`Switchyard recovery stopped safely: ${message}\n`);
  if (auditContext !== null) {
    try {
      await writeAudit(auditContext.auditFile, {
        allocation_id: auditContext.allocationId,
        event: "switchyard-owner-recovery",
        ledger_settlement_required: true,
        result_code: "stopped-safely",
      });
    } catch {
      process.stderr.write("Switchyard recovery could not write its private audit record.\n");
    }
  }
  process.exitCode = 1;
}

function parseArguments(arguments_: readonly string[]) {
  const allowed = new Set([
    "--allocation-id",
    "--audit-file",
    "--confirm",
    "--execute",
    "--plan-hash",
    "--provider-vm-id",
    "--subscription",
  ]);
  const values = new Map<string, string>();
  let execute = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined || !allowed.has(argument))
      throw new RecoverySafetyError("unknown argument");
    if (argument === "--execute") {
      if (execute) throw new RecoverySafetyError("duplicate execute argument");
      execute = true;
      continue;
    }
    if (values.has(argument)) throw new RecoverySafetyError("duplicate argument");
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new RecoverySafetyError("argument value is missing");
    values.set(argument, value);
    index += 1;
  }
  const allocationId = values.get("--allocation-id");
  const subscriptionId = values.get("--subscription");
  const auditFile = values.get("--audit-file");
  if (allocationId === undefined || subscriptionId === undefined || auditFile === undefined) {
    throw new RecoverySafetyError("--allocation-id, --subscription and --audit-file are required");
  }
  const confirmation = values.get("--confirm");
  const expectedPlanHash = values.get("--plan-hash");
  const expectedProviderVmId = values.get("--provider-vm-id");
  return {
    allocationId,
    auditFile,
    ...(confirmation === undefined ? {} : { confirmation }),
    execute,
    ...(expectedPlanHash === undefined ? {} : { expectedPlanHash }),
    ...(expectedProviderVmId === undefined ? {} : { expectedProviderVmId }),
    subscriptionId,
  };
}

function requiredRunnerToken(environment: NodeJS.ProcessEnv): string {
  const token = environment.SWITCHYARD_GITHUB_RUNNER_TOKEN;
  if (typeof token !== "string" || token.length < 32 || token.length > 16_384) {
    throw new RecoverySafetyError(
      "execute requires SWITCHYARD_GITHUB_RUNNER_TOKEN from the reviewed Doppler owner config",
    );
  }
  return token;
}

function requiredRecoverySubscription(environment: NodeJS.ProcessEnv): string {
  const subscriptionId = environment.SWITCHYARD_RECOVERY_SUBSCRIPTION_ID;
  if (
    typeof subscriptionId !== "string" ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(subscriptionId)
  ) {
    throw new RecoverySafetyError(
      "SWITCHYARD_RECOVERY_SUBSCRIPTION_ID must be the reviewed dedicated subscription",
    );
  }
  return subscriptionId;
}

async function writeAudit(path: string, event: Readonly<Record<string, unknown>>): Promise<void> {
  if (!path.startsWith("/") || path.length > 1024) {
    throw new RecoverySafetyError("audit file must be an absolute bounded path");
  }
  const handle = await open(
    path,
    constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_WRONLY,
    0o600,
  );
  try {
    const status = await handle.stat();
    if (!status.isFile() || (status.mode & 0o777) !== 0o600 || status.uid !== process.geteuid?.()) {
      throw new RecoverySafetyError("audit file must be an owner-only regular file");
    }
    await handle.writeFile(
      `${JSON.stringify({ ...event, timestamp: new Date().toISOString() })}\n`,
      {
        encoding: "utf8",
      },
    );
  } finally {
    await handle.close();
  }
}
