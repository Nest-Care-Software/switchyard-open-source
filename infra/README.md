# Switchyard infrastructure

This directory defines the external approval foundation and application
infrastructure. Checked-in authority values are synthetic and do not establish
a deployed foundation.

## Ownership boundary

| Area | Owner | Definition |
| --- | --- | --- |
| External state and approval-control resource group, lock, two Storage accounts, three deployment identities, FICs and container-scoped data roles | Owner-run subscription Bicep | `foundation/main.bicep`, `foundation/resources.bicep`, generated `foundation/main.json` and canonical `foundation/activation.json` |
| Azure control resource group, CanNotDelete lock, keyless Storage, controller and ledger-bootstrap identities, Function skeleton, monitoring, and shared runner VNet, subnet and NAT | OpenTofu | `modules/azure-control` and `environments/azure-pilot` |
| One allocation resource group and generation-one deployment, NSG, VM, OS disk, NIC and temporary public IP | The future TypeScript controller | Subscription-scope `templates/azure-allocation/main.bicep`, its resource-group module and generated `main.json` |
| One temporary JIT Managed Run Command on the already-created generation-one VM | The future TypeScript controller, only after exact Compute Schedule acceptance and checked launch prerequisites | Separate resource-group-scope `templates/azure-allocation/jit-launch.bicep` and generated `jit-launch.json` |
| Dormant V2 D1 reporting database | OpenTofu, not applied for V1 | `modules/cloudflare-reporting` |
| Dormant V2 reporting Worker, D1 binding, retention cron and Access application | OpenTofu, not applied for V1 | `modules/cloudflare-reporting` |
| Allocation, fallback, readiness, cutoff and reconciliation behaviour | Future TypeScript application work | Not part of Phase 2 |

OpenTofu deliberately contains no transient VM or allocation resource group.
The controller must invoke `main.json` as a subscription deployment. That exact
template derives and creates the tagged allocation resource group, then uses
its embedded resource-group deployment to create all generation resources. It
does not accept an arbitrary target resource-group name. The shared subnet is
the sole long-lived allocation dependency. The NSG is generation-specific,
contains the required Azure platform and HTTPS outbound rules followed by an
explicit deny, and is attached directly to that generation's NIC.

Every VM has a distinct physical generation in its names, tags and outputs. V1
creates only generation one and contains no JIT material or Run Command. V2 may
add bounded replacement. The controller
must next submit a fresh Compute Schedule operation for the exact VM ID and the
allocation's immutable `originalCompleteBy`. It must persist the generation, VM
resource and provider IDs, correlation and returned operation IDs, requested
deadline, status and acceptance in authoritative Table Storage. Readiness is
closed until that exact operation is accepted. The template's
`computeScheduleTarget` output is only an instruction for that next step; an ARM
deployment cannot supply or imply Compute Schedule acceptance.

The template accepts distinct canonical UTC `allocationAcceptedAt`,
`originalCompleteBy` and `deletionTarget` values. V1 invokes only the
calculated-valid 45-minute contract using minutes 40 and 45. There is no
90-minute input in the V1 template. A longer lifetime requires a future reviewed
template and state-contract change. The literal mapped timeout
plus the fixed five-minute policy margin must leave a non-negative
latest-safe-start window. `latestSafeStart` is calculated as
`originalCompleteBy - mappedJobTimeoutMinutes - providerStopMarginMinutes` and
is returned and tagged. For the Workload mapping, minute 40 minus 25 minutes minus
five minutes is minute 10. The controller must persist these allocation-level
instants once and pass the same originals to every physical generation.

The control resource group has an inherited `CanNotDelete` management lock.
It protects the authoritative Storage account, Function/reconciler, monitoring,
identity and shared network even though the controller's subscription-scoped
runtime role can delete resource groups. The controller has no management-lock
action, so it cannot remove this protection. `CanNotDelete` prevents deletion;
it is not an immutability lock and does not block every update. Azure RBAC also
cannot constrain resource-group and allowed transient-resource actions by a
name prefix or tag. The controller code and identity therefore remain trusted
at the dedicated-subscription boundary. That subscription must contain no
unrelated resources, while the runtime identity intentionally retains enough
scope to create and delete isolated per-allocation groups. It has no Storage
management, Function, identity, IAM or lock action that could administer or
remove the authoritative control services. Its separately assigned blob, queue
and runtime-ledger data roles remain the controller's application-data boundary
described below.

The Function endpoint is public HTTPS so GitHub-hosted allocation jobs can
reach it. App Service Authentication requires an Entra token, accepts only the
configured API audience and approved GitHub workload client application, and
returns HTTP 401 to unauthenticated callers. It is not exposed through a
private endpoint and it is not attached to the runner subnet.

## Pinned toolchain

