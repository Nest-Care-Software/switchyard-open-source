#!/usr/bin/env bash
set -euo pipefail

repository_root="$(git rev-parse --show-toplevel)"
tofu_image="ghcr.io/opentofu/opentofu@sha256:1cdf44e7a44a67c7838ada83c71ad28b4c4e1571b47ad1c5b592624c2c8f35b5"
bicep_version="0.46.1"
bicep_sha256="3e011d629ea4311b7a7dd8f0040ab2b1a072ea4ff5d02cb75e0e55a9a6703fb9"
bicep_directory="${repository_root}/.cache/tools/bicep-${bicep_version}"
bicep_binary="${bicep_directory}/bicep"
runtime_ledger_schema_version="$(sed -n 's/^export const CONTROL_LEDGER_SCHEMA_VERSION = \([0-9][0-9]*\);$/\1/p' "${repository_root}/packages/core/src/allocation-ledger.ts")"

node --check "${repository_root}/infra/foundation/verify-immutability-policy.mjs"
node --check "${repository_root}/infra/foundation/verify-bootstrap-authority.mjs"
node --check "${repository_root}/infra/foundation/verify-oidc-subject-correction.mjs"
bash -n \
  "${repository_root}/infra/foundation/azure-cli-version.sh" \
  "${repository_root}/infra/foundation/configure-operator.sh" \
  "${repository_root}/infra/foundation/deploy.sh" \
  "${repository_root}/infra/foundation/manage-bootstrap-authority.sh" \
  "${repository_root}/infra/foundation/update-oidc-subjects.sh"

if [[ -z "${runtime_ledger_schema_version}" ]]; then
  echo "Could not read the runtime ledger schema version." >&2
  exit 1
fi

if [[ "${runtime_ledger_schema_version}" != "10" ]]; then
  echo "The infrastructure contract must be reviewed when the runtime ledger schema changes." >&2
  exit 1
fi

if ! grep -Eq 'default[[:space:]]*=[[:space:]]*10' "${repository_root}/infra/environments/azure-pilot/variables.tf" ||
  ! grep -Eq 'ledger_schema_version[[:space:]]*=[[:space:]]*10' "${repository_root}/infra/environments/azure-pilot/terraform.tfvars.example" ||
  ! grep -Eq 'default[[:space:]]*=[[:space:]]*10' "${repository_root}/infra/modules/azure-control/variables.tf"; then
  echo "Azure infrastructure ledger schema settings disagree with runtime schema 10." >&2
  exit 1
fi

if grep -REn --exclude=validate.sh --exclude-dir=.terraform \
  'schema-9|schema version[ `]*9([^0-9]|$)|for schema 9([^0-9]|$)|control-v9|ledger_schema_version[[:space:]]*=[[:space:]]*9|ledger_schema_version == 9|ledger_schema_version must (be|match).*9' \
  "${repository_root}/infra"; then
  echo "Stale schema-9 infrastructure guidance or configuration remains." >&2
  exit 1
fi

node "${repository_root}/scripts/build-control-function-bundle.mjs" --assets-only

jq -e '
  (.version == "2.0") and
  (.extensions.queues.batchSize == 1) and
  (.extensions.queues.newBatchThreshold == 0) and
  (.extensions.queues.maxDequeueCount == 5) and
  (.extensions.queues.maxPollingInterval == "00:00:05") and
  (.extensions.queues.messageEncoding == "none") and
  (.extensions.queues.visibilityTimeout == "00:00:30") and
  (.extensionBundle.id == "Microsoft.Azure.Functions.ExtensionBundle") and
  (.extensionBundle.version == "[4.*, 5.0.0)") and
  (.functionTimeout == "00:05:00")
' "${repository_root}/apps/control-function/host.json" >/dev/null

function_definition="${repository_root}/infra/modules/azure-control/function.tf"
monitoring_definition="${repository_root}/infra/modules/azure-control/monitoring.tf"
if ! rg -q 'worker_count[[:space:]]*=[[:space:]]*1' "${function_definition}" ||
  ! rg -q 'FUNCTIONS_WORKER_PROCESS_COUNT.*=[[:space:]]*"1"' "${function_definition}" ||
  ! rg -q 'SWITCHYARD_PROVISIONING_POISON_QUEUE' "${function_definition}" ||
  ! rg -q 'zip_deploy_file.*function_package_deployment_enabled' "${function_definition}" ||
  ! rg -q 'filesha256\(var.function_package_path\).*function_package_sha256' "${function_definition}" ||
  ! rg -q 'switchyard-safety-incident' "${monitoring_definition}" ||
  ! rg -q 'switchyard-provisioning-poison' "${monitoring_definition}" ||
  ! rg -q '\\"stage_code\\":\\"azure-provision-poison\\"' "${monitoring_definition}"; then
  echo "The single-worker, poison-queue, reviewed-package or safety-alert contract is incomplete." >&2
  exit 1
