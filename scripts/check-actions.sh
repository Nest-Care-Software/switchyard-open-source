#!/usr/bin/env bash

set -euo pipefail

readonly actionlint_version="1.7.12"
readonly actionlint_archive="actionlint_${actionlint_version}_linux_amd64.tar.gz"
readonly actionlint_sha256="8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8"
readonly actionlint_url="https://github.com/rhysd/actionlint/releases/download/v${actionlint_version}/${actionlint_archive}"

temporary_directory="$(mktemp -d)"
trap 'rm -rf "${temporary_directory}"' EXIT

curl \
  --proto '=https' \
  --proto-redir '=https' \
  --tlsv1.2 \
  --fail \
  --silent \
  --show-error \
  --location \
  "${actionlint_url}" \
  --output "${temporary_directory}/${actionlint_archive}"

printf '%s  %s\n' \
  "${actionlint_sha256}" \
  "${temporary_directory}/${actionlint_archive}" | sha256sum --check --strict -

tar \
  --extract \
  --gzip \
  --file "${temporary_directory}/${actionlint_archive}" \
  --directory "${temporary_directory}" \
  actionlint

# actionlint 1.7.12 predates GitHub's documented reusable-workflow job identity
# fields. A repository test limits those four fields to the reviewed allocator.
"${temporary_directory}/actionlint" \
  -color \
  -shellcheck= \
  -pyflakes= \
  -ignore 'property "workflow_(file_path|ref|repository|sha)" is not defined in object type'
