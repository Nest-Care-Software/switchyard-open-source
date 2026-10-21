targetScope = 'resourceGroup'

@description('Exact existing generation-one VM name returned by the reviewed base allocation deployment.')
@minLength(1)
@maxLength(64)
param virtualMachineName string

@description('V1 Azure region. The launch resource must remain beside the existing VM.')
@allowed([
  'uksouth'
])
param location string = 'uksouth'

@description('Accepted Compute Schedule operation for this exact VM. The controller persists and verifies this before launch.')
@minLength(1)
@maxLength(256)
param acceptedScheduleOperationId string

@description('Acceptance time for the exact Compute Schedule operation, in canonical UTC form.')
@minLength(24)
@maxLength(24)
param scheduleAcceptedAt string

@description('Checked bootstrap, local NVMe and Docker prerequisite marker time, in canonical UTC form.')
@minLength(24)
@maxLength(24)
param launchPrerequisitesCheckedAt string

@description('Immutable latest safe start copied from the authoritative generation. JIT launch must finish its local guard before this instant.')
@minLength(24)
@maxLength(24)
param latestSafeStart string

@description('Reduced, single-use encoded JIT runner configuration returned by GitHub. It must never contain a GitHub App key, installation token or registration token.')
@secure()
@minLength(1)
param reducedEncodedJitConfiguration string

@description('Mandatory lifecycle tags copied from the authoritative generation record.')
param tags object

resource virtualMachine 'Microsoft.Compute/virtualMachines@2025-04-01' existing = {
  name: virtualMachineName
}

// Azure supplies this named protected parameter as an environment variable.
// The fixed script never places the JIT payload in command text, arguments,
// output or a Switchyard-created payload file. The runner itself necessarily
// creates restricted disposable files, which this wrapper removes after the
// one-job process exits. The controller deletes this Run Command resource
// immediately after launch is confirmed and before declaring readiness.
resource managedRunCommand 'Microsoft.Compute/virtualMachines/runCommands@2025-04-01' = {
  parent: virtualMachine
  name: 'launch-jit-g1'
  location: location
  properties: {
    asyncExecution: false
    protectedParameters: [
      {
        name: 'SWITCHYARD_REDUCED_JIT_CONFIG'
        value: reducedEncodedJitConfiguration
      }
    ]
    source: {
      script: '''
#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

runner_user='switchyard'
runner_home='/opt/actions-runner'
runtime_root='/run/switchyard'
launcher_path="${runtime_root}/launch-runner"

cleanup_outer() {
  status=$?
  trap - EXIT HUP INT TERM
  set +e
  unset SWITCHYARD_REDUCED_JIT_CONFIG ACTIONS_RUNNER_INPUT_JITCONFIG
  exit "${status}"
}
trap cleanup_outer EXIT HUP INT TERM

if [[ ! -x "${runner_home}/run.sh" ]] || ! id "${runner_user}" >/dev/null 2>&1; then
  echo 'Switchyard JIT launch failed before runner start.' >&2
  exit 1
fi

# The root-owned guest guard uses Azure-host-synchronised UTC plus a monotonic
# anchor and shares one lock with both persistent deadline timers. Equality is
# too late for JIT launch even though the pre-job hook can win equality later.
/usr/local/sbin/switchyard-deadline-guard allow-jit-launch

if [[ -z "${SWITCHYARD_REDUCED_JIT_CONFIG:-}" ]]; then
  echo 'Switchyard JIT launch failed before runner start.' >&2
  exit 1
fi

install -d -m 0710 -o root -g "${runner_user}" "${runtime_root}"
install -m 0550 -o root -g "${runner_user}" /dev/stdin "${launcher_path}" <<'SWITCHYARD_RUNNER'
#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

runner_home='/opt/actions-runner'

cleanup_runner_files() {
  status=$?
  trap - EXIT HUP INT TERM
  set +e
  unset ACTIONS_RUNNER_INPUT_JITCONFIG
  for credential_name in .credentials .credentials_rsaparams .runner; do
    credential_path="${runner_home}/${credential_name}"
    if [[ -f "${credential_path}" ]]; then
      chmod 0600 "${credential_path}"
      rm -f "${credential_path}"
    fi
  done
  exit "${status}"
}
trap cleanup_runner_files EXIT HUP INT TERM

cd "${runner_home}"
./run.sh >/dev/null 2>&1 &
runner_pid=$!
unset ACTIONS_RUNNER_INPUT_JITCONFIG
wait "${runner_pid}"
SWITCHYARD_RUNNER

export ACTIONS_RUNNER_INPUT_JITCONFIG="${SWITCHYARD_REDUCED_JIT_CONFIG}"
unset SWITCHYARD_REDUCED_JIT_CONFIG

nohup setsid sudo --preserve-env=ACTIONS_RUNNER_INPUT_JITCONFIG \
  --user "${runner_user}" -- "${launcher_path}" \
  >/dev/null 2>&1 </dev/null &
launcher_pid=$!
unset ACTIONS_RUNNER_INPUT_JITCONFIG

if ! kill -0 "${launcher_pid}" 2>/dev/null; then
  echo 'Switchyard JIT launch failed before runner start.' >&2
  exit 1
fi

echo 'Switchyard JIT runner process launch handed off.'
'''
    }
    timeoutInSeconds: 120
    treatFailureAsDeploymentFailure: true
  }
  tags: union(tags, {
    acceptedScheduleOperationId: acceptedScheduleOperationId
    launchPrerequisitesCheckedAt: launchPrerequisitesCheckedAt
    latestSafeStart: latestSafeStart
    scheduleAcceptedAt: scheduleAcceptedAt
  })
}

output boundVirtualMachineId string = virtualMachine.id
output managedRunCommandId string = managedRunCommand.id
output managedRunCommandName string = managedRunCommand.name
output deletionObligation object = {
  deleteImmediatelyAfterConfirmedLaunch: true
  readinessRequiresDeletionComplete: true
}