fi

function_switchyard_settings="$(rg -o '"SWITCHYARD_[A-Z0-9_]+"' "${function_definition}" | tr -d '"' | sort -u)"
expected_switchyard_settings="$(printf '%s\n' \
  SWITCHYARD_AZURE_IMAGE_VERSION \
  SWITCHYARD_AZURE_SUBSCRIPTION_ID \
  SWITCHYARD_BOOTSTRAP_SHA256 \
  SWITCHYARD_FUNCTION_ARTIFACT_SHA256 \
  SWITCHYARD_LEDGER_ACCOUNT_NAME \
  SWITCHYARD_LEDGER_INSTANCE_ID \
  SWITCHYARD_LEDGER_PARTITION_KEY \
  SWITCHYARD_LEDGER_SCHEMA_VERSION \
  SWITCHYARD_LEDGER_TABLE_NAME \
  SWITCHYARD_MANAGED_IDENTITY_CLIENT_ID \
  SWITCHYARD_PROVISIONING_POISON_QUEUE \
  SWITCHYARD_PROVISIONING_QUEUE \
  SWITCHYARD_RUNNER_SUBNET_ID \
  SWITCHYARD_RUNTIME_INSTANCE_ID \
  SWITCHYARD_TEMPLATE_SHA256 | sort)"
if [[ "${function_switchyard_settings}" != "${expected_switchyard_settings}" ]]; then
  echo "Function app settings do not exactly match the reviewed non-secret safety-runtime allowlist." >&2
  diff -u <(printf '%s\n' "${expected_switchyard_settings}") <(printf '%s\n' "${function_switchyard_settings}") >&2 || true
  exit 1
fi

application_admission_settings="$(sed -n '/const ADMISSION_KEYS = \[/,/\] as const;/p' \
  "${repository_root}/apps/control-function/src/config.ts" | rg -o 'SWITCHYARD_[A-Z0-9_]+' | sort -u)"
module_admission_settings="$(sed -n '/variable "admission_runtime_settings"/,/variable "diagnostics_container_name"/p' \
  "${repository_root}/infra/modules/azure-control/variables.tf" | rg -o 'SWITCHYARD_[A-Z0-9_]+' | sort -u)"
environment_admission_settings="$(sed -n '/variable "admission_runtime_settings"/,/variable "tags"/p' \
  "${repository_root}/infra/environments/azure-pilot/variables.tf" | rg -o 'SWITCHYARD_[A-Z0-9_]+' | sort -u)"
if [[ "${module_admission_settings}" != "${application_admission_settings}" ]] ||
  [[ "${environment_admission_settings}" != "${application_admission_settings}" ]]; then
  echo "Infrastructure admission settings do not exactly match the application allowlist." >&2
  exit 1
fi

if ! rg -q 'function_package_deployment_enabled[[:space:]]*=[[:space:]]*false' \
  "${repository_root}/infra/environments/azure-pilot/terraform.tfvars.example"; then
  echo "Function package deployment must remain disabled in the example environment." >&2
  exit 1
fi

mkdir -p "${bicep_directory}"

if [[ ! -x "${bicep_binary}" ]] || [[ "$(sha256sum "${bicep_binary}" | cut -d ' ' -f 1)" != "${bicep_sha256}" ]]; then
  download_path="${bicep_binary}.download"
  curl -fsSLo "${download_path}" "https://github.com/Azure/bicep/releases/download/v${bicep_version}/bicep-linux-x64"
  echo "${bicep_sha256}  ${download_path}" | sha256sum --check --status
  chmod 0755 "${download_path}"
  mv "${download_path}" "${bicep_binary}"
fi

echo "Checking OpenTofu formatting with ${tofu_image}"
docker run --rm \
  -v "${repository_root}:/workspace" \
  -w /workspace \
  "${tofu_image}" \
  fmt -check -recursive infra

for environment in azure-pilot cloudflare-reporting; do
  echo "Initialising ${environment} without a backend"
  docker run --rm \
    -v "${repository_root}:/workspace" \
    -w "/workspace/infra/environments/${environment}" \
    "${tofu_image}" \
    init -backend=false -input=false -lockfile=readonly

  echo "Validating ${environment}"
  docker run --rm \
    -v "${repository_root}:/workspace" \
    -w "/workspace/infra/environments/${environment}" \
    "${tofu_image}" \
    validate -no-color
done

