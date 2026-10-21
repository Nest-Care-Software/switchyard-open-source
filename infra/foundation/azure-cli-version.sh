require_exact_azure_cli_version() {
  local expected_version="$1"
  local version_output
  local version_line=''
  local version_line_count=0
  local line

  if ! version_output="$(az --version 2>&1)"; then
    echo "Azure CLI ${expected_version} is required." >&2
    return 1
  fi

  while IFS= read -r line || [[ -n "${line}" ]]; do
    [[ "${line}" =~ ^azure-cli[[:space:]] ]] || continue
    if [[ "${line}" =~ ^azure-cli[[:space:]]+([0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
      version_line="${BASH_REMATCH[1]}"
      version_line_count=$((version_line_count + 1))
    else
      echo "Azure CLI ${expected_version} is required." >&2
      return 1
    fi
  done <<<"${version_output}"

  if [[ "${version_line_count}" -ne 1 || "${version_line}" != "${expected_version}" ]]; then
    echo "Azure CLI ${expected_version} is required." >&2
    return 1
  fi
}
