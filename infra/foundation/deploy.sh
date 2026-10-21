#!/usr/bin/env bash
set -euo pipefail

readonly expected_subscription='a0000000-0000-4000-8000-000000000001'
readonly expected_tenant='a0000000-0000-4000-8000-000000000002'
readonly disabled_engine_sha='49be281fc0d6c2cf746a0ce0f6db517d0ac821af'
readonly expected_azure_cli_version='2.89.1'
readonly deployment_name='switchyard-approval-foundation'
readonly policy_api_version='2025-06-01'
readonly policy_lock_api_version='2025-08-01'

usage() {
  echo 'Usage: deploy.sh <validate|what-if|create> <engine-sha> [acknowledgement]' >&2
  exit 2
}

[[ $# -ge 2 && $# -le 3 ]] || usage
mode="$1"
engine_sha="$2"
acknowledgement="${3:-}"

[[ "${mode}" == 'validate' || "${mode}" == 'what-if' || "${mode}" == 'create' ]] || usage
if [[ "${mode}" == 'create' ]]; then
  [[ $# -eq 3 ]] || usage
else
  [[ $# -eq 2 ]] || usage
fi
[[ "${engine_sha}" =~ ^[0-9a-f]{40}$ ]] || { echo 'The final engine SHA must be one full lowercase commit SHA.' >&2; exit 1; }
[[ "${engine_sha}" != "${disabled_engine_sha}" ]] || { echo 'The disabled 49be281 engine can never activate this foundation.' >&2; exit 1; }

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${script_dir}/azure-cli-version.sh"
template_path="${script_dir}/main.json"
template_digest="$(sha256sum "${template_path}" | awk '{print $1}')"
policy_id="/subscriptions/${expected_subscription}/resourceGroups/rg-switchyard-example-state/providers/Microsoft.Storage/storageAccounts/swexampleapprovalreceipt/blobServices/default/containers/plan-receipts/immutabilityPolicies/default"
policy_get_url="https://management.azure.com${policy_id}?api-version=${policy_api_version}"
policy_lock_url="https://management.azure.com${policy_id}/lock?api-version=${policy_lock_api_version}"
state_resource_group='rg-switchyard-example-state'

command -v az >/dev/null 2>&1 || { echo 'Azure CLI is required but was not found.' >&2; exit 1; }
require_exact_azure_cli_version "${expected_azure_cli_version}" || exit 1

account_json="$(az account show --output json --only-show-errors)"
subscription_id="$(node -e 'const v=JSON.parse(process.argv[1]); process.stdout.write(String(v.id ?? ""))' "${account_json}")"
tenant_id="$(node -e 'const v=JSON.parse(process.argv[1]); process.stdout.write(String(v.tenantId ?? ""))' "${account_json}")"
[[ "${subscription_id}" == "${expected_subscription}" && "${tenant_id}" == "${expected_tenant}" ]] || { echo 'Azure CLI is not on the exact reviewed Switchyard subscription and tenant.' >&2; exit 1; }

if [[ "${mode}" == 'create' ]]; then
  expected_ack="DEPLOY SWITCHYARD FOUNDATION ${template_digest}"
  [[ "${acknowledgement}" == "${expected_ack}" ]] || { echo "Creation requires: ${expected_ack}" >&2; exit 1; }
fi

select_receipt_policy_deployment() {
  local group_exists current_json current_evidence current_state current_etag
  group_exists="$(az group exists \
    --name "${state_resource_group}" \
    --subscription "${expected_subscription}" \
    --output tsv \
    --only-show-errors)" || return 1

  if [[ "${group_exists}" == 'false' ]]; then
    printf 'true\n'
    return 0
  fi
  [[ "${group_exists}" == 'true' ]] || return 1

  current_json="$(az rest --method get --url "${policy_get_url}" --output json --only-show-errors)" || {
    echo 'The foundation resource group exists, but the receipt immutability policy could not be proved. Stop and follow the recovery runbook.' >&2
    return 1
  }
  current_evidence="$(printf '%s' "${current_json}" | node "${script_dir}/verify-immutability-policy.mjs" "${policy_id}" either)" || return 1
  IFS=$'\t' read -r current_state current_etag <<<"${current_evidence}" || return 1
  [[ -n "${current_etag}" ]] || return 1

  case "${current_state}" in
    Locked) printf 'false\n' ;;
    Unlocked) printf 'true\n' ;;
    *) return 1 ;;
  esac
}

deploy_receipt_immutability_policy="$(select_receipt_policy_deployment)" || exit 1

az deployment sub "${mode}" \
  --name "${deployment_name}" \
  --location uksouth \
  --subscription "${expected_subscription}" \
  --template-file "${template_path}" \
  --parameters \
    finalEngineSha="${engine_sha}" \
    deployReceiptImmutabilityPolicy="${deploy_receipt_immutability_policy}" \
  --only-show-errors

lock_receipt_policy() {
  local current_json current_evidence current_state current_etag lock_json final_json
  current_json="$(az rest --method get --url "${policy_get_url}" --output json --only-show-errors)" || return 1
  current_evidence="$(printf '%s' "${current_json}" | node "${script_dir}/verify-immutability-policy.mjs" "${policy_id}" either)" || return 1
  IFS=$'\t' read -r current_state current_etag <<<"${current_evidence}" || return 1

  if [[ "${current_state}" == 'Unlocked' ]]; then
    lock_json="$(az rest \
      --method post \
      --url "${policy_lock_url}" \
      --headers "If-Match=${current_etag}" \
      --output json \
      --only-show-errors)" || return 1
    printf '%s' "${lock_json}" | node "${script_dir}/verify-immutability-policy.mjs" "${policy_id}" locked >/dev/null || return 1
  elif [[ "${current_state}" != 'Locked' ]]; then
    return 1
  fi

  final_json="$(az rest --method get --url "${policy_get_url}" --output json --only-show-errors)" || return 1
  printf '%s' "${final_json}" | node "${script_dir}/verify-immutability-policy.mjs" "${policy_id}" locked >/dev/null || return 1
}

if [[ "${mode}" == 'create' ]] && ! lock_receipt_policy; then
  echo 'Foundation deployment is partial: the receipt immutability policy lock or its final verification failed. Stop and follow docs/infrastructure-foundation-rollback.md.' >&2
  exit 1
fi
