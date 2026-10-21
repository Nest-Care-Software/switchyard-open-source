import { readFile } from "node:fs/promises";

import { parseStrictJsonObject, requireExactKeys, requireRecord } from "@switchyard/core";

import type { AzureApprovalStorageConfig } from "./azure-live.js";
import {
  azureUuid,
  commitSha,
  type InfrastructureApprovalPolicy,
  InfrastructureApprovalError,
  sha256,
  sha256Bytes,
} from "./contracts.js";

export const ACTIVATION_CONFIGURATION_PATH = "infra/foundation/activation.json" as const;
// Synthetic preview authority. Live use requires a reviewed replacement of the complete tuple.
export const EXPECTED_SUBSCRIPTION_ID = "a0000000-0000-4000-8000-000000000001" as const;
export const EXPECTED_TENANT_ID = "a0000000-0000-4000-8000-000000000002" as const;
export const DISABLED_ENGINE_SHA = "49be281fc0d6c2cf746a0ce0f6db517d0ac821af" as const;
export const PLANNER_AUDIENCE = "api://switchyard-900000003/infrastructure/planner" as const;
export const FOUNDATION_AUDIENCE =
  "api://switchyard-900000003/infrastructure/foundation-applier" as const;
export const BOOTSTRAP_AUDIENCE =
  "api://switchyard-900000003/infrastructure/bootstrap-applier" as const;
export const STATE_RESOURCE_GROUP_NAME = "rg-switchyard-example-state" as const;
export const STATE_STORAGE_ACCOUNT_NAME = "swexampleapprovalstate" as const;
export const STATE_CONTAINER_NAME = "tfstate" as const;
export const STATE_BLOB_NAME = "switchyard/azure-pilot.tfstate" as const;
export const RECEIPT_STORAGE_ACCOUNT_NAME = "swexampleapprovalreceipt" as const;
export const RECEIPT_CONTAINER_NAME = "plan-receipts" as const;
export const APPLY_CONTROL_STORAGE_ACCOUNT_NAME = STATE_STORAGE_ACCOUNT_NAME;
export const APPLY_CONTROL_CONTAINER_NAME = "apply-control" as const;
export const FOUNDATION_DEPLOYMENT_NAME = "switchyard-approval-foundation" as const;
export const FOUNDATION_TEMPLATE_SHA256 =
  "2174aaf0d6f619a526d2f27782caa80fb435d86a899228744e34976da16b7ba5" as const;

const ACTIVATION_KEYS = [
  "subscription_id",
  "tenant_id",
  "final_engine_sha",
  "audiences",
  "identities",
  "backend",
  "receipts",
  "control",
  "foundation",
] as const;

export interface ActivationIdentity {
  readonly clientId: string;
  readonly principalId: string;
}

export interface ActivationConfiguration {
  readonly canonicalBytes: Uint8Array;
  readonly digest: string;
  readonly finalEngineSha: string;
  readonly policy: InfrastructureApprovalPolicy;
  readonly storage: AzureApprovalStorageConfig;
}

export async function readActivationConfiguration(path: string): Promise<ActivationConfiguration> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch {
    throw new InfrastructureApprovalError("activation-configuration-absent");
  }
  return parseActivationConfiguration(bytes);
}

