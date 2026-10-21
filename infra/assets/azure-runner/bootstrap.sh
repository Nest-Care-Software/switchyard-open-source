#!/usr/bin/env bash

set -euo pipefail
umask 027

readonly runner_version="2.336.0"
readonly runner_archive="actions-runner-linux-x64-${runner_version}.tar.gz"
readonly runner_url="https://github.com/actions/runner/releases/download/v${runner_version}/${runner_archive}"
readonly runner_sha256="04cf0be1aff4c3ec3554466c39124ca250e3effd8873bb7e8d68535aa9505d5d"
readonly runner_home="/opt/actions-runner"
readonly resource_link="/dev/disk/azure/resource"
readonly work_mount="/mnt/switchyard"
readonly disk_preparation_command="/usr/local/sbin/switchyard-prepare-resource-disk"
readonly disk_preparation_service="/etc/systemd/system/switchyard-resource-disk.service"
readonly readiness_command="/usr/local/sbin/switchyard-runner-readiness"
readonly readiness_marker="/var/lib/switchyard/bootstrap-ready"
readonly deadline_guard_command="/usr/local/sbin/switchyard-deadline-guard"
readonly job_start_hook="/usr/local/sbin/switchyard-job-start-hook"
readonly deadline_guard_config="/etc/switchyard/deadline-guard.conf"
readonly deadline_guard_failure_service="/etc/systemd/system/switchyard-deadline-guard-failure.service"
readonly deadline_guard_cutoff_service="/etc/systemd/system/switchyard-latest-safe-start.service"
readonly deadline_guard_cutoff_timer="/etc/systemd/system/switchyard-latest-safe-start.timer"
readonly deadline_guard_compute_service="/etc/systemd/system/switchyard-compute-deadline.service"
readonly deadline_guard_compute_timer="/etc/systemd/system/switchyard-compute-deadline.timer"
readonly deadline_guard_sudoers="/etc/sudoers.d/switchyard-deadline-guard"
readonly metadata_url='http://169.254.169.254/metadata/instance/compute?api-version=2025-04-07'

fail() {
  printf 'switchyard-bootstrap: %s\n' "$1" >&2
  exit 1
}

[[ "${EUID}" -eq 0 ]] || fail "root is required"
[[ "$#" -eq 0 ]] || fail "arguments are not accepted"
rm -f -- "${readiness_marker}"

source /etc/os-release
[[ "${ID:-}" == "ubuntu" && "${VERSION_ID:-}" == "24.04" ]] ||
  fail "Canonical Ubuntu 24.04 is required"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends ca-certificates chrony curl docker.io e2fsprogs jq sudo util-linux

[[ -e /dev/ptp_hyperv && -L /dev/ptp_hyperv ]] || fail "Azure host PTP clock is unavailable"
ptp_device="$(basename -- "$(readlink -f -- /dev/ptp_hyperv)")"
[[ "${ptp_device}" =~ ^ptp[0-9]+$ ]] || fail "Azure host PTP device is invalid"
[[ "$(<"/sys/class/ptp/${ptp_device}/clock_name")" == "hyperv" ]] ||
  fail "PTP device is not the Azure host clock"
cat >/etc/chrony/conf.d/switchyard-azure-host.conf <<'CHRONY'
refclock PHC /dev/ptp_hyperv poll 3 dpoll -2 offset 0 stratum 2 prefer
makestep 1.0 -1
CHRONY
chown root:root /etc/chrony/conf.d/switchyard-azure-host.conf
chmod 0644 /etc/chrony/conf.d/switchyard-azure-host.conf
systemctl restart chrony.service
chronyc waitsync 30 0.050 100 1 >/dev/null || fail "Azure host clock did not synchronise"
chronyc sources | grep -Eq '^#\*.*PHC' || fail "Chrony did not select the Azure host PTP clock"

metadata_file="$(mktemp --tmpdir switchyard-imds.XXXXXX)"
trap 'rm -f -- "${metadata_file}"' EXIT
curl --fail --silent --show-error --noproxy '*' \
  --header 'Metadata: true' --connect-timeout 2 --max-time 5 \
  --retry 4 --retry-all-errors --retry-delay 1 \
  --output "${metadata_file}" "${metadata_url}" || fail "Azure instance metadata is unavailable"
(("$(stat -c '%s' "${metadata_file}")" <= 65536)) || fail "Azure instance metadata is oversized"
# BEGIN SWITCHYARD TESTABLE IMDS CONTRACT
jq -e '
  type == "object" and
  .azEnvironment == "AZUREPUBLICCLOUD" and
  (.location | ascii_downcase) == "uksouth" and
  (.tagsList | type == "array" and length <= 64) and
  ([.tagsList[].name | ascii_downcase] | length == (unique | length)) and
  ([.tagsList[] | select((.name | type) != "string" or (.value | type) != "string")] | length == 0)
