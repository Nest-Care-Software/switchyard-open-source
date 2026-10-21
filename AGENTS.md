# Switchyard Agent Guide

## Mission

Switchyard is a provider-neutral allocator for GitHub Actions runners. Workflows
request a capability profile; Switchyard selects and prepares a runner, waits
until the provider-specific assignment is safe, and returns the label that the
workload job should use.

Switchyard serves one operator GitHub organisation per deployment. Customer
accounts, billing, multi-tenancy and an unauthenticated control plane are outside
V1. All checked-in identities are synthetic; production allocation must remain
disabled until independently reviewed activation evidence is supplied.

## V1 Scope

Implement only:

- An Azure pay-as-you-go VM as the first bounded cloud-provider pilot.
- Blacksmith as the managed fallback.
- `linux-x64-standard` and `linux-x64-large` profiles.
- Ephemeral GitHub just-in-time runners with a unique label for each Azure
  allocation, and provider-managed shared labels for Blacksmith.
- Cleanup for successful, failed, cancelled, timed-out, and abandoned
  allocations.
- An organization-level reusable workflow that returns the selected runner
  label to its caller.
- An authenticated public HTTPS Azure Function API and Azure Storage control
  plane for allocation, provisioning, reconciliation, and safety counters.
- Per-allocation visibility through a Switchyard Check Run, redacted Azure
  lifecycle logs, and owner alerts.
- Trusted build, test, and production-deployment workloads. Switchyard is not a
  CI-only allocator.

Do not add GCP, OVHcloud, EC2, development-machine runners, a dashboard,
multi-tenancy, predictive scheduling, live D1 reporting, 90-minute allocations,
or automatic replacement VMs during the Azure pilot. Evaluate the pilot before
the owner selects the V1 cloud provider or authorises another adapter. The
already implemented D1 reporting components remain dormant and must never
control allocation, readiness, provider selection, fallback, cleanup, or
reconciliation. Preserve extension points for deferred capabilities without
implementing them in V1.

## Public Workflow Contract

- Expose exactly two caller inputs: a required capability profile with no
  default, and the backup choice whose default is `Keep going`.
- Expose exactly two outputs: `runner_label` and `allocation_id`.
- `runner_label` is provider-appropriate. Azure returns a unique allocation
  label; Blacksmith returns the configured shared managed label.
- Do not expose provider names, machine types, concurrency, allowances, expiry,
  or timeout controls as caller inputs or outputs.
- Report the selected provider, duration, estimated cost, fallback, and cleanup
  result in a Switchyard Check Run on the immutable workload commit. Do not
  promise a post-job summary from a job that has already finished.
- Create the Check Run when the controller accepts an allocation, persist its
  identifier, update it through reconciliation, and conclude it only after the
  allocation has ended. A later Check Run update failure is retried and
  alerted, but never delays safety cleanup.

## Controller and Fallback

- Run the allocation API, queue-driven provisioning worker, and one-minute
  reconciler in one Azure Function App. The API is internet-routable public
  HTTPS protected by Entra; it is not network-private or unauthenticated.
- Keep authoritative allocation state and the Azure and Blacksmith concurrency
  and allowance reservations in Azure Table Storage. Use atomic reservations
  and never reconstruct control state from D1.
- Fail closed for every new allocation, including Blacksmith, if the Switchyard
  API, authoritative ledger, GitHub trust verification, Doppler access, or
  required controller reconciliation is unavailable or ambiguous. Existing
  cleanup continues wherever possible.
- Only a healthy controller may apply the caller's backup choice. Fallback is
  permitted only when that controller classifies Azure capacity or Azure
  provisioning as unavailable. Examples include the Azure concurrency or
  allowance ceiling, exhausted configured UK South zones, a classified Azure
  management-plane provisioning failure, or the ten-minute readiness timeout.
- An unreachable Switchyard API, failed ledger operation, unavailable trust
  evidence, Doppler failure, invalid configuration, failed security check, or
  unexpected internal error is not provider unavailability and must not select
  Blacksmith.
