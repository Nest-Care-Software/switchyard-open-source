import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

const templatePath = "infra/foundation/main.json";
const template = JSON.parse(readFileSync(templatePath, "utf8"));
const cloudShellAzureCliVersionOutput = readFileSync(
  "scripts/fixtures/azure-cli-2.89.1-cloud-shell.txt",
  "utf8",
);
const nested = template.resources.find(
  (resource) => resource.type === "Microsoft.Resources/deployments",
)?.properties?.template;

describe("external Azure infrastructure approval foundation", () => {
  it("targets only the exact dedicated subscription and cannot activate 49be281", () => {
    assert.equal(template.variables.expectedSubscriptionId, "a0000000-0000-4000-8000-000000000001");
    assert.equal(template.variables.expectedTenantId, "a0000000-0000-4000-8000-000000000002");
    assert.equal(template.variables.disabledEngineSha, "49be281fc0d6c2cf746a0ce0f6db517d0ac821af");
    assert.match(template.variables.activationAllowed, /disabledEngineSha/);
    assert.match(template.variables.activationAllowed, /subscription\(\)\.subscriptionId/);
    assert.match(template.variables.activationAllowed, /tenant\(\)\.tenantId/);
    assert.match(
      template.variables.activationAllowed,
      /length\(parameters\('finalEngineSha'\)\), 40/,
    );
    assert.match(template.variables.activationAllowed, /finalEngineShaWithoutHex/);
    assert.ok(
      template.resources.every(
        (resource) => resource.condition === "[variables('activationAllowed')]",
      ),
    );
    assert.deepEqual(template.parameters.finalEngineSha, {
      maxLength: 40,
      metadata: {
        description:
          "Full reviewed commit SHA containing both final reusable infrastructure engines.",
      },
      minLength: 40,
      type: "string",
    });
    assert.equal(template.parameters.plannerAudience, undefined);
    assert.equal(template.parameters.foundationAudience, undefined);
    assert.equal(template.parameters.bootstrapAudience, undefined);
    assert.deepEqual(template.parameters.deployReceiptImmutabilityPolicy, {
      defaultValue: true,
      metadata: {
        description:
          "Deploys the receipt immutability policy only while it is absent or still Unlocked. The owner wrapper derives this from live evidence.",
      },
      type: "bool",
    });
  });

  it("declares exactly the reviewed resource set and no compute, registration or secret channel", () => {
    assert.ok(nested);
    const expectedTop = [
      "Microsoft.Authorization/roleDefinitions",
      "Microsoft.Authorization/roleDefinitions",
      "Microsoft.Authorization/roleDefinitions",
      "Microsoft.Authorization/roleDefinitions",
      "Microsoft.Authorization/roleAssignments",
      "Microsoft.Authorization/roleAssignments",
      "Microsoft.Resources/deployments",
      "Microsoft.Resources/resourceGroups",
    ].sort();
    assert.deepEqual(template.resources.map((resource) => resource.type).sort(), expectedTop);
    const expectedNested = [
      "Microsoft.Authorization/locks",
      ...Array(7).fill("Microsoft.Authorization/roleAssignments"),
      ...Array(3).fill("Microsoft.ManagedIdentity/userAssignedIdentities"),
      ...Array(3).fill(
        "Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials",
      ),
      ...Array(2).fill("Microsoft.Storage/storageAccounts"),
      ...Array(2).fill("Microsoft.Storage/storageAccounts/blobServices"),
      ...Array(3).fill("Microsoft.Storage/storageAccounts/blobServices/containers"),
      "Microsoft.Storage/storageAccounts/blobServices/containers/immutabilityPolicies",
    ].sort();
    assert.deepEqual(nested.resources.map((resource) => resource.type).sort(), expectedNested);
    const source = readFileSync(templatePath, "utf8");
    assert.doesNotMatch(
      source,
      /Microsoft\.Compute|deploymentScripts|register\/action|privateEndpoints|listKeys|sharedAccess|sasToken|clientSecret/i,
    );
  });

  it("keeps both accounts Entra-only and applies the exact retention and immutability contracts", () => {
    const accounts = nested.resources.filter(
      (resource) => resource.type === "Microsoft.Storage/storageAccounts",
    );
    assert.deepEqual(accounts.map((resource) => resource.name).sort(), [
      "swexampleapprovalreceipt",
      "swexampleapprovalstate",
    ]);
    for (const account of accounts) {
      assert.equal(account.kind, "StorageV2");
      assert.equal(account.sku.name, "Standard_LRS");
      assert.equal(account.properties.accessTier, "Hot");
      assert.equal(account.properties.allowBlobPublicAccess, false);
      assert.equal(account.properties.allowSharedKeyAccess, false);
      assert.equal(account.properties.defaultToOAuthAuthentication, true);
      assert.equal(account.properties.minimumTlsVersion, "TLS1_2");
      assert.equal(account.properties.publicNetworkAccess, "Enabled");
      assert.equal(account.properties.encryption.requireInfrastructureEncryption, true);
    }
    const blobServices = Object.fromEntries(
      nested.resources
        .filter((resource) => resource.type === "Microsoft.Storage/storageAccounts/blobServices")
        .map((resource) => [resource.name, resource.properties]),
    );
    const state = blobServices["[format('{0}/{1}', 'swexampleapprovalstate', 'default')]"];
    const receipt = blobServices["[format('{0}/{1}', 'swexampleapprovalreceipt', 'default')]"];
    assert.equal(state.isVersioningEnabled, true);
    assert.deepEqual(state.deleteRetentionPolicy, {
      allowPermanentDelete: false,
      days: 30,
      enabled: true,
    });
    assert.deepEqual(state.containerDeleteRetentionPolicy, { days: 30, enabled: true });
    assert.equal(receipt.isVersioningEnabled, false);
    assert.deepEqual(receipt.deleteRetentionPolicy, { enabled: false });
    assert.deepEqual(receipt.containerDeleteRetentionPolicy, { enabled: false });
    const receiptContainer = nested.resources.find(
      (resource) =>
        resource.type === "Microsoft.Storage/storageAccounts/blobServices/containers" &&
        resource.name.includes("plan-receipts"),
    );
    assert.deepEqual(receiptContainer.properties, { publicAccess: "None" });
    const policy = nested.resources.find((resource) =>
      resource.type.endsWith("/immutabilityPolicies"),
    );
    assert.equal(policy.condition, "[parameters('deployReceiptImmutabilityPolicy')]");
    assert.deepEqual(policy.properties, {
      allowProtectedAppendWrites: false,
      allowProtectedAppendWritesAll: false,
      immutabilityPeriodSinceCreationInDays: 1,
    });
  });

  it("gives the planner only the read permissions required to refresh state and alerts", () => {
    const roles = template.resources.filter(
      (resource) => resource.type === "Microsoft.Authorization/roleDefinitions",
    );
    assert.equal(roles.length, 4);
    const stateReader = roles.find(
      (role) => role.properties.roleName === "Switchyard infrastructure state reader",
    ).properties.permissions[0];
    const logQueryReader = roles.find(
      (role) => role.properties.roleName === "Switchyard infrastructure log query planner",
    ).properties.permissions[0];
    const custodian = roles.find(
      (role) => role.properties.roleName === "Switchyard infrastructure approval blob custodian",
    ).properties.permissions[0];
    assert.deepEqual(stateReader.actions, []);
    assert.deepEqual(stateReader.dataActions, [
      "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read",
    ]);
    assert.deepEqual(logQueryReader.actions, [
      "Microsoft.OperationalInsights/workspaces/query/read",
    ]);
    assert.deepEqual(logQueryReader.dataActions, []);
    assert.deepEqual(logQueryReader.notActions, []);
    assert.deepEqual(logQueryReader.notDataActions, []);
    assert.deepEqual(custodian.actions, []);
    assert.deepEqual(custodian.dataActions, [
      "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read",
      "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write",
    ]);
    const assignments = nested.resources.filter(
      (resource) => resource.type === "Microsoft.Authorization/roleAssignments",
    );
    assert.equal(assignments.length, 7);
    assert.ok(
      assignments.every((assignment) => assignment.properties.principalType === "ServicePrincipal"),
    );
    const planner = assignments.filter((assignment) =>
      assignment.properties.principalId.includes("id-switchyard-infra-planner-uksouth"),
    );
    assert.equal(planner.length, 1);
    assert.match(planner[0].scope, /'tfstate'/);
    assert.equal(
      planner[0].properties.roleDefinitionId,
      "[parameters('stateReaderRoleDefinitionId')]",
    );
    for (const assignment of assignments.filter((value) => value !== planner[0])) {
      assert.equal(
        assignment.properties.roleDefinitionId,
        "[parameters('approvalBlobCustodianRoleDefinitionId')]",
      );
    }
    const expectedApplierScopes = [
      "[resourceId('Microsoft.Storage/storageAccounts/blobServices/containers', 'swexampleapprovalreceipt', 'default', 'plan-receipts')]",
      "[resourceId('Microsoft.Storage/storageAccounts/blobServices/containers', 'swexampleapprovalstate', 'default', 'apply-control')]",
      "[resourceId('Microsoft.Storage/storageAccounts/blobServices/containers', 'swexampleapprovalstate', 'default', 'tfstate')]",
    ].sort();
    for (const identity of ["foundation", "bootstrap"]) {
      const scoped = assignments.filter((assignment) =>
        assignment.properties.principalId.includes(`id-switchyard-infra-${identity}-uksouth`),
      );
      assert.equal(scoped.length, 3);
      assert.deepEqual(scoped.map((assignment) => assignment.scope).sort(), expectedApplierScopes);
    }

    const subscriptionAssignments = template.resources.filter(
      (resource) => resource.type === "Microsoft.Authorization/roleAssignments",
    );
    assert.equal(subscriptionAssignments.length, 2);
    const subscriptionReader = subscriptionAssignments.find(
      (resource) =>
        resource.properties.roleDefinitionId === "[variables('readerRoleDefinitionId')]",
    );
    assert.ok(subscriptionReader);
    assert.equal(subscriptionReader.scope, undefined);
    assert.equal(
      subscriptionReader.name,
      "[guid(subscription().id, 'rg-switchyard-example-state', 'id-switchyard-infra-planner-uksouth', variables('readerRoleDefinitionId'))]",
    );
    assert.equal(subscriptionReader.properties.principalType, "ServicePrincipal");
    assert.match(subscriptionReader.properties.principalId, /plannerIdentityPrincipalId/);
    assert.equal(
      subscriptionReader.properties.roleDefinitionId,
      "[variables('readerRoleDefinitionId')]",
    );
    assert.equal(
      template.variables.readerRoleDefinitionId,
      "[subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'acdd72a7-3385-48ef-bd42-f606fba81ae7')]",
    );
    const logQueryAssignment = subscriptionAssignments.find(
      (resource) => resource !== subscriptionReader,
    );
    assert.ok(logQueryAssignment);
    assert.equal(logQueryAssignment.scope, undefined);
    assert.equal(logQueryAssignment.properties.principalType, "ServicePrincipal");
    assert.match(logQueryAssignment.properties.principalId, /plannerIdentityPrincipalId/);
    assert.equal(
      logQueryAssignment.properties.roleDefinitionId,
      "[subscriptionResourceId('Microsoft.Authorization/roleDefinitions', guid(subscription().id, 'switchyard-infrastructure-log-query-planner'))]",
    );
  });

  it("pins exact final-engine FIC subjects and audiences", () => {
    const credentials = nested.resources.filter((resource) =>
      resource.type.endsWith("/federatedIdentityCredentials"),
    );
    assert.equal(credentials.length, 3);
    assert.ok(
      credentials.every(
        (credential) =>
          credential.properties.issuer === "https://token.actions.githubusercontent.com",
      ),
    );
    assert.match(nested.variables.planSubject, /infrastructure-plan-engine\.yml/);
    assert.match(nested.variables.applySubject, /infrastructure-apply-engine\.yml/);
    assert.match(nested.variables.planSubject, /finalEngineSha/);
    assert.match(nested.variables.applySubject, /finalEngineSha/);
    assert.match(nested.variables.subjectPrefix, /:ref:refs\/heads\/main:job_workflow_ref:/);
    assert.doesNotMatch(nested.variables.subjectPrefix, /:context:|%3A/);
    assert.deepEqual(
      credentials.map((credential) => credential.properties.subject),
      ["[variables('planSubject')]", "[variables('applySubject')]", "[variables('applySubject')]"],
    );
    const audiences = {
      plannerAudience: "api://switchyard-900000003/infrastructure/planner",
      foundationAudience: "api://switchyard-900000003/infrastructure/foundation-applier",
      bootstrapAudience: "api://switchyard-900000003/infrastructure/bootstrap-applier",
    };
    assert.deepEqual(
      credentials.map((credential) => credential.properties.audiences),
      [
        ["[parameters('plannerAudience')]"],
        ["[parameters('foundationAudience')]"],
        ["[parameters('bootstrapAudience')]"],
      ],
    );
    for (const [parameter, audience] of Object.entries(audiences)) {
      assert.deepEqual(nested.parameters[parameter].allowedValues, [audience]);
      assert.equal(template.variables[parameter], audience);
    }
    const deployment = template.resources.find(
      (resource) => resource.type === "Microsoft.Resources/deployments",
    );
    assert.equal(
      deployment.properties.parameters.plannerAudience.value,
      "[variables('plannerAudience')]",
    );
    assert.equal(
      deployment.properties.parameters.foundationAudience.value,
      "[variables('foundationAudience')]",
    );
    assert.equal(
      deployment.properties.parameters.bootstrapAudience.value,
      "[variables('bootstrapAudience')]",
    );
  });

  it("exports every managed identity client and principal ID plus the initial creator role ID", () => {
    for (const identity of ["planner", "foundation", "bootstrap"]) {
      assert.ok(nested.outputs[`${identity}IdentityClientId`]);
      assert.ok(nested.outputs[`${identity}IdentityPrincipalId`]);
      assert.ok(template.outputs[`${identity}IdentityClientId`]);
      assert.ok(template.outputs[`${identity}IdentityPrincipalId`]);
    }
    assert.match(
      template.outputs.foundationIdentityPrincipalId.value,
      /foundationIdentityPrincipalId/,
    );
    assert.match(
      template.outputs.initialControlCreatorRoleDefinitionId.value,
      /switchyard-initial-control-creator/,
    );
  });

  it("defines but does not assign the create-only initial control creator role", () => {
    const role = template.resources.find(
      (resource) =>
        resource.type === "Microsoft.Authorization/roleDefinitions" &&
        resource.properties.roleName === "Switchyard initial control creator",
    );
    assert.ok(role);
    const permission = role.properties.permissions[0];
    assert.equal(
      permission.actions.includes("Microsoft.Authorization/roleDefinitions/write"),
      true,
    );
    assert.equal(
      permission.actions.includes("Microsoft.Authorization/roleAssignments/write"),
      true,
    );
    assert.deepEqual(permission.dataActions, []);
    assert.deepEqual(permission.notActions, []);
    assert.deepEqual(permission.notDataActions, []);
    assert.equal(
      permission.actions.some((action) => action.includes("*")),
      false,
    );
    assert.equal(
      permission.actions.some((action) => action.endsWith("/delete")),
      false,
    );

    const ordinaryAssignments = [
      ...template.resources.filter(
        (resource) => resource.type === "Microsoft.Authorization/roleAssignments",
      ),
      ...nested.resources.filter(
        (resource) => resource.type === "Microsoft.Authorization/roleAssignments",
      ),
    ];
    assert.equal(
      ordinaryAssignments.some((assignment) =>
        String(assignment.properties.roleDefinitionId).includes("initialControlCreatorRole"),
      ),
      false,
    );
  });

  it("pins and guards the owner wrapper without adding login or OpenTofu commands", () => {
    const wrapper = readFileSync("infra/foundation/deploy.sh", "utf8");
    const versionParser = readFileSync("infra/foundation/azure-cli-version.sh", "utf8");
    assert.match(wrapper, /expected_azure_cli_version='2\.89\.1'/);
    assert.match(wrapper, /source "\$\{script_dir\}\/azure-cli-version\.sh"/);
    assert.match(versionParser, /az --version 2>&1/);
    assert.doesNotMatch(versionParser, /\baz\s+version\b|--query|--output/);
    assert.match(wrapper, /disabled_engine_sha='49be281fc0d6c2cf746a0ce0f6db517d0ac821af'/);
    assert.match(wrapper, /DEPLOY SWITCHYARD FOUNDATION/);
    assert.match(wrapper, /az deployment sub "\$\{mode\}"/);
    assert.match(wrapper, /policy_lock_url=.*\/lock\?api-version=\$\{policy_lock_api_version\}/);
    assert.match(wrapper, /--headers "If-Match=\$\{current_etag\}"/);
    assert.match(wrapper, /verify-immutability-policy\.mjs.*locked/);
    assert.match(wrapper, /Foundation deployment is partial/);
    assert.doesNotMatch(wrapper, /\baz\s+login\b|\b(?:tofu|terraform)\s+(?:plan|apply|destroy)\b/);
  });

  it("rejects the disabled SHA before any Azure CLI or API call", () => {
    withFakeAzure("success", ({ bin, log }) => {
      const result = runWrapper(bin, ["validate", "49be281fc0d6c2cf746a0ce0f6db517d0ac821af"]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /can never activate/);
      assert.equal(readOptional(log), "");
    });
  });

  it("does not accept caller-selected audiences", () => {
    withFakeAzure("success", ({ bin, log }) => {
      const result = runWrapper(bin, [
        "validate",
        "57728542317b024bebc7dbeebf46045f1ac3e9d3",
        "arbitrary-planner-audience",
        "arbitrary-foundation-audience",
        "arbitrary-bootstrap-audience",
      ]);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /Usage:/);
      assert.equal(readOptional(log), "");
    });
  });

  it("locks the created one-day policy with its exact ETag and rereads Locked state", () => {
    withFakeAzure("success", ({ bin, log }) => {
      const result = runWrapper(bin, createArguments());
      assert.equal(result.status, 0, result.stderr);
      const calls = readFileSync(log, "utf8");
      assert.match(calls, /deployment sub create/);
      assert.match(calls, /rest --method get .*api-version=2025-06-01/);
      assert.match(calls, /rest --method post .*\/lock\?api-version=2025-08-01/);
      assert.match(calls, /--headers If-Match="0x8DABCDEF"/);
      assert.equal((calls.match(/rest --method get/g) ?? []).length, 2);
    });
  });

  it("safely verifies an already Locked policy without invoking Lock again", () => {
    withFakeAzure("already-locked", ({ bin, log }) => {
      const result = runWrapper(bin, createArguments());
      assert.equal(result.status, 0, result.stderr);
      const calls = readFileSync(log, "utf8");
      assert.equal(calls.includes("rest --method post"), false);
      assert.equal((calls.match(/rest --method get/g) ?? []).length, 3);
      assert.match(calls, /deployReceiptImmutabilityPolicy=false/);
    });
  });

  it("fails closed before deployment when an existing policy cannot be proved", () => {
    withFakeAzure("existing-policy-unreadable", ({ bin, log }) => {
      const result = runWrapper(bin, createArguments());
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /could not be proved/);
      assert.doesNotMatch(readFileSync(log, "utf8"), /deployment sub create/);
    });
  });

  it("reports a partial deployment and exits nonzero when locking or final proof fails", () => {
    for (const scenario of ["lock-fails", "verify-fails"]) {
      withFakeAzure(scenario, ({ bin }) => {
        const result = runWrapper(bin, createArguments());
        assert.notEqual(result.status, 0, scenario);
        assert.match(result.stderr, /Foundation deployment is partial/);
        assert.match(result.stderr, /infrastructure-foundation-rollback\.md/);
      });
    }
  });

  it("accepts the owner's complete multiline Cloud Shell output captured from stderr", () => {
    withFakeAzure(
      "success",
      ({ bin, log }) => {
        const result = runWrapper(bin, ["validate", "57728542317b024bebc7dbeebf46045f1ac3e9d3"]);
        assert.equal(result.status, 0, result.stderr);
        assert.match(readFileSync(log, "utf8"), /^--version\naccount show/m);
      },
      cloudShellAzureCliVersionOutput,
    );
  });

  it("ignores unrelated azure-cli substring occurrences after the exact version candidate", () => {
    const output = `${cloudShellAzureCliVersionOutput}notice: azure-cli is installed\n/usr/share/azure-cli-extensions/cache\n`;
    withFakeAzure(
      "success",
      ({ bin }) => {
        const result = runWrapper(bin, ["validate", "57728542317b024bebc7dbeebf46045f1ac3e9d3"]);
        assert.equal(result.status, 0, result.stderr);
      },
      output,
    );
  });

  it("rejects missing, duplicate, malformed, warning-only, token-padded and wrong CLI versions", () => {
    const rejectedOutputs = [
      ["empty", ""],
      ["missing", "core 2.89.1\nPython (Linux) 3.12.9\n"],
      ["duplicate", "azure-cli 2.89.1\nazure-cli 2.89.1\ncore 2.89.1\n"],
      ["malformed", "azure-cli version 2.89.1\ncore 2.89.1\n"],
      ["malformed-alongside-valid", "azure-cli 2.89.1\nazure-cli version 2.89.1\ncore 2.89.1\n"],
      ["warning-only", "WARNING: Azure CLI version lookup is unavailable\n"],
      ["leading-token", "warning azure-cli 2.89.1\n"],
      ["trailing-token", "azure-cli 2.89.1 extra\n"],
      ["different", "azure-cli 2.89.0\ncore 2.89.0\n"],
    ];
    for (const [name, output] of rejectedOutputs) {
      withFakeAzure(
        "success",
        ({ bin, log }) => {
          const result = runWrapper(bin, ["validate", "57728542317b024bebc7dbeebf46045f1ac3e9d3"]);
          assert.notEqual(result.status, 0, name);
          assert.match(result.stderr, /Azure CLI 2\.89\.1 is required/);
          assert.equal(readFileSync(log, "utf8"), "--version\n");
        },
        output,
      );
    }
  });
});

