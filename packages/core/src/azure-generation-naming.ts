import type { AzurePilotZone } from "./allocation-ledger.js";

export interface AzureGenerationOneNames {
  readonly baseDeploymentIdByZone: Readonly<Record<AzurePilotZone, string>>;
  readonly baseDeploymentNameByZone: Readonly<Record<AzurePilotZone, string>>;
  readonly childDeploymentId: string;
  readonly childDeploymentName: string;
  readonly jitDeploymentId: string;
  readonly jitDeploymentName: string;
  readonly jitMintIntentId: string;
  readonly resourceGroupId: string;
  readonly resourceGroupName: string;
  readonly scheduleCorrelationId: string;
  readonly vmName: string;
  readonly vmResourceId: string;
}

/**
 * Deterministic names used before any billable side effect. The same immutable
 * allocation identity always recovers the same generation-one operation.
 */
export function azureGenerationOneNames(input: {
  readonly allocationId: string;
  readonly subscriptionId: string;
}): AzureGenerationOneNames {
  const match = /^sy1-([a-f0-9]{64})$/.exec(input.allocationId);
  if (match === null) throw new TypeError("allocationId is not a canonical Switchyard ID");
  if (!/^[A-Za-z0-9-]{1,64}$/.test(input.subscriptionId)) {
    throw new TypeError("subscriptionId is not a bounded Azure subscription identifier");
  }
  const digest = match[1];
  if (digest === undefined) throw new TypeError("allocationId digest is missing");
  const stem = `sy-${digest.slice(0, 24)}-g1`;
  const resourceGroupName = `rg-switchyard-allocation-${digest.slice(0, 24)}`;
  const resourceGroupId = `/subscriptions/${input.subscriptionId}/resourceGroups/${resourceGroupName}`;
  const baseDeploymentNameByZone = Object.freeze({
    "1": `${stem}-z1`,
    "2": `${stem}-z2`,
    "3": `${stem}-z3`,
  });
  const generationStem = digest.slice(0, 20);
  const childDeploymentName = `switchyard-allocation-${generationStem}-g1`;
  const vmName = `swy-${generationStem}-g1`;
  return Object.freeze({
    baseDeploymentIdByZone: Object.freeze({
      "1": `/subscriptions/${input.subscriptionId}/providers/Microsoft.Resources/deployments/${baseDeploymentNameByZone["1"]}`,
      "2": `/subscriptions/${input.subscriptionId}/providers/Microsoft.Resources/deployments/${baseDeploymentNameByZone["2"]}`,
      "3": `/subscriptions/${input.subscriptionId}/providers/Microsoft.Resources/deployments/${baseDeploymentNameByZone["3"]}`,
    }),
    baseDeploymentNameByZone,
    childDeploymentId: `${resourceGroupId}/providers/Microsoft.Resources/deployments/${childDeploymentName}`,
    childDeploymentName,
    jitDeploymentId: `${resourceGroupId}/providers/Microsoft.Resources/deployments/${stem}-jit`,
    jitDeploymentName: `${stem}-jit`,
    jitMintIntentId: `${stem}-jit-mint`,
    resourceGroupId,
    resourceGroupName,
    scheduleCorrelationId: `${stem}-completeby`,
    vmName,
    vmResourceId: `${resourceGroupId}/providers/Microsoft.Compute/virtualMachines/${vmName}`,
  });
}