- Keep allocation policy deterministic and explainable in structured logs.
- Isolate provider behaviour behind a small adapter contract. Azure owns
  ephemeral VM allocation, readiness, release, and reconciliation. Blacksmith
  exposes managed labels; Switchyard never provisions, stops, or deletes a
  Blacksmith machine.

## Identity and Workload Binding

- The allocation idempotency identity is exactly
  `{repository_id, run_id, run_attempt, allocator_check_run_id}`. The final
  field is the numeric GitHub check-run ID for the exact reusable allocator job,
  discovered and verified through the GitHub API.
- The allocator job's Actions check run used in that identity is distinct from
  the controller-created Switchyard Check Run used for lifecycle reporting.
  Persist both identifiers.
- An exact retry returns the existing allocation and never repeats a reservation
  or provision. A new run attempt is a new identity. Two approved allocator
  checks in one run are distinct allocations, even when they target the same
  future workload profile.
- Persist all four identity fields and reject conflicting reuse. Test transport
  retries, workflow reruns, multiple allocator jobs in one run, and mismatched
  or replayed check-run IDs.
- Bind Azure to the intended job with its unique runner label and require the
  exact just-in-time runner registration to be online and idle before returning
  that label.
- The approved mapping contains the repository ID, caller workflow path,
  allocator job/check, future workload job key and name, capability profile,
  expected provider-label contract, production status, and a literal integer
  `timeout-minutes` value.
- Before selecting either provider, fetch the immutable approved workflow and
  verify the exact mapped job and profile, its approved use of the allocator's
  `runner_label`, and the literal centrally approved `timeout-minutes`.
  Expressions or caller-supplied timeout values fail closed.
- Blacksmith binding has two stages. Before returning its shared label,
  authorise the immutable workflow/job mapping and validate its timeout,
  profile, and exact centrally mapped managed label. After return, correlate the
  allocation to the expected numeric GitHub job ID as soon as GitHub exposes
  it, then persist that ID.
- If the expected Blacksmith job never appears, or another or ambiguous job
  appears, mark binding failed and open an incident. Do not choose another
  runner or rerun the workflow. Reconcile while conservatively retaining the
  concurrency and worst-case cost reservation until the concrete mapped job or
  whole workflow run is terminal. Never release it merely because time has
  elapsed since label return: GitHub starts `timeout-minutes` only when the job
  executes. If neither becomes terminal, require the owner to cancel the run and
  keep the reservation and incident open until that terminal state is verified.
- For every Blacksmith selection, reserve the public list-price worst case for
  the full mapped timeout, including provider billing minimums and rounding.
  GitHub enforces the timeout; Switchyard tracks the job but never manages the
  Blacksmith machine.
- Allow at most three Blacksmith jobs at once and reserve them against a
  separate estimated $5 UTC-daily allowance. Do not count unverified free
  minutes or discounts. When either final-provider ceiling is reached, stop for
  both backup choices.

## Trust and Approval

- Require an approved caller gate to finish before the allocation job starts.
  Never create or reserve a runner while production approval is still pending.
- GitHub Free for a private repository supplies neither the required pre-run
  environment approval nor branch protection assumed by stronger designs. The
  V1 fallback is an owner-initiated `workflow_dispatch` whose original
  `actor.id` and `triggering_actor.id` both equal configured the owner ID
  `900000001`; login names are not identity checks.
- The pilot allowlist is example-workload repository ID `900000002`, caller workflow
  path `.github/workflows/ci.yml`, mapped workload job `example-build`,
  `linux-x64-large`, and literal `timeout-minutes: 25`. The controller must also
  verify the approved allocator job/check introduced for this mapping.
- Treat the dispatch as approval only when the controller independently verifies
  the exact approved repository ID and workflow path, event
  `workflow_dispatch`, exact approved `refs/heads/main` ref, immutable run SHA,
  original `actor.id`, `triggering_actor.id`, run attempt, allocator job/check,
  approved future workload mapping, non-PR status, and the reusable Switchyard
  workflow at an approved path and full commit SHA. Fetch and verify the run,
  ref, commit, jobs, checks, and workflow content independently through GitHub;
  never trust request fields.
