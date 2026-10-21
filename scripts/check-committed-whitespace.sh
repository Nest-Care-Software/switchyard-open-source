#!/usr/bin/env bash

set -euo pipefail

readonly empty_tree="4b825dc642cb6eb9a060e54bf8d69288fbee4904"
readonly event_name="${EVENT_NAME:?EVENT_NAME is required}"
readonly before_sha="${BEFORE_SHA:-}"

case "${event_name}" in
  pull_request)
    # GitHub checks out a synthetic merge commit; its first parent is the base.
    git diff --check HEAD^1 HEAD
    ;;
  push)
    # A push may contain several commits, so check the complete pushed range.
    if [[ -n "${before_sha}" ]] &&
      [[ "${before_sha}" != "0000000000000000000000000000000000000000" ]] &&
      git cat-file -e "${before_sha}^{commit}" 2>/dev/null; then
      git diff --check "${before_sha}" HEAD
    else
      git diff --check "${empty_tree}" HEAD
    fi
    ;;
  workflow_dispatch)
    # A manual run checks the selected commit against its first parent.
    if git rev-parse --verify --quiet HEAD^ >/dev/null; then
      git diff --check HEAD^ HEAD
    else
      git diff --check "${empty_tree}" HEAD
    fi
    ;;
  *)
    echo "Unsupported event: ${event_name}" >&2
    exit 1
    ;;
esac