- OpenTofu `1.12.1`, container digest
  `sha256:1cdf44e7a44a67c7838ada83c71ad28b4c4e1571b47ad1c5b592624c2c8f35b5`
- AzureRM provider `5.2.0`
- AzAPI provider `2.12.0`
- Cloudflare provider `5.23.0`
- Bicep `0.46.1`, Linux x64 SHA-256
  `3e011d629ea4311b7a7dd8f0040ab2b1a072ea4ff5d02cb75e0e55a9a6703fb9`

Provider lock files are checked in at environment roots. The validation script
uses the pinned OpenTofu image and downloads Bicep into the repository's ignored
`.cache/` directory after checking its digest. It installs nothing globally.

## Disabled two-dispatch approval runtime

GitHub Free cannot provide the required private-repository protected-environment
pause immediately before an infrastructure apply. The future control therefore
uses two independent first-attempt the owner dispatches:

1. The plan dispatch targets the exact current `main` commit and calls the
   reusable plan engine at a full SHA. Its identity is read-only and the engine
   has no blob-write, lease or apply port. The exact plan command includes
   `-lock=false`; raw state SHA-256 and ETag must match on reads immediately
   before and after planning.
2. The plan engine creates a strict canonical plan bundle containing
   `plan.txt`, `plan.json`, the opaque saved plan and `manifest.json`. The two
   views are rendered from that exact saved plan with fixed OpenTofu commands.
   One reviewed real-ZIP decoder treats the raw archive bytes as its only input
   and bounds headers, entries, paths, modes, sizes, inflation and ratios. The
   saved plan is sensitive and never printed. The runtime writes only a
   deterministic local ZIP plus its name, path and SHA-256. GitHub does not
   support workflow artefact upload through its REST API, so the future PR C
   workflow must upload that exact file with the reviewed artefact action and
   `retention-days: 1`.
3. After reviewing the bundle, the owner starts a separate fresh dispatch with the
   exact plan run ID, artefact ID, commit SHA, full lowercase saved-plan SHA-256
   and, when destructive, `APPROVE DESTRUCTIVE PLAN <plan digest>`. The approval
   expires ten minutes after the dispatch run was created.
4. The apply engine independently proves both API runs, actor ID and triggering
   actor ID `900000001`, `workflow_dispatch`, run attempt one, repository and
   owner IDs, `refs/heads/main`, unchanged current `main`, all workflow paths and
   full SHAs, tenant, dedicated subscription, backend, authority class,
   publication chronology, artefact, manifest, rerendered views and saved-plan
   digests. Only after classifying the exact foundation or bootstrap identity
   does it request that identity's audience. It verifies the OIDC subject,
   `job_workflow_sha`, workflow-ref SHA suffix and audience, then exchanges those
   same token bytes with Entra.
5. Every private Azure receipt, state, lease and intent operation requires that
   resulting explicit session. The applier conditionally creates or verifies the
   content-addressed private receipt, takes the authoritative apply lease,
   rechecks state by SHA-256 and ETag, and atomically creates an apply intent
   keyed by the plan digest. It then refetches `main`, rechecks approval, plan,
   publication freshness and state again before the sole accepted command:
   `tofu apply -input=false -no-color saved-plan`. OpenTofu acquires its native
   backend lock normally. Completed retries return only after proof. Every other
   intent, native-lock failure or stale plan requires a new plan and approval.

The required GitHub OIDC setting uses GitHub's current first-party semantics:
`use_default: false`, `use_immutable_subject: true`, and exact custom claims
`repo`, `context`, `job_workflow_ref`. The stable prefix is
`repo:example-org@900000004/switchyard@900000003`. GitHub expands the
`context` placeholder directly as `ref:refs/heads/main`; the subject does not
contain a literal `context` key or percent-encode that separator.
`job_workflow_ref` names the reusable engine
at its full SHA. The future planner, steady foundation applier and bootstrap
applier use three separate Entra identities and these exact audiences:
`api://switchyard-900000003/infrastructure/planner`,
`api://switchyard-900000003/infrastructure/foundation-applier` and
`api://switchyard-900000003/infrastructure/bootstrap-applier`. Foundation has
no IAM application authority; a routine plan containing IAM fails. Bootstrap
accepts only an explicitly selected, create-only initial IAM plan at state
serial zero.

The checked-in GitHub settings are synthetic negative fixtures. Before any
live use, verify immutable subjects, private Actions access and organisation
SHA pinning independently. The runtime rejects settings that differ from the
reviewed contract before requesting a token.

The checked-in plan, apply and one-time initial-state manual callers pin the
foundation-bound engines to `5c9b286fcb5761a3fcf4b4c87882ec56103333e7`.
They contain no steps, checkout, secret, environment, cloud login or direct
OpenTofu command. Their OIDC capability is usable only after the runtime verifies
the exact immutable repository settings. The apply engine fixes one
`switchyard-infrastructure-apply` concurrency group with
`cancel-in-progress: false`, but the separate apply lease, native OpenTofu state
lock and private apply intent remain authoritative.

