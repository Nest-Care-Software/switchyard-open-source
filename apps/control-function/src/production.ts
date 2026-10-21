import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ManagedIdentityCredential } from "@azure/identity";
import { createAzureTableAllocationLedger } from "@switchyard/azure-ledger";
import { AzureGenerationOneWorker } from "@switchyard/azure-worker";
import { AllocationReconciler } from "@switchyard/reconciler";

import { createAdmissionRuntime } from "./admission-live.js";
import {
  AzureRuntimeTransport,
  LiveAzureComputeSchedule,
  LiveAzureGenerationPlanner,
  LiveAzureResourcePort,
} from "./azure-live.js";
import { parseAdmissionRuntimeConfig, parseSafetyRuntimeConfig } from "./config.js";
import { DeferredGitHubSafetyGateway } from "./github-gateway.js";
import { LiveGitHubRunnerRegistration, LiveGitHubWorkloadObservation } from "./github-live.js";
import {
  ManagedIdentityProvisioningQueue,
  QueueDrivenSafetyRuntime,
  SplitControlFunctionRuntime,
} from "./runtime.js";

export async function createProductionRuntime(
  environment: Readonly<Record<string, string | undefined>>,
): Promise<SplitControlFunctionRuntime> {
  // Safety configuration is the process prerequisite. Admission is parsed and
  // constructed later and may remain unavailable without stopping cleanup.
  const safety = parseSafetyRuntimeConfig(environment);
  const credential = new ManagedIdentityCredential(safety.managedIdentityClientId, {
    retryOptions: { maxRetries: 0 },
  });
  const ledger = createAzureTableAllocationLedger({
    accountName: safety.ledger.accountName,
    ledgerInstanceId: safety.ledger.instanceId,
    managedIdentityClientId: safety.managedIdentityClientId,
    schemaVersion: safety.ledger.schemaVersion,
    tableName: safety.ledger.tableName,
  });
  const [baseTemplate, jitTemplate, bootstrap] = await Promise.all([
    loadRuntimeJson("runtime-assets/azure-allocation/main.json", safety.artefacts.templateSha256),
    loadRuntimeJson("runtime-assets/azure-allocation/jit-launch.json"),
    loadRuntimeText("runtime-assets/azure-runner/bootstrap.sh", safety.artefacts.bootstrapSha256),
  ]);
  const transport = new AzureRuntimeTransport({
    credential,
    subscriptionId: safety.azure.subscriptionId,
  });
  const queue = new ManagedIdentityProvisioningQueue({
    accountName: safety.ledger.accountName,
    credential,
    queueName: safety.provisioningQueue,
  });
  let admissionComposition: ReturnType<typeof buildAdmissionComposition> | null = null;
  const loadAdmissionComposition = async () => {
    let loading = admissionComposition;
    if (loading === null) {
      loading = buildAdmissionComposition();
      admissionComposition = loading;
    }
    try {
      return await loading;
    } catch (error) {
      if (admissionComposition === loading) admissionComposition = null;
      throw error;
    }
  };
  const gateway = new DeferredGitHubSafetyGateway(async () => {
    const composed = await loadAdmissionComposition();
    return composed.safety;
  });
  const planning = new LiveAzureGenerationPlanner({
    baseTemplateSha256: safety.artefacts.templateSha256,
    imageVersion: safety.azure.imageVersion,
    nonSecretBootstrapCustomData: bootstrap,
    sharedRunnerSubnetId: safety.runnerSubnetId,
    subscriptionId: safety.azure.subscriptionId,
  });
  const azureResources = new LiveAzureResourcePort({
    baseTemplate,
    baseTemplateSha256: safety.artefacts.templateSha256,
    bootstrapSha256: safety.artefacts.bootstrapSha256,
    imageVersion: safety.azure.imageVersion,
    jitTemplate,
    ledger,
    runnerSubnetId: safety.runnerSubnetId,
    transport,
  });
  const worker = new AzureGenerationOneWorker({
    alerts: redactedWorkerAlerts(),
    azure: azureResources,
    github: gateway,
    ledger,
    planning,
    schedule: new LiveAzureComputeSchedule({ ownership: azureResources, transport }),
  });
  const reconciler = new AllocationReconciler({
    azure: worker,
    github: gateway,
    heartbeat: ledger,
    incidents: redactedReconcilerIncidents(),
    ledger,
    visibility: gateway,
  });
  const safetyRuntime = new QueueDrivenSafetyRuntime({
    queue,
    reconcile: () => reconciler.runCycle(),
    worker,
  });
  return new SplitControlFunctionRuntime({
    admission: async () => (await loadAdmissionComposition()).runtime,
    safety: safetyRuntime,
  });

  async function buildAdmissionComposition() {
    const admission = parseAdmissionRuntimeConfig(environment);
    const composed = await createAdmissionRuntime({
      azureDispatch: { dispatch: (message) => queue.dispatch(message, 0) },
      config: admission,
      credential,
      ledger,
      runtimeInstanceId: safety.runtimeInstanceId,
    });
    return {
      runtime: composed.runtime,
      safety: {
        runner: new LiveGitHubRunnerRegistration({
          clients: composed.clients,
          organisation: admission.github.organisation,
          runnerGroupId: admission.github.runnerGroupId,
        }),
        visibility: composed.visibility,
        workload: new LiveGitHubWorkloadObservation({
          clients: composed.clients,
          repository: {
            id: "900000002",
            name: "example-workload",
            owner: "example-org",
          },
        }),
      },
    };
  }
}

async function loadRuntimeText(path: string, expectedSha256?: string): Promise<string> {
  const bytes = await readFile(join(process.cwd(), path));
  if (expectedSha256 !== undefined) verifyDigest(bytes, expectedSha256);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function loadRuntimeJson(path: string, expectedSha256?: string): Promise<unknown> {
  const text = await loadRuntimeText(path, expectedSha256);
  return JSON.parse(text);
}

function verifyDigest(bytes: Uint8Array, expected: string): void {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) throw new TypeError("runtime artefact digest mismatch");
}

function redactedWorkerAlerts() {
  return {
    raise: async (input: { readonly allocationId: string; readonly code: string }) => {
      console.error(
        JSON.stringify({
          allocation_id: input.allocationId,
          event: "switchyard-safety-incident",
          result_code: input.code,
          stage_code: "azure-worker",
        }),
      );
    },
  };
}

function redactedReconcilerIncidents() {
  return {
    raise: async (input: {
      readonly allocationId: string | null;
      readonly classification: string;
    }) => {
      console.error(
        JSON.stringify({
          ...(input.allocationId === null ? {} : { allocation_id: input.allocationId }),
          event: "switchyard-safety-incident",
          result_code: input.classification,
          stage_code: "reconciler",
        }),
      );
    },
  };
}