- The dispatch approves the immutable SHA captured for the exact main ref. Do
  not claim GitHub branch protection or require `Administration: read` to check
  protection that this plan does not provide. Persist the approved ref and SHA;
  on rerun verify that same pair and commit rather than requiring moving `main`
  still to point at it. A future paid pre-allocation environment or branch
  control may replace or strengthen this fallback.
- Apply the complete trust algorithm to every run attempt. In particular, a
  rerun fails closed unless its `triggering_actor.id` is also `900000001`, even
  when the original actor and immutable SHA were previously approved.
- Exact transport retries within one allocator invocation remain idempotent;
  `run_attempt` remains part of the allocation identity, so a rerun is a new
  allocation request after it passes trust again.
- Switchyard allocates but never grants deployment authority. Both Azure and an
  approved `Keep going` Blacksmith job receive only short-lived,
  least-privilege production access after the approved caller gate.
- Do not route pull-request or other untrusted code to Switchyard runners, and
  never automatically rerun a production workflow after runner failure.

## Authentication and GitHub Permissions

- Register the allocation API as an Entra application with an explicit API
  audience and a narrowly scoped federated credential for the pinned reusable
  workflow.
- The reusable workflow obtains a GitHub OIDC JWT, presents it to Entra as a
  federated client assertion, and receives an Entra access token whose audience
  is the allocation API. It sends that token to the public HTTPS API. The
  workflow receives no Azure subscription role or credential.
- Treat the Entra token accepted by Easy Auth only as app-only API client proof.
  Require its exact mapped tenant, API audience, client application, dedicated
  application role and app identity type, with no delegated scope. It does not
  carry or prove the exact GitHub run identity.
- Separate those required Easy Auth security claims from one reviewed ancillary
  claim allowlist. Reject duplicate, accessor-backed, delegated-scope, mixed v1/v2
  client and unreviewed claims. A synthetic documented principal is test evidence,
  not a substitute for the required live redacted mapped-claim fixture.
- Require a separate fresh, short-lived GitHub OIDC RS256 JWT addressed to one
  exact custom allocation-proof audience. Verify GitHub's exact issuer through
  bounded discovery and JWKS retrieval, then bind the signed repository, run,
  attempt, allocator Check Run, caller workflow, reusable workflow, ref, SHA and
  actor claims to the request and approved mapping. A fresh `jti` is permitted
  but is never allocation identity.
- Require the full reviewed GitHub-hosted reusable-workflow token shape, including
  the exact subject and redundant actor, repository-owner, run-number and workflow
  claims. Reject caller-only shapes, repository-property claims and every other
  unreviewed addition. Keep a live redacted token capture as an activation blocker.
- Compose both proofs with the independent GitHub run, job, Check Run and
  immutable-workflow trust verification into one pre-state security decision.
  Every proof and trust check must finish before any allocation-ledger read.
  Never persist or log either token.
- Accept only one strict allocation request body containing the exact identity,
  capability profile and backup choice. Compare the latter two with independently
  verified mapping evidence, reject duplicate or unknown fields, and derive the
  managed label and literal timeout only from that mapping evidence.
- Use Doppler's GitHub OIDC support for the allocator. Live-test Doppler custom
  OIDC with the Azure Function managed identity before deployment. If that
  undocumented combination fails, the sole permitted bootstrap-secret
  exception is one narrowly scoped Doppler service token in Azure Key Vault,
  readable only by the controller and rotated independently.
- Keep the GitHub App private key solely in Doppler and handle it only in
  controller memory. A Doppler outage always stops new allocation and fallback.
- Install one GitHub App with selected-repository access to both example-workload and
  Switchyard. Its single registered permission set is only `Metadata: read`,
  repository `Actions: read`, `Contents: read`, and `Checks: write`, plus
  organisation `Self-hosted runners: write`. Do not add `Issues: write`,
  `Administration: read`, or any broader permission in V1.
- Mint separate short-lived, reduced installation tokens per operation and
  repository: Workload-only `Actions: read`, `Contents: read`, and `Checks: write`
  for caller validation and the Check Run, and only the organisation runner
  permission needed for a JIT runner operation. Never reuse a broader token
  between these operations.