' "${metadata_file}" >/dev/null || fail "Azure instance metadata is invalid"

metadata_field() {
  local field="$1"
  jq -er --arg field "${field}" '.[$field] | select(type == "string" and length > 0)' \
    "${metadata_file}" || fail "Azure instance metadata field is missing"
}

metadata_tag() {
  local name="$1"
  jq -er --arg name "${name}" \
    '[.tagsList[] | select(.name == $name)] | select(length == 1) | .[0].value' \
    "${metadata_file}" || fail "mandatory Azure recovery tag is missing"
}

allocation_id="$(metadata_tag allocationId)"
physical_generation="$(metadata_tag physicalGeneration)"
latest_safe_start="$(metadata_tag latestSafeStart)"
compute_deadline="$(metadata_tag originalCompleteBy)"
allocation_accepted_at="$(metadata_tag allocationAcceptedAt)"
allocation_lifetime_minutes="$(metadata_tag allocationLifetimeMinutes)"
deletion_target="$(metadata_tag deletionTarget)"
mapped_job_timeout_minutes="$(metadata_tag mappedJobTimeoutMinutes)"
provider_stop_margin_minutes="$(metadata_tag providerStopMarginMinutes)"
resource_group_name="$(metadata_field resourceGroupName)"
vm_name="$(metadata_field name)"

[[ "${allocation_id}" =~ ^sy1-([a-f0-9]{64})$ ]] || fail "allocation identity is invalid"
allocation_digest="${BASH_REMATCH[1]}"
[[ "${physical_generation}" == "1" ]] || fail "physical generation is invalid"
[[ "$(metadata_tag physicalGenerationId)" == "${allocation_id}:g1" ]] ||
  fail "physical generation identity is invalid"
[[ "$(metadata_tag managedBy)" == "switchyard-controller" ]] || fail "managedBy tag is invalid"
[[ "$(metadata_tag system)" == "switchyard" ]] || fail "system tag is invalid"
[[ "$(metadata_tag deadlineContractValidated)" == "true" ]] || fail "deadline contract is invalid"
[[ "${mapped_job_timeout_minutes}" == "25" ]] || fail "mapped job timeout is invalid"
[[ "${provider_stop_margin_minutes}" == "5" ]] || fail "provider stop margin is invalid"
[[ "${allocation_lifetime_minutes}" == "45" ]] || fail "allocation lifetime is invalid"
[[ "${resource_group_name}" == "rg-switchyard-allocation-${allocation_digest:0:24}" ]] ||
  fail "resource group identity is invalid"
[[ "${vm_name}" == "swy-${allocation_digest:0:20}-g1" ]] || fail "VM identity is invalid"

