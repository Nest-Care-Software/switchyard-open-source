import { ContractValidationError, parseStrictJson, requireRecord } from "@switchyard/core";

import {
  exactString,
  InfrastructureApprovalError,
  type PlanAuthorityClass,
  type StateIdentity,
  sha256Text,
  validateStateIdentity,
} from "./contracts.js";

const PLAN_JSON_MAX_BYTES = 1_024 * 1_024;
const MAX_RESOURCES = 4_096;

export interface PlanChangeSummary {
  readonly authority: number;
  readonly create: number;
  readonly delete: number;
  readonly read: number;
  readonly replace: number;
  readonly update: number;
}

export interface OpenTofuPlanClassification {
  readonly destructive: boolean;
  readonly priorManagedResourceCount: number;
  readonly priorStateDigest: string;
  readonly summary: PlanChangeSummary;
}

type AuthorityClassification = "authority" | "compound" | "routine";

const AZURERM_TYPES: Readonly<Record<string, AuthorityClassification>> = Object.freeze({
  azurerm_api_management_authorization_server: "authority",
  azurerm_api_management_identity_provider_aad: "authority",
  azurerm_api_management_identity_provider_aadb2c: "authority",
  azurerm_api_management_identity_provider_facebook: "authority",
  azurerm_api_management_identity_provider_google: "authority",
  azurerm_api_management_identity_provider_microsoft: "authority",
  azurerm_api_management_identity_provider_twitter: "authority",
  azurerm_api_management_named_value: "authority",
  azurerm_application_insights: "routine",
  azurerm_app_configuration_key: "authority",
  azurerm_automation_certificate: "authority",
  azurerm_automation_connection: "authority",
  azurerm_automation_credential: "authority",
  azurerm_automation_variable_string: "authority",
  azurerm_container_registry_scope_map: "authority",
  azurerm_container_registry_token: "authority",
  azurerm_cosmosdb_sql_role_assignment: "authority",
  azurerm_cosmosdb_sql_role_definition: "authority",
  azurerm_data_factory_credential_service_principal: "authority",
  azurerm_data_factory_credential_user_managed_identity: "authority",
  azurerm_federated_identity_credential: "authority",
  azurerm_key_vault: "compound",
  azurerm_key_vault_access_policy: "authority",
  azurerm_key_vault_certificate: "authority",
  azurerm_key_vault_key: "authority",
  azurerm_key_vault_secret: "authority",
  azurerm_kubernetes_cluster_trusted_access_role_binding: "authority",
  azurerm_lighthouse_assignment: "authority",
  azurerm_lighthouse_definition: "authority",
  azurerm_linux_function_app: "compound",
  azurerm_log_analytics_workspace: "routine",
  azurerm_management_group_policy_assignment: "authority",
  azurerm_management_group_policy_definition: "authority",
  azurerm_management_group_policy_remediation: "authority",
  azurerm_management_lock: "authority",
  azurerm_monitor_action_group: "routine",
  azurerm_monitor_diagnostic_setting: "routine",
  azurerm_monitor_metric_alert: "routine",
  azurerm_monitor_scheduled_query_rules_alert_v2: "routine",
  azurerm_nat_gateway: "routine",
  azurerm_nat_gateway_public_ip_association: "routine",
  azurerm_pim_active_role_assignment: "authority",
  azurerm_pim_eligible_role_assignment: "authority",
  azurerm_policy_definition: "authority",
  azurerm_policy_set_definition: "authority",
  azurerm_public_ip: "routine",
  azurerm_resource_group: "routine",
  azurerm_resource_group_policy_assignment: "authority",
  azurerm_resource_group_policy_exemption: "authority",
  azurerm_role_assignment: "authority",
  azurerm_role_definition: "authority",
  azurerm_role_management_policy: "authority",
  azurerm_role_management_policy_assignment: "authority",
  azurerm_service_plan: "routine",
  azurerm_storage_account: "compound",
  azurerm_storage_account_customer_managed_key: "authority",
  azurerm_storage_account_local_user: "authority",
  azurerm_storage_container: "routine",
  azurerm_storage_management_policy: "routine",
  azurerm_storage_queue: "routine",
  azurerm_subnet: "routine",
  azurerm_subnet_nat_gateway_association: "routine",
  azurerm_subscription_policy_assignment: "authority",
  azurerm_subscription_policy_exemption: "authority",
  azurerm_user_assigned_identity: "authority",
  azurerm_virtual_network: "routine",
});