- Restrict the Workload runner group and caller allowlist to example-workload. Use one
  immediate Azure Monitor email alert for each safety incident. Automated
  private GitHub incident issues are deferred to V2.
- Never commit or print tokens, JIT configuration, private keys, or cloud
  credentials. Apply least-privilege IAM to the controller and runner VM.

Production allocation remains disabled. Activation additionally requires a live
Easy Auth mapped-claim fixture; the exact Entra tenant, API audience, allocation
client application and dedicated role; the exact GitHub proof audience; the full
approved reusable-workflow commit SHA; and working GitHub-hosted allocator billing.
The checked-in Workload mapping must remain disabled until every blocker is resolved
and reviewed.

## Azure Pilot Policy

- Create pilot runners only in UK South. Try configured availability zones in a
  fixed order, then apply the backup choice; do not search other regions.
- Map `linux-x64-standard` to Azure `Standard_D4ds_v6` or Blacksmith
  `blacksmith-2vcpu-ubuntu-2404`. Map `linux-x64-large` to Azure
  `Standard_D8ds_v6` or Blacksmith `blacksmith-4vcpu-ubuntu-2404`. The managed
  fallback deliberately uses one smaller CPU tier than Azure. The Workload pilot
  uses only the large profile.
- Allow at most three Azure allocations in total, shared across both profiles.
  Treat that ceiling and the authoritative Azure allowance as unavailable
  capacity. `Keep going` uses Blacksmith and `Save money` stops; do not queue.
- Use Canonical Ubuntu 24.04 LTS Gen2. Resolve the UK South Marketplace image at
  deployment and pin its exact version. Pin the GitHub runner and setup tools,
  configure the runner with automatic updates disabled, check versions weekly,
  and open reviewable updates before the installed runner leaves GitHub's
  support window. Pin application dependencies and third-party Actions too.
  Never update a live runner silently or merge an update automatically.
- Use a deletable managed Standard SSD OS disk. Prepare the Ddsv6 local NVMe on
  every boot and use it only for Docker data and the GitHub runner workspace.
  Do not use an ephemeral OS disk.
- Start with the stock image and non-secret bootstrap. Consider a custom image
  only if pilot measurements show setup is materially slow or unreliable.
- Give each runner a temporary Standard public IPv4 address and an NSG that
  denies all inbound traffic, including SSH. Permit only required outbound
  HTTPS. Do not connect pilot runners to private networks.
- Keep the Azure pilot in a dedicated subscription. Scope long-lived control
  resources separately from per-allocation resource groups and put no unrelated
  resources in the subscription.

## Azure Lifecycle and Cost Safety

1. An allocation ends only after its workload is terminal and every
   Switchyard-owned runner registration, resource cleanup, concurrency
   reservation, and cost reservation is settled. A record remains open in
   `cleanup_pending` after workload completion while any of those remain.
2. Every Azure allocation has immutable original compute and deletion deadlines,
   required recovery tags, and numbered physical generations. Cleanup must be
   idempotent and succeed when a target is already absent.
3. V1 has one fixed 45-minute lifetime. Set the original compute deadline to
   minute 40 with Azure Compute Schedule deadline type `CompleteBy`, and set the
   deletion target to minute 45. Callers cannot request or extend the lifetime.
4. The V1 physical generation requires its own Compute Schedule operation
   targeting that generation's exact VM and the allocation's original absolute
   `CompleteBy` deadline. Persist the VM resource ID and provider VM ID,
   operation ID, requested deadline, status, and acceptance. Poll the operation
   and never make the generation ready without acceptance; rejection or later
   failure is a safety incident. The numbered-generation model remains so V2
   can add replacement without changing allocation identity.
5. Each accepted generation schedule independently bounds that VM's compute.
   Complete resource-group deletion is asynchronous and is never guaranteed by
   the expiry target. Retry and alert on residual disks, network interfaces,
   public IPs, or other resources, and never claim their post-target costs are
   hard bounded.
6. Reserve conservative Azure compute, managed-disk, and public-IP exposure
   through the applicable deletion target before provisioning. Keep the full
   reservation held while cleanup is incomplete, including after the target;
   release unused capacity only after complete deletion and settlement.