export function parseActivationConfiguration(bytes: Uint8Array): ActivationConfiguration {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 2 || bytes.byteLength > 64 * 1_024) {
    throw new InfrastructureApprovalError("activation-configuration-size-invalid");
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new InfrastructureApprovalError("activation-configuration-not-utf8");
  }
  if (containsSecretLikeMaterial(source)) {
    throw new InfrastructureApprovalError("activation-configuration-secret-like-value");
  }
  const value = parseStrictJsonObject(source, ACTIVATION_KEYS, {
    maxBytes: 64 * 1_024,
    maxDepth: 5,
    path: "activation",
  });
  requireExactKeys(value, ACTIVATION_KEYS, "activation");
  requireLiteral(value.subscription_id, EXPECTED_SUBSCRIPTION_ID, "subscription-id");
  requireLiteral(value.tenant_id, EXPECTED_TENANT_ID, "tenant-id");
  const finalEngineSha = commitSha(value.final_engine_sha, "activation.final_engine_sha");
  if (finalEngineSha === DISABLED_ENGINE_SHA || /^([0-9a-f])\1{39}$/.test(finalEngineSha)) {
    throw new InfrastructureApprovalError("activation-engine-sha-disabled-or-placeholder");
  }

  const audiences = requireRecord(value.audiences, "activation.audiences");
  requireExactKeys(
    audiences,
    ["planner", "foundation_applier", "bootstrap_applier"],
    "activation.audiences",
  );
  requireLiteral(audiences.planner, PLANNER_AUDIENCE, "planner-audience");
  requireLiteral(audiences.foundation_applier, FOUNDATION_AUDIENCE, "foundation-audience");
  requireLiteral(audiences.bootstrap_applier, BOOTSTRAP_AUDIENCE, "bootstrap-audience");

  const identities = requireRecord(value.identities, "activation.identities");
  requireExactKeys(
    identities,
    ["planner", "foundation_applier", "bootstrap_applier"],
    "activation.identities",
  );
  const planner = parseIdentity(identities.planner, "activation.identities.planner");
  const foundation = parseIdentity(
    identities.foundation_applier,
    "activation.identities.foundation_applier",
  );
  const bootstrap = parseIdentity(
    identities.bootstrap_applier,
    "activation.identities.bootstrap_applier",
  );
  const allIdentityIds = [
    planner.clientId,
    planner.principalId,
    foundation.clientId,
    foundation.principalId,
    bootstrap.clientId,
    bootstrap.principalId,
  ];
  if (new Set(allIdentityIds).size !== allIdentityIds.length) {
    throw new InfrastructureApprovalError("activation-identity-ids-not-distinct");
  }

  const backend = requireRecord(value.backend, "activation.backend");
  requireExactKeys(
    backend,
    ["resource_group_name", "storage_account_name", "container_name", "blob_name"],
    "activation.backend",
  );
  requireLiteral(backend.resource_group_name, STATE_RESOURCE_GROUP_NAME, "backend-resource-group");
  requireLiteral(
    backend.storage_account_name,
    STATE_STORAGE_ACCOUNT_NAME,
    "backend-storage-account",
  );
  requireLiteral(backend.container_name, STATE_CONTAINER_NAME, "backend-container");
  requireLiteral(backend.blob_name, STATE_BLOB_NAME, "backend-blob");

  const receipts = requireRecord(value.receipts, "activation.receipts");
  requireExactKeys(receipts, ["storage_account_name", "container_name"], "activation.receipts");
  requireLiteral(
    receipts.storage_account_name,
    RECEIPT_STORAGE_ACCOUNT_NAME,
    "receipt-storage-account",
  );
  requireLiteral(receipts.container_name, RECEIPT_CONTAINER_NAME, "receipt-container");

  const control = requireRecord(value.control, "activation.control");
  requireExactKeys(control, ["storage_account_name", "container_name"], "activation.control");
  requireLiteral(
    control.storage_account_name,
    APPLY_CONTROL_STORAGE_ACCOUNT_NAME,
    "control-storage-account",
  );
  requireLiteral(control.container_name, APPLY_CONTROL_CONTAINER_NAME, "control-container");

  const foundationDeployment = requireRecord(value.foundation, "activation.foundation");
  requireExactKeys(
    foundationDeployment,
    ["deployment_name", "template_sha256"],
    "activation.foundation",
  );
  requireLiteral(
    foundationDeployment.deployment_name,
    FOUNDATION_DEPLOYMENT_NAME,
    "foundation-deployment-name",
  );
  requireLiteral(
    sha256(foundationDeployment.template_sha256, "activation.foundation.template_sha256"),
    FOUNDATION_TEMPLATE_SHA256,
    "foundation-template-digest",
  );

  const canonicalSource = canonicalActivationSource({
    bootstrap,
    finalEngineSha,
    foundation,
    planner,
  });
  if (source !== canonicalSource) {
    throw new InfrastructureApprovalError("activation-configuration-not-canonical");
  }
  const canonicalBytes = new TextEncoder().encode(canonicalSource);
  const digest = sha256Bytes(canonicalBytes);
  const policy: InfrastructureApprovalPolicy = Object.freeze({
    activationConfigDigest: digest,
    applyEngineSha: finalEngineSha,
    backend: Object.freeze({
      containerName: STATE_CONTAINER_NAME,
      key: STATE_BLOB_NAME,
      resourceGroupName: STATE_RESOURCE_GROUP_NAME,
      storageAccountName: STATE_STORAGE_ACCOUNT_NAME,
      type: "azurerm" as const,
    }),
    bootstrapAudience: BOOTSTRAP_AUDIENCE,
    bootstrapIdentityClientId: bootstrap.clientId,
    bootstrapIdentityPrincipalId: bootstrap.principalId,
    dedicatedSubscriptionConfirmed: true as const,
    foundationAudience: FOUNDATION_AUDIENCE,
    foundationIdentityClientId: foundation.clientId,
    foundationIdentityPrincipalId: foundation.principalId,
    planEngineSha: finalEngineSha,
    plannerAudience: PLANNER_AUDIENCE,
    plannerIdentityClientId: planner.clientId,
    plannerIdentityPrincipalId: planner.principalId,
    subscriptionId: EXPECTED_SUBSCRIPTION_ID,
    tenantId: EXPECTED_TENANT_ID,
  });
  const storage: AzureApprovalStorageConfig = Object.freeze({
    applyControlContainerName: APPLY_CONTROL_CONTAINER_NAME,
    receiptContainerName: RECEIPT_CONTAINER_NAME,
    receiptStorageAccountName: RECEIPT_STORAGE_ACCOUNT_NAME,
    stateBackend: policy.backend,
  });
  return Object.freeze({ canonicalBytes, digest, finalEngineSha, policy, storage });
}