generated_template="$(mktemp)"
generated_jit_template="$(mktemp)"
generated_foundation_template="$(mktemp)"
generated_bootstrap_authority_template="$(mktemp)"
generated_oidc_subject_correction_template="$(mktemp)"
extracted_jit_script="$(mktemp)"
trap 'rm -f "${generated_template}" "${generated_jit_template}" "${generated_foundation_template}" "${generated_bootstrap_authority_template}" "${generated_oidc_subject_correction_template}" "${extracted_jit_script}"' EXIT

echo "Compiling the allocation Bicep source with Bicep ${bicep_version}"
"${bicep_binary}" lint \
  "${repository_root}/infra/templates/azure-allocation/main.bicep"

"${bicep_binary}" build \
  "${repository_root}/infra/templates/azure-allocation/main.bicep" \
  --outfile "${generated_template}"

echo "Compiling the external approval foundation Bicep source"
"${bicep_binary}" lint "${repository_root}/infra/foundation/main.bicep"
"${bicep_binary}" build \
  "${repository_root}/infra/foundation/main.bicep" \
  --outfile "${generated_foundation_template}"
cmp "${generated_foundation_template}" "${repository_root}/infra/foundation/main.json"

echo "Compiling the digest-bound bootstrap-authority Bicep source"
"${bicep_binary}" lint "${repository_root}/infra/foundation/bootstrap-authority.bicep"
"${bicep_binary}" build \
  "${repository_root}/infra/foundation/bootstrap-authority.bicep" \
  --outfile "${generated_bootstrap_authority_template}"
cmp "${generated_bootstrap_authority_template}" "${repository_root}/infra/foundation/bootstrap-authority.json"

echo "Compiling the one-time OIDC subject correction Bicep source"
"${bicep_binary}" lint "${repository_root}/infra/foundation/oidc-subject-correction.bicep"
"${bicep_binary}" build \
  "${repository_root}/infra/foundation/oidc-subject-correction.bicep" \
  --outfile "${generated_oidc_subject_correction_template}"
cmp "${generated_oidc_subject_correction_template}" "${repository_root}/infra/foundation/oidc-subject-correction.json"

"${bicep_binary}" lint \
  "${repository_root}/infra/templates/azure-allocation/jit-launch.bicep"

"${bicep_binary}" build \
  "${repository_root}/infra/templates/azure-allocation/jit-launch.bicep" \
  --outfile "${generated_jit_template}"

cmp --silent \
  "${generated_template}" \
  "${repository_root}/infra/templates/azure-allocation/main.json" || {
  echo "The checked-in ARM JSON is stale. Rebuild it with Bicep ${bicep_version}." >&2
  exit 1
}

cmp --silent \
  "${generated_jit_template}" \
  "${repository_root}/infra/templates/azure-allocation/jit-launch.json" || {
  echo "The checked-in JIT-launch ARM JSON is stale. Rebuild it with Bicep ${bicep_version}." >&2
  exit 1
}