const AUTHORITY_ARM_TYPES = new Set([
  "microsoft.authorization/denyassignments",
  "microsoft.authorization/policyassignments",
  "microsoft.authorization/policydefinitions",
  "microsoft.authorization/policysetdefinitions",
  "microsoft.authorization/roleassignments",
  "microsoft.authorization/roleassignmentschedulerequests",
  "microsoft.authorization/roledefinitions",
  "microsoft.authorization/roleeligibilityschedulerequests",
  "microsoft.authorization/rolemanagementpolicies",
  "microsoft.authorization/rolemanagementpolicyassignments",
  "microsoft.keyvault/vaults/accesspolicies",
  "microsoft.managedidentity/userassignedidentities",
  "microsoft.managedidentity/userassignedidentities/federatedidentitycredentials",
]);

const ROUTINE_ARM_TYPES = new Set(["microsoft.storage/storageaccounts/tableservices/tables"]);

const COMPOUND_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  azurerm_key_vault: Object.freeze([
    "access_policy",
    "enabled_for_deployment",
    "enabled_for_disk_encryption",
    "enabled_for_template_deployment",
    "rbac_authorization_enabled",
    "tenant_id",
  ]),
  azurerm_linux_function_app: Object.freeze([
    "identity",
    "key_vault_reference_identity_id",
    "storage_uses_managed_identity",
  ]),
  azurerm_storage_account: Object.freeze([
    "azure_files_authentication",
    "identity",
    "local_user_enabled",
    "shared_access_key_enabled",
  ]),
});

export function classifyOpenTofuPlan(
  source: string,
  authorityClass: PlanAuthorityClass,
  sourceState: StateIdentity,
): OpenTofuPlanClassification {
  validateStateIdentity(sourceState, "render.sourceState");
  const root = requireRecord(
    parseStrictJson(source, { maxBytes: PLAN_JSON_MAX_BYTES, maxDepth: 64 }),
    "plan.json",
  );
  let priorStateDigest: string;
  let priorManagedResourceCount: number;
  if (!Object.hasOwn(root, "prior_state")) {
    if (
      authorityClass !== "bootstrap" ||
      sourceState.serial !== 0 ||
      !sourceState.managedResourcesEmpty ||
      sourceState.managedResourceCount !== 0
    ) {
      throw new InfrastructureApprovalError("plan-prior-state-missing");
    }
    priorStateDigest = sha256Text("null\n");
    priorManagedResourceCount = 0;
  } else {
    const priorState = requireRecord(root.prior_state, "plan.json.prior_state");
    priorStateDigest = sha256Text(`${canonicalJson(priorState)}\n`);
    priorManagedResourceCount = countPriorManagedResources(priorState);
  }
  if (
    priorManagedResourceCount !== sourceState.managedResourceCount ||
    sourceState.managedResourcesEmpty !== (priorManagedResourceCount === 0)
  ) {
    throw new InfrastructureApprovalError("plan-prior-state-backend-mismatch");
  }

  const changes = root.resource_changes;
  if (!Array.isArray(changes) || changes.length > MAX_RESOURCES) {
    throw new ContractValidationError("plan.json.resource_changes", "must be a bounded array");
  }
  const drift = root.resource_drift;
  if (drift !== undefined && (!Array.isArray(drift) || drift.length > MAX_RESOURCES)) {
    throw new ContractValidationError("plan.json.resource_drift", "must be a bounded array");
  }
  if (authorityClass === "bootstrap" && Array.isArray(drift) && drift.length > 0) {
    throw new InfrastructureApprovalError("bootstrap-plan-has-resource-drift");
  }
  if (Array.isArray(drift)) inspectResourceDrift(drift, authorityClass);

  const summary = { authority: 0, create: 0, delete: 0, read: 0, replace: 0, update: 0 };
  let managedChangeCount = 0;
  for (const [index, rawChange] of changes.entries()) {
    const path = `plan.json.resource_changes[${index}]`;
    const change = requireRecord(rawChange, path);
    if (change.mode !== "managed" && change.mode !== "data") {
      throw new ContractValidationError(`${path}.mode`, "must be managed or data");
    }
    const address = exactString(change.address, `${path}.address`, 512);
    const type = exactString(change.type, `${path}.type`, 128);
    const providerName = exactString(change.provider_name, `${path}.provider_name`, 256);
    const body = requireRecord(change.change, `${path}.change`);
    const actions = parseActions(body.actions, `${path}.change.actions`);
    if (body.importing !== undefined && body.importing !== null) {
      throw new InfrastructureApprovalError("plan-import-unsupported");
    }
    if (change.mode === "data") {
      if (!actions.every((action) => action === "read" || action === "no-op")) {
        throw new InfrastructureApprovalError("data-source-mutation-rejected");
      }
      if (actions.includes("read")) summary.read += 1;
      continue;
    }

    managedChangeCount += 1;
    if (actions.includes("create")) summary.create += 1;
    if (actions.includes("update")) summary.update += 1;
    if (actions.includes("delete")) summary.delete += 1;
    if (actions.includes("read")) summary.read += 1;
    if (actions.length === 2) summary.replace += 1;
    if (authorityClass === "bootstrap" && actions.join(",") !== "create") {
      throw new InfrastructureApprovalError("bootstrap-plan-is-not-create-only");
    }
    const mutable = actions.some(
      (action) => action === "create" || action === "update" || action === "delete",
    );
    if (!mutable) continue;
    if (classifyMutableResource(providerName, type, body, `${path}.change`, address, actions)) {
      summary.authority += 1;
    }
  }

  if (authorityClass === "foundation" && summary.authority > 0) {
    throw new InfrastructureApprovalError("foundation-plan-contains-authority-change");
  }
  if (
    authorityClass === "bootstrap" &&
    (sourceState.serial !== 0 ||
      !sourceState.managedResourcesEmpty ||
      sourceState.managedResourceCount !== 0 ||
      priorManagedResourceCount !== 0 ||
      managedChangeCount === 0 ||
      summary.authority === 0)
  ) {
    throw new InfrastructureApprovalError("bootstrap-plan-is-not-fresh-authority-creation");
  }
  return Object.freeze({
    destructive: summary.delete > 0 || summary.replace > 0,
    priorManagedResourceCount,
    priorStateDigest,
    summary: Object.freeze({ ...summary }),
  });
}

