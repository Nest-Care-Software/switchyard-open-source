#!/usr/bin/env bash
set -euo pipefail

readonly expected_subscription='a0000000-0000-4000-8000-000000000001'
readonly expected_tenant='a0000000-0000-4000-8000-000000000002'
readonly expected_azure_cli_version='2.89.1'
readonly resource_group='rg-switchyard-example-state'
readonly deployment_name='switchyard-oidc-subject-correction'
readonly api_version='2023-01-31'

usage() {
  echo 'Usage: update-oidc-subjects.sh <validate|what-if|create> [create-acknowledgement]' >&2
  exit 2
}

[[ $# -ge 1 && $# -le 2 ]] || usage
mode="$1"
acknowledgement="${2:-}"
[[ "${mode}" == 'validate' || "${mode}" == 'what-if' || "${mode}" == 'create' ]] || usage
if [[ "${mode}" == 'create' ]]; then
  [[ $# -eq 2 ]] || usage
else
  [[ $# -eq 1 ]] || usage
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${script_dir}/azure-cli-version.sh"
template_path="${script_dir}/oidc-subject-correction.json"
verifier_path="${script_dir}/verify-oidc-subject-correction.mjs"
template_digest="$(sha256sum "${template_path}" | awk '{print $1}')"

if [[ "${mode}" == 'create' ]]; then
  expected_acknowledgement="UPDATE SWITCHYARD OIDC SUBJECTS ${template_digest}"
  [[ "${acknowledgement}" == "${expected_acknowledgement}" ]] || { echo "Creation requires: ${expected_acknowledgement}" >&2; exit 1; }
fi

command -v az >/dev/null 2>&1 || { echo 'Azure CLI is required but was not found.' >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo 'Node.js is required but was not found.' >&2; exit 1; }
require_exact_azure_cli_version "${expected_azure_cli_version}" || exit 1

account_json="$(az account show --output json --only-show-errors)"
subscription_id="$(node -e 'const v=JSON.parse(process.argv[1]); process.stdout.write(String(v.id ?? ""))' "${account_json}")"
tenant_id="$(node -e 'const v=JSON.parse(process.argv[1]); process.stdout.write(String(v.tenantId ?? ""))' "${account_json}")"
[[ "${subscription_id}" == "${expected_subscription}" && "${tenant_id}" == "${expected_tenant}" ]] || { echo 'Azure CLI is not on the exact reviewed Switchyard subscription and tenant.' >&2; exit 1; }

az deployment group "${mode}" \
  --name "${deployment_name}" \
  --resource-group "${resource_group}" \
  --subscription "${expected_subscription}" \
  --template-file "${template_path}" \
  --only-show-errors

if [[ "${mode}" != 'create' ]]; then
  exit 0
fi

corrected="$(az deployment group show \
  --name "${deployment_name}" \
  --resource-group "${resource_group}" \
  --subscription "${expected_subscription}" \
  --query properties.outputs.corrected.value \
  --output tsv \
  --only-show-errors)"
[[ "${corrected}" == 'true' ]] || { echo 'The subject correction deployment did not prove its exact subscription, tenant and resource group.' >&2; exit 1; }

verify_credential() {
  local identity="$1"
  local credential="$2"
  local kind="$3"
  local resource_id="/subscriptions/${expected_subscription}/resourceGroups/${resource_group}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${identity}/federatedIdentityCredentials/${credential}"
  az rest \
    --method get \
    --url "https://management.azure.com${resource_id}?api-version=${api_version}" \
    --output json \
    --only-show-errors | node "${verifier_path}" "${kind}" >/dev/null
}

verify_credential 'id-switchyard-infra-planner-uksouth' 'github-infrastructure-plan-engine' 'planner'
verify_credential 'id-switchyard-infra-foundation-uksouth' 'github-infrastructure-apply-engine' 'foundation'
verify_credential 'id-switchyard-infra-bootstrap-uksouth' 'github-infrastructure-apply-engine' 'bootstrap'

echo 'All three Switchyard federated credentials now match the reviewed GitHub immutable subject.'