jq -e '
  ([.resources[] | select(.type == "Microsoft.Resources/deployments")][0]) as $deployment |
  $deployment.properties.template as $generation |
  ([$generation.resources[] | select(.type == "Microsoft.Network/networkSecurityGroups")][0]) as $nsg |
  ([$generation.resources[] | select(.type == "Microsoft.Network/networkInterfaces")][0]) as $nic |
  (."$schema" == "https://schema.management.azure.com/schemas/2018-05-01/subscriptionDeploymentTemplate.json#") and
  (.parameters.nonSecretBootstrapCustomData.type == "securestring") and
  (.parameters.reducedEncodedJitConfiguration == null) and
  (.parameters.allocationId.minLength == 68) and
  (.parameters.allocationId.maxLength == 68) and
  (.parameters.allocationResourceGroupName.minLength == 20) and
  (.parameters.allocationResourceGroupName.maxLength == 90) and
  (.parameters.githubRunId.maxLength == 64) and
  (.parameters.physicalGeneration.type == "int") and
  (.parameters.physicalGeneration.allowedValues == [1]) and
  (.parameters.allocationAcceptedAt.minLength == 24) and
  (.parameters.allocationAcceptedAt.maxLength == 24) and
  (.parameters.originalCompleteBy.minLength == 24) and
  (.parameters.originalCompleteBy.maxLength == 24) and
  (.parameters.deletionTarget.minLength == 24) and
  (.parameters.deletionTarget.maxLength == 24) and
  (.parameters.allocationLifetimeMinutes.allowedValues == [45]) and
  (.parameters.providerStopMarginMinutes.allowedValues == [5]) and
  (.variables.expectedOriginalCompleteBy == "[dateTimeAdd(parameters(\u0027allocationAcceptedAt\u0027), format(\u0027PT{0}M\u0027, sub(parameters(\u0027allocationLifetimeMinutes\u0027), 5)))]") and
  (.variables.expectedDeletionTarget == "[dateTimeAdd(parameters(\u0027allocationAcceptedAt\u0027), format(\u0027PT{0}M\u0027, parameters(\u0027allocationLifetimeMinutes\u0027)))]") and
  (.variables.latestSafeStart == "[dateTimeAdd(parameters(\u0027originalCompleteBy\u0027), format(\u0027-PT{0}M\u0027, add(parameters(\u0027mappedJobTimeoutMinutes\u0027), parameters(\u0027providerStopMarginMinutes\u0027))))]") and
  (.variables.allocationTags | contains("mappedJobTimeoutMinutes")) and
  (.variables.allocationTags | contains("providerStopMarginMinutes")) and
  (.variables.deadlineContractValid | contains("equals(parameters(\u0027originalCompleteBy\u0027), variables(\u0027expectedOriginalCompleteBy\u0027))")) and
  (.variables.deadlineContractValid | contains("equals(parameters(\u0027deletionTarget\u0027), variables(\u0027expectedDeletionTarget\u0027))")) and
  (.variables.deadlineContractValid | contains("greaterOrEquals(variables(\u0027latestSafeStartOffsetMinutes\u0027), 0)")) and
  ([.resources[].type] | sort == [
    "Microsoft.Resources/deployments",
    "Microsoft.Resources/resourceGroups"
  ]) and
  ([.resources[] | select(.type == "Microsoft.Resources/resourceGroups")][0] as $resourceGroup |
    ($resourceGroup.name == "[parameters(\u0027allocationResourceGroupName\u0027)]") and
    ($resourceGroup.tags == "[variables(\u0027allocationTags\u0027)]")) and
  ($deployment.resourceGroup == "[parameters(\u0027allocationResourceGroupName\u0027)]") and
  ($deployment.name == "[format(\u0027switchyard-allocation-{0}-g{1}\u0027, substring(parameters(\u0027allocationId\u0027), 4, 20), parameters(\u0027physicalGeneration\u0027))]") and
  ($generation.variables.vmName == "[format(\u0027swy-{0}-g{1}\u0027, variables(\u0027allocationSuffix\u0027), parameters(\u0027physicalGeneration\u0027))]") and
  ($deployment.properties.parameters.deadlineContractValid.value == "[variables(\u0027deadlineContractValid\u0027)]") and
  ($generation.parameters.deadlineContractValid.allowedValues == [true]) and
  (1 + ($generation.resources | length) == 5) and
  ([$generation.resources[].type] | sort == [
    "Microsoft.Compute/virtualMachines",
    "Microsoft.Network/networkInterfaces",
    "Microsoft.Network/networkSecurityGroups",
    "Microsoft.Network/publicIPAddresses"
  ]) and
  ([$generation.resources[] | select(.tags != "[variables(\u0027generationTags\u0027)]")] | length == 0) and
  (($nsg.properties.securityRules | map(.name) | sort) == [
    "AllowAzurePlatformDnsTcp",
    "AllowAzurePlatformDnsUdp",
    "AllowAzurePlatformImds",
    "AllowAzureWireServer",
    "AllowHttps",
    "DenyAllInbound",
    "DenyAllOutbound"
  ]) and
  ([$nsg.properties.securityRules[] | select(.name == "DenyAllInbound")][0].properties |
    (.access == "Deny") and (.direction == "Inbound") and (.priority == 4096)) and
  ([$nsg.properties.securityRules[] | select(.name == "AllowAzurePlatformDnsUdp")][0].properties |
    (.destinationAddressPrefix == "AzurePlatformDNS") and (.destinationPortRange == "53") and (.protocol == "Udp")) and
  ([$nsg.properties.securityRules[] | select(.name == "AllowAzurePlatformDnsTcp")][0].properties |
    (.destinationAddressPrefix == "AzurePlatformDNS") and (.destinationPortRange == "53") and (.protocol == "Tcp")) and
  ([$nsg.properties.securityRules[] | select(.name == "AllowAzurePlatformImds")][0].properties |
    (.destinationAddressPrefix == "AzurePlatformIMDS") and (.destinationPortRange == "80") and (.protocol == "Tcp")) and
  ([$nsg.properties.securityRules[] | select(.name == "AllowAzureWireServer")][0].properties |
    (.destinationAddressPrefix == "168.63.129.16") and (.destinationPortRanges == ["80", "32526"]) and (.protocol == "Tcp")) and
  ([$nsg.properties.securityRules[] | select(.name == "AllowHttps")][0].properties |
    (.destinationAddressPrefix == "Internet") and (.destinationPortRange == "443") and (.protocol == "Tcp")) and
  ([$nsg.properties.securityRules[] | select(.name == "DenyAllOutbound")][0].properties |
    (.access == "Deny") and (.direction == "Outbound") and (.priority == 4096)) and
  ($nic.properties.networkSecurityGroup.id == "[resourceId(\u0027Microsoft.Network/networkSecurityGroups\u0027, variables(\u0027networkSecurityGroupName\u0027))]") and
  ($generation.outputs.computeScheduleTarget.value.deadlineType == "CompleteBy") and
  ($generation.outputs.computeScheduleTarget.value.originalCompleteBy == "[parameters(\u0027originalCompleteBy\u0027)]") and
  ($generation.outputs.computeScheduleTarget.value.requiresFreshAcceptedOperation == true) and
  ($generation.outputs.computeScheduleTarget.value.physicalGenerationId == "[variables(\u0027physicalGenerationId\u0027)]") and
  (.outputs.originalCompleteBy.value == "[parameters(\u0027originalCompleteBy\u0027)]") and
  (.outputs.deletionTarget.value == "[parameters(\u0027deletionTarget\u0027)]") and
  (.outputs.deadlineContract.value.latestSafeStartOffsetMinutes == "[variables(\u0027latestSafeStartOffsetMinutes\u0027)]") and
  ([.. | strings | select(ascii_downcase == "latest")] | length == 0)
