# Switchyard

Switchyard routes trusted GitHub Actions jobs to a provider-appropriate runner
while keeping provider policy out of application repositories. Each deployment
serves one organisation.

Available under the [MIT licence](LICENSE).

This is a [sanitised source preview](docs/source-preview.md). Allocation remains disabled. All checked-in
owner, repository and cloud identities are fictional examples. No deployment
credentials or live activation evidence are included.

## V1 Scope

V1 is a bounded Azure pay-as-you-go pilot in UK South with Blacksmith as the
managed fallback. It supports `linux-x64-standard` and `linux-x64-large`, trusted
builds and tests, and production deployments that have passed an approved caller
gate before allocation. Each Azure allocation gets one physical runner generation
and one fixed 45-minute lifetime. Automatic replacement, extended lifetimes and
live Cloudflare reporting begin in V2.

The reusable workflow has exactly two inputs: the required capability profile
and a backup choice, defaulting to `Keep going`. It has exactly two outputs:
`runner_label` and `allocation_id`. Azure returns a unique just-in-time label;
Blacksmith returns its shared managed profile label. Provider, duration,
estimated cost, fallback, and cleanup results appear in a Switchyard Check Run,
not in the workflow contract or a post-job summary.

The first pilot is the example-workload manual `main` CI `example-build` job,
whose display name is `Example approved build`. It uses
`linux-x64-large`, mapped to Azure `Standard_D8ds_v6` or the smaller managed
`blacksmith-4vcpu-ubuntu-2404` fallback, with literal `timeout-minutes: 25`.
The controller validates the exact repository, workflow, approved main ref and
immutable commit, run attempt, allocator check, approved future job mapping,
non-PR status, and owner dispatch through GitHub rather than trusting request
fields. GitHub Free provides no private-repository branch or required-reviewer
environment protection here. The fallback approval is a `workflow_dispatch`
whose original actor and triggering actor both have the owner's numeric ID on every
attempt; it approves the captured immutable SHA. A future paid pre-allocation
environment or branch control may replace or strengthen it. After the example
pilot passes, V1 proves one approved production deployment with job-scoped
short-lived access. It does not need to migrate every production workflow before
V1 is complete.

## Safety Model

The Switchyard API is authenticated public HTTPS protected by Entra. A caller
exchanges its GitHub OIDC token for an Entra token addressed to that API and
receives no Azure subscription permissions. Easy Auth's exact app-only tenant,
audience, client and dedicated-role evidence proves only which application
called the API. It does not prove the GitHub run identity. The allocator must
also send a separate fresh, short-lived GitHub OIDC RS256 proof for one exact
custom audience.
That proof binds the repository, run, attempt, allocator Check Run, exact caller
workflow, pinned reusable workflow, ref, SHA and actor.

`@switchyard/controller` combines both proofs with the independent GitHub API and
immutable-workflow trust result into one pre-state security decision. All of those
checks finish before the post-trust allocation-control capability is supplied.
Discovery, JWKS, token, time, body and cache bounds fail closed; an unknown
signing key gets one refresh.
Fresh OIDC `jti` values are allowed but never form allocation identity, and neither
token is returned, persisted or logged. Every new allocation also fails closed if
the API, authoritative Azure Table Storage ledger, GitHub trust verification,
Doppler, or required controller reconciliation is unavailable. Only a healthy
controller may use Blacksmith, and only after classifying Azure capacity or
provisioning as unavailable.

`@switchyard/azure-worker` is the production-disabled generation-one Azure
provisioning and cleanup orchestrator. It recovers each fixed-zone deployment,
exact Compute Schedule operation, reduced JIT launch and cleanup step through
injected ports and the authoritative ledger. Its assigned-runner cleanup keeps
provider deletion and GitHub registration fencing as independent durable branches.
An outage in either branch cannot erase the other's proof, and a GitHub outage does
not keep billable Azure compute, disks or IPs alive. Final settlement still requires
both branches and independently verified workload-terminal evidence. It has no cloud
SDK, Function registration or live Workload mapping.
The zero-generation cutoff path uses those same defensive proofs while preserving
the rule that provisioning cannot begin until its authoritative generation row exists.
The future live GitHub adapter must separately prove label-wide registration absence
through GitHub's eventual consistency before activation.

