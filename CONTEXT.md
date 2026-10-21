# Switchyard

Switchyard supplies an approved GitHub Actions job with a safe runner assignment
while keeping provider choice and lifecycle responsibility outside the calling
project.

## Language

**Allocation**:
Switchyard's responsibility for one runner assignment. It begins when the
controller accepts the request and ends only when the workload is terminal and
owned cleanup and reservations are settled.
_Avoid_: Provisioning, which describes only setup

**Allocation identity**:
The stable identity
`{repository_id, run_id, run_attempt, allocator_check_run_id}` that makes an
exact retry refer to the same allocation while separating reruns and multiple
allocator jobs.
_Avoid_: Run ID, request ID

**Allocator check run**:
The GitHub Actions Check Run for the exact reusable allocator job. It forms part
of allocation identity and is distinct from Switchyard's lifecycle Check Run.
_Avoid_: Switchyard Check Run, allocator job ID

**Allocation state**:
The authoritative live record of an allocation's identity, binding, lifecycle,
reservations, physical generations, and absolute expiry.
_Avoid_: Usage record, telemetry

**Provider attempt**:
One provider's ordered opportunity to fulfil an allocation, identified by a
stable positive ordinal and ending in success or classified unavailability.
_Avoid_: Allocation retry, workflow rerun

**API client proof**:
Evidence that an approved application, acting without a user, addressed the
Switchyard API through the expected tenant, audience and role.
_Avoid_: Workload identity, allocation identity

**Workload invocation proof**:
Short-lived GitHub evidence binding one allocator invocation to its repository,
run, attempt, check, workflows, ref, commit and actor.
_Avoid_: API client proof, trusted workload

**Pre-state security decision**:
Agreement between the API client proof, workload invocation proof and independent
trusted-workload evidence, established before allocation state is consulted.
_Avoid_: Authentication, controller health

**Capability profile**:
A provider-neutral performance tier rather than a promise of an exact processor
count. V1 offers `linux-x64-standard` and `linux-x64-large`.
_Avoid_: Azure size, Blacksmith label, runner type

**Runner label**:
The provider-appropriate GitHub `runs-on` value returned for an allocation. It
is unique for Azure and shared and static for a Blacksmith capability profile.
_Avoid_: Unique runner label, which is not true for every provider

**Workload binding**:
The provider-appropriate association between an allocation and one approved
future GitHub job. For a shared label it comprises pre-return authorisation and
later correlation to the concrete job.
_Avoid_: Runner selection, job name

**Job correlation**:
Post-return confirmation that a shared-label allocation belongs to the expected
numeric GitHub job. It is not a precondition for returning a managed label.
_Avoid_: Authorisation, ready assignment

**Physical generation**:
One Azure VM, its own compute protection, and runner registration within an
allocation. V1 creates only generation one; a future replacement would be a new
generation, not a new allocation.
_Avoid_: Retry, rerun

**Zone try**:
One fixed-order attempt to create generation one's VM in an approved UK South
availability zone. Another zone is permitted only after durable proof that the
previous try created no VM.
_Avoid_: Physical generation, replacement

**Runner assignment**:
The immutable provider-specific result of a successful provider attempt. It is
separate from provider reservation and later shared-label job correlation. An
Azure assignment includes a fresh online-and-idle check of the exact runner so
an interrupted assignment write can be repaired safely.
_Avoid_: Provider attempt, reservation, available label

**Approved caller gate**:
Verified authority for an approved workflow to request a production allocation,
completed before any runner is reserved or created.
_Avoid_: Workload environment, post-allocation approval

**Approved branch evidence**:
The durable fact that an initial approved workflow attempt's exact
`refs/heads/main` Git ref pointed to its immutable run commit. Later attempts
reuse that same run, ref and commit fact without requiring the moving branch tip.
_Avoid_: Branch name, current main, head branch

**Plan bundle**:
The immutable, content-addressed evidence the owner reviews before authorising one
exact infrastructure change.
_Avoid_: Plan output, build artefact

