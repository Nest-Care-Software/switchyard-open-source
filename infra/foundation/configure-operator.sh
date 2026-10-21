#!/usr/bin/env bash
set -euo pipefail
set +H

readonly expected_subscription='a0000000-0000-4000-8000-000000000001'
readonly expected_tenant='a0000000-0000-4000-8000-000000000002'
readonly expected_azure_cli_version='2.89.1'
readonly operator_client_id='a0000000-0000-4000-8000-00000000000a'
readonly operator_principal_id='a0000000-0000-4000-8000-00000000000b'
readonly operator_display_name='Switchyard operator operator'
readonly bootstrap_principal_id='a0000000-0000-4000-8000-000000000009'
readonly creator_role_id='3ad77f1d-46f0-5203-b2d8-2ccfa0bcf5e3'
readonly reader_role_id='acdd72a7-3385-48ef-bd42-f606fba81ae7'
readonly rbac_admin_role_id='f58310d9-a9f6-439a-9e8d-f62e7b41a168'
readonly reader_assignment_name='a0000000-0000-4000-8000-00000000000c'
readonly rbac_assignment_name='a0000000-0000-4000-8000-00000000000d'
readonly acknowledgement='CONFIGURE SWITCHYARD OPERATOR OPERATOR'
readonly subscription_scope="/subscriptions/${expected_subscription}"