The allocation request contains exactly its identity, capability profile and backup
choice. The controller compares those values with independently verified mapping
evidence and returns one immutable policy input. The managed Blacksmith label and
literal timeout always come from that mapping, never from request data. The
reviewed GitHub proof shape includes the exact subject and reusable-workflow
claims; Easy Auth uses fixed security and ancillary semantic slots whose exact
mapped claim types come from reviewed configuration. Both mappings must have
exact keys, unique and disjoint types, and `role_typ` must equal the configured
role type. The checked-in proof
fixtures are synthetic, redacted shapes based on Microsoft's documented
[Easy Auth principal](https://learn.microsoft.com/azure/app-service/configure-authentication-user-identities)
and [Entra access-token claims](https://learn.microsoft.com/entra/identity-platform/access-token-claims-reference),
not live captures. Production activation remains blocked on reviewed redacted live
captures and the exact Easy Auth mapped principal configuration observed from the
approved deployment.

One GitHub App is installed on selected repositories example-workload and Switchyard
with one minimal registered permission set. The controller mints separate,
reduced short-lived tokens for Workload validation and Check Runs, and
organisation JIT runner operations.

Allocation retries use
`{repository_id, run_id, run_attempt, allocator_check_run_id}`. Azure binds an
allocation to its unique label. Blacksmith uses a shared label plus a centrally
approved workflow/job mapping. That immutable mapping, profile, timeout, and
label authorise return; the controller then correlates and persists the expected
numeric GitHub job ID as soon as it appears. A missing, different, or ambiguous
job fails the binding and raises an incident without selecting another runner or
rerunning. Reservations remain held until the concrete job or whole workflow is
terminal; elapsed time since label return cannot release them because GitHub's
job timeout begins only when execution starts. Blacksmith continues to own its
machine. Job-terminal evidence must carry the identical positive numeric job ID
stored in the durable binding. While correlation is awaiting or has failed, only
whole-workflow terminal evidence for the exact repository, run and attempt may
release the reservation.

Azure admits no more than three allocations and an estimated $5 of conservative
UTC-daily exposure. Blacksmith separately admits no more than three jobs and an
estimated $5 at public list prices. These are controller admission guards, not
provider spending caps. The caller's `Keep going` choice uses Blacksmith when
healthy Azure capacity or provisioning is unavailable; `Save money` stops.

V1 has one fixed lifetime. The original Azure `CompleteBy` deadline is minute
40 and complete deletion is targeted for minute 45. The single physical
generation needs its own separately persisted and accepted Compute Schedule
operation targeting its exact VM before JIT registration can start. The base VM
deployment contains no JIT material. A second reviewed ARM template launches the
runner only after schedule acceptance and checked bootstrap, local NVMe and
Docker prerequisites. Readiness also requires that launch to be confirmed, its
Managed Run Command resource to be proven absent after any asynchronous
deletion, the schedule to remain accepted and not yet executing, and the exact
runner to be online and idle. Reservations cover compute, disk, and public-IP
exposure through
deletion and remain held while cleanup is incomplete.

Azure also validates the mapped literal job timeout. Its latest safe start is
the original compute deadline minus that timeout and a conservative provider
stop margin. For the Workload pilot, minute 40 minus the 25-minute timeout and a
five-minute policy margin gives minute 10. No label is returned after that
instant; an unassigned runner is fenced and cleaned up then. The one-minute
reconciler uses strict first-tick cleanup, while a root-owned guest guard enforces
the exact instant independently. It admits a job-start hook before or exactly at
the cutoff only when that hook wins the same lock as the persistent cutoff timer.
It always powers off the guest at the original compute deadline. Guest power-off
is defence in depth, not Azure deallocation or cleanup settlement. The margin is
Switchyard policy, not an Azure guarantee. Production remains disabled until the
guard and recovery path have been exercised in the approved live safety drill.

`@switchyard/reconciler` is the production-disabled lifecycle repair loop. The
monitored Function timer invokes one bounded cycle every minute. The cycle scans
every allocation row in pages, validates authoritative state, includes ended rows
whose Switchyard Check Run still needs delivery, and writes a fresh heartbeat only
after the complete safety scan succeeds. It repairs lost Blacksmith assignment
responses, binds jobs by the centrally approved display name, expected runner label
and numeric GitHub job ID, and uses only the exact job or whole-run terminal evidence
to release reservations.
For a healthy active run, Azure's readiness cutoff settles as provider
unavailable so the approved Blacksmith fallback remains possible after cleanup;
an unverified GitHub observation fails non-fallback. A bounded final deadline
sweep catches cutoffs crossed while later rows ran and suppresses an unstable
heartbeat. Elapsed time and expiry start cleanup but never prove workload
termination. Check Run delivery runs only after every safety row and the
heartbeat, under bounded cancellation deadlines, so a hung visibility adapter
cannot delay cleanup or cycle completion.

Each accepted generation schedule independently bounds that VM's compute. Azure
resource-group deletion is asynchronous, so residual disk, IP, or other costs
after the target are not guaranteed to be bounded. The reconciler keeps retrying
and alerts the owner by email. The dry-run-first owner recovery command and
[manual runbook](docs/recovery.md) work independently of the ledger. They still
require a reviewed live drill before activation. Hosted recovery and automated
private incident issues are V2 features.

Every post-creation VM check also matches Azure's immutable provider VM ID to
the value persisted for that physical generation. Recreating a VM at the same
ARM resource ID, even with matching tags, cannot inherit the original schedule,
JIT or readiness evidence. If the original deployment response was lost before
that provider ID became durable, cleanup deletes the tagged group only after the
exact deterministic VM is proved absent. A live VM remains fenced as an incident
for owner recovery rather than being adopted or deleted from its current tags.

If a ready Azure runner disappears before the job starts, V1 fences and deletes
it and reports failure. It never creates a replacement or automatically reruns
the caller. An allocation ends only when the workload is terminal and owned
cleanup and reservations are settled. The numbered-generation model is retained
so V2 can add bounded replacement without changing allocation identity.

JIT configuration reaches the VM only through the separate Azure Managed Run
Command protected parameters or environment variables. Switchyard excludes the
payload from cloud-init, command text, logs, diagnostics, and its own files, and
the bootstrap scrubs its environment. The runner necessarily writes restricted
temporary credential and configuration files to its disposable OS disk, so
cleanup revokes registration and deletes the complete disk and resource group.
Azure diagnostics remain small allowlisted lifecycle records in structured
platform logs; failed visibility updates never delay deletion. Runner
auto-update is disabled; pinned releases are reviewed weekly and updated within
GitHub's support window.

## Production-disabled controller contract

The repository includes a portable injected allocation service and strict HTTP
handler for `POST /api/v1/allocations`. The handler accepts at most 4 KiB of
duplicate-free JSON containing only the exact allocation identity, profile and
backup choice. It requires the Easy Auth bearer boundary, mapped app-only principal
and one fresh `X-Switchyard-GitHub-OIDC` proof on every create, retry and poll. It
returns only a pending allocation ID or the exact final allocation ID and runner
label, with redacted errors, `no-store` and `nosniff` on every response.

After proof and immutable trust, the service checks the durable reconciler heartbeat,
accepts the provider-neutral allocation, and requires the accepted lifecycle Check
Run's numeric ID to be durable before any counter reservation. One exhaustive
projection translates the ordered ledger aggregate into the next action. Azure is
attempt 1 and receives only a deterministic injected dispatch. Safely settled Azure
unavailability may lead to Blacksmith attempt 2 for `Keep going`; a Blacksmith
reservation is assigned only the managed label carried by immutable trust evidence.
No missing Azure dispatch or controller failure can manufacture fallback.

The private allocation action contains a standalone Node 24 client with no
package dependency. It obtains separate OIDC JWTs for Entra exchange and
allocation proof, requests a fresh allocation proof for every poll, honours
`Retry-After`, uses a monotonic 14-minute deadline, rejects ambiguous responses
and writes only validated outputs. The reusable workflow runs only on
GitHub-hosted Ubuntu with `id-token: write` and calls that private action at the
full reviewed source commit SHA. A checked source-digest manifest binds that pin
to the reviewed local action bytes. The workflow never checks out caller code or
attempts a private cross-repository checkout with Workload's token.

The Azure Function runtime is now composed but remains production-disabled.
Safety startup is independent from admission startup, so an unavailable proof,
Doppler or GitHub dependency returns 503 for new work without stopping the
one-minute timer or Azure cleanup. The app registers the public Easy
Auth-protected allocation route, raw provisioning and poison queues, and the
reconciler timer. Live adapters use explicit managed identity, bounded provider
calls, deterministic resource ownership checks and two full GitHub
runner-absence scans separated by a bounded cancellable wait. Timer and queue
cleanup can lazily recover the reduced GitHub safety capability after restart,
without an allocation HTTP request. D1 has no runtime dependency or control
path.

Production prices and rounding, cloud identities, audiences, live proof fixtures,
the approved full reusable-workflow SHA, exact-cutoff watchdog and current
organisation Actions billing remain external activation inputs. The checked-in
Workload mapping stays disabled, and the default infrastructure cannot deploy the
deterministic Function ZIP until its reviewed digest and the two-dispatch
infrastructure approval are supplied.

## Infrastructure and deferred reporting

TypeScript implements the controller and shared logic. OpenTofu owns only
long-lived Azure infrastructure needed by V1. The controller invokes an exact
checked-in, validated subscription-scope ARM template which creates each
runtime allocation resource group and all of its transient resources. The
already-defined Cloudflare module remains disabled until V2.

`@switchyard/infrastructure-approval` now contains the production-capable
runtime and strict CLI for the future two-dispatch approval flow. It composes
bounded GitHub evidence, engine-owned GitHub OIDC token acquisition and
verification, exact Entra client-assertion exchange, explicit Azure Blob
sessions, deterministic plan archives, pinned OpenTofu 1.12.1 execution and the
one-time initial-state operation. It has no ambient Azure credential, GitHub App
credential, secret, cloud fallback or reporting dependency.

The checked-in approval foundation and activation configuration use fictional
identities. No live foundation is supplied by this repository.

One separate owner dispatcher creates the canonical initial state once. It calls
the same immutable apply engine with an exact acknowledgement and fixed sentinel
transport values. The checked-out bridge changes that transport to the strict
`initialise-state` operation only for the exact dedicated caller. The runtime
then verifies the caller workflow, engine SHA, first attempt, actors, current
`main`, activation bytes and repository OIDC settings before requesting a token
or touching Storage. It never interprets this path as a saved-plan apply.

These workflows still fail closed today because the required immutable GitHub
OIDC repository settings must be changed and independently verified outside this
change. Production runner allocation and the Workload mapping remain disabled.

The plan bundle is one strictly decoded real ZIP containing `plan.txt`,
`plan.json`, the opaque saved plan and one canonical manifest. The two reviewed
views are rendered from that exact saved plan with fixed OpenTofu commands and
rerendered before apply. Planning uses exactly
`tofu plan -input=false -lock=false -no-color -out=saved-plan` and requires the
raw state SHA-256 and ETag to match immediately before and after it. The planner
has no blob-write or lease port. It writes one deterministic local ZIP and an
exact publication contract. The plan engine uploads that exact file with the
full-SHA-pinned GitHub artefact action and `retention-days: 1`; the apply runtime
independently downloads and verifies it through GitHub's API. After approval and
Entra exchange, the selected applier
conditionally creates or verifies the identical content-addressed private Azure
receipt. The saved plan is sensitive and never printed. Foundation fails closed for every
authority-bearing or unclassified Azure mutation. Bootstrap requires serial
zero, an empty digest-bound prior state, create-only changes and at least one
classified authority creation.

Immediately before applying, the runtime holds the separate
authoritative apply lease, rechecks exact state and atomically creates an apply
intent keyed by the plan digest. It then refetches `main` and rechecks approval,
plan and publication freshness. OpenTofu acquires its native backend lock through
the normal saved-plan apply. A proved completed intent is replay-safe. Every
other intent or terminal native-lock/stale-plan result requires a new plan and
approval and must never execute again. The only accepted command is
`tofu apply -input=false -no-color saved-plan`. OpenTofu runs from one exact
verified binary path, with fixed working directories, argument arrays, output
and time bounds and a minimal allowlisted child environment.

The reusable engines use only `actions: read`, `contents: read` and
`id-token: write`. They check out without persisted credentials, install the
locked Node dependencies, verify the OpenTofu 1.12.1 release archive and binary,
and pass bounded JSON to the strict CLI. Their target configuration comes from
the non-secret `SWITCHYARD_INFRASTRUCTURE_TARGET_CONFIGURATION_JSON` repository
variable and is validated again by the runtime. Third-party Actions are pinned
to full commits.

The checked-in manual plan and apply workflows expose only the settled inputs.
Each has one job pinned to the exact foundation-bound reusable engine at
`5c9b286fcb5761a3fcf4b4c87882ec56103333e7`. The one-time initial-state workflow
has only the commit and exact acknowledgement inputs and calls that same apply
engine with fixed sentinel transport values. The callers contain no steps,
secrets, environment, cloud login or direct OpenTofu command. They grant only
`actions: read`, `contents: read` and `id-token: write`, and the runtime refuses
to request the OIDC token while the immutable repository settings differ.

The separate subscription-scope Bicep foundation defines the future state and
approval stores, their lock, three user-assigned identities, exact final-engine
federated credentials and container-scoped custom blob roles. It gives the
planner subscription Reader visibility while preserving its exact read-only
`tfstate` data permission, exports every identity's client and principal IDs,
and defines but does not assign the create-only initial-control role. ARM creates the
receipt container's exact one-day immutability policy without a synthetic state
field. Only after a successful owner-run `create` does the Azure CLI 2.89.1
wrapper read its ETag, call Azure's ETag-protected Lock Immutability Policy
operation and reread the exact Locked policy. A lock or verification failure is
a partial deployment and exits nonzero.

The separate owner-only bootstrap-authority wrapper is not reachable from a
GitHub workflow. A future grant is bound to the reviewed plan and control-template
SHA-256 digests, proves the exact deployed bootstrap identity and role, and must
be revoked after every terminal or uncertain initial apply result. The existing
limited foundation approval does not authorise that grant.

Canonical initial state is OpenTofu 1.12.1 state version 4 with a new lowercase
UUID lineage, serial zero and empty outputs/resources. Before creating either
the state blob or its separate record, the bootstrap adapter performs bounded,
paginated, exact-name enumeration including current blobs, versions, deleted
versions, snapshots and uncommitted blobs. Any retained match or ambiguous list
response fails closed. `If-None-Match: *` remains the final creation race guard.
After creating state, the adapter leases that blob exclusively while it verifies
the canonical state, creates and rereads the digest/ETag record, then rereads and
revalidates the unchanged state. It reports success only after safe lease release.

Azure Table Storage is authoritative for lifecycle and safety reservations. V1
visibility comes from the Switchyard Check Run, redacted Azure lifecycle logs
and Azure Monitor email alerts. The already-implemented Cloudflare D1 reporting
copy, Access-protected Worker, statistics and scheduled reports remain dormant
until V2. D1 can never affect allocation, controller health or cleanup.

The repository currently includes the allocation safety foundation,
provider-neutral acceptance with ordered Azure-then-Blacksmith attempt state,
immutable final runner assignment, durable GitHub branch and lifecycle Check Run
coordination evidence, the schema-10 authoritative Azure Table ledger adapters,
a production-disabled portable controller/API contract, a bounded pure reconciler,
a production-disabled Azure Functions composition with live Azure and GitHub adapters,
a self-contained
best-effort D1 reporting Worker, and the GitHub trust and Check Run adapter.
Reporting has no path into allocation, fallback, readiness, cleanup or controller
health. Workload remains disabled until the live activation evidence and safety drills
are reviewed.

## Infrastructure

Infrastructure definitions live in [`infra/`](infra/README.md). V1 uses
the long-lived Azure foundation plus a separate controller-owned ARM allocation
template. Cloudflare definitions are retained but disabled. The current
authorisation is local validation only. No cloud authentication, plan or apply
has been run.

## GitHub Trust and Lifecycle Reporting

`@switchyard/core` defines the provider-neutral approved-workload evidence and
Switchyard Check Run lifecycle contracts. `@switchyard/github` implements the
production GitHub boundary with narrow REST fetch wrappers pinned to API version
`2026-03-10`.

The adapter obtains repository, exact main Git ref, run-attempt, jobs, allocator
Check Run, commit and workflow content evidence independently from GitHub. It
persists the initial run/ref/SHA approval fact for reruns, reads the caller workflow
at the run's immutable commit and rejects ambiguous job bindings, workload
strategies or matrices, mutable reusable workflow refs, YAML aliases, expressions
in centrally fixed values and unsupported security-relevant fields.

The checked-in example-workload pilot mapping remains disabled. It records the known
workload display name `Example approved build`. Only the exact
allocator job and Actions Check Run names and the full approved reusable
Switchyard workflow commit SHA remain unknown and are intentionally not guessed.
No code in this phase performs a live GitHub mutation or obtains a real
credential.

Activation is deliberately phased:

1. Merge this disabled workflow-hardening phase. Its SHA is preliminary and
   non-activatable because the current non-secret `vars` are non-production
   scaffolding only.
2. Obtain and independently review the real immutable non-secret configuration.
3. Commit and merge that configuration into the reusable workflow as literal or
   digest-bound values.
4. Only after that merge, record the final post-configuration reusable-workflow
   SHA. In a separate example-workload change, pin the approved gate and allocator job
   to that exact SHA with exactly `id-token: write`; keep the mapping disabled.
5. Review and enable the required organisation access to the private action and
   working GitHub-hosted Actions billing. Capture and review live redacted proof
   evidence against the final SHA, then record the observed allocator job and
   Actions Check Run names while the mapping remains disabled.
6. Review every remaining safety and activation blocker, then enable the mapping
   in a separate authorised change.

Production activation is also blocked on a reviewed redacted live Easy Auth
mapped-claim capture and its exact security mapping, ancillary allowlist and principal
metadata configuration; the exact Entra tenant, API audience, allocation client
application and dedicated role; the exact custom GitHub proof audience; a reviewed
redacted live GitHub reusable-workflow proof capture; the full approved reusable
workflow SHA; and working GitHub-hosted allocator billing. The current
Blacksmith-hosted repository CI does not satisfy the allocator's required
`github-hosted` proof.

See [GitHub trust and Check Run adapter](docs/github-trust.md) for the implemented
boundary and activation blockers.