' "${repository_root}/infra/templates/azure-allocation/main.json" >/dev/null

jq -e '
  ([.resources[] | select(.type == "Microsoft.Compute/virtualMachines/runCommands")][0]) as $runCommand |
  (."$schema" == "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#") and
  (.parameters.reducedEncodedJitConfiguration.type == "securestring") and
  (.parameters.location.allowedValues == ["uksouth"]) and
  (.parameters.acceptedScheduleOperationId.minLength == 1) and
  (.parameters.scheduleAcceptedAt.minLength == 24) and
  (.parameters.launchPrerequisitesCheckedAt.minLength == 24) and
  (.parameters.latestSafeStart.minLength == 24) and
  (.parameters.latestSafeStart.maxLength == 24) and
  ([.resources[].type] == ["Microsoft.Compute/virtualMachines/runCommands"]) and
  ($runCommand.apiVersion == "2025-04-01") and
  ($runCommand.name == "[format(\u0027{0}/{1}\u0027, parameters(\u0027virtualMachineName\u0027), \u0027launch-jit-g1\u0027)]") and
  ($runCommand.properties.asyncExecution == false) and
  ($runCommand.properties.treatFailureAsDeploymentFailure == true) and
  ($runCommand.properties.timeoutInSeconds == 120) and
  ($runCommand.properties.protectedParameters == [{
    "name": "SWITCHYARD_REDUCED_JIT_CONFIG",
    "value": "[parameters(\u0027reducedEncodedJitConfiguration\u0027)]"
  }]) and
  ($runCommand.properties.parameters == null) and
  ($runCommand.properties.source.script as $script |
    ($script | contains("umask 077")) and
    ($script | contains("/usr/local/sbin/switchyard-deadline-guard allow-jit-launch")) and
    ($script | contains("export ACTIONS_RUNNER_INPUT_JITCONFIG")) and
    ($script | contains("--preserve-env=ACTIONS_RUNNER_INPUT_JITCONFIG")) and
    ($script | contains("nohup setsid sudo")) and
    ($script | contains("./run.sh >/dev/null 2>&1 &")) and
    ($script | contains("unset ACTIONS_RUNNER_INPUT_JITCONFIG")) and
    ($script | contains(".credentials_rsaparams")) and
    ($script | contains("--jitconfig") | not) and
    ($script | contains("jit-config.b64") | not)) and
  (.outputs.boundVirtualMachineId.value == "[resourceId(\u0027Microsoft.Compute/virtualMachines\u0027, parameters(\u0027virtualMachineName\u0027))]") and
  (.outputs.managedRunCommandId.value == "[resourceId(\u0027Microsoft.Compute/virtualMachines/runCommands\u0027, parameters(\u0027virtualMachineName\u0027), \u0027launch-jit-g1\u0027)]") and
  (.outputs.managedRunCommandName.value == "launch-jit-g1") and
  (.outputs.deletionObligation.value.deleteImmediatelyAfterConfirmedLaunch == true) and
  (.outputs.deletionObligation.value.readinessRequiresDeletionComplete == true)
' "${repository_root}/infra/templates/azure-allocation/jit-launch.json" >/dev/null

jq -r '.resources[] | select(.type == "Microsoft.Compute/virtualMachines/runCommands") | .properties.source.script' \
  "${repository_root}/infra/templates/azure-allocation/jit-launch.json" >"${extracted_jit_script}"
bash -n "${extracted_jit_script}"