export function canonicalActivationSource(input: {
  readonly bootstrap: ActivationIdentity;
  readonly finalEngineSha: string;
  readonly foundation: ActivationIdentity;
  readonly planner: ActivationIdentity;
}): string {
  return `${JSON.stringify({
    subscription_id: EXPECTED_SUBSCRIPTION_ID,
    tenant_id: EXPECTED_TENANT_ID,
    final_engine_sha: input.finalEngineSha,
    audiences: {
      planner: PLANNER_AUDIENCE,
      foundation_applier: FOUNDATION_AUDIENCE,
      bootstrap_applier: BOOTSTRAP_AUDIENCE,
    },
    identities: {
      planner: identityJson(input.planner),
      foundation_applier: identityJson(input.foundation),
      bootstrap_applier: identityJson(input.bootstrap),
    },
    backend: {
      resource_group_name: STATE_RESOURCE_GROUP_NAME,
      storage_account_name: STATE_STORAGE_ACCOUNT_NAME,
      container_name: STATE_CONTAINER_NAME,
      blob_name: STATE_BLOB_NAME,
    },
    receipts: {
      storage_account_name: RECEIPT_STORAGE_ACCOUNT_NAME,
      container_name: RECEIPT_CONTAINER_NAME,
    },
    control: {
      storage_account_name: APPLY_CONTROL_STORAGE_ACCOUNT_NAME,
      container_name: APPLY_CONTROL_CONTAINER_NAME,
    },
    foundation: {
      deployment_name: FOUNDATION_DEPLOYMENT_NAME,
      template_sha256: FOUNDATION_TEMPLATE_SHA256,
    },
  })}\n`;
}

export function requireCommittedActivationConfiguration(
  policy: InfrastructureApprovalPolicy,
  bytes: Uint8Array,
): void {
  const committed = parseActivationConfiguration(bytes);
  if (committed.digest !== policy.activationConfigDigest || !samePolicy(committed.policy, policy)) {
    throw new InfrastructureApprovalError("committed-activation-configuration-mismatch");
  }
}

function samePolicy(
  left: InfrastructureApprovalPolicy,
  right: InfrastructureApprovalPolicy,
): boolean {
  return (
    left.activationConfigDigest === right.activationConfigDigest &&
    left.applyEngineSha === right.applyEngineSha &&
    left.bootstrapAudience === right.bootstrapAudience &&
    left.bootstrapIdentityClientId === right.bootstrapIdentityClientId &&
    left.bootstrapIdentityPrincipalId === right.bootstrapIdentityPrincipalId &&
    left.dedicatedSubscriptionConfirmed === right.dedicatedSubscriptionConfirmed &&
    left.foundationAudience === right.foundationAudience &&
    left.foundationIdentityClientId === right.foundationIdentityClientId &&
    left.foundationIdentityPrincipalId === right.foundationIdentityPrincipalId &&
    left.planEngineSha === right.planEngineSha &&
    left.plannerAudience === right.plannerAudience &&
    left.plannerIdentityClientId === right.plannerIdentityClientId &&
    left.plannerIdentityPrincipalId === right.plannerIdentityPrincipalId &&
    left.subscriptionId === right.subscriptionId &&
    left.tenantId === right.tenantId &&
    left.backend.type === right.backend.type &&
    left.backend.resourceGroupName === right.backend.resourceGroupName &&
    left.backend.storageAccountName === right.backend.storageAccountName &&
    left.backend.containerName === right.backend.containerName &&
    left.backend.key === right.backend.key
  );
}

function parseIdentity(value: unknown, path: string): ActivationIdentity {
  const record = requireRecord(value, path);
  requireExactKeys(record, ["client_id", "principal_id"], path);
  return Object.freeze({
    clientId: azureUuid(record.client_id, `${path}.client_id`),
    principalId: azureUuid(record.principal_id, `${path}.principal_id`),
  });
}

function identityJson(value: ActivationIdentity): Record<string, string> {
  return { client_id: value.clientId, principal_id: value.principalId };
}

function requireLiteral(value: unknown, expected: string, code: string): void {
  if (value !== expected) throw new InfrastructureApprovalError(`activation-${code}-mismatch`);
}

function containsSecretLikeMaterial(source: string): boolean {
  return /(?:client[_-]?secret|access[_-]?token|refresh[_-]?token|private[_-]?key|password|sas[_-]?token|certificate)/i.test(
    source,
  );
}