function inspectResourceDrift(drift: readonly unknown[], authorityClass: PlanAuthorityClass): void {
  for (const [index, rawChange] of drift.entries()) {
    const path = `plan.json.resource_drift[${index}]`;
    const change = requireRecord(rawChange, path);
    if (change.mode !== "managed" && change.mode !== "data") {
      throw new ContractValidationError(`${path}.mode`, "must be managed or data");
    }
    const address = exactString(change.address, `${path}.address`, 512);
    const type = exactString(change.type, `${path}.type`, 128);
    const providerName = exactString(change.provider_name, `${path}.provider_name`, 256);
    const body = requireRecord(change.change, `${path}.change`);
    const actions = parseActions(body.actions, `${path}.change.actions`);
    if (body.importing !== undefined && body.importing !== null) {
      throw new InfrastructureApprovalError("plan-import-unsupported");
    }
    if (change.mode === "data") {
      if (!actions.every((action) => action === "read" || action === "no-op")) {
        throw new InfrastructureApprovalError("data-source-mutation-rejected");
      }
      continue;
    }
    const mutable = actions.some(
      (action) => action === "create" || action === "update" || action === "delete",
    );
    if (
      mutable &&
      classifyMutableResource(providerName, type, body, `${path}.change`, address, actions) &&
      authorityClass === "foundation"
    ) {
      throw new InfrastructureApprovalError("foundation-plan-contains-authority-drift");
    }
  }
}

function parseActions(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || value.some((part) => typeof part !== "string")) {
    throw new ContractValidationError(path, "must be a string array");
  }
  const actions = value as string[];
  if (
    !new Set(["no-op", "read", "create", "update", "delete", "delete,create", "create,delete"]).has(
      actions.join(","),
    )
  ) {
    throw new ContractValidationError(path, "contains an unsupported action");
  }
  return actions;
}

function classifyMutableResource(
  providerName: string,
  type: string,
  change: Record<string, unknown>,
  path: string,
  address: string,
  actions: readonly string[],
): boolean {
  if (providerName === "registry.opentofu.org/azure/azapi") {
    if (type !== "azapi_resource") {
      throw new InfrastructureApprovalError("unknown-mutable-azapi-resource-type");
    }
    const armType = exactAzapiArmType(change, path, address, actions);
    if (AUTHORITY_ARM_TYPES.has(armType)) return true;
    if (ROUTINE_ARM_TYPES.has(armType)) return false;
    if (armType === "microsoft.keyvault/vaults") return true;
    throw new InfrastructureApprovalError("unknown-mutable-azapi-arm-type");
  }
  if (providerName !== "registry.opentofu.org/hashicorp/azurerm") {
    throw new InfrastructureApprovalError("unsupported-plan-provider");
  }
  const classification = AZURERM_TYPES[type];
  if (classification === undefined) {
    throw new InfrastructureApprovalError("unknown-mutable-azurerm-type");
  }
  if (classification === "authority") return true;
  if (classification === "routine") return false;
  return compoundAuthorityChange(type, change, path, actions);
}