bootstrap_definition="$(<"${repository_root}/infra/assets/azure-runner/bootstrap.sh")"
for guard_contract in \
  'metadata_tag mappedJobTimeoutMinutes' \
  'metadata_tag providerStopMarginMinutes' \
  '/dev/ptp_hyperv' \
  'ACTIONS_RUNNER_HOOK_JOB_STARTED=/usr/local/sbin/switchyard-job-start-hook' \
  'OnFailure=switchyard-deadline-guard-failure.service' \
  'AccuracySec=1us' \
  'RandomizedDelaySec=0' \
  'Persistent=true' \
  'switchyard-deadline-guard" readiness'; do
  if [[ "${bootstrap_definition}" != *"${guard_contract}"* ]]; then
    echo "The Azure bootstrap is missing exact-cutoff guard contract: ${guard_contract}" >&2
    exit 1
  fi
done

if [[ "$(rg -c '^Persistent=true$' "${repository_root}/infra/assets/azure-runner/bootstrap.sh")" != "2" ]] ||
  [[ "$(rg -c '^RandomizedDelaySec=0$' "${repository_root}/infra/assets/azure-runner/bootstrap.sh")" != "2" ]]; then
  echo "Both immutable guest deadlines must use persistent zero-jitter timers." >&2
  exit 1
fi

if ((45 - 5 - 25 - 5 != 10)); then
  echo "The Workload pilot latest-safe-start regression check did not resolve to minute 10." >&2
  exit 1
fi

if rg -n 'azurerm_(linux|windows)_virtual_machine|resource[[:space:]]+"azurerm_resource_group"[[:space:]]+"allocation' "${repository_root}/infra"; then
  echo "Transient allocation resources must not be owned by OpenTofu." >&2
  exit 1
fi

if rg -n 'resource[[:space:]]+"azurerm_(network_security_group|subnet_network_security_group_association)"' "${repository_root}/infra/modules/azure-control"; then
  echo "Allocation network security groups must be owned by the subscription-scope ARM template, not OpenTofu." >&2
  exit 1
fi

runtime_role="$(sed -n '/resource "azurerm_role_definition" "runtime"/,/resource "azurerm_role_definition" "owner_recovery"/p' "${repository_root}/infra/modules/azure-control/identity.tf")"
deployment_role="$(sed -n '/resource "azurerm_role_definition" "deployment"/,/resource "azurerm_role_assignment" "deployment"/p' "${repository_root}/infra/modules/azure-control/identity.tf")"
owner_recovery_role="$(sed -n '/resource "azurerm_role_definition" "owner_recovery"/,/resource "azurerm_role_assignment" "owner_recovery"/p' "${repository_root}/infra/modules/azure-control/identity.tf")"
owner_recovery_assignment="$(sed -n '/resource "azurerm_role_assignment" "owner_recovery"/,/^}/p' "${repository_root}/infra/modules/azure-control/identity.tf")"

for runtime_action in \
  Microsoft.Resources/subscriptions/resourceGroups/write \
  Microsoft.Resources/deployments/write \
  Microsoft.Network/networkSecurityGroups/write \
  Microsoft.Network/networkSecurityGroups/delete \
  Microsoft.Network/networkSecurityGroups/securityRules/write \
  Microsoft.Network/networkInterfaces/write \
  Microsoft.Network/publicIPAddresses/write \
  Microsoft.Compute/virtualMachines/write \
  Microsoft.Compute/virtualMachines/runCommands/read \
  Microsoft.Compute/virtualMachines/runCommands/write \
  Microsoft.Compute/virtualMachines/runCommands/delete; do
  if [[ "${runtime_role}" != *"${runtime_action}"* ]]; then
    echo "The controller runtime role is missing allocation-template action: ${runtime_action}" >&2
    exit 1
  fi
done

if [[ "${deployment_role}" == *"Microsoft.Network/networkSecurityGroups"* ]]; then
  echo "The long-lived foundation role must not own allocation network security groups." >&2
  exit 1
fi

for deployment_action in \
  'Microsoft.Insights/scheduledQueryRules/read' \
  'Microsoft.Insights/scheduledQueryRules/write' \
  'Microsoft.Insights/scheduledQueryRules/delete' \
  'Microsoft.Storage/storageAccounts/blobServices/write' \
  'Microsoft.Web/sites/config/list/action' \
  'Microsoft.Web/sites/basicPublishingCredentialsPolicies/read' \
  'Microsoft.Web/sites/basicPublishingCredentialsPolicies/write'; do
  if [[ "${deployment_role}" != *"\"${deployment_action}\""* ]]; then
    echo "The foundation role is missing declared-resource action: ${deployment_action}" >&2
    exit 1
  fi
done

if [[ "${deployment_role}" == *'"*"'* ]] || [[ "${deployment_role}" == *'/*"'* ]]; then
  echo "The foundation role must not use wildcard actions." >&2
  exit 1