**Plan rendering evidence**:
Proof that the reviewed human and machine views came from the exact opaque saved
plan rather than from independently supplied planning output.
_Avoid_: Plan summary, plan bundle

**Plan authority class**:
The explicit boundary between routine foundation changes and the initial IAM
bootstrap path. It is selected before planning and is never inferred upwards.
_Avoid_: Deployment mode, automatic bootstrap

**Apply intent**:
The authoritative at-most-once decision to apply one plan bundle. Any outcome
other than proved completion requires a new plan and approval.
_Avoid_: Apply attempt, deployment retry

**Apply lease**:
The authoritative mutex that excludes competing infrastructure apply
orchestrations. It is separate from the native OpenTofu backend lock acquired by
the apply command.
_Avoid_: State lock, workflow concurrency

**Trusted workload**:
An approved job whose repository, workflow, immutable code revision, event,
attempt actors, and future job mapping have been independently verified.
_Avoid_: Internal job, merged code

**Untrusted workload**:
A job whose authority or code provenance does not satisfy the approved caller
policy, including every pull-request workload in V1.
_Avoid_: External job

**Production workload**:
A trusted job allowed to change or directly access a live service,
infrastructure, or data store.
_Avoid_: CI job

**Controller healthy**:
The state in which Switchyard can authenticate the caller, verify trust, read
and atomically update authoritative control state, obtain required secrets, and
reconcile the resulting allocation.
_Avoid_: API reachable, provider reachable

**Provider unavailable**:
A healthy controller's classification that Azure capacity or provisioning
cannot safely supply an otherwise valid allocation. A controller or trust
failure is not provider unavailability.
_Avoid_: Dependency outage, error, failure

**Backup choice**:
The caller's choice between using the approved managed backup (`Keep going`) and
stopping when Azure is unavailable (`Save money`). It applies only while the
controller is healthy.
_Avoid_: Must run, fallback on error

**Absolute expiry**:
The immutable time by which complete allocation deletion is targeted. It does
not claim that asynchronous residual-resource deletion is guaranteed by then.
_Avoid_: Guaranteed deletion, job timeout

**Compute deadline**:
A fixed allocation-level instant shared by every physical generation's own
accepted provider operation for independently bounding VM compute.
_Avoid_: Cleanup deadline, cost cap

**Schedule request correlation ID**:
Switchyard's stable identity for one physical generation's compute-schedule
request. It is distinct from the operation identity later returned by Azure.
_Avoid_: Schedule operation ID, allocation ID

**Schedule provider operation ID**:
Azure's identity for one accepted compute-schedule operation, adopted once by
Switchyard and paired with its schedule request correlation ID.
_Avoid_: Schedule request correlation ID, allocation ID

**Compute schedule protection**:
Provider evidence that a generation's deallocation is scheduled but has not
started. A schedule already executing or completed cannot protect a new runner
assignment.
_Avoid_: Schedule success, compute deadline

**Latest safe start**:
The last instant an approved job may start while preserving its full mapped
timeout and Switchyard's provider-stop safety margin before the compute deadline.
_Avoid_: Readiness deadline, provider guarantee

**Cloud allowance**:
The maximum conservative estimated exposure that Switchyard may admit during a
period. It reserves capacity before work begins but is not a provider bill cap.
_Avoid_: Azure budget, guaranteed maximum spend

**Usage record**:
A best-effort reporting entry about an allocation's provider, capability
profile, duration, outcome, fallback or cleanup event, and estimated cost.
_Avoid_: Allocation state, machine record, billing record

**Runner diagnostic record**:
A bounded allowlisted set of structured lifecycle facts about runner preparation
and cleanup, excluding arbitrary runner output, job output, code, and secrets.
_Avoid_: Runner log, CI log, job log

**Switchyard Check Run**:
The GitHub-facing lifecycle record that shows an allocation's provider choice,
duration, estimated cost, fallback, and cleanup result.
_Avoid_: Job summary, allocation output

**Switchyard owner**:
the owner, the sole person allowed to change organisation-wide policy or view
combined usage and cost reports.
_Avoid_: Operator team, administrator, customer, tenant