for timestamp in "${allocation_accepted_at}" "${latest_safe_start}" "${compute_deadline}" "${deletion_target}"; do
  [[ "${timestamp}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$ ]] ||
    fail "deadline is not canonical UTC"
  [[ "$(date --utc --date="${timestamp}" '+%Y-%m-%dT%H:%M:%S.%3NZ')" == "${timestamp}" ]] ||
    fail "deadline is not a real UTC instant"
done
allocation_accepted_epoch_ms="$(date --utc --date="${allocation_accepted_at}" '+%s%3N')"
latest_safe_start_epoch_ms="$(date --utc --date="${latest_safe_start}" '+%s%3N')"
compute_deadline_epoch_ms="$(date --utc --date="${compute_deadline}" '+%s%3N')"
deletion_target_epoch_ms="$(date --utc --date="${deletion_target}" '+%s%3N')"
((compute_deadline_epoch_ms == allocation_accepted_epoch_ms + 40 * 60 * 1000)) ||
  fail "compute deadline is inconsistent"
((deletion_target_epoch_ms == allocation_accepted_epoch_ms + 45 * 60 * 1000)) ||
  fail "deletion target is inconsistent"
((latest_safe_start_epoch_ms == compute_deadline_epoch_ms - (mapped_job_timeout_minutes + provider_stop_margin_minutes) * 60 * 1000)) ||
  fail "latest safe start is inconsistent"
# END SWITCHYARD TESTABLE IMDS CONTRACT
boot_id="$(</proc/sys/kernel/random/boot_id)"
[[ "${boot_id}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] ||
  fail "boot identity is invalid"
anchor_utc_epoch_ms="$(date --utc '+%s%3N')"
anchor_monotonic_ms="$(awk '{printf "%.0f", $1 * 1000}' /proc/uptime)"
[[ "${anchor_utc_epoch_ms}" =~ ^[0-9]{13}$ && "${anchor_monotonic_ms}" =~ ^[0-9]+$ ]] ||
  fail "clock anchor is invalid"

getent group docker >/dev/null || groupadd --system docker
if ! id switchyard >/dev/null 2>&1; then
  useradd --create-home --home-dir /home/switchyard --shell /bin/bash --user-group switchyard
fi
usermod -aG docker switchyard

install -d -o root -g root -m 0755 /etc/switchyard /var/lib/switchyard
config_temporary="$(mktemp --tmpdir=/etc/switchyard deadline-guard.conf.XXXXXX)"
printf '%s\n' \
  'format_version=1' \
  "allocation_id=${allocation_id}" \
  "physical_generation=${physical_generation}" \
  "mapped_job_timeout_minutes=${mapped_job_timeout_minutes}" \
  "provider_stop_margin_minutes=${provider_stop_margin_minutes}" \
  "latest_safe_start=${latest_safe_start}" \
  "compute_deadline=${compute_deadline}" \
  "boot_id=${boot_id}" \
  "anchor_utc_epoch_ms=${anchor_utc_epoch_ms}" \
  "anchor_monotonic_ms=${anchor_monotonic_ms}" >"${config_temporary}"
chown root:root "${config_temporary}"
chmod 0444 "${config_temporary}"
mv -f -- "${config_temporary}" "${deadline_guard_config}"

cat >"${deadline_guard_command}" <<'DEADLINE_GUARD'
#!/usr/bin/env bash
set -euo pipefail
umask 077

readonly production_config='/etc/switchyard/deadline-guard.conf'
readonly production_state='/var/lib/switchyard/deadline-guard'
readonly production_cutoff_timer='/etc/systemd/system/switchyard-latest-safe-start.timer'
readonly production_compute_timer='/etc/systemd/system/switchyard-compute-deadline.timer'
readonly runner_pattern='/opt/actions-runner|/run/switchyard/launch-runner'

if [[ -n "${SWITCHYARD_GUARD_TEST_ROOT:-}" ]]; then
  [[ "${EUID}" -ne 0 ]] || exit 70
  [[ "${SWITCHYARD_GUARD_TEST_ROOT}" == /* && -d "${SWITCHYARD_GUARD_TEST_ROOT}" ]] || exit 70
  readonly config="${SWITCHYARD_GUARD_TEST_ROOT}/deadline-guard.conf"
  readonly state="${SWITCHYARD_GUARD_TEST_ROOT}/state"
  readonly test_mode=true
else
  [[ "${EUID}" -eq 0 ]] || exit 70
  readonly config="${production_config}"
  readonly state="${production_state}"
  readonly test_mode=false
fi
readonly marker="${state}/job-started"
readonly fence_marker="${state}/fenced"
readonly evidence="${state}/evidence.jsonl"
readonly lock="${state}/guard.lock"

die() {
  printf 'switchyard-deadline-guard: invalid local safety state\n' >&2
  exit 70
}

utc_now() {
  if [[ "${test_mode}" == true && -f "${SWITCHYARD_GUARD_TEST_ROOT}/now-ms" ]]; then
    local supplied
    supplied="$(<"${SWITCHYARD_GUARD_TEST_ROOT}/now-ms")"
    [[ "${supplied}" =~ ^[0-9]{13}$ ]] || die
    printf '%s\n' "${supplied}"
  else
    date --utc '+%s%3N'
  fi
}

monotonic_now() {
  if [[ "${test_mode}" == true && -f "${SWITCHYARD_GUARD_TEST_ROOT}/monotonic-ms" ]]; then
    local supplied
    supplied="$(<"${SWITCHYARD_GUARD_TEST_ROOT}/monotonic-ms")"
    [[ "${supplied}" =~ ^[0-9]+$ ]] || die
    printf '%s\n' "${supplied}"
  else
    awk '{printf "%.0f", $1 * 1000}' /proc/uptime
  fi
}

current_boot_id() {
  if [[ "${test_mode}" == true && -f "${SWITCHYARD_GUARD_TEST_ROOT}/boot-id" ]]; then
    tr -d '\n' <"${SWITCHYARD_GUARD_TEST_ROOT}/boot-id"
  else
    tr -d '\n' </proc/sys/kernel/random/boot_id
  fi
}

effective_now() {
  local utc monotonic projected
  [[ "$(current_boot_id)" == "${boot_id}" ]] || die
  utc="$(utc_now)"
  monotonic="$(monotonic_now)"
  ((monotonic >= anchor_monotonic_ms)) || die
  projected=$((anchor_utc_epoch_ms + monotonic - anchor_monotonic_ms))
  if ((utc >= projected)); then printf '%s\n' "${utc}"; else printf '%s\n' "${projected}"; fi
}

load_config() {
  [[ -f "${config}" && ! -L "${config}" ]] || die
  local owner_mode
  owner_mode="$(stat -c '%U:%G:%a' "${config}")"
  if [[ "${test_mode}" == true ]]; then
    [[ "${owner_mode}" == "$(id -un):$(id -gn):444" ]] || die
  else
    [[ "${owner_mode}" == 'root:root:444' ]] || die
  fi
  mapfile -t config_lines <"${config}"
  [[ "${#config_lines[@]}" -eq 10 ]] || die
  [[ "${config_lines[0]}" == 'format_version=1' ]] || die
  [[ "${config_lines[1]}" =~ ^allocation_id=(sy1-[a-f0-9]{64})$ ]] || die
  allocation_id="${BASH_REMATCH[1]}"
  [[ "${config_lines[2]}" == 'physical_generation=1' ]] || die
  physical_generation='1'
  [[ "${config_lines[3]}" == 'mapped_job_timeout_minutes=25' ]] || die
  mapped_job_timeout_minutes=25
  [[ "${config_lines[4]}" == 'provider_stop_margin_minutes=5' ]] || die
  provider_stop_margin_minutes=5
  [[ "${config_lines[5]}" =~ ^latest_safe_start=([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z)$ ]] || die
  latest_safe_start="${BASH_REMATCH[1]}"
  [[ "${config_lines[6]}" =~ ^compute_deadline=([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z)$ ]] || die
  compute_deadline="${BASH_REMATCH[1]}"
  [[ "${config_lines[7]}" =~ ^boot_id=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$ ]] || die
  boot_id="${BASH_REMATCH[1]}"
  [[ "${config_lines[8]}" =~ ^anchor_utc_epoch_ms=([0-9]{13})$ ]] || die
  anchor_utc_epoch_ms="${BASH_REMATCH[1]}"
  [[ "${config_lines[9]}" =~ ^anchor_monotonic_ms=([0-9]+)$ ]] || die
  anchor_monotonic_ms="${BASH_REMATCH[1]}"
  for timestamp in "${latest_safe_start}" "${compute_deadline}"; do
    [[ "$(date --utc --date="${timestamp}" '+%Y-%m-%dT%H:%M:%S.%3NZ')" == "${timestamp}" ]] || die
  done
  latest_safe_start_epoch_ms="$(date --utc --date="${latest_safe_start}" '+%s%3N')"
  compute_deadline_epoch_ms="$(date --utc --date="${compute_deadline}" '+%s%3N')"
  ((latest_safe_start_epoch_ms == compute_deadline_epoch_ms - (mapped_job_timeout_minutes + provider_stop_margin_minutes) * 60 * 1000)) || die
  [[ "$(current_boot_id)" == "${boot_id}" ]] || die
  effective_now >/dev/null
}

append_evidence() {
  local result_code="$1"
  case "${result_code}" in
    job-start-authorised | job-start-rejected | runner-fenced-at-cutoff | compute-deadline-fenced) ;;
    *) die ;;
  esac
  local event_epoch_ms event_time
  event_epoch_ms="$(effective_now)"
  event_time="$(date --utc --date="@$((${event_epoch_ms} / 1000))" '+%Y-%m-%dT%H:%M:%SZ')"
  printf '{"allocation_id":"%s","event_time":"%s","physical_generation":1,"result_code":"%s"}\n' \
    "${allocation_id}" "${event_time}" "${result_code}" >>"${evidence}"
}

validate_marker() {
  [[ -f "${marker}" && ! -L "${marker}" ]] || return 1
  local owner_mode
  owner_mode="$(stat -c '%U:%G:%a' "${marker}")"
  if [[ "${test_mode}" == true ]]; then
    [[ "${owner_mode}" == "$(id -un):$(id -gn):444" ]] || die
  else
    [[ "${owner_mode}" == 'root:root:444' ]] || die
  fi
  mapfile -t marker_lines <"${marker}"
  [[ "${#marker_lines[@]}" -eq 4 ]] || die
  [[ "${marker_lines[0]}" == 'format_version=1' ]] || die
  [[ "${marker_lines[1]}" == "allocation_id=${allocation_id}" ]] || die
  [[ "${marker_lines[2]}" == "physical_generation=${physical_generation}" ]] || die
  [[ "${marker_lines[3]}" =~ ^started_at_epoch_ms=([0-9]{13})$ ]] || die
  started_at_epoch_ms="${BASH_REMATCH[1]}"
  ((started_at_epoch_ms <= latest_safe_start_epoch_ms)) || die
}

validate_fence_marker() {
  [[ -f "${fence_marker}" && ! -L "${fence_marker}" ]] || return 1
  local owner_mode
  owner_mode="$(stat -c '%U:%G:%a' "${fence_marker}")"
  if [[ "${test_mode}" == true ]]; then
    [[ "${owner_mode}" == "$(id -un):$(id -gn):444" ]] || die
  else
    [[ "${owner_mode}" == 'root:root:444' ]] || die
  fi
  mapfile -t fence_lines <"${fence_marker}"
  [[ "${#fence_lines[@]}" -eq 3 ]] || die
  [[ "${fence_lines[0]}" == 'format_version=1' ]] || die
  [[ "${fence_lines[1]}" == "allocation_id=${allocation_id}" ]] || die
  [[ "${fence_lines[2]}" == "physical_generation=${physical_generation}" ]] || die
}

validate_timer_file() {
  local path="$1"
  local timestamp="$2"
  [[ -f "${path}" && ! -L "${path}" ]] || die
  [[ "$(stat -c '%U:%G:%a' "${path}")" == 'root:root:644' ]] || die
  local calendar
  calendar="${timestamp/T/ }"
  calendar="${calendar%Z} UTC"
  [[ "$(grep -Fxc "OnCalendar=${calendar}" "${path}")" -eq 1 ]] || die
  [[ "$(grep -Fxc 'AccuracySec=1us' "${path}")" -eq 1 ]] || die
  [[ "$(grep -Fxc 'RandomizedDelaySec=0' "${path}")" -eq 1 ]] || die
  [[ "$(grep -Fxc 'Persistent=true' "${path}")" -eq 1 ]] || die
}

record_start() {
  load_config
  mkdir -p -- "${state}"
  chmod 0755 "${state}"
  exec 9>"${lock}"
  flock --exclusive 9
  if validate_fence_marker; then
    append_evidence job-start-rejected
    return 78
  fi
  if validate_marker; then
    append_evidence job-start-rejected
    return 78
  fi
  local observed temporary
  observed="$(effective_now)"
  if ((observed > latest_safe_start_epoch_ms)); then
    append_evidence job-start-rejected
    return 78
  fi
  temporary="$(mktemp --tmpdir="${state}" job-started.XXXXXX)"
  printf '%s\n' \
    'format_version=1' \
    "allocation_id=${allocation_id}" \
    "physical_generation=${physical_generation}" \
    "started_at_epoch_ms=${observed}" >"${temporary}"
  chmod 0444 "${temporary}"
  if [[ "${test_mode}" == false ]]; then chown root:root "${temporary}"; fi
  mv -f -- "${temporary}" "${marker}"
  append_evidence job-start-authorised
}

fence_and_power_off() {
  local result_code="$1"
  if ! validate_fence_marker; then
    local temporary
    temporary="$(mktemp --tmpdir="${state}" fenced.XXXXXX)"
    printf '%s\n' \
      'format_version=1' \
      "allocation_id=${allocation_id}" \
      "physical_generation=${physical_generation}" >"${temporary}"
    chmod 0444 "${temporary}"
    if [[ "${test_mode}" == false ]]; then chown root:root "${temporary}"; fi
    mv -f -- "${temporary}" "${fence_marker}"
  fi
  append_evidence "${result_code}"
  if [[ "${test_mode}" == true ]]; then
    : >"${state}/poweroff-requested"
    return 0
  fi
  pkill --signal TERM --uid switchyard --full "${runner_pattern}" 2>/dev/null || true
  /usr/bin/systemctl stop docker.service docker.socket 2>/dev/null || true
  sleep 1
  pkill --signal KILL --uid switchyard --full "${runner_pattern}" 2>/dev/null || true
  /usr/bin/systemctl poweroff --force --force
}

sleep_until() {
  local target_epoch_ms="$1"
  while true; do
    local current remaining sleep_seconds
    current="$(effective_now)"
    ((current >= target_epoch_ms)) && return 0
    remaining=$((target_epoch_ms - current))
    sleep_seconds="$(printf '%d.%03d' "$((remaining / 1000))" "$((remaining % 1000))")"
    sleep "${sleep_seconds}"
  done
}

cutoff() {
  load_config
  mkdir -p -- "${state}"
  chmod 0755 "${state}"
  touch "${lock}"
  chmod 0660 "${lock}"
  sleep_until "${latest_safe_start_epoch_ms}"
  exec 9>"${lock}"
  flock --exclusive 9
  if ! validate_marker; then
    fence_and_power_off runner-fenced-at-cutoff
    return 0
  fi
}

compute_deadline() {
  load_config
  mkdir -p -- "${state}"
  chmod 0755 "${state}"
  touch "${lock}"
  chmod 0660 "${lock}"
  sleep_until "${compute_deadline_epoch_ms}"
  exec 9>"${lock}"
  flock --exclusive 9
  fence_and_power_off compute-deadline-fenced
}

allow_jit_launch() {
  load_config
  mkdir -p -- "${state}"
  chmod 0755 "${state}"
  exec 9>"${lock}"
  flock --exclusive 9
  validate_fence_marker && return 78
  local observed
  observed="$(effective_now)"
  ((observed < latest_safe_start_epoch_ms)) || return 78
}

case "${1:-}" in
  record-start)
    [[ "$#" -eq 1 ]] || die
    record_start
    ;;
  validate)
    [[ "$#" -eq 1 ]] || die
    load_config
    ;;
  readiness)
    [[ "$#" -eq 1 ]] || die
    load_config
    if validate_fence_marker; then exit 78; fi
    validate_timer_file "${production_cutoff_timer}" "${latest_safe_start}"
    validate_timer_file "${production_compute_timer}" "${compute_deadline}"
    systemctl is-active --quiet chrony.service
    systemctl is-active --quiet switchyard-latest-safe-start.timer
    systemctl is-active --quiet switchyard-compute-deadline.timer
    systemctl is-enabled --quiet switchyard-latest-safe-start.timer
    systemctl is-enabled --quiet switchyard-compute-deadline.timer
    chronyc sources | grep -Eq '^#\*.*PHC'
    ;;
  latest-safe-start)
    [[ "$#" -eq 1 ]] || die
    cutoff
    ;;
  compute-deadline)
    [[ "$#" -eq 1 ]] || die
    compute_deadline
    ;;
  allow-jit-launch)
    [[ "$#" -eq 1 ]] || die
    allow_jit_launch
    ;;
  *) die ;;
esac
DEADLINE_GUARD
chown root:root "${deadline_guard_command}"
chmod 0755 "${deadline_guard_command}"

cat >"${job_start_hook}" <<'JOB_START_HOOK'
#!/usr/bin/env bash
set -euo pipefail
set +x
exec timeout --signal=KILL 10s sudo --non-interactive -- \
  /usr/local/sbin/switchyard-deadline-guard record-start
JOB_START_HOOK
chown root:root "${job_start_hook}"
chmod 0755 "${job_start_hook}"

printf '%s\n' \
  'switchyard ALL=(root) NOPASSWD: /usr/local/sbin/switchyard-deadline-guard record-start' \
  >"${deadline_guard_sudoers}"
chown root:root "${deadline_guard_sudoers}"
chmod 0440 "${deadline_guard_sudoers}"
visudo --check --file="${deadline_guard_sudoers}" >/dev/null

cat >"${deadline_guard_failure_service}" <<'GUARD_FAILURE_SERVICE'
[Unit]
Description=Fail closed when the Switchyard deadline guard cannot prove local safety

[Service]
Type=oneshot
ExecStart=/usr/bin/systemctl poweroff --force --force
GUARD_FAILURE_SERVICE
chown root:root "${deadline_guard_failure_service}"
chmod 0644 "${deadline_guard_failure_service}"

cat >"${deadline_guard_cutoff_service}" <<'CUTOFF_SERVICE'
[Unit]
Description=Fence an unassigned Switchyard runner at latest safe start
After=time-sync.target
Wants=time-sync.target
OnFailure=switchyard-deadline-guard-failure.service

[Service]
Type=oneshot
ExecStartPre=/usr/local/sbin/switchyard-deadline-guard validate
CUTOFF_SERVICE
printf '%s\n' 'ExecStart=/usr/local/sbin/switchyard-deadline-guard latest-safe-start' \
  >>"${deadline_guard_cutoff_service}"
chown root:root "${deadline_guard_cutoff_service}"
chmod 0644 "${deadline_guard_cutoff_service}"

cat >"${deadline_guard_compute_service}" <<'COMPUTE_SERVICE'
[Unit]
Description=Fence Switchyard guest compute at its immutable CompleteBy deadline
After=time-sync.target
Wants=time-sync.target
OnFailure=switchyard-deadline-guard-failure.service

[Service]
Type=oneshot
ExecStartPre=/usr/local/sbin/switchyard-deadline-guard validate
ExecStart=/usr/local/sbin/switchyard-deadline-guard compute-deadline
COMPUTE_SERVICE
chown root:root "${deadline_guard_compute_service}"
chmod 0644 "${deadline_guard_compute_service}"

latest_safe_start_calendar="${latest_safe_start/T/ }"
latest_safe_start_calendar="${latest_safe_start_calendar%Z} UTC"
compute_deadline_calendar="${compute_deadline/T/ }"
compute_deadline_calendar="${compute_deadline_calendar%Z} UTC"
cat >"${deadline_guard_cutoff_timer}" <<CUTOFF_TIMER
[Unit]
Description=Arm the immutable Switchyard latest-safe-start fence

[Timer]
OnCalendar=${latest_safe_start_calendar}
AccuracySec=1us
RandomizedDelaySec=0
Persistent=true
Unit=switchyard-latest-safe-start.service

[Install]
WantedBy=timers.target
CUTOFF_TIMER
chown root:root "${deadline_guard_cutoff_timer}"
chmod 0644 "${deadline_guard_cutoff_timer}"

cat >"${deadline_guard_compute_timer}" <<COMPUTE_TIMER
[Unit]
Description=Arm the immutable Switchyard CompleteBy compute fence

[Timer]
OnCalendar=${compute_deadline_calendar}
AccuracySec=1us
RandomizedDelaySec=0
Persistent=true
Unit=switchyard-compute-deadline.service

[Install]
WantedBy=timers.target
COMPUTE_TIMER
chown root:root "${deadline_guard_compute_timer}"
chmod 0644 "${deadline_guard_compute_timer}"

cat >"${disk_preparation_command}" <<'PREPARE_DISK'
#!/usr/bin/env bash
set -euo pipefail
umask 027

readonly resource_link="/dev/disk/azure/resource"
readonly work_mount="/mnt/switchyard"

for _attempt in $(seq 1 30); do
  [[ -L "${resource_link}" ]] && break
  sleep 1
done
[[ -L "${resource_link}" ]]
resource_device="$(readlink -f -- "${resource_link}")"
[[ -b "${resource_device}" ]]
[[ "$(lsblk -dnro TYPE -- "${resource_device}")" == "disk" ]]
[[ "${resource_device}" == /dev/nvme* ]]

root_device="$(readlink -f -- "$(findmnt -nro SOURCE /)")"
while read -r block_device _mountpoint; do
  [[ "$(readlink -f -- "${block_device}")" != "${root_device}" ]]
done < <(lsblk -nrpo NAME,MOUNTPOINT -- "${resource_device}")

while read -r block_device mountpoint; do
  case "${mountpoint}" in
    "") ;;
    "[SWAP]") swapoff -- "${block_device}" ;;
    *) umount -- "${block_device}" ;;
  esac
done < <(lsblk -nrpo NAME,MOUNTPOINT -- "${resource_device}" | tac)

wipefs --all --force -- "${resource_device}"
mkfs.ext4 -F -L switchyard-work "${resource_device}"
install -d -m 0755 "${work_mount}"
mount -o nodev,nosuid,noatime "${resource_device}" "${work_mount}"
install -d -o root -g switchyard -m 0710 "${work_mount}/docker"
install -d -o switchyard -g switchyard -m 0710 "${work_mount}/runner-work"
PREPARE_DISK
chown root:root "${disk_preparation_command}"
chmod 0755 "${disk_preparation_command}"

cat >"${disk_preparation_service}" <<'RESOURCE_DISK_SERVICE'
[Unit]
Description=Prepare the disposable Switchyard NVMe resource disk
After=local-fs.target
Before=docker.service docker.socket

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/switchyard-prepare-resource-disk
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
RESOURCE_DISK_SERVICE
chown root:root "${disk_preparation_service}"
chmod 0644 "${disk_preparation_service}"

install -d -m 0755 /etc/docker
printf '%s\n' \
  '{' \
  "  \"data-root\": \"${work_mount}/docker\"," \
  '  "log-driver": "local",' \
  '  "log-opts": {' \
  '    "max-file": "2",' \
  '    "max-size": "10m"' \
  '  }' \
  '}' >/etc/docker/daemon.json
chmod 0644 /etc/docker/daemon.json

systemctl stop docker.service docker.socket || true
systemctl daemon-reload
systemctl enable switchyard-resource-disk.service docker.service
systemctl restart switchyard-resource-disk.service

archive_path="$(mktemp --tmpdir "${runner_archive}.XXXXXX")"
trap 'rm -f -- "${archive_path}"' EXIT
curl --fail --silent --show-error --location \
  --proto '=https' --tlsv1.2 \
  --connect-timeout 10 --max-time 180 \
  --output "${archive_path}" "${runner_url}"
printf '%s  %s\n' "${runner_sha256}" "${archive_path}" | sha256sum --check --status ||
  fail "runner archive digest mismatch"

rm -rf -- "${runner_home}"
install -d -m 0755 "${runner_home}"
tar --extract --gzip --file "${archive_path}" --directory "${runner_home}" \
  --no-same-owner --no-same-permissions
[[ -x "${runner_home}/bin/Runner.Listener" && -x "${runner_home}/run.sh" ]] ||
  fail "runner archive is incomplete"
"${runner_home}/bin/installdependencies.sh"
chown -R switchyard:switchyard "${runner_home}"
rm -rf -- "${runner_home}/_work"
ln -sfn "${work_mount}/runner-work" "${runner_home}/_work"
chown -h switchyard:switchyard "${runner_home}/_work"
printf '%s\n' 'ACTIONS_RUNNER_DISABLEUPDATE=1' >"${runner_home}/.env"
printf '%s\n' 'ACTIONS_RUNNER_HOOK_JOB_STARTED=/usr/local/sbin/switchyard-job-start-hook' \
  >>"${runner_home}/.env"
chown root:root "${runner_home}/.env"
chmod 0444 "${runner_home}/.env"

systemctl enable --now switchyard-latest-safe-start.timer switchyard-compute-deadline.timer
systemctl start docker.service
docker info >/dev/null

install -d -o root -g root -m 0755 /var/lib/switchyard
cat >"${readiness_command}" <<'READINESS'
#!/usr/bin/env bash
set -euo pipefail

readonly runner_home="/opt/actions-runner"
readonly resource_link="/dev/disk/azure/resource"
readonly work_mount="/mnt/switchyard"
readonly readiness_marker="/var/lib/switchyard/bootstrap-ready"
readonly expected_runner_version="2.336.0"

[[ "${EUID}" -eq 0 ]]
[[ "$#" -eq 0 ]]
[[ -L "${resource_link}" ]]
resource_device="$(readlink -f -- "${resource_link}")"
[[ -b "${resource_device}" && "${resource_device}" == /dev/nvme* ]]
[[ "$(readlink -f -- "$(findmnt -nro SOURCE "${work_mount}")")" == "${resource_device}" ]]
[[ -d "${work_mount}/docker" && -d "${work_mount}/runner-work" ]]
[[ "$(stat -c '%U:%G:%a' "${readiness_marker}")" == "root:root:444" ]]
[[ "$(stat -c '%U:%G:%a' "${runner_home}/.env")" == "root:root:444" ]]
mapfile -t runner_environment <"${runner_home}/.env"
[[ "${#runner_environment[@]}" -eq 2 ]]
[[ "${runner_environment[0]}" == "ACTIONS_RUNNER_DISABLEUPDATE=1" ]]
[[ "${runner_environment[1]}" == "ACTIONS_RUNNER_HOOK_JOB_STARTED=/usr/local/sbin/switchyard-job-start-hook" ]]
[[ -x "${runner_home}/bin/Runner.Listener" && -x "${runner_home}/run.sh" ]]
[[ "$(runuser -u switchyard -- "${runner_home}/bin/Runner.Listener" --version)" == "${expected_runner_version}" ]]
systemctl is-active --quiet docker.service
"/usr/local/sbin/switchyard-deadline-guard" readiness
printf '{"ready":true,"runner_version":"%s"}\n' "${expected_runner_version}"
READINESS
chown root:root "${readiness_command}"
chmod 0755 "${readiness_command}"

resource_device="$(readlink -f -- "${resource_link}")"
[[ -b "${resource_device}" && "${resource_device}" == /dev/nvme* ]] ||
  fail "prepared Azure resource disk is invalid"
[[ "$(readlink -f -- "$(findmnt -nro SOURCE "${work_mount}")")" == "${resource_device}" ]] ||
  fail "prepared Azure resource disk is not mounted"
[[ "$(runuser -u switchyard -- "${runner_home}/bin/Runner.Listener" --version)" == "${runner_version}" ]] ||
  fail "installed runner version is invalid"
systemctl is-active --quiet docker.service || fail "Docker is not active"

printf '%s\n' \
  "runner_version=${runner_version}" \
  "runner_archive_sha256=${runner_sha256}" \
  "work_mount=${work_mount}" \
  "deadline_guard_version=1" \
  "allocation_id=${allocation_id}" \
  "physical_generation=${physical_generation}" \
  "latest_safe_start=${latest_safe_start}" \
  "compute_deadline=${compute_deadline}" >"${readiness_marker}"
chown root:root "${readiness_marker}"
chmod 0444 "${readiness_marker}"

"${readiness_command}" >/dev/null
printf 'switchyard-bootstrap: ready\n'