## External approval foundation

`foundation/main.bicep` is a subscription-scope entry point with checked
generated ARM. It is limited to `rg-switchyard-example-state` and its
`CanNotDelete` lock; Entra-only, TLS 1.2, infrastructure-encrypted Standard LRS
Storage accounts `swexampleapprovalstate` and `swexampleapprovalreceipt`; private
`tfstate`, `apply-control` and `plan-receipts` containers; and the three named
planner, foundation and bootstrap UAMIs. State Storage has blob versioning plus
30-day blob and container soft delete. Receipt Storage has neither, and its
container ends with a locked one-day immutability policy. ARM creates that policy
without the read-only `state` property. After `create`, the owner wrapper obtains
the created policy ETag, calls Azure's Lock Immutability Policy operation, then
rereads and requires the exact one-day Locked policy before success. Both public
endpoints remain enabled for GitHub-hosted jobs. There are no keys, SAS tokens,
secrets or private endpoints.

Before any later foundation reconciliation, the owner wrapper proves the exact
live policy. It omits that immutable child resource from the ARM request only when
the live policy is already Locked, then rereads and verifies it after the rest of
the deployment. An existing resource group with an absent, unreadable or malformed
policy fails closed before deployment.

The planner receives the built-in Azure Reader role at subscription scope for
management visibility, one custom subscription role containing only
`Microsoft.OperationalInsights/workspaces/query/read` so AzureRM can refresh the
reviewed scheduled-query alert, and only blob read at the `tfstate` container.
Reader does not add Storage data-plane access. The two applier identities receive
only blob read/write at the three exact containers. Their data roles contain no
delete, wildcard or management actions. The template exports the client and
principal IDs for all three identities, including the foundation principal later
supplied as `deployment_principal_object_id`.

The template also defines one unassigned subscription-scope custom role for the
reviewed create-only initial control plan. Its explicit management operations
cover the declared resource group, lock, UAMIs and FIC contract, custom roles and
assignments, Entra-only Storage resources, Key Vault, Function/App Service,
monitoring and network resources. The allowlist includes the AzureRM 5.2.0
create-time App Service name check, deleted Log Analytics workspace list, and
Application Insights current-billing-feature read/write calls. It has no wildcard,
delete or Storage DataAction. Ordinary foundation deployment does not assign it.
The FIC subjects require one future full engine commit and the three fixed
audiences above. The current disabled `49be281` engine makes the template's
activation condition false and is also rejected by the pinned owner wrapper.

Federated identity subjects must encode `ref:refs/heads/main` directly,
without a literal `context` segment. `foundation/oidc-subject-correction.bicep` is a one-time,
resource-group-scoped correction containing only the three existing federated
credentials, their fixed audiences and the reviewed final engine SHA.
Its owner wrapper supports `validate`, `what-if` and acknowledgement-bound
`create`, then rereads all three credentials and requires the exact corrected
subjects. It does not change identities, roles, Storage, state or workflow
settings. The checked-in foundation source carries the same correction for any
future reconciliation.

Canonical initial state is one OpenTofu 1.12.1 state-version-4 document with a
generated lowercase UUID lineage, serial zero, empty outputs/resources and null
check results. Before creating each of the state blob and
`apply-control/foundation/initial-state.json`, the live bootstrap adapter uses
the authenticated Azure List Blobs API with bounded pagination and the complete
versions, deleted, snapshots and uncommitted include set. It compares decoded
names exactly and fails closed on any current or retained match, malformed or
ambiguous page, repeated marker, truncation or limit breach. It keeps
`If-None-Match: *` as the final race guard.

After state creation, the adapter acquires an exclusive lease on that exact blob.
While leased, it verifies all canonical bytes and metadata, creates and rereads
the digest/ETag record create-only, then rereads and revalidates the unchanged
state. Every protected state read carries the lease ID, and lease loss, concurrent
mutation, final mismatch or uncertain release prevents success. The adapter and
all other live Blob adapters are composed by the strict production CLI. The
dedicated owner initial-state dispatcher invokes that operation only through the
exact pinned apply engine and exact acknowledgement transport.

## Activation and runtime boundary

The strict runtime entry point accepts only `plan`, `apply-saved-plan` or
`initialise-state`. It has no fake fallback. It requests the job's
short-lived GitHub workflow credential and OIDC request capability from the
process environment, consumes them once, and passes only an explicit verified
session to private Blob operations. It never uses a GitHub App credential,
repository secret, Azure CLI login, `DefaultAzureCredential`, client secret,
certificate or managed-identity fallback.