fi

for recovery_action in \
  Microsoft.Resources/subscriptions/read \
  Microsoft.Resources/subscriptions/resourceGroups/read \
  Microsoft.Resources/subscriptions/resourceGroups/resources/read \
  Microsoft.Resources/subscriptions/resourceGroups/delete \
  Microsoft.Compute/virtualMachines/read \
  Microsoft.Compute/virtualMachines/instanceView/read \
  Microsoft.Compute/virtualMachines/deallocate/action \
  Microsoft.Compute/disks/read \
  Microsoft.Network/networkInterfaces/read \
  Microsoft.Network/networkSecurityGroups/read \
  Microsoft.Network/publicIPAddresses/read; do
  if [[ "${owner_recovery_role}" != *"${recovery_action}"* ]]; then
    echo "The owner recovery role is missing ${recovery_action}." >&2
    exit 1
  fi
done

if [[ "${owner_recovery_role}" == *"/write"* ]] ||
  [[ "${owner_recovery_role}" == *"Microsoft.Authorization"* ]] ||
  [[ "${owner_recovery_role}" == *"Microsoft.Storage"* ]] ||
  [[ "${owner_recovery_role}" == *"Microsoft.Web"* ]] ||
  [[ "${owner_recovery_role}" == *"Microsoft.Authorization/locks"* ]] ||
  [[ "${owner_recovery_role}" == *"data_actions"* ]] ||
  [[ "${owner_recovery_role}" == *"virtualMachines/delete"* ]]; then
  echo "The owner recovery role exceeds the reviewed read, deallocate and allocation-group delete boundary." >&2
  exit 1
fi

if [[ "${owner_recovery_assignment}" != *'scope              = local.subscription_scope'* ]] ||
  [[ "${owner_recovery_assignment}" != *'principal_id       = var.owner_recovery_principal_object_id'* ]] ||
  [[ "${owner_recovery_assignment}" != *'principal_type     = "User"'* ]]; then
  echo "Owner recovery must use its separately approved user identity at the dedicated subscription scope." >&2
  exit 1
fi

if rg -n 'secret_text|access_service_token_secret|azurerm_key_vault_secret' "${repository_root}/infra" --glob '*.tf'; then
  echo "Secret-bearing infrastructure resources or bindings are forbidden in OpenTofu." >&2
  exit 1
fi

if rg -n 'azurerm_storage_table|deployment_principal_object_id' "${repository_root}/infra/modules/azure-control/storage.tf"; then
  echo "The keyless table workaround must use ARM, and the deployment identity must have no Storage data role." >&2
  exit 1
fi

if rg -n \
  --glob '*.tf' \
  --glob '*.md' \
  'Allocations|SafetyReservations|SWITCHYARD_ALLOCATION_TABLE|SWITCHYARD_RESERVATIONS_TABLE|table_names|table_contributor|0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3' \
  "${repository_root}/infra"; then
  echo "The infrastructure must expose only the single authoritative ledger table and its runtime settings." >&2
  exit 1
fi

table_resource_count="$(rg -c '^resource "azapi_resource" "authoritative_table"' "${repository_root}/infra/modules/azure-control/storage.tf")"
if [[ "${table_resource_count}" != "1" ]]; then
  echo "Exactly one authoritative Azure Table resource is required." >&2
  exit 1
fi

function_definition="$(<"${repository_root}/infra/modules/azure-control/function.tf")"
for setting in \
  SWITCHYARD_LEDGER_TABLE_NAME \
  SWITCHYARD_LEDGER_PARTITION_KEY \
  SWITCHYARD_LEDGER_INSTANCE_ID \
  SWITCHYARD_LEDGER_SCHEMA_VERSION \
  SWITCHYARD_MANAGED_IDENTITY_CLIENT_ID; do
  if [[ "$(rg -o "${setting}" "${repository_root}/infra/modules/azure-control/function.tf" | wc -l)" != "1" ]]; then
    echo "The Function must define exactly one ${setting} setting." >&2
    exit 1
  fi
done

if [[ "${function_definition}" != *'"SWITCHYARD_MANAGED_IDENTITY_CLIENT_ID" = azurerm_user_assigned_identity.controller.client_id'* ]] ||
  [[ "${function_definition}" == *'azurerm_user_assigned_identity.ledger_bootstrap'* ]]; then
  echo "The Function must use only the controller identity for runtime ledger access." >&2
  exit 1
fi

if rg -n 'SWITCHYARD_(LEDGER_TABLE"|LEDGER_MANAGED_IDENTITY_CLIENT_ID|REPORTING_QUEUE|DOPPLER_BOOTSTRAP_ENABLED|KEY_VAULT_URI)' \
  "${repository_root}/infra/modules/azure-control/function.tf"; then
  echo "Stale or dormant Function settings must not bypass the strict runtime allowlist." >&2
  exit 1