7. Limit admitted Azure exposure to an estimated $5 per UTC day. This is an
   admission guard, not a provider spending cap: provider bills remain
   authoritative and failed residual deletion can continue to cost money.
8. Create a uniquely tagged resource group before billable resources. Runtime
   resource groups, VMs, disks, NICs, public IPs, NSGs, and deletion attachment
   settings come from the checked-in, validated subscription-scope base ARM
   template invoked by the controller. The base template must contain no JIT
   material or Managed Run Command. Disk, NIC, and public-IP attachment deletion
   options must be `Delete`.
9. Apply the mapped literal timeout to Azure too. Define
   `latest_safe_start = original_complete_by - mapped_job_timeout -
   provider_stop_margin`. The Workload pilot uses a 25-minute timeout and a
   conservative five-minute policy margin, so its minute-40 compute deadline
   gives a concrete latest safe start at minute 10. The margin is Switchyard
   policy, not a provider guarantee.
10. Treat Azure as ready only after bootstrap succeeds, local NVMe is mounted,
    Docker is healthy, the runner process starts, the exact unique JIT runner is
    online and idle, that generation's schedule remains accepted, and the
    latest safe start has not passed. Do not return a label after that instant.
    If the exact workload is not assigned by then, fence its runner registration
    and clean up the generation.
11. If a ready Azure runner disappears before accepting the job, V1 fences its
    registration, cleans up its generation, releases reservations only after
    settlement, and reports the workload failure. It never creates a replacement
    or automatically reruns the caller. Automatic replacement is a V2
    reliability feature.
12. Only after the exact VM's Compute Schedule operation is accepted and
    bootstrap, local NVMe and Docker prerequisites are checked, invoke the
    separately checked-in generation-one JIT-launch ARM template. Deliver the
    encoded JIT configuration only through Azure Managed Run Command protected
    parameters or protected environment variables. Switchyard must
    not place it in cloud-init, command text, logs, diagnostics, or
    Switchyard-created files, and bootstrap must scrub its environment after
    hand-off. Delete the Run Command resource immediately after the runner
    process launches.
13. The GitHub runner necessarily creates restricted temporary credential and
    configuration files on the disposable OS disk. Limit them to the dedicated
    runner account with least-privilege file permissions, never log or collect
    them, revoke the runner registration, and delete the complete disk and
    resource group. Do not claim universal memory-only handling.
14. Runner VMs receive no Azure identity capable of deleting allocations or
    changing schedules. They receive no long-lived project or control-plane
    credentials; production access is short-lived and scoped to the exact job.
15. The reconciler polls GitHub once per minute, removes the runner registration,
    and requests resource-group deletion as soon as a workload is terminal or
    expired. Do not add a GitHub webhook in V1; polling is the repair path if one
    is added later. Complete deletion within five minutes of an ordinary job
    ending is an operational target, not a provider guarantee.
16. Alert the owner immediately by Azure Monitor email when cleanup fails, a compute
    deadline is missed, a schedule status fails, or an allowance guard becomes
    unhealthy. Keep retrying until recovery. Automated private GitHub incident
    issues are deferred to V2.
17. Provide an owner-run recovery command and manual runbook independent of the
    allocation ledger. They enumerate resources and runner registrations by
    required immutable allocation and generation tags, fence compute, and retry
    deletion. Exercise this path in the abandoned-allocation drill. A hosted
    recovery workflow is deferred to V2.

## Diagnostics and Visibility

- Diagnostics are allowlisted structured lifecycle records only: timestamp,
  allocation and generation identifiers, stage code, result code, duration,
  and a predefined redacted error classification. Never collect arbitrary
  stdout or stderr, raw GitHub runner logs, ordinary job output, source code,
  request payloads, JIT configuration, secrets, or customer data.
- Emit bounded structured lifecycle logs to Azure and show provider, duration,
  estimated cost, fallback, and cleanup status in the Switchyard Check Run.
  Failed visibility updates never delay deletion.
- V2 may activate the already implemented D1 reporting copy, protected Worker,
  bounded diagnostic upload, 7/30/365-day reports, retention aggregation, and
  weekly summaries. D1 remains best-effort and permanently outside controller
  health and lifecycle decisions.