function compoundAuthorityChange(
  type: string,
  change: Record<string, unknown>,
  path: string,
  actions: readonly string[],
): boolean {
  const fields = COMPOUND_FIELDS[type];
  if (fields === undefined) throw new InfrastructureApprovalError("compound-type-unclassified");
  const before = change.before === null ? null : requireRecord(change.before, `${path}.before`);
  const after = change.after === null ? null : requireRecord(change.after, `${path}.after`);
  if (type === "azurerm_key_vault" && (actions.includes("create") || actions.includes("delete"))) {
    return true;
  }
  return fields.some(
    (field) => canonicalJson(before?.[field] ?? null) !== canonicalJson(after?.[field] ?? null),
  );
}

function exactAzapiArmType(
  change: Record<string, unknown>,
  path: string,
  address: string,
  actions: readonly string[],
): string {
  const candidates: string[] = [];
  for (const side of ["before", "after"] as const) {
    if (change[side] === null) continue;
    const record = requireRecord(change[side], `${path}.${side}`);
    if (typeof record.type !== "string" || record.type.length === 0) {
      throw new InfrastructureApprovalError(`azapi-arm-type-missing-or-disagrees:${address}`);
    }
    candidates.push(canonicalArmType(record.type, `${path}.${side}.type`));
  }
  if (candidates.length < 1 || new Set(candidates).size !== 1) {
    throw new InfrastructureApprovalError(`azapi-arm-type-missing-or-disagrees:${address}`);
  }
  if (actions.join(",") === "create" && change.before !== null) {
    throw new InfrastructureApprovalError("azapi-create-before-state-invalid");
  }
  if (actions.join(",") === "delete" && change.after !== null) {
    throw new InfrastructureApprovalError("azapi-delete-after-state-invalid");
  }
  const candidate = candidates[0];
  if (candidate === undefined) {
    throw new InfrastructureApprovalError(`azapi-arm-type-missing-or-disagrees:${address}`);
  }
  return candidate;
}

function canonicalArmType(value: unknown, path: string): string {
  const raw = exactString(value, path, 256);
  const parts = raw.split("@");
  const baseType = parts[0];
  const version = parts[1];
  if (
    parts.length > 2 ||
    baseType === undefined ||
    !/^[A-Za-z][A-Za-z0-9.]+(?:\/[A-Za-z][A-Za-z0-9.]+)+$/.test(baseType) ||
    (parts.length === 2 &&
      (version === undefined || !/^\d{4}-\d{2}-\d{2}(?:-preview)?$/.test(version)))
  ) {
    throw new ContractValidationError(
      path,
      "must be a canonical ARM type with optional API version",
    );
  }
  return baseType.toLowerCase();
}

function countPriorManagedResources(priorState: Record<string, unknown>): number {
  const values = requireRecord(priorState.values, "plan.json.prior_state.values");
  const root = requireRecord(values.root_module, "plan.json.prior_state.values.root_module");
  const addresses = new Set<string>();
  const visit = (module: Record<string, unknown>, path: string): void => {
    const resources = module.resources ?? [];
    if (!Array.isArray(resources))
      throw new ContractValidationError(`${path}.resources`, "must be an array");
    for (const [index, raw] of resources.entries()) {
      const resource = requireRecord(raw, `${path}.resources[${index}]`);
      if (resource.mode !== "managed" && resource.mode !== "data") {
        throw new ContractValidationError(
          `${path}.resources[${index}].mode`,
          "must be managed or data",
        );
      }
      if (resource.mode === "managed") {
        const address = exactString(resource.address, `${path}.resources[${index}].address`, 512);
        if (addresses.has(address))
          throw new InfrastructureApprovalError("prior-state-address-duplicate");
        addresses.add(address);
        if (addresses.size > MAX_RESOURCES)
          throw new InfrastructureApprovalError("prior-state-too-large");
      }
    }
    const children = module.child_modules ?? [];
    if (!Array.isArray(children))
      throw new ContractValidationError(`${path}.child_modules`, "must be an array");
    for (const [index, raw] of children.entries()) {
      visit(
        requireRecord(raw, `${path}.child_modules[${index}]`),
        `${path}.child_modules[${index}]`,
      );
    }
  };
  visit(root, "plan.json.prior_state.values.root_module");
  return addresses.size;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new ContractValidationError("canonicalJson", "has a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = requireRecord(value, "canonicalJson");
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