describe("foundation OpenTofu role allowlist", () => {
  it("contains every P1 action required by actual declared resources and no wildcard", () => {
    const identity = readFileSync("infra/modules/azure-control/identity.tf", "utf8");
    const deployment = identity.match(
      /resource "azurerm_role_definition" "deployment" \{([\s\S]*?)resource "azurerm_role_assignment" "deployment"/,
    )?.[1];
    assert.ok(deployment);
    const required = [
      "Microsoft.Insights/scheduledQueryRules/read",
      "Microsoft.Insights/scheduledQueryRules/write",
      "Microsoft.Insights/scheduledQueryRules/delete",
      "Microsoft.OperationalInsights/workspaces/query/read",
      "Microsoft.Storage/storageAccounts/blobServices/write",
      "Microsoft.Web/sites/config/list/action",
      "Microsoft.Web/sites/basicPublishingCredentialsPolicies/read",
      "Microsoft.Web/sites/basicPublishingCredentialsPolicies/write",
    ];
    for (const action of required) assert.match(deployment, new RegExp(`"${action}"`));
    assert.doesNotMatch(deployment, /"[^"]*\*[^"]*"/);
    assert.match(
      readFileSync("infra/modules/azure-control/monitoring.tf", "utf8"),
      /azurerm_monitor_scheduled_query_rules_alert_v2/,
    );
    assert.match(
      readFileSync("infra/modules/azure-control/storage.tf", "utf8"),
      /azurerm_storage_account/,
    );
    assert.match(
      readFileSync("infra/modules/azure-control/function.tf", "utf8"),
      /azurerm_linux_function_app/,
    );
  });
});

describe("initial control creator resource-to-operation allowlist", () => {
  it("maps every declared Azure control resource to the exact create/read union", () => {
    const mappings = {
      __provider_discovery__: [
        "Microsoft.Resources/subscriptions/read",
        "Microsoft.Resources/subscriptions/locations/read",
        "Microsoft.Resources/providers/read",
        "Microsoft.Resources/subscriptions/providers/read",
      ],
      __approved_identity_federation__: [
        "Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials/read",
        "Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials/write",
      ],
      azapi_resource: [
        "Microsoft.Storage/storageAccounts/tableServices/read",
        "Microsoft.Storage/storageAccounts/tableServices/tables/read",
        "Microsoft.Storage/storageAccounts/tableServices/tables/write",
      ],
      azurerm_application_insights: [
        "Microsoft.Insights/components/read",
        "Microsoft.Insights/components/write",
        "Microsoft.Insights/components/currentbillingfeatures/read",
        "Microsoft.Insights/components/currentbillingfeatures/write",
      ],
      azurerm_key_vault: ["Microsoft.KeyVault/vaults/read", "Microsoft.KeyVault/vaults/write"],
      azurerm_linux_function_app: [
        "Microsoft.ManagedIdentity/userAssignedIdentities/assign/action",
        "Microsoft.Web/checknameavailability/read",
        "Microsoft.Web/serverfarms/read",
        "Microsoft.Web/sites/read",
        "Microsoft.Web/sites/write",
        "Microsoft.Web/sites/config/read",
        "Microsoft.Web/sites/config/write",
        "Microsoft.Web/sites/config/list/action",
        "Microsoft.Web/sites/basicPublishingCredentialsPolicies/read",
        "Microsoft.Web/sites/basicPublishingCredentialsPolicies/write",
      ],
      azurerm_log_analytics_workspace: [
        "Microsoft.OperationalInsights/deletedworkspaces/read",
        "Microsoft.OperationalInsights/workspaces/read",
        "Microsoft.OperationalInsights/workspaces/write",
      ],
      azurerm_management_lock: [
        "Microsoft.Authorization/locks/read",
        "Microsoft.Authorization/locks/write",
      ],
      azurerm_monitor_action_group: [
        "Microsoft.Insights/actionGroups/read",
        "Microsoft.Insights/actionGroups/write",
      ],
      azurerm_monitor_diagnostic_setting: [
        "Microsoft.Insights/diagnosticSettings/read",
        "Microsoft.Insights/diagnosticSettings/write",
      ],
      azurerm_monitor_metric_alert: [
        "Microsoft.Insights/metricAlerts/read",
        "Microsoft.Insights/metricAlerts/write",
      ],
      azurerm_monitor_scheduled_query_rules_alert_v2: [
        "Microsoft.Insights/scheduledQueryRules/read",
        "Microsoft.Insights/scheduledQueryRules/write",
        "Microsoft.OperationalInsights/workspaces/query/read",
      ],
      azurerm_nat_gateway: [
        "Microsoft.Network/natGateways/read",
        "Microsoft.Network/natGateways/write",
      ],
      azurerm_nat_gateway_public_ip_association: [
        "Microsoft.Network/natGateways/read",
        "Microsoft.Network/natGateways/write",
        "Microsoft.Network/natGateways/join/action",
        "Microsoft.Network/publicIPAddresses/read",
        "Microsoft.Network/publicIPAddresses/join/action",
      ],
      azurerm_public_ip: [
        "Microsoft.Network/publicIPAddresses/read",
        "Microsoft.Network/publicIPAddresses/write",
      ],
      azurerm_resource_group: [
        "Microsoft.Resources/subscriptions/resourceGroups/read",
        "Microsoft.Resources/subscriptions/resourceGroups/write",
      ],
      azurerm_role_assignment: [
        "Microsoft.Authorization/roleAssignments/read",
        "Microsoft.Authorization/roleAssignments/write",
        "Microsoft.Authorization/roleDefinitions/read",
      ],
      azurerm_role_definition: [
        "Microsoft.Authorization/roleDefinitions/read",
        "Microsoft.Authorization/roleDefinitions/write",
      ],
      azurerm_service_plan: ["Microsoft.Web/serverfarms/read", "Microsoft.Web/serverfarms/write"],
      azurerm_storage_account: [
        "Microsoft.Storage/storageAccounts/read",
        "Microsoft.Storage/storageAccounts/write",
        "Microsoft.Storage/storageAccounts/blobServices/read",
        "Microsoft.Storage/storageAccounts/blobServices/write",
      ],
      azurerm_storage_container: [
        "Microsoft.Storage/storageAccounts/read",
        "Microsoft.Storage/storageAccounts/blobServices/containers/read",
        "Microsoft.Storage/storageAccounts/blobServices/containers/write",
      ],
      azurerm_storage_management_policy: [
        "Microsoft.Storage/storageAccounts/managementPolicies/read",
        "Microsoft.Storage/storageAccounts/managementPolicies/write",
      ],
      azurerm_storage_queue: [
        "Microsoft.Storage/storageAccounts/read",
        "Microsoft.Storage/storageAccounts/queueServices/read",
        "Microsoft.Storage/storageAccounts/queueServices/queues/read",
        "Microsoft.Storage/storageAccounts/queueServices/queues/write",
      ],
      azurerm_subnet: [
        "Microsoft.Network/virtualNetworks/subnets/read",
        "Microsoft.Network/virtualNetworks/subnets/write",
      ],
      azurerm_subnet_nat_gateway_association: [
        "Microsoft.Network/natGateways/read",
        "Microsoft.Network/virtualNetworks/subnets/read",
        "Microsoft.Network/virtualNetworks/subnets/write",
        "Microsoft.Network/natGateways/join/action",
      ],
      azurerm_user_assigned_identity: [
        "Microsoft.ManagedIdentity/userAssignedIdentities/read",
        "Microsoft.ManagedIdentity/userAssignedIdentities/write",
      ],
      azurerm_virtual_network: [
        "Microsoft.Network/virtualNetworks/read",
        "Microsoft.Network/virtualNetworks/write",
      ],
    };

    const moduleSource = ["infra/environments/azure-pilot", "infra/modules/azure-control"]
      .flatMap((directory) =>
        readdirSync(directory)
          .filter((name) => name.endsWith(".tf"))
          .map((name) => readFileSync(`${directory}/${name}`, "utf8")),
      )
      .join("\n");
    const declaredTypes = [
      ...new Set([...moduleSource.matchAll(/^resource "([^"]+)"/gm)].map((match) => match[1])),
    ].sort();
    assert.deepEqual(
      declaredTypes,
      Object.keys(mappings)
        .filter((name) => !name.startsWith("__"))
        .sort(),
    );

    const role = template.resources.find(
      (resource) => resource.properties?.roleName === "Switchyard initial control creator",
    );
    const expectedActions = [...new Set(Object.values(mappings).flat())].sort();
    assert.deepEqual([...role.properties.permissions[0].actions].sort(), expectedActions);
    assert.equal(
      expectedActions.some((action) => action.includes("*")),
      false,
    );
    assert.equal(
      expectedActions.some((action) => action.endsWith("/delete")),
      false,
    );
    assert.equal(
      expectedActions.some((action) => action.includes("/blobs/")),
      false,
    );
    assert.equal(
      expectedActions.some((action) => action.includes("/entities/")),
      false,
    );
  });
});

const policyId =
  "/subscriptions/a0000000-0000-4000-8000-000000000001/resourceGroups/rg-switchyard-example-state/providers/Microsoft.Storage/storageAccounts/swexampleapprovalreceipt/blobServices/default/containers/plan-receipts/immutabilityPolicies/default";

function createArguments() {
  const digest = createHash("sha256").update(readFileSync(templatePath)).digest("hex");
  return [
    "create",
    "57728542317b024bebc7dbeebf46045f1ac3e9d3",
    `DEPLOY SWITCHYARD FOUNDATION ${digest}`,
  ];
}

function runWrapper(fakeBin, arguments_) {
  const result = spawnSync("bash", ["infra/foundation/deploy.sh", ...arguments_], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    },
  });
  return {
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

function withFakeAzure(scenario, work, versionOutput = cloudShellAzureCliVersionOutput) {
  const directory = mkdtempSync(join(tmpdir(), "switchyard-foundation-test-"));
  const bin = join(directory, "bin");
  const log = join(directory, "az.log");
  const state = join(directory, "az.state");
  try {
    writeFileSync(join(directory, "placeholder"), "");
    mkdirSync(bin);
    const az = join(bin, "az");
    writeFileSync(
      az,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> '${log}'
policy_id='${policyId}'
policy() {
  node -e 'process.stdout.write(JSON.stringify({etag:String.fromCharCode(34)+"0x8DABCDEF"+String.fromCharCode(34),id:process.argv[1],name:"default",type:"Microsoft.Storage/storageAccounts/blobServices/containers/immutabilityPolicies",properties:{allowProtectedAppendWrites:false,allowProtectedAppendWritesAll:false,immutabilityPeriodSinceCreationInDays:1,state:process.argv[2]}})+"\\n")' "$policy_id" "$1"
}
case "$1" in
  --version)
    printf '%s' ${shellQuote(versionOutput)} >&2
    ;;
  account)
    printf '{"id":"a0000000-0000-4000-8000-000000000001","tenantId":"a0000000-0000-4000-8000-000000000002"}\\n'
    ;;
  group)
    if [[ '${scenario}' == 'already-locked' || '${scenario}' == 'existing-policy-unreadable' ]]; then
      printf 'true\\n'
    else
      printf 'false\\n'
    fi
    ;;
  deployment)
    printf '{"properties":{"provisioningState":"Succeeded"}}\\n'
    ;;
  rest)
    [[ '${scenario}' != 'existing-policy-unreadable' ]] || exit 9
    if [[ "$*" == *'/lock?api-version=2025-08-01'* ]]; then
      [[ '${scenario}' != 'lock-fails' ]] || exit 9
      policy Locked
    else
      count=0
      [[ ! -f '${state}' ]] || count="$(< '${state}')"
      count=$((count + 1))
      printf '%s' "$count" > '${state}'
      if [[ '${scenario}' == 'already-locked' ]]; then
        policy Locked
      elif [[ '${scenario}' == 'verify-fails' && "$count" -gt 1 ]]; then
        policy Unlocked
      elif [[ "$count" -eq 1 ]]; then
        policy Unlocked
      else
        policy Locked
      fi
    fi
    ;;
  *) exit 64 ;;
esac
`,
    );
    chmodSync(az, 0o755);
    work({ bin, log });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function readOptional(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}
