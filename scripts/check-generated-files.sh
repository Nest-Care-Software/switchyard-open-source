#!/usr/bin/env bash

set -euo pipefail

git diff --exit-code HEAD --

mapfile -d '' -t untracked_files < <(git ls-files --others --exclude-standard -z)
if (( ${#untracked_files[@]} > 0 )); then
  echo "Untracked files were generated:" >&2
  printf '  %q\n' "${untracked_files[@]}" >&2
  exit 1
fi