## Infrastructure and Delivery

- Implement allocator, controller, recovery command, and shared libraries in
  TypeScript.
- Use OpenTofu only for long-lived Azure infrastructure in V1, such as the
  Function App, storage, monitoring, and identities. Keep the dormant
  Cloudflare reporting module isolated and disabled. OpenTofu must not own
  runtime allocation groups or VMs.
- Use the exact checked-in base and JIT-launch ARM template versions for all
  runtime Azure allocation resources. Validate both schemas and policies in CI
  and run non-mutating Azure what-if checks before authorising either controller
  deployment path.
- Real infrastructure applies use two independent first-attempt owner
  dispatches because GitHub Free cannot provide the required private-repository
  protected-environment pause. The first creates an immutable, content-addressed
  plan bundle. After the owner reviews that exact bundle, a fresh dispatch supplies
  its run ID, artefact ID, immutable commit, saved-plan digest and any required
  digest-bound destructive acknowledgement. The apply engine must independently
  decode the exact ZIP, rerender both reviewed views from the saved plan, verify
  publication chronology, actors, current `main`, pinned reusable workflows,
  the cryptographically verified raw GitHub OIDC token and same-token Entra
  exchange, ten-minute approval age, exact Azure authority, backend state digest,
  lineage, serial and emptiness. It then takes a separate apply lease, rechecks
  state, creates an atomic apply intent and rechecks `main` and freshness before
  applying only the saved plan with normal native backend locking. The one-time
  initial-state caller uses the same pinned apply-engine identity but is a
  separate owner dispatch with an exact acknowledgement; the runtime verifies
  that caller independently and can only create canonical serial-zero state
  after proving complete current and retained absence. No started,
  unknown, failed, partial, stale-plan or native-lock-failed proof permits a
  reapply; only proved completion may be returned. The infrastructure callers
  remain fail closed until the committed activation evidence, exact live
  identities and immutable repository OIDC settings all agree. Production
  allocation remains separately disabled throughout infrastructure activation.
- Before a live Azure pilot, confirm the startup credit is attached to the
  selected subscription, verify UK South total and Ddsv6-family vCPU quotas,
  prove the per-generation schedule path, and confirm every safety dependency
  is healthy. Budgets and credit balances monitor spend; they are not cleanup
  mechanisms.
- Pin third-party GitHub Actions to full commit SHAs.

## Verification and Pilot Evaluation

- Add focused tests for controller-health fail-closed behaviour, fallback
  classification, actor and triggering-actor trust on every attempt,
  idempotency, two-stage Blacksmith binding, literal provider timeouts and
  reservations, Azure latest-safe-start arithmetic, generation schedule
  acceptance, lost-runner failure, JIT handling, reduced GitHub tokens,
  diagnostics bounds, expiry, and cleanup.
- Use fake provider implementations in unit tests. Live-cloud tests must be
  explicit, bounded, and impossible before the approval and safety prerequisites
  above are met.
- Evaluate the Workload pilot with five Azure and five Blacksmith runs, alternated
  against the same unchanged `main` commit. Measure allocation-to-ready,
  ready-to-job-start, setup and download, Supabase startup, repeated database
  steps, total job duration, cleanup duration, and estimated cost separately.
- The pilot passes only when all five ordinary Azure runs succeed without an
  Azure-caused retry; each Azure runner accepts at most one job; ordinary cleanup
  completes within five minutes; cancellation and abandoned-cleanup drills
  leave no registration or Azure allocation; the Azure request-to-completion
  median is no slower than the paired Blacksmith median; and admitted Azure
  exposure remains within the $5 daily allowance.
- After the example pilot passes, prove one approved production deployment path
  with job-scoped short-lived access before declaring V1 complete. This need not
  migrate every production workflow.
- Update documentation whenever behaviour, permissions, trust rules, or
  lifecycle ownership changes.

## Completion Standard

A change is complete only when relevant tests pass, infrastructure or workflow
configuration is validated, cleanup behaviour is considered, and no secret or
provider-specific detail has leaked into the reusable workflow contract.