`infra/foundation/activation.json` is a canonical synthetic fixture containing
fictional cloud identities, storage locations and a template digest. It is not a
record of a deployment. The parser still rejects missing, extra, secret-like,
non-canonical or compile-time-inconsistent values. Live activation requires
independently reviewed configuration and immutable GitHub evidence returning
those exact committed bytes before a token is requested.

The reusable engines install OpenTofu 1.12.1 from the exact official Linux AMD64
release URL. They require archive SHA-256
`1fc9af962e3632b7cd0ba27076cd9f1ced177567defe9e331ac37f5a40468575`
and extracted-binary SHA-256
`b6cb308bd699c8b53882319986f339eeaa44f925a68f12d5b0a14e6caceedf23`,
then invoke only the strict CLI. The plan engine uploads its exact local ZIP with
full-SHA-pinned `actions/upload-artifact`, no compression and one-day retention.
Both engines receive only `actions: read`, `contents: read` and
`id-token: write`; their inputs and result bridge are bounded and fail closed.

The owner plan and apply dispatchers pin the exact foundation engine SHA
`5c9b286fcb5761a3fcf4b4c87882ec56103333e7`. A separately acknowledged one-time
initial-state dispatcher routes through that same immutable apply engine. Its
fixed sentinel transport is converted to `initialise-state` only for the exact
caller; the runtime independently verifies that caller and proves complete
current and retained state absence before it can create anything.

This still does not permit a live operation until the external GitHub OIDC
repository settings are changed to the exact immutable contract. All engines
read and verify those settings before requesting an OIDC token. The non-secret
`SWITCHYARD_INFRASTRUCTURE_TARGET_CONFIGURATION_JSON` repository variable also
remains a later prerequisite for plan and apply. Production runner allocation
and the Workload mapping remain disabled.

The owner wrapper pins Azure CLI `2.89.1`. It checks the exact subscription and
tenant, refuses the disabled SHA and requires a template-digest acknowledgement
for creation. Its disabled-SHA guard precedes every Azure CLI or API call. After
ARM creation it locks and verifies the receipt policy as described above; failure
leaves a partial deployment that requires recovery. It performs no login and was
not run. Follow the
[rollback runbook](../docs/infrastructure-foundation-rollback.md) for a failed or
partial future deployment. Storage-name availability remains a live read-only
check after code review.

`foundation/manage-bootstrap-authority.sh` is separate owner-run Cloud Shell
tooling for the later initial control apply. It performs no login and is not
called by any GitHub workflow. Grant, revoke and verify-absent all require the
reviewed plan and control-template lowercase SHA-256 digests, Azure CLI 2.89.1,
the exact tenant and subscription, and the bootstrap principal and initial role
read back from the fixed foundation deployment. Grant also rereads the fixed UAMI
and exact custom-role permissions, requires an acknowledgement containing both
full digests, creates their deterministic assignment, then rereads and proves it.
Revoke removes only that exact assignment and proves absence; it is safe to repeat.
The limited approval for the external foundation does not authorise grant. Grant
may run only immediately before a separately reviewed and approved create-only
initial plan apply, and revoke is mandatory after every terminal or uncertain
result. See the [rollback runbook](../docs/infrastructure-foundation-rollback.md).

All checked-in cloud identities, repository IDs and activation outputs are
synthetic examples. They are not deployment evidence or authorisation. Replace
the complete authority tuple through a reviewed change and collect fresh live
evidence before attempting a deployment.

## Secret-free boundary

No credential or secret value belongs in HCL, a tfvars file, the Worker bundle,
the generated ARM template, OpenTofu state or command output.

- Azure and the partial AzureRM state backend must authenticate through
  workload identity or another short-lived identity supplied as environment
  configuration. Provider automatic registration is disabled.
- The steady-state foundation deployment role is assigned only at the control
  resource group. A subscription-level Reader assignment lets it refresh the
  configuration without changing allocation resources or reading Storage data.
  It cannot create role definitions or assignments, so it cannot expand its own
  permissions. Initial resource-group and IAM creation, recovery of a deleted
  control group, and any reviewed IAM change require a separately authorised
  bootstrap identity. The external template defines its UAMI, scoped blob access
  and an unassigned create-only management role. Its separate digest-bound owner
  wrapper is the only reviewed grant/revoke path, remains unreachable from GitHub,
  and must not use a client secret. The
  foundation role can maintain the control-group lock; the
  controller runtime role cannot read, write or delete management locks.
- The Entra API app registration and GitHub allocation workload identity remain
  external prerequisites. The three infrastructure deployment UAMIs and FICs
  are defined only by the undeployed external foundation. OpenTofu receives only
  non-secret client or object IDs.
- The separate owner recovery identity receives only subscription/resource-group
  reads, exact allocation-resource reads, VM instance-view/deallocate and
  resource-group delete. It has no create, write, IAM, lock, Storage or Function
  action. The command adds strict name, tag, location, provider-VM-ID and plan
  proof before using that deliberately broad Azure group-delete operation.
