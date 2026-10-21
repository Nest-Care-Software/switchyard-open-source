#!/usr/bin/env bash
set -euo pipefail

readonly expected_subscription='a0000000-0000-4000-8000-000000000001'
readonly expected_tenant='a0000000-0000-4000-8000-000000000002'
readonly expected_azure_cli_version='2.89.1'
readonly foundation_deployment_name='switchyard-approval-foundation'
readonly subscription_scope="/subscriptions/${expected_subscription}"

usage() {
  echo 'Usage: manage-bootstrap-authority.sh <grant|revoke|verify-absent> <reviewed-plan-sha256> <control-template-sha256> [grant-acknowledgement]' >&2
  exit 2
}

[[ $# -ge 3 && $# -le 4 ]] || usage
mode="$1"
plan_digest="$2"
control_template_digest="$3"
acknowledgement="${4:-}"

[[ "${mode}" == 'grant' || "${mode}" == 'revoke' || "${mode}" == 'verify-absent' ]] || usage
[[ "${plan_digest}" =~ ^[0-9a-f]{64}$ ]] || { echo 'The reviewed plan digest must be exactly 64 lowercase hexadecimal characters.' >&2; exit 1; }
[[ "${control_template_digest}" =~ ^[0-9a-f]{64}$ ]] || { echo 'The control-template digest must be exactly 64 lowercase hexadecimal characters.' >&2; exit 1; }

if [[ "${mode}" == 'grant' ]]; then
  [[ $# -eq 4 ]] || usage
  expected_acknowledgement="GRANT SWITCHYARD INITIAL CONTROL AUTHORITY PLAN ${plan_digest} CONTROL TEMPLATE ${control_template_digest}"
  [[ "${acknowledgement}" == "${expected_acknowledgement}" ]] || { echo "Grant requires: ${expected_acknowledgement}" >&2; exit 1; }
else
  [[ $# -eq 3 ]] || usage
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${script_dir}/azure-cli-version.sh"
verifier_path="${script_dir}/verify-bootstrap-authority.mjs"

command -v az >/dev/null 2>&1 || { echo 'Azure CLI is required but was not found.' >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo 'Node.js is required but was not found.' >&2; exit 1; }
require_exact_azure_cli_version "${expected_azure_cli_version}" || exit 1

account_json="$(az account show --output json --only-show-errors)"
subscription_id="$(node -e 'const v=JSON.parse(process.argv[1]); process.stdout.write(String(v.id ?? ""))' "${account_json}")"
tenant_id="$(node -e 'const v=JSON.parse(process.argv[1]); process.stdout.write(String(v.tenantId ?? ""))' "${account_json}")"
[[ "${subscription_id}" == "${expected_subscription}" ]] || { echo 'Azure CLI is not on the exact reviewed Switchyard subscription.' >&2; exit 1; }
[[ "${tenant_id}" == "${expected_tenant}" ]] || { echo 'Azure CLI is not on the exact reviewed Switchyard tenant.' >&2; exit 1; }

foundation_outputs="$(az deployment sub show \
  --name "${foundation_deployment_name}" \
  --subscription "${expected_subscription}" \
  --query properties.outputs \
  --output json \
  --only-show-errors)"
foundation_evidence="$(printf '%s' "${foundation_outputs}" | node "${verifier_path}" foundation)"
IFS=$'\t' read -r bootstrap_client_id bootstrap_principal_id role_definition_id <<<"${foundation_evidence}"

if [[ "${mode}" == 'grant' ]]; then
  bootstrap_identity="$(az identity show \
    --ids "/subscriptions/${expected_subscription}/resourceGroups/rg-switchyard-example-state/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-switchyard-infra-bootstrap-uksouth" \
    --subscription "${expected_subscription}" \
    --output json \
    --only-show-errors)"
  [[ "$(printf '%s' "${bootstrap_identity}" | node "${verifier_path}" identity-evidence \
    "${bootstrap_client_id}" \
    "${bootstrap_principal_id}")" == 'verified' ]]

  role_definition="$(az role definition show \
    --id "${role_definition_id}" \
    --subscription "${expected_subscription}" \
    --output json \
    --only-show-errors)"
  [[ "$(printf '%s' "${role_definition}" | node "${verifier_path}" role-definition-evidence)" == 'verified' ]]
fi

assignment_name="$(node "${verifier_path}" assignment-name \
  "${bootstrap_principal_id}" \
  "${role_definition_id}" \
  "${plan_digest}" \
  "${control_template_digest}")"
assignment_id="${subscription_scope}/providers/Microsoft.Authorization/roleAssignments/${assignment_name}"

read_assignment_status() {
  local assignments
  assignments="$(az role assignment list \
    --scope "${subscription_scope}" \
    --fill-principal-name false \
    --fill-role-definition-name false \
    --subscription "${expected_subscription}" \
    --output json \
    --only-show-errors)"
  printf '%s' "${assignments}" | node "${verifier_path}" assignment-list \
    "${assignment_id}" \
    "${bootstrap_principal_id}" \
    "${role_definition_id}" \
    "${plan_digest}" \
    "${control_template_digest}"
}

if [[ "${mode}" == 'grant' ]]; then
  assignment_description="Temporary Switchyard initial control authority for plan ${plan_digest} and control template ${control_template_digest}."
  az role assignment create \
    --name "${assignment_name}" \
    --assignee-object-id "${bootstrap_principal_id}" \
    --assignee-principal-type ServicePrincipal \
    --role "${role_definition_id}" \
    --scope "${subscription_scope}" \
    --description "${assignment_description}" \
    --subscription "${expected_subscription}" \
    --output none \
    --only-show-errors
  [[ "$(read_assignment_status)" == 'present' ]] || { echo 'The temporary bootstrap role assignment was not proved after grant.' >&2; exit 1; }
  echo 'The exact digest-bound temporary bootstrap role assignment is present. Revoke it after every terminal or uncertain initial apply result.'
  exit 0
fi

initial_status="$(read_assignment_status)"
if [[ "${mode}" == 'revoke' && "${initial_status}" == 'present' ]]; then
  az role assignment delete \
    --ids "${assignment_id}" \
    --subscription "${expected_subscription}" \
    --only-show-errors
fi

[[ "$(read_assignment_status)" == 'absent' ]] || { echo 'The exact temporary bootstrap role assignment is still present.' >&2; exit 1; }
echo 'The exact digest-bound temporary bootstrap role assignment is absent.'