fi

ledger_runtime_role="$(sed -n '/resource "azurerm_role_definition" "ledger_runtime"/,/resource "azurerm_role_definition" "ledger_bootstrap"/p' "${repository_root}/infra/modules/azure-control/identity.tf")"
ledger_bootstrap_role="$(sed -n '/resource "azurerm_role_definition" "ledger_bootstrap"/,/resource "azurerm_role_definition" "deployment"/p' "${repository_root}/infra/modules/azure-control/identity.tf")"

for data_action in \
  Microsoft.Storage/storageAccounts/tableServices/tables/entities/read \
  Microsoft.Storage/storageAccounts/tableServices/tables/entities/add/action \
  Microsoft.Storage/storageAccounts/tableServices/tables/entities/update/action; do
  if [[ "${ledger_runtime_role}" != *"${data_action}"* ]]; then
    echo "The runtime ledger role is missing ${data_action}." >&2
    exit 1
  fi
done

for data_action in \
  Microsoft.Storage/storageAccounts/tableServices/tables/entities/read \
  Microsoft.Storage/storageAccounts/tableServices/tables/entities/add/action; do
  if [[ "${ledger_bootstrap_role}" != *"${data_action}"* ]]; then
    echo "The provisioning ledger role is missing ${data_action}." >&2
    exit 1
  fi
done

for forbidden_action in \
  Microsoft.Storage/storageAccounts/tableServices/tables/entities/delete \
  Microsoft.Storage/storageAccounts/tableServices/tables/entities/update/action; do
  if [[ "${ledger_bootstrap_role}" == *"${forbidden_action}"* ]]; then
    echo "The provisioning ledger role must not contain ${forbidden_action}." >&2
    exit 1
  fi
done

ledger_runtime_assignment="$(sed -n '/resource "azurerm_role_assignment" "ledger_runtime_data"/,/^}/p' "${repository_root}/infra/modules/azure-control/storage.tf")"
ledger_bootstrap_assignment="$(sed -n '/resource "azurerm_role_assignment" "ledger_bootstrap_data"/,/^}/p' "${repository_root}/infra/modules/azure-control/storage.tf")"
if [[ "${ledger_runtime_assignment}" != *'scope                            = azapi_resource.authoritative_table.id'* ]] ||
  [[ "${ledger_runtime_assignment}" != *'principal_id                     = azurerm_user_assigned_identity.controller.principal_id'* ]] ||
  [[ "${ledger_bootstrap_assignment}" != *'scope                            = azapi_resource.authoritative_table.id'* ]] ||
  [[ "${ledger_bootstrap_assignment}" != *'principal_id                     = azurerm_user_assigned_identity.ledger_bootstrap.principal_id'* ]]; then
  echo "Ledger roles must be table-scoped and assigned to their distinct runtime and provisioning identities." >&2
  exit 1
fi

if find "${repository_root}" \
  -path '*/.git' -prune -o \
  -path '*/.terraform' -prune -o \
  -type f \( -name '*.tfstate' -o -name '*.tfstate.*' -o -name '*.tfplan' -o -name 'tfplan' -o -name 'plan' \) \
  -print | grep -q .; then
  echo "OpenTofu state or saved plan files must not be present in the repository." >&2
  exit 1
fi

if rg -n --hidden \
  --glob '!.git/**' \
  '(-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9_]{20,}|CF-Access-Client-Secret[[:space:]]*[:=][[:space:]]*[^$<{[:space:]])' \
  "${repository_root}"; then
  echo "A private key or credential-shaped value was found." >&2
  exit 1
fi

for ignored_path in \
  infra/scratch/terraform.tfvars.json \
  infra/scratch/example.auto.tfvars.json \
  infra/scratch/example.tfstate.backup \
  infra/scratch/example.tfplan \
  infra/scratch/tfplan \
  infra/scratch/plan \
  infra/scratch/override.tf \
  infra/scratch/local_override.tf.json; do
  git -C "${repository_root}" check-ignore --no-index --quiet "${ignored_path}" || {
    echo "Expected OpenTofu working file is not ignored: ${ignored_path}" >&2
    exit 1
  }
done

for tracked_example in \
  infra/environments/azure-pilot/terraform.tfvars.example \
  infra/environments/cloudflare-reporting/terraform.tfvars.example; do
  if git -C "${repository_root}" check-ignore --no-index --quiet "${tracked_example}"; then
    echo "Checked-in example is unexpectedly ignored: ${tracked_example}" >&2
    exit 1
  fi
done

echo "Infrastructure validation passed without cloud authentication."