- OpenTofu creates an empty RBAC-enabled Key Vault and no
  `azurerm_key_vault_secret`. Doppler managed-identity access must be proved
  live first. Only if that fails and the owner approves the exception may
  `doppler_bootstrap_enabled` be set. That grants the controller read access and
  reserves the name `doppler-bootstrap-token`; a later controlled process must
  put only that token value in the vault.
- The dormant V2 Cloudflare module remains disabled throughout the V1 pilot.
  Its future Access service token, provider-token and Worker-artefact boundaries
  remain defined and independently validated, but none is a V1 prerequisite.
- Allocation `nonSecretBootstrapCustomData` is a required, reviewed ARM runtime
  parameter that installs the pinned runner at `/opt/actions-runner`. The secure
  decorator protects deployment history as defence in depth, but VM custom
  data is not a secret store. The payload must contain no token, JIT
  configuration, private key or credential, and it never passes through
  OpenTofu or a checked-in parameter file.
- `reducedEncodedJitConfiguration` is a separate secure ARM parameter consumed
  only by the separate generation-one Managed Run Command template. It is the
  reduced, single-use encoded JIT payload returned by GitHub, never a GitHub App
  private key, installation token or registration token. On Linux, Azure
  exposes a named protected parameter to the script as an environment variable.
  The fixed script maps it directly in memory to
  `ACTIONS_RUNNER_INPUT_JITCONFIG`, never creates a JIT payload file and never
  puts the value in a process argument. The GitHub runner reads that supported
  input, masks it and removes the environment variable before decoding it.
  Switchyard also unsets its copies. Shell tracing and runner output are
  suppressed, and a detached wrapper runs as the unprivileged `switchyard`
  account with `umask 077`.
- The GitHub runner itself necessarily writes `.credentials`,
  `.credentials_rsaparams`, `.runner` and related configuration on the
  disposable OS disk. Those are the only credential files in this hand-off.
  The wrapper removes any that remain after the one-job runner exits, and
  controller cleanup revokes the registration and deletes the complete disk
  and allocation group. Later diagnostic forwarding must redact secrets and
  must not include these files, ordinary job output or Run Command output.
- Azure documents protected parameters as its secure parameter channel, but
  the value is necessarily handled by Resource Manager, the Compute service and
  the VM agent. Neither the API schema nor the Managed Run Command guidance
  promises immediate or universal non-persistence. Deleting the Run Command
  resource promptly reduces exposure; it is not evidence that every Azure or
  guest-agent copy has already been purged under the platform's retention
  rules.

## Fail-closed staged interfaces

The Azure environment creates a Linux Function App on a dedicated single-worker
B1 plan. Function package deployment is disabled by default. The reviewed
interface accepts only the deterministic ZIP from `npm run function:bundle`
and its matching lowercase SHA-256; supplying either value without enabling
deployment, or enabling deployment without both matching values, fails the
plan. A real deployment still needs the separately reviewed two-dispatch
approval described above.
The Functions platform supports only the `~4` host major channel, so that
platform value cannot be an exact patch pin; the Node runtime major is fixed to
24 and application dependencies are exactly locked.

The bundle builder includes only the compiled Function output, its production
dependency closure, the two reviewed generated ARM JSON templates, and the
checked-in non-secret runner bootstrap. It writes a per-file manifest inside
the ZIP, fixes ZIP timestamps and ordering, rejects provisioning-only or
reporting packages and credential-shaped content, then writes the complete ZIP
digest beside the ignored artefact. CI builds it twice and requires byte-for-byte
equality.

The Functions host runs one Node worker. Queue polling uses a batch size of one,
no prefetch threshold, raw message encoding, a 30-second visibility timeout and
five delivery attempts. Storage creates the corresponding provisioning poison
queue explicitly. The poison trigger records one allowlisted lifecycle event
and never redispatches the message. Azure Monitor evaluates every minute and
emails the owner for either that exact poison event or an allowlisted safety incident;
these visibility paths never replace ledger-backed cleanup.

The optional `admission_runtime_settings` map is empty by default, so the
deployed safety timer and cleanup path do not imply that new allocations are
enabled. A future reviewed configuration must supply the complete exact
application admission allowlist in one step; partial, unknown, empty or
credential-shaped values fail validation. The map contains identifiers,
audiences, claim-shape policy and conservative costs only. GitHub App key
material and any Doppler bootstrap token remain outside OpenTofu.

