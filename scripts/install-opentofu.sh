#!/usr/bin/env bash
set -euo pipefail

readonly tofu_version="1.12.1"
readonly archive_sha256="1fc9af962e3632b7cd0ba27076cd9f1ced177567defe9e331ac37f5a40468575"
readonly binary_sha256="b6cb308bd699c8b53882319986f339eeaa44f925a68f12d5b0a14e6caceedf23"
readonly archive_url="https://github.com/opentofu/opentofu/releases/download/v${tofu_version}/tofu_${tofu_version}_linux_amd64.zip"

if [[ -z "${RUNNER_TEMP:-}" || "${RUNNER_TEMP}" != /* || "${RUNNER_TEMP}" == */../* ]]; then
  echo "RUNNER_TEMP must be an absolute canonical path." >&2
  exit 1
fi

readonly install_parent="${RUNNER_TEMP}/switchyard-opentofu"
readonly install_dir="${install_parent}/${tofu_version}"
readonly archive_path="${RUNNER_TEMP}/switchyard-opentofu-${tofu_version}.zip"

install -d -m 0700 "${install_parent}"
if [[ -e "${install_dir}" || -e "${archive_path}" ]]; then
  echo "OpenTofu staging path is not empty." >&2
  exit 1
fi
mkdir -m 0700 "${install_dir}"
trap 'rm -f "${archive_path}"' EXIT

curl \
  --proto '=https' \
  --tlsv1.2 \
  --fail \
  --location \
  --silent \
  --show-error \
  --max-time 60 \
  --output "${archive_path}" \
  "${archive_url}"

printf '%s  %s\n' "${archive_sha256}" "${archive_path}" | sha256sum --check --strict

mapfile -t archive_entries < <(unzip -Z1 "${archive_path}")
readonly expected_entries=(CHANGELOG.md LICENSE README.md tofu)
if [[ "${archive_entries[*]}" != "${expected_entries[*]}" ]]; then
  echo "OpenTofu archive contents differ from the reviewed release." >&2
  exit 1
fi

unzip -qq -j "${archive_path}" tofu -d "${install_dir}"
chmod 0500 "${install_dir}/tofu"
printf '%s  %s\n' "${binary_sha256}" "${install_dir}/tofu" | sha256sum --check --strict
test "$("${install_dir}/tofu" version)" = $'OpenTofu v1.12.1\non linux_amd64'