if [[ $# -ne 1 || "$1" != "${acknowledgement}" ]]; then
  echo "Usage: configure-operator.sh '${acknowledgement}'" >&2
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${script_dir}/azure-cli-version.sh"

command -v az >/dev/null 2>&1 || { echo 'Azure CLI is required.' >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo 'jq is required.' >&2; exit 1; }
require_exact_azure_cli_version "${expected_azure_cli_version}" || exit 1

actual_subscription="$(az account show --query id --output tsv --only-show-errors)"
actual_tenant="$(az account show --query tenantId --output tsv --only-show-errors)"
[[ "${actual_subscription}" == "${expected_subscription}" ]] || { echo 'Azure CLI is on the wrong subscription.' >&2; exit 1; }
[[ "${actual_tenant}" == "${expected_tenant}" ]] || { echo 'Azure CLI is on the wrong tenant.' >&2; exit 1; }

service_principal="$(az ad sp show --id "${operator_client_id}" --output json --only-show-errors)"
[[ "$(printf '%s' "${service_principal}" | jq -r '.appId')" == "${operator_client_id}" ]] || { echo 'The operator application ID is wrong.' >&2; exit 1; }
[[ "$(printf '%s' "${service_principal}" | jq -r '.id')" == "${operator_principal_id}" ]] || { echo 'The operator principal ID is wrong.' >&2; exit 1; }
[[ "$(printf '%s' "${service_principal}" | jq -r '.displayName')" == "${operator_display_name}" ]] || { echo 'The operator display name is wrong.' >&2; exit 1; }

role_definition_path="${subscription_scope}/providers/Microsoft.Authorization/roleDefinitions"
reader_role_definition="${role_definition_path}/${reader_role_id}"
rbac_role_definition="${role_definition_path}/${rbac_admin_role_id}"

existing_assignments="$(az role assignment list \
  --scope "${subscription_scope}" \
  --fill-principal-name false \
  --fill-role-definition-name false \
  --subscription "${expected_subscription}" \
  --output json \
  --only-show-errors)"

mapfile -t stale_assignment_ids < <(printf '%s' "${existing_assignments}" | jq -r \
  --arg principal "${operator_principal_id}" \
  --arg reader "${reader_role_definition}" \
  --arg rbac "${rbac_role_definition}" \
  '.[] | select(.principalId == $principal and (.roleDefinitionId == $reader or .roleDefinitionId == $rbac)) | .id')

for assignment_id in "${stale_assignment_ids[@]}"; do
  az role assignment delete \
    --ids "${assignment_id}" \
    --subscription "${expected_subscription}" \
    --only-show-errors
done

az role assignment create \
  --name "${reader_assignment_name}" \
  --assignee-object-id "${operator_principal_id}" \
  --assignee-principal-type ServicePrincipal \
  --role "${reader_role_id}" \
  --scope "${subscription_scope}" \
  --description 'Read-only Azure inspection for the Switchyard operator operator.' \
  --subscription "${expected_subscription}" \
  --output none \
  --only-show-errors

rbac_condition="((!(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})) OR (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${creator_role_id}} AND @Request[Microsoft.Authorization/roleAssignments:PrincipalId] ForAnyOfAnyValues:GuidEquals {${bootstrap_principal_id}} AND @Request[Microsoft.Authorization/roleAssignments:PrincipalType] ForAnyOfAnyValues:StringEqualsIgnoreCase {'ServicePrincipal'})) AND ((!(ActionMatches{'Microsoft.Authorization/roleAssignments/delete'})) OR (@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${creator_role_id}} AND @Resource[Microsoft.Authorization/roleAssignments:PrincipalId] ForAnyOfAnyValues:GuidEquals {${bootstrap_principal_id}} AND @Resource[Microsoft.Authorization/roleAssignments:PrincipalType] ForAnyOfAnyValues:StringEqualsIgnoreCase {'ServicePrincipal'}))"

az role assignment create \
  --name "${rbac_assignment_name}" \
  --assignee-object-id "${operator_principal_id}" \
  --assignee-principal-type ServicePrincipal \
  --role "${rbac_admin_role_id}" \
  --scope "${subscription_scope}" \
  --condition "${rbac_condition}" \
  --condition-version '2.0' \
  --description 'May manage only the exact Switchyard bootstrap creator assignment.' \
  --subscription "${expected_subscription}" \
  --output none \
  --only-show-errors

verified_assignments="$(az role assignment list \
  --scope "${subscription_scope}" \
  --fill-principal-name false \
  --fill-role-definition-name false \
  --subscription "${expected_subscription}" \
  --output json \
  --only-show-errors)"

reader_count="$(printf '%s' "${verified_assignments}" | jq \
  --arg id "${subscription_scope}/providers/Microsoft.Authorization/roleAssignments/${reader_assignment_name}" \
  --arg principal "${operator_principal_id}" \
  --arg role "${reader_role_definition}" \
  --arg scope "${subscription_scope}" \
  '[.[] | select(.id == $id and .principalId == $principal and .roleDefinitionId == $role and .scope == $scope)] | length')"

restricted_count="$(printf '%s' "${verified_assignments}" | jq \
  --arg id "${subscription_scope}/providers/Microsoft.Authorization/roleAssignments/${rbac_assignment_name}" \
  --arg principal "${operator_principal_id}" \
  --arg role "${rbac_role_definition}" \
  --arg scope "${subscription_scope}" \
  --arg condition "${rbac_condition}" \
  '[.[] | select(.id == $id and .principalId == $principal and .roleDefinitionId == $role and .scope == $scope and .conditionVersion == "2.0" and .condition == $condition)] | length')"

[[ "${reader_count}" == '1' ]] || { echo 'The exact Reader assignment was not proved.' >&2; exit 1; }
[[ "${restricted_count}" == '1' ]] || { echo 'The exact restricted RBAC assignment was not proved.' >&2; exit 1; }

credential_json="$(az ad app credential reset \
  --id "${operator_client_id}" \
  --display-name 'switchyard-example-operator' \
  --years 1 \
  --output json \
  --only-show-errors)"
client_secret="$(printf '%s' "${credential_json}" | jq -r '.password')"
[[ -n "${client_secret}" && "${client_secret}" != 'null' ]] || { echo 'Azure did not return the replacement credential.' >&2; exit 1; }

echo 'The restricted Switchyard operator operator is configured and verified.'
echo 'Copy these three values directly into Doppler switchyard/prd. Do not paste them into chat.'
jq -n \
  --arg clientId "${operator_client_id}" \
  --arg objectId "${operator_principal_id}" \
  --arg clientSecret "${client_secret}" \
  '{AZURE_CLIENT_ID:$clientId,AZURE_OPERATOR_OBJECT_ID:$objectId,AZURE_CLIENT_SECRET:$clientSecret}'

unset client_secret credential_json