The bootstrap is fixed to GitHub Actions runner `2.336.0` for Linux x64 and
verifies the release SHA-256 before extraction. It requires Canonical Ubuntu
24.04, prepares only Azure's `/dev/disk/azure/resource` NVMe disk, moves Docker
data and runner work there, runs the runner as the unprivileged `switchyard`
account, and disables automatic runner updates. It accepts no arguments or JIT
material and prints no environment or command output containing credentials.
Its root-owned readiness command verifies the mount, Docker, exact runner
version, update-disable setting, and root-owned marker before reporting ready.
The pinned release and digest come from the
[official GitHub runner release](https://github.com/actions/runner/releases/tag/v2.336.0).

AzureRM `5.2.0` cannot manage an Entra-only Azure Table safely: its table
resource still reads ACLs through shared-key authentication. The authoritative
ledger table therefore uses the pinned AzAPI provider and the ARM management
plane. There is exactly one `SwitchyardLedger` table and the runtime uses its
single `control-v10` partition for the registry, both provider controls,
allocations, ordered provider attempts, physical generations, immutable branch
evidence, reconciler heartbeat and allowance history. The older separate
allocation and safety-reservation table settings do not exist.

The Function receives the exact non-secret settings
`SWITCHYARD_LEDGER_ACCOUNT_NAME`, `SWITCHYARD_LEDGER_TABLE_NAME`,
`SWITCHYARD_LEDGER_PARTITION_KEY`, `SWITCHYARD_LEDGER_INSTANCE_ID`,
`SWITCHYARD_LEDGER_SCHEMA_VERSION` and
`SWITCHYARD_MANAGED_IDENTITY_CLIENT_ID`. The immutable instance ID is an
externally chosen UUID for one complete table installation; schema version 10
must agree with every persisted row and document. The Function attaches only
the controller identity. Its table-scoped custom role can read, add and update
entities, but cannot delete them.

The one-time `@switchyard/azure-ledger-bootstrap` deployment artefact runs under
the distinct `id-switchyard-ledger-bootstrap-uksouth` managed identity. That
identity has only table-scoped entity read and add DataActions. It is not
attached to the Function and the bootstrap package is excluded from runtime and
future `apps/` packages by content gates. TypeScript capability types help
callers but are not the security boundary. The package/deployment separation
and distinct identity assignment are the boundary. Azure Table RBAC cannot
restrict entity access by row key, so the provisioning procedure must also
guarantee exclusive access while bootstrap proves the whole table empty and
atomically creates the registry, both controls and empty heartbeat foundation
rows in the sole partition.

Missing foundation is always runtime corruption. It is never repaired in
place. A complete destructive table replacement, new instance UUID and fresh
bootstrap are one explicit provisioning event after independent recovery has
accounted for every live allocation. Any surviving row makes bootstrap fail.

In this provider version, the AzureRM queue and container resources perform
CRUD through Resource Manager management operations. During reads the provider
derives their data-plane URLs only to populate computed `url` attributes; it
does not use those endpoints to manage the resources. The existing
`Microsoft.Storage` control Actions are therefore sufficient. The deployment
role intentionally has no queue-message or blob DataActions, cannot read
messages or diagnostics, and requires no control-Storage data-plane network
connectivity. Public control-Storage endpoints remain enabled for the Function
and controller's managed-identity runtime data access. Only the controller
identity can write runtime data and the owner's identity can read diagnostics.
Versioning and soft-delete retention are not enabled for these blobs, so they
do not extend the diagnostics lifecycle beyond the seven-day deletion policy.

The allocation template fixes the publisher, offer and SKU to Canonical Ubuntu
24.04 LTS Gen2, but requires the exact UK South image version as a runtime
parameter. The Azure environment has the same required value with no default
and exposes it to the future controller as fixed configuration. `latest` is
deliberately mapped to a nonexistent image version so the deployment fails
closed. The exact available version is an unresolved live input because Phase
2 forbids Azure login.

The template accepts the controller's exact 68-character allocation ID
(`sy1-` plus its 64-character hash), the shared maximum 64-digit GitHub run ID
and Node's canonical millisecond UTC timestamps. Deadline equality is checked
directly in that exact format; ARM `dateTimeAdd` preserves its base format when
no different output format is requested. This keeps one exact instant across
the controller, ledger, template and Compute Schedule.

The template also requires the future application build's reviewed non-secret
bootstrap payload and an ephemeral SSH public key. The settled JIT channel is
the separately deployed `jit-launch.json` Managed Run Command protected
parameter described above. The base deployment has no JIT parameter, and the VM
still has no Azure identity or Azure role. Run Command waits only for the short
script to detach the independent one-job runner process, not for `run.sh` to
finish. A
successful command therefore confirms only process hand-off, never runner
readiness. Immediately after that confirmation, the controller must persist
`launch_confirmed_at`, `run_command_delete_requested_at` and eventual
`run_command_delete_completed_at`, delete generation one's precise Run Command
child resource at
`/subscriptions/{subscriptionId}/resourceGroups/{allocationResourceGroup}/providers/Microsoft.Compute/virtualMachines/{vmName}/runCommands/launch-jit-g1`
and must reject any output naming a different group, VM or command. The
controller retries or incidents any failure. Readiness requires confirmed Run Command
deletion as well as bootstrap, local NVMe, Docker, the exact unique GitHub
runner online and idle, the fresh accepted schedule and an unpassed
latest-safe-start. The JIT template's exact existing-VM output and deletion
obligation, together with the schema-10 generation record and local validator,
make this a checked interface for the future controller.

The dormant V2 Cloudflare provider can create D1 but cannot apply application SQL
migrations declaratively. `deploy_worker` and `publish_worker` therefore both
default to `false`. The protected hostname is derived, never supplied: it is
`<worker_script_name>.<workers_dev_account_subdomain>.workers.dev`. Enabling
deployment requires a real secret-free Worker file, its matching digest, the
reviewed D1 migration revision already applied by a later application workflow,
the account subdomain and the existing Access service token ID. The pinned
provider creates the self-hosted Access application and inline service-token
policy first, creates the Worker object with its subdomain disabled, uploads and
deploys the reviewed version with its D1 binding, then creates the retention
cron. Publication is a separate deliberate stage: only after Access has been
independently verified may `access_protection_verified` and `publish_worker` be
set to `true`. Preview URLs remain disabled. No placeholder script, unrelated
hostname or schema is supplied.

This phase defines no application fallback behaviour. When this branch is
rebased or merged with the controller work, preserve main's fail-closed rule for
a controller or authoritative control dependency outage. Never resolve a
documentation conflict by restoring fallback-on-controller-outage wording.

The generated ARM JSON is checked in so the later controller can invoke a
reviewed artefact without compiling Bicep at runtime. Validation recompiles the
Bicep source and fails if the JSON differs.

## Preflight before any future plan

1. Change the repository OIDC customisation to the exact immutable-subject
   contract, then independently read it back. Confirm the two reusable engine
   SHAs and three exact Entra identity, audience and immutable-subject
   registrations still match before using any infrastructure dispatcher.
2. Confirm the subscription is dedicated to Switchyard, the startup credit is
   attached, and UK South total and Ddsv6-family vCPU quotas are sufficient.
3. Have a subscription owner register `Microsoft.Authorization`,
   `Microsoft.ManagedIdentity`, `Microsoft.Storage`, `Microsoft.KeyVault`,
   `Microsoft.Web`, `Microsoft.Insights`, `Microsoft.OperationalInsights`,
   `Microsoft.Network`, `Microsoft.Compute` and `Microsoft.ComputeSchedule`.
   OpenTofu will not register them automatically.
4. The external foundation has passed `validate`, `what-if` and separately
   acknowledged `create`; its exact non-secret activation evidence is committed.
   After the OIDC readback in step 1, use only the dedicated one-time initial-state
   dispatcher to create the canonical state and SHA-256/ETag record from proved
   total absence. The partial
   `backend "azurerm"` block still prevents an accidental local-state apply. Do
   not grant any deployment identity control-Storage blob or queue-message
   DataActions.
5. Create or verify the external Entra API registration, approved GitHub
   federated workload identity, deployment identity, diagnostics owner and
   separate recovery owner object IDs. Do
   not create client secrets. After a separate review and approval of the exact
   create-only initial plan and control template, use the owner-only
   `manage-bootstrap-authority.sh grant` command immediately before that apply.
   This grant is not authorised by the earlier foundation approval. Run
   `manage-bootstrap-authority.sh revoke` after every terminal or uncertain result,
   then `verify-absent` before leaving the incident or maintenance window.
   The steady-state deployment role deliberately cannot write IAM or grant
   itself more access. Any intentional destructive replacement inside the
   control group requires a separately reviewed lock-removal procedure.
6. Supply a new immutable `ledger_instance_id`, deploy the distinct ledger
   bootstrap identity and its table-scoped role assignment, then run only the
   `@switchyard/azure-ledger-bootstrap` artefact with that identity. It must
   prove the complete target table is empty and atomically create the exact
   schema-10 `control-v10` foundation. Replacing a ledger table is a destructive
   provisioning event, never controller recovery.
7. Prove the undocumented Doppler exchange with the Function managed identity.
   Keep the Key Vault exception disabled unless that exact live test fails and
   the owner approves it.
8. Resolve and record one exact Canonical
   `ubuntu-24_04-lts:server` image version in UK South. Never supply `latest`.
9. Drain and delete all active allocations before changing the shared VNet,
   subnet or NAT gateway because those long-lived resources can affect running
   jobs immediately. Each allocation owns its NSG and direct NIC attachment.
   That NSG permits Azure platform DNS, IMDS, WireServer and outbound HTTPS,
   then explicitly denies all other outbound traffic. Roll out an NSG rule or
   template-version change only after draining existing allocations; never
   mutate an active generation's network contract in place.
10. Keep the Cloudflare environment unplanned and unapplied for V1. Its token,
    migrations, artefact, Access verification and publication stages are V2
    prerequisites, not Azure-pilot blockers.
11. Review the custom role operations against the registered provider operation
   list. Azure validates custom-role action strings only during a real request,
   not during local provider-schema validation.
12. Before production activation, exercise the exact-cutoff guard and the
    [owner recovery drill](../docs/recovery.md) against one approved
    non-production allocation. A checked-in command is not live recovery proof.

### Fresh-bootstrap activation for schema 10

There is no live ledger, and this phase adds no live migration. Production
allocation remains disabled. A future activation must fail closed unless all
of these conditions are satisfied in order:

1. Recover and account for every allocation or tagged Azure resource through
   the independent recovery path. Select a genuinely unused table, or approve
   complete destructive replacement of an old table. Never copy older-schema rows.
2. Configure a new immutable ledger instance UUID, partition `control-v10` and
   schema version `10` in the reviewed infrastructure plan and controller
   settings. Any disagreement must stop startup.
3. Under the separate provisioning identity and exclusive table access, run
   the bootstrap artefact once. It must prove the whole table empty, commit the
   four exact foundation rows atomically and re-scan the table successfully.
4. Remove bootstrap access from the activation path. Start the reconciler and
   require it to persist a fresh successful heartbeat. Then verify controller
   health, trust, Doppler and lifecycle Check Run creation against the new
   ledger before enabling any allocation mapping.
5. Keep the Workload mapping disabled until the complete activation evidence and
   production blockers in `AGENTS.md` have been independently reviewed.

An old schema, partial foundation, stale heartbeat, copied allocation row or
failed bootstrap proof has no repair or compatibility mode. It leaves new
allocation and Blacksmith fallback disabled while independent cleanup remains
available.

## Validation commands

Run the complete local check from the repository root:

```sh
./infra/scripts/validate.sh
```

It runs `tofu fmt -check`, `tofu init -backend=false` and `tofu validate` for
both environments, compiles and lints all three Bicep entry points, compares all
generated ARM JSON files, checks that the base template has no JIT channel,
checks the separate exact Managed Run Command/JIT contract, and scans ownership,
secret, state, saved-plan and ignore boundaries. It also validates the pinned
bootstrap, one-worker Functions host, five-attempt poison-queue path,
default-disabled ZIP gate, and both owner-alert definitions. It downloads
provider plugins and the pinned Bicep binary but never authenticates to a cloud.

The equivalent environment-specific OpenTofu command is:

```sh
docker run --rm \
  -v "$PWD:/workspace" \
  -w /workspace/infra/environments/azure-pilot \
  ghcr.io/opentofu/opentofu@sha256:1cdf44e7a44a67c7838ada83c71ad28b4c4e1571b47ad1c5b592624c2c8f35b5 \
  init -backend=false -input=false -lockfile=readonly
```

Run the same container invocation with `validate -no-color` after
initialisation. Use both commands in `cloudflare-reporting`. Do not run `plan`
or `apply` under this phase's authorisation.

## Unresolved external inputs

- live read-only global availability proof for both fixed Storage names
- three exact custom audiences and live FIC exchange proof for planner,
  foundation apply and bootstrap apply
- reviewed full SHAs for the future activated reusable engines and manual
  dispatchers
- globally unique Storage, Key Vault and Function names
- externally chosen immutable ledger instance UUID
- deployment, owner diagnostics, separate owner recovery, Function API and GitHub
  workload identity IDs
- separate approval for the exact digest-bound initial-control grant and plan,
  followed by mandatory proved revocation
- provisioning-only ledger bootstrap execution under its distinct managed
  identity after an exclusive complete-table emptiness proof
- owner alert email
- deployment and canonical initial-state creation evidence for the external
  approval foundation
- current credit evidence and later revalidation of UK South quota and exact
  Ubuntu image availability
- per-allocation ephemeral SSH public key
- per-allocation reduced encoded JIT configuration produced at runtime, never a
  GitHub App key or token
- the exact reviewed admission-only Function settings and deterministic ZIP digest
- proof that Compute Schedule accepts the required one-off deallocation in UK
  South, plus controller persistence of a fresh accepted operation for every
  physical generation
- proof that the configured Entra Easy Auth flow accepts the GitHub workload
  token without an app client secret
- result of the Doppler managed-identity exchange test
- reviewed live exact-cutoff and owner-recovery drill evidence, plus live provider
  proof fixtures
- V2 only: Cloudflare account and Access configuration, reviewed D1 migrations,
  and the built Worker artefact and digest

These are deliberately not guessed or represented by placeholder resources.
