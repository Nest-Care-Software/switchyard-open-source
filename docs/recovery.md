# Owner recovery

This is the manual, ledger-independent safety path for one Azure allocation. It
fences Azure cost and the matching GitHub runner registration as independent
branches. It never changes the Switchyard ledger or releases a reservation.

Recovery from a partial control-foundation apply or lingering temporary bootstrap
authority is a separate procedure. Use the
[infrastructure foundation rollback runbook](infrastructure-foundation-rollback.md),
including mandatory digest-bound revoke and verify-absent after every terminal or
uncertain initial apply result. Do not use this allocation command to change IAM.

The command is dry-run by default. Production remains disabled, so these steps
document the reviewed drill and future incident procedure. Do not run `--execute`
until the dedicated subscription, owner recovery role and live drill have been
approved.

## Run one recovery

1. Sign in to the dedicated Switchyard Azure subscription with the separately
   approved owner recovery identity:

   ```sh
   export SWITCHYARD_RECOVERY_SUBSCRIPTION_ID='<reviewed dedicated subscription UUID>'
   az login
   az account set --subscription "$SWITCHYARD_RECOVERY_SUBSCRIPTION_ID"
   ```

   This identity can read allocation resources, deallocate an exact VM and delete
   an allocation resource group. It cannot create resources, change IAM, remove
   locks, read Storage or operate the Function app.

2. Build the checked-in command, then create a private absolute audit-file path:

   ```sh
   npm ci
   npm run build --workspace @switchyard/recovery-cli
   install -m 0600 /dev/null /absolute/private/path/switchyard-recovery.jsonl
   ```

   The audit contains only the allocation ID, plan hash, result code, timestamp
   and `ledger_settlement_required`. It never contains Azure or GitHub tokens.

3. Run the non-mutating plan for exactly one canonical allocation ID:

   ```sh
   node apps/recovery-cli/dist/cli.js \
     --allocation-id 'sy1-<64 lowercase hex characters>' \
     --subscription "$SWITCHYARD_RECOVERY_SUBSCRIPTION_ID" \
     --audit-file /absolute/private/path/switchyard-recovery.jsonl
   ```

   Confirm the subscription, UK South resource-group name, VM name, provider VM
   ID, runner label and complete inventory. The command recomputes the 10, 40 and
   45-minute deadlines from immutable tags. Unknown resources are called out and
   prevent resource-group deletion.

4. Obtain a short-lived organisation runner token through the reviewed Doppler
   owner config. It needs only the organisation self-hosted runner permission.
   Doppler must expose it to this process as
   `SWITCHYARD_GITHUB_RUNNER_TOKEN`. Do not use a repository token, broad GitHub
   token or a token copied into shell history.

5. Immediately rerun through Doppler with the exact fresh plan hash, observed
   provider VM ID and literal resource-group confirmation:

   ```sh
   doppler run -- node apps/recovery-cli/dist/cli.js \
     --allocation-id 'sy1-<64 lowercase hex characters>' \
     --subscription "$SWITCHYARD_RECOVERY_SUBSCRIPTION_ID" \
     --audit-file /absolute/private/path/switchyard-recovery.jsonl \
     --execute \
     --plan-hash '<64 lowercase hex characters from step 3>' \
     --provider-vm-id '<exact provider VM ID from step 3>' \
     --confirm 'DELETE rg-switchyard-allocation-<first 24 allocation digest characters>'
   ```

   The command re-enumerates before every mutation. It proves VM deallocation,
   deletes every registration with the exact unique runner label, requires two
   separated complete absence scans, requests resource-group deletion and polls
   for absence. A changed target stops safely.
   If the dry run proves that the resource group is already absent, omit
   `--provider-vm-id`; execution still performs the independent GitHub fence.

6. Treat a non-zero result as a partial recovery, not a reason to stop. Azure and
   GitHub are independent. For example, a GitHub outage must not prevent Azure
   deallocation or deletion, and an Azure outage must not prevent runner fencing.
   Rerun from step 3. If an unknown Azure resource is present, the proved VM is
   still deallocated and the runner is fenced, but group deletion is refused for
   owner investigation.

7. After both external branches are clean, leave the authoritative ledger alone.
   `ledger_settlement_required` means the ordinary controller must independently
   verify terminal workload evidence, Azure absence and runner absence before it
   can release concurrency or cost reservations. Azure deletion alone is not
   settlement.

## Abandoned-allocation drill

1. Use an explicitly approved non-production allocation in the dedicated
   subscription. Record its allocation ID without copying job output or tokens.
2. Stop the normal control path at the agreed drill point and run the dry-run and
   execute steps above.
3. Verify independently that the Azure VM is deallocated, the allocation group is
   absent and two separated GitHub runner scans are empty.
4. Restore the controller and verify that reconciliation, not the recovery CLI,
   settles the ledger and reservations from independent evidence.
5. Preserve only the redacted 0600 audit and the approved lifecycle evidence.
   Do not collect runner logs, source, job output or credentials.

GitHub documents the synchronous pre-job hook used by the guest safety guard in
[Running scripts before or after a job](https://docs.github.com/en/actions/how-tos/managing-self-hosted-runners/running-scripts-before-or-after-a-job).
Microsoft documents Azure host PTP clock synchronisation in
[Time sync for Linux VMs](https://learn.microsoft.com/azure/virtual-machines/linux/time-sync),
and the non-secret metadata source in
[Azure Instance Metadata Service](https://learn.microsoft.com/azure/virtual-machines/instance-metadata-service).
