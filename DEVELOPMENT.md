# Local development

The repository uses npm workspaces. `@switchyard/core` contains platform-neutral
allocation, trust and Check Run contracts and policy. `@switchyard/github` contains
the Node-specific GitHub REST, GitHub App authentication, immutable workflow
verification and Check Run delivery adapters. `@switchyard/reporting` contains
platform-neutral telemetry contracts, and `@switchyard/reporting-worker` is the
Cloudflare Worker and private report CLI. The Azure Table Storage runtime adapter
lives in `@switchyard/azure-ledger`; the separately installable
`@switchyard/azure-ledger-bootstrap` package is the one-time provisioning artefact.
`@switchyard/controller` contains the production-disabled pre-state proof and trust
composition, exhaustive ledger projection, portable allocation service, strict HTTP
handler and per-allocation Blacksmith correlation engine. It registers no Function app
and contains no ledger or provider runtime adapter. `@switchyard/azure-worker`
contains the production-disabled generation-one Azure state machine over injected
Azure, GitHub, schedule, clock, planning, alert and ledger ports. It has no cloud SDK
or runtime registration. `@switchyard/reconciler` contains the production-disabled,
provider-neutral one-minute lifecycle scan and repair loop over injected ledger,
GitHub observation, Azure worker, visibility, incident and clock ports. The dependency
direction is deliberate. `@switchyard/recovery` contains the pure, ledger-independent
owner recovery planner and executor over injected Azure and GitHub ports. The private
`@switchyard/recovery-cli` app supplies the bounded Azure CLI and reduced GitHub token
transports. It is never bundled into the Function app. Reporting may use completed
allocation facts, but allocation code never imports reporting, D1 never appears in
controller health, and the ledger
does not depend on the reporting, GitHub or controller packages.

`@switchyard/infrastructure-approval` contains the separate infrastructure
approval engines and their production runtime composition. Its live CLI supports
only `plan`, `apply-saved-plan` and `initialise-state`. It uses bounded GitHub
REST evidence and workflow credentials, requests and verifies the exact OIDC
token only after immutable evidence succeeds, exchanges the same bytes with
Entra, and supplies explicit short-lived Azure sessions to the Blob ports. Its
pinned OpenTofu adapter has fixed staging, commands, environment, output and time
bounds. It does not import ledger bootstrap, reporting or D1 code.

The package executable is called only by the reusable plan and apply engines.
Those engines have the exact read and OIDC permissions required by the runtime.
The owner plan, apply and one-time initial-state dispatchers call the exact
foundation-bound engine SHA. The committed activation file contains only the
canonical non-secret foundation outputs. The runtime still stops before token
issuance while GitHub's immutable repository OIDC settings differ from the exact
contract.

## Activation scope

V1 activates only Azure generation one with a fixed 45-minute allocation,
Blacksmith fallback, Check Run visibility, redacted Azure logs and email alerts.
The repository already contains forward-compatible D1 reporting, but production
configuration must not enable it before V2. Longer allocations and replacement
VMs remain documented extension points only; the schema-10 ledger rejects them.

The Azure bootstrap installs a root-owned exact-cutoff guard before any JIT runner
configuration is delivered. Its tests extract the real checked-in guard and IMDS
contract from the bootstrap, so boundary, reboot, clock-rollback, corrupt-state and
tag-arithmetic checks exercise the shipped scripts rather than a second model. See
[the recovery runbook](docs/recovery.md) for the separate owner-only path.

Node 24 LTS is the development and build baseline. The exact repository toolchain
is Node 24.19.0 with its bundled npm 11.17.0; `.node-version` and `packageManager`
record those versions. Azure Functions v4 currently
[supports Node 24](https://learn.microsoft.com/azure/azure-functions/functions-reference-node#supported-versions),
and Cloudflare Wrangler supports
[Current, Active and Maintenance Node releases](https://developers.cloudflare.com/workers/wrangler/install-and-update/).
Workers execute in `workerd`, so the shared core avoids Node-specific runtime APIs.

## Infrastructure approval contract

The infrastructure flow has two checked-in manual caller shells. They still call
the production-disabled historical reusable engines and always fail. The new
engine definitions are ready for a later exact-SHA activation:

1. A future first-attempt owner `workflow_dispatch` at the exact current `main` commit
   calls the plan engine at a full SHA. The read-only planner produces
   one opaque saved plan, then renders `plan.txt` and `plan.json` from that exact
   file with fixed commands before building the canonical manifest. The runtime
   produces one deterministic local ZIP. The workflow owns the later supported
   artefact-action upload with exactly one-day retention.
2. the owner reviews those exact bytes. A separate fresh first-attempt owner dispatch
   supplies the plan run ID, artefact ID, commit SHA, lowercase saved-plan
   SHA-256 and the digest-bound acknowledgement for a destructive plan.
3. Before requesting its GitHub OIDC token, the apply engine decodes and
   rerenders the saved plan, classifies its exact foundation or bootstrap
   authority and verifies both GitHub API runs, original
   and triggering numeric actor IDs, event, branch, current `main`, commit,
   workflow paths and SHAs, approval and publication chronology, immutable
   artefact, identical private receipt, canonical manifest, rerendered plan
   views, authority class, tenant, dedicated subscription, backend state digest,
   resource count, lineage, serial and all digests. It then requests only the
   selected identity's exact audience, verifies `job_workflow_sha` and the SHA
   suffix of `job_workflow_ref`, and uses those same token bytes for Entra.
4. After exact foundation or bootstrap identity selection, it takes the
   authoritative apply lease, rechecks state and atomically creates the apply
   intent. It then refetches `main` and rechecks approval, plan and publication
   freshness before the fixed saved-plan-only command. OpenTofu acquires its own
   native backend lock normally. Any non-completed intent, native lock failure or
   stale plan never executes again. Completed retries return only after the
   receipt and current state prove completion.

GitHub's current first-party immutable subject format is used, not the older
name-only custom-template assumption. The required repository setting is
`use_default: false`, `use_immutable_subject: true`, and exact claims `repo`,
`context`, `job_workflow_ref`. Its exact prefix is
`repo:example-org@900000004/switchyard@900000003`; `context` is
`ref:refs/heads/main`, encoded by GitHub in the subject, and
`job_workflow_ref` ends in the reviewed engine's full SHA. See GitHub's
[OIDC reference](https://docs.github.com/en/actions/reference/security/oidc).

The checked-in repository evidence and activation configuration are synthetic.
They deliberately do not authorise this repository or any live deployment.

The planner, foundation applier and bootstrap applier are three distinct future
Entra identities with these exact audiences:

- `api://switchyard-900000003/infrastructure/planner`
- `api://switchyard-900000003/infrastructure/foundation-applier`
- `api://switchyard-900000003/infrastructure/bootstrap-applier`

The two appliers deliberately
share the apply engine's exact immutable subject because `job_workflow_ref`
identifies the reusable workflow, not a job ID; manifest classification and the
distinct audience/client identity prevent cross-use. The foundation identity has
no IAM write authority. The bootstrap identity is valid only for an explicitly
classified create-only initial IAM plan at state serial zero. The external
foundation exports all three client and principal IDs, gives the planner the
built-in subscription Reader role plus the single Log Analytics query action
needed to refresh the reviewed alert, alongside only its exact `tfstate` blob-read
permission, and leaves the tightly allowlisted initial-control role unassigned.
A future owner-only grant must bind the reviewed plan and control-template
digests and be revoked after every terminal or uncertain result. The limited
foundation approval does not authorise that later grant.

The two engine workflows are reusable-only. They use exact action SHAs,
`actions: read`, `contents: read` and `id-token: write`; install a SHA-256-verified
OpenTofu 1.12.1 archive and binary; invoke only the strict CLI; and keep the apply
concurrency group fixed with `cancel-in-progress: false`. Plan bundles are
uploaded for exactly one day. The target configuration is one bounded non-secret
repository variable and the runtime validates its complete canonical form.

The plan and apply dispatchers expose only the settled inputs and pin the matching
engine at `5c9b286fcb5761a3fcf4b4c87882ec56103333e7`. A third one-time dispatcher
requires the exact `INITIALISE EMPTY SWITCHYARD STATE` acknowledgement and routes
fixed sentinel values through that same apply engine. The bridge recognises this
transport only for the exact initial-state caller, and the runtime then verifies
that caller independently before creating state. None of the callers contains a
step, secret, environment, cloud login or direct OpenTofu command.

## Local CI parity

Use the version in `.node-version`, then run the same gates as CI:

1. Run `npm ci` to install only the dependency versions in `package-lock.json`.
2. Run `npm run check` for formatting, linting, type checking, tests, script syntax
   and workflow validation. The workflow check downloads the pinned actionlint
   Linux amd64 archive into a temporary directory, verifies its published SHA-256
   before extraction and does not install anything globally. ShellCheck and
   pyflakes integration are explicitly disabled, so actionlint runs the same
   built-in checks locally and in CI regardless of tools available on `PATH`.
3. Run `npm run build`, `npm run smoke:imports` and `npm run package:check` to
   compile the workspaces, import every public package path, prove the runtime
   bootstrap subpath is unavailable, verify each exact `npm pack --dry-run`
   allowlist and perform a no-deploy Wrangler bundle check.
4. Run `npm audit`. Before committing, run `git diff --check` and
   `git diff --cached --check`. From a clean commit, run
   `bash scripts/check-generated-files.sh` to confirm that the gates leave no
   tracked changes or untracked, non-ignored files.

The GitHub package deliberately uses narrow fetch wrappers rather than Octokit.
Every request sends the checked-in GitHub REST API version `2026-03-10`. Workflow
YAML parsing uses the exact locked `yaml` package version. Review API-version and
parser upgrades as ordinary pinned dependency changes.

## Controller contract slice

The controller package accepts two independent credentials. Easy Auth's mapped
principal must prove the exact app-only Entra tenant, API audience, client
application, dedicated role and app identity type, with no delegated scope. That
proof authenticates the API client only. A separate fresh GitHub OIDC JWT must be
RS256-signed for the exact GitHub issuer and one custom audience, and must bind the
repository, run, attempt, allocator Check Run, exact caller workflow, pinned reusable
workflow, ref, SHA and actor.

The public verifier returns a decision only after those proofs agree with the
independent `@switchyard/github` trust result. A security or trust failure therefore
occurs before the post-trust allocation-control capability is supplied. OIDC discovery and JWKS fetches have
strict time, response-size and cache bounds, redirects are rejected, and one unknown
key triggers exactly one JWKS refresh. JWT segments and JSON nesting are bounded,
duplicate and unsupported claims fail closed, and the maximum signed lifetime is ten
minutes. A new `jti` is normal and is deliberately absent from the returned decision.
Tests use generated local RSA keys and injected fetch/trust fakes, so they make no
network or cloud call.

The allocation request body is strict JSON containing exactly `identity`, `profile`
and `backupChoice`. The verifier rejects inherited or accessor-backed transport data,
unknown and duplicate fields, and any request attempt to provide a runner label or
timeout. It compares the requested profile and backup choice with independent mapping
evidence, then returns one frozen policy input whose managed label and literal timeout
come only from that evidence.

The application-facing `ApprovedBranchEvidenceStore` is separate from the
post-trust `AllocationControlLedger`. A storage class may implement both, but the
portable service receives the allocation and counter capability only from an injected
provider after the complete proof and trust decision succeeds. It then requires a
durable reconciler heartbeat no older than 150 seconds before acceptance or any exact
retry response. Once an allocation is stopped, abandoned, cleaning or ended, the
exhaustive projection returns terminal `runner-unavailable` before provider policy;
an authenticated late poll can never reserve again or receive a dead runner label.

`POST /api/v1/allocations` is represented by an injected HTTP handler rather than a
registered runtime. It accepts no query string and at most 4 KiB of UTF-8
`application/json`. The body has exactly `identity`, `profile` and `backupChoice`;
duplicate and unknown keys, runner labels and timeouts fail transport validation. The
handler requires one bearer header, one mapped `X-MS-CLIENT-PRINCIPAL` and one fresh
`X-Switchyard-GitHub-OIDC`. Ready, pending and redacted error responses follow the
documented status contract, and every response has `Cache-Control: no-store` and
`X-Content-Type-Options: nosniff`.

| Status | JSON result | Extra header |
| --- | --- | --- |
| `200` | `{runner_label, allocation_id}` | none |
| `202` | `{allocation_id, status: "pending"}` | `Retry-After: 5` |
| `400` | `{error: "invalid-request"}` | none |
| `401` | `{error: "authentication-required"}` | none |
| `403` | `{error: "allocation-not-authorised"}` | none |
| `405` | `{error: "method-not-allowed"}` | `Allow: POST` |
| `409` | `{error: "allocation-conflict"}` or `{error: "runner-unavailable"}` | none |
| `413` | `{error: "request-too-large"}` | none |
| `415` | `{error: "unsupported-media-type"}` | none |
| `500` | `{error: "internal-error"}` | none |
| `503` | `{error: "controller-unavailable"}` | `Retry-After: 5` |

After acceptance, durable lifecycle Check Run creation is mandatory. Check Run lease
contention has a configurable two-second coordination deadline and returns a typed
deferred result, so one API call cannot spend roughly 128 seconds in the old bounded
poll loop. The numeric ID must be persisted before projection can reserve anything.
One exhaustive projection is the only bridge from ordered attempt records into policy:
Azure ordinal 1 is reserved and deterministically dispatched; safely settled Azure
unavailability applies `Save money` or `Keep going`; Blacksmith ordinal 2 is reserved,
marked successful and assigned the exact trust-owned managed label. Dispatch failure is
controller unavailability and never fallback. Later Check Run delivery remains best
effort and reconciled.

Blacksmith correlation is deliberately per allocation, not a claimed full reconciler.
Its observation port receives the exact run identity and the mapping pointer, profile,
backup choice, workload key and name, literal timeout and shared label derived only from
`VerifiedWorkloadTrust`. It persists one numeric job ID or one immutable binding failure
(`expected-job-missing`, `different-job` or `ambiguous-job`). Failures require an
incident result but this phase does not mutate Issues. It never releases a reservation,
selects another provider or treats elapsed time as terminal evidence.

The GitHub proof accepts only the reviewed non-PR, GitHub-hosted reusable-workflow
claim shape. It validates the exact configured subject plus redundant actor,
repository-owner, run-number and workflow fields, and rejects caller-only tokens,
repository-property claims and unreviewed additions. Easy Auth similarly separates
required app-only security claims from explicitly mapped documented ancillary claims,
rejecting delegated scope, duplicates and mixed v1/v2 client identity. The checked-in
redacted fixtures are synthetic. Reviewed live redacted GitHub and Easy Auth captures
remain activation blockers.

This package is not a registered allocation endpoint and cannot activate Workload. Activation is
blocked on a reviewed live Easy Auth mapped-claim fixture; exact Entra tenant, API
audience, allocation client application and dedicated role values; the exact GitHub
proof audience; the full approved reusable-workflow commit SHA; and working
GitHub-hosted allocator billing. Tokens and mapped principal headers must never be
logged, persisted, placed in fixtures or included in returned errors.

The standalone `.github/actions/allocate/index.mjs` has no package dependency. It
obtains one GitHub OIDC assertion for Entra client-credentials exchange, keeps the
resulting access token in process memory, obtains a separate fresh
Switchyard-audience proof for every API call, and honours each pending response's
`Retry-After`. It uses a monotonic 14-minute poll deadline, requires the Entra
token to cover that budget, accepts only canonical API JSON and literal GitHub
runner labels, and writes only `runner_label` and `allocation_id` to
`GITHUB_OUTPUT`.

The reusable workflow references the private action at the reviewed commit whose
action files are byte-equivalent to the current source. The checked source-digest
manifest must agree with both the pinned commit and the local files. The workflow
never uses Workload's repository-scoped token to check out private Switchyard source.
It runs only on GitHub-hosted Ubuntu for 15 minutes, validates the called-workflow
identity, executes no caller code and has only `id-token: write`.

Switchyard's private Actions access is currently `none`, and working GitHub-hosted
Actions billing remains a reviewed activation prerequisite. The current non-secret
`vars` configuration is for non-production validation only. Activation order is:

1. Merge this disabled hardening phase. Its SHA is preliminary and
   non-activatable.
2. Obtain and independently review the real immutable non-secret configuration.
3. Commit and merge that configuration as literal or digest-bound reusable-workflow
   values.
4. Only then record the final post-configuration reusable-workflow SHA and pin the
   separately reviewed Workload gate and allocator to that exact SHA with exactly
   `id-token: write`. Keep the mapping disabled.
5. Enable and review private Actions access and billing, capture live redacted
   proof evidence against the final SHA, and record the exact allocator job and
   Actions Check Run names while the mapping remains disabled.
6. Review all remaining blockers before a separate mapping-enablement change.

There is no `apps/control-function`, Azure Function registration, live GitHub, Azure,
Doppler or Storage construction, Azure VM adapter, queue, timer, heartbeat writer, final
settlement, price feed, incident mutation, D1 integration, Workload mapping activation,
organisation sharing change or infrastructure change in this slice. Exact managed
prices and rounding and every cloud identity remain validated external production
inputs; none is guessed by this package.

## Repository CI ownership

`.github/workflows/ci.yml` is the project-required quality gate for pull requests,
`main` pushes and manual checks. GitHub Free cannot enforce a required status check
on this private repository, so confirming that this workflow passed before merge
is currently a manual project policy. GitHub-hosted jobs are currently blocked by
the account payment or Actions spending-limit state, so the workflow uses the
bounded Blacksmith-managed `blacksmith-2vcpu-ubuntu-2404` tier. This bootstrap gate
remains independent and does not call Switchyard. It has read-only repository
access, no secrets or cloud credentials, and a 15-minute limit. A newer run cancels
an older run for the same pull request; distinct `main` pushes are never cancelled
by the concurrency rule.

CI checks committed whitespace across the pull request merge result relative to
its base parent, the complete `main` push range, or the selected manual-dispatch
commit relative to its first parent. It separately rejects tracked changes and
untracked, non-ignored files created by the gates.

Dependabot checks npm and pinned GitHub Actions every Monday. It limits open
update pull requests, uses the default `dependencies` and ecosystem labels that
GitHub creates without setup, and leaves every update for human review. Nothing
auto-merges. The schedule controls version updates. Dependabot security-update
pull requests also require vulnerability alerts and Dependabot security
updates to be enabled in the repository settings; this file cannot enable those
settings.

## D1 reporting application

This application remains dormant throughout V1 and is retained for V2. When
activated, the reporting Worker is a narrow best-effort telemetry boundary. It
exposes only:

| Method | Path | Operation |
| --- | --- | --- |
| `POST` | `/v1/usage-records` | One strict idempotent completed-usage write |
| `GET` | `/v1/reports/7` | Fixed rolling 7-day report |
| `GET` | `/v1/reports/30` | Fixed rolling 30-day report |
| `GET` | `/v1/reports/365` | Fixed rolling 365-day report |

Query parameters, arbitrary SQL, table names, arbitrary report windows and every other
operation are rejected. All SQL is static and every value is passed through a numbered
prepared-statement binding. The request schema accepts only the exact V1 reporting
dimension tuple `example-org/example-workload`, `.github/workflows/ci.yml` and
`example-build`; GitHub run ID and URL; provider and capability profile; start,
completion and duration; outcome; fallback and cleanup indicators; and estimated US dollar
cents. It rejects every other repository, workflow or job value even if it contains only
safe characters. It also rejects machine details, branch and actor data, logs, source,
messages, secrets and all unknown fields. The D1 table repeats the exact V1 dimension
constraints as defence in depth.

`V1_USAGE_RECORD_CONTRACT` is the production binding and contains only that one approved
combination. Tests and future centrally reviewed code may inject an allowlist through
`createUsageRecordContract`; construction validates, copies and freezes complete tuples so
mixed combinations and later mutation cannot widen it. Extending reporting dimensions
requires a reviewed central code or immutable configuration change, a matching migration
and tests. The Worker has no request field, endpoint or caller input that can extend the
allowlist.

The `Idempotency-Key` request header is protocol metadata. D1 stores only its SHA-256 hash
and a hash of the canonical validated payload. Exact replays succeed, while reuse with a
different payload returns a conflict. Hash-only replay markers remain after detailed
records expire, so an old replay cannot recreate deleted detail.

### Access authentication

Cloudflare Access must protect the Worker hostname. The Worker also validates the
`Cf-Access-Jwt-Assertion` itself before routing. It permits only RS256 application tokens,
fetches the issuer's JWKS, verifies the signature with Web Crypto, and checks the exact
issuer, audience, issue time, optional not-before time and expiry. Missing, malformed,
expired, unsigned, wrongly addressed or unverifiable assertions fail closed.
The Access application policy must admit only the owner and the dedicated controller service
token, so organisation-wide reports remain private to the owner and the reporting path.

`ACCESS_ISSUER` and `ACCESS_AUDIENCE` are non-secret Worker runtime configuration. The
controller's Cloudflare Access service-token client ID and secret stay in Doppler under
`SWITCHYARD_REPORTING_ACCESS_CLIENT_ID` and
`SWITCHYARD_REPORTING_ACCESS_CLIENT_SECRET`. The controller reads them only at runtime and
passes them to `createReportingHttpSink`; no value belongs in source, Wrangler variables,
`.dev.vars`, logs or private working notes. That HTTP path owns the complete best-effort operation.
It permits at most three attempts, gives each attempt a fresh `AbortSignal` and a two-second
deadline, and caps the whole operation at five seconds. The caller may supply an earlier
external abort. Completion races the deadline rather than trusting `fetch` to honour abort,
so an ignored abort or never-resolving request cannot retain the controller path. Timeout,
external abort, conflict, invalid input and exhausted retries return a deterministic
`discard-and-alert` telemetry outcome; they do not throw into lifecycle work. Late fetch
settlement remains observed so it cannot create an unhandled rejection. No telemetry result
can change an allocation, provider, fallback, readiness, cleanup or controller-health
result.

No Access application, service token or Doppler value was created in this phase.

### EU database and migrations

The schema is checked in at `apps/reporting-worker/migrations/0001_reporting.sql`. A future
authorised OpenTofu phase must create the database with Cloudflare's immutable `eu`
jurisdiction setting before the controlled delivery path applies the migration. The
reviewed plan must show that jurisdiction and the new database before approval. The
all-zero database ID in `wrangler.jsonc` is a deliberately unusable packaging placeholder,
so this branch cannot target a live D1 database. Do not create the database through the
dashboard or an ad hoc Wrangler command.

Local tests apply the same migration to an in-memory SQLite fake and exercise the D1
prepared-statement contract without Cloudflare login or credentials.

### Retention and scheduled output

The `15 2 * * *` UTC schedule finds only complete UTC days whose detail is beyond the
365-day boundary. For each day, one D1 batch transaction creates exact grouped summaries,
marks replay hashes as detail-retired and deletes the detailed rows. A failed statement
rolls the whole day back. A rerun finds no deleted detail and cannot overwrite an existing
summary with zero. A delayed record for an already summarised day is added exactly once by
its own idempotent retention transaction. Daily summaries are retained; monthly values are
derived from daily values.

The `0 8 * * MON` UTC schedule builds the fixed 7-day weekly payload, including usage,
estimated cost, slow jobs, fallbacks and cleanup problems. `WEEKLY_REPORT_SINK` is an
optional code-level sink for the later authorised delivery integration. This phase creates
no queue, GitHub credential, workflow or Cloudflare infrastructure.

### Private CLI

The CLI accepts only `--days 7`, `--days 30` or `--days 365`, with `--format markdown` or
`--format json`. It uses the same Access service credential from the runtime environment.

1. Run `npm run build`. This compiles the shared contract and CLI, and should finish with no
   TypeScript errors.
2. Run `doppler run -- npm run report --workspace @switchyard/reporting-worker -- --days 7 --format markdown`.
   This queries the protected fixed report without placing credentials on the command line,
   and should print GitHub workflow-summary Markdown.
3. In the future authorised Monday workflow, append that stdout to
   `$GITHUB_STEP_SUMMARY`. The resulting private workflow run summary is the owner-facing
   weekly report.

The CLI does not accept SQL, a table, a custom date range or credentials as command-line
arguments.

## Authoritative ledger

`AllocationControlLedger` is the small post-trust provider-neutral contract. Allocation acceptance stores
the exact four-field identity, immutable verified request/trust evidence and lifecycle
Check Run coordination without selecting or reserving a provider. Its in-memory implementation
is exported from `@switchyard/core/testing`; it follows the same ordered-attempt limits,
optimistic concurrency, exact-retry and settlement rules as the Azure adapter. The production
adapter uses `@azure/data-tables` with an explicit `ManagedIdentityCredential`. A hosted
Function App therefore selects its system-assigned identity, or the configured
user-assigned identity when `managedIdentityClientId` is supplied, without relying on
the broader development credential chain. Runtime construction also requires the
externally configured immutable ledger instance ID and schema version. It has no
connection-string, SAS or account-key path, does not create the table, and still accepts
a table-client port so all tests remain cloud-free.

`AllocationControlLedger`, `AzureTableAllocationLedger` and the in-memory runtime fake expose no
initialisation operation. Every runtime operation reads and strictly validates the
configured ledger registry, both provider controls and reconciler heartbeat foundation
before it reads or changes an
allocation. A missing, deleted or mismatched foundation row is corrupt authoritative
state and fails closed, including an otherwise exact allocation retry.

One-time creation is deliberately isolated in the installable
`@switchyard/azure-ledger-bootstrap` provisioning package. Its production factory
requires an explicitly supplied Entra `TokenCredential`; it never selects the
controller's runtime credential. Before writing,
it scans the complete target table, not only the control partition, and requires it to be
empty. It then creates the registry, both controls and empty reconciler heartbeat in one
same-partition entity-group transaction. A call that initially observes any row fails even when the four surviving
rows look like a matching foundation. Only a call that first proved emptiness may recover
an identical racing commit or lost transaction response. Different instance/schema
evidence, a partial foundation, or any surviving allocation, generation, history or
unknown row fails closed.

Azure Tables has no transaction that can assert that an entire table is empty, and it
cannot transact across partitions. The pre-scan is therefore a point-in-time proof, not a
cross-partition lock. Bootstrap re-scans after its transaction and accepts only the exact
four foundation rows, but provisioning must also guarantee exclusive access to the new
table for the duration. Any concurrent foreign write makes bootstrap fail closed; it does
not create a cross-partition atomicity claim.

Provisioning must run under a separate identity granted the table entity DataActions
needed to scan and insert:
`Microsoft.Storage/storageAccounts/tableServices/tables/entities/read`,
`Microsoft.Storage/storageAccounts/tableServices/tables/entities/add/action`. The
bootstrap identity and package must not be available to controller recovery code. The
controller identity instead has the read, add and update entity actions needed by ordinary
ledger transactions, and no entity-delete action. Azure Table RBAC has no row-key-level
permission, so a TypeScript capability type is not a security boundary. The enforced
deployment boundary is the separately packaged artefact plus the distinct managed identity
and table-scoped role assignment; package-content gates keep that artefact out of the runtime
package. The runtime-app boundary independently rejects the bootstrap package in all four
npm dependency sections, any static, dynamic or CommonJS source reference below `apps/`,
and bootstrap markers in compiled or bundled app artefacts. Its adversarial fixtures include
an undeclared workspace-hoisted import, so a missing manifest declaration is not a bypass.
Runtime recovery never recreates a foundation row. Replacing a ledger means an explicitly approved
provisioning event that destructively replaces the complete table, supplies a new immutable
ledger instance ID, and first accounts for all live allocations through the independent
tag-based recovery process. Deleting rows and calling bootstrap is not recovery.

### Azure Table schema

All control entities use the single partition key `control-v10` in one table. The
fixed partition is deliberate: Azure Table entity-group transactions are atomic
only within one table and one partition. The pilot admits at most six
final-provider jobs, so an enforceable reservation invariant is more important
than horizontal partition scale.

| Row key | Purpose | Important properties |
| --- | --- | --- |
| `bootstrap!ledger` | Immutable ledger instance registry | Externally configured ledger instance ID, schema version, partition evidence, initialisation timestamp and initial UTC day |
| `allocation!<allocation_id>` | Provider-neutral logical allocation | Matching immutable instance/schema evidence, exact four-field identity, complete verified request/trust evidence, lifecycle Check Run lease/delivery state, workload binding, final immutable runner assignment, allocation cleanup, stop or stale no-side-effect abandonment evidence and attempt count |
| `attempt!<allocation_id>!<ordinal>` | One ordered provider attempt | Stable ordinal, provider, requested and held cost, admission and classified outcome, provider cleanup, Azure deadlines where applicable, settlement evidence and generation count |
| `generation!<allocation_id>!<attempt_ordinal>!<nn>` | One Azure physical generation | Matching immutable instance/schema evidence, allocation resource group, fixed-order zone and deployment IDs, exact Ddsv6 size, VM identifiers, exact `CompleteBy` operation and correlation, checked bootstrap/NVMe/Docker prerequisites, JIT Run Command launch/deletion evidence, online-idle runner evidence and cleanup |
| `control!<provider>` | Required provider safety control | Matching immutable instance/schema evidence, provider-wide `activeReservations`, current UTC day and that day's held worst-case plus settled final estimated cost |
| `allowance-history!<provider>!<YYYY-MM-DD>` | Rolled-over daily allowance | Matching immutable instance/schema evidence, prior UTC day's conservative accounted cost and rollover timestamp, retained so later settlement still adjusts the admission day safely |
| `branch-evidence!<repository_id>!<run_id>` | Immutable approved branch evidence | Exact approved ref, commit, run attempt and repository/run identity, recorded once and compared on reruns |
| `heartbeat!reconciler` | Durable reconciler freshness evidence | Empty at fresh bootstrap, then the monotonic timestamp and ETag of the latest successful reconciliation cycle |

Every row and every JSON document has the immutable `ledgerInstanceId`,
`schemaVersion: 9` evidence and an entity-type discriminator. Every JSON document
and entity is validated at runtime with exact keys and values, including on
deterministic-key exact retries. Strict JSON parsing rejects duplicate keys at
every nesting level. Validation covers nested enums, canonical UTC timestamps,
revisions/ETags, costs, deadlines, lifecycle and cleanup relationships,
per-generation schedule evidence, and agreement with every duplicated indexed
property. Unknown, missing or inconsistent fields are corrupt authoritative
state, not ordinary provider unavailability. A row arriving late from an
earlier, destructively replaced ledger instance therefore fails closed even when
its allocation ID and request identity otherwise match exactly.

Allocation IDs are a fixed 64-hex-character hash of the canonical, length-delimited
four-field identity. GitHub numeric identity fields are capped at 64 digits, so every
contract-valid allocation and generation row key is far below Azure Tables' 1,024
character limit. The exact unhashed identity remains in the allocation document and is
compared on every deterministic-key hit. A hash collision therefore fails as conflicting
identity reuse rather than returning or mutating another allocation.

### Consistency and atomicity

- Acceptance creates only the provider-neutral allocation. Exact retries compare the
  complete immutable request and verified trust evidence. A lifecycle Check Run lease has
  a bounded owner, expiry, renewable revision and four-attempt delivery record; its numeric
  ID must be durably persisted before provider reservation can start. The ledger lease is
  atomic, but GitHub lookup/create is not. External request timing is bounded and the holder
  renews and fences the lease before persisting a result after the external operation.
- Attempt 1 is Azure. Its reservation transaction updates the allocation, creates the
  attempt and changes Azure's concurrency and current-day allowance. Attempt 2 can only be
  Blacksmith after attempt 1 has a classified unavailable outcome and every held Azure
  reservation and owned resource is safely settled. A capacity refusal is itself a durable,
  non-held, safely settled unavailable attempt. A Blacksmith attempt-2 refusal is the final
  provider outcome and permits only the `all-providers-unavailable` stop. No controller,
  trust, storage or corrupt-state error creates attempt 2. Every attempt keeps a stable
  positive ordinal.
- A non-fallback Azure safety abort is a separate final outcome, never provider
  unavailability. It records one allowlisted redacted fatal classification and
  atomically ends an unassigned allocation and releases counters only after the
  exact runner registration and every Azure generation are settled. This path
  also covers loss after provider success but before the write-once assignment.
  Unknown failures remain open and fail closed until classified and cleaned.
- A successful attempt does not implicitly assign a runner. The
  provider-discriminated assignment is a separate write-once allocation field.
  For Azure, the reconciler sees a repair action containing generation one and
  the exact runner registration ID, rechecks that registration as online and
  idle strictly after both provider success and the generation's original
  readiness check, then persists that fresh assignment proof. Runner
  registration IDs are positive decimal GitHub IDs. An exact replay returns it
  without another reservation; conflicting reuse fails closed.
- UTC rollover archives the old allowance and advances the provider control in the same
  admission transaction. It never resets provider-wide concurrency. Settlement for an
  older admission day updates that history row together with the current concurrency
  control and allocation, all in the same partition.
- V1 accepts exactly generation one. Its first zone try is recorded with the
  allocation resource group and base deployment. Zone 2 or 3 may be appended
  only in fixed order after the prior try has a durable checked no-VM-created
  result. Once any try records a VM, no later zone or generation is permitted.
  V2 replacement needs a new reviewed schema.
- The core naming helper deterministically derives the exact allocation resource
  group, three distinct subscription deployment names, resource-group child
  deployment, VM, JIT deployment and Compute Schedule operation/correlation IDs
  from the immutable allocation ID. Each generation also persists hashes of the
  reviewed base template, bootstrap and SSH key plus its pinned image, subnet and
  dedicated subscription before any billable resource is created. Retries reject
  configuration drift and bind template output to those exact identities.
- A generation cannot become ready until its schedule targets the exact VM with
  deadline type `CompleteBy`, its checked bootstrap/local-NVMe/Docker
  prerequisites are durable, its separate fixed-script JIT Run Command launch
  is confirmed and deletion is complete, and the exact runner registration is
  durably online and idle. Schedule `requested` is the durable deterministic
  submit-or-recover intent, not evidence that Azure accepted it. Its final
  accepted, not-yet-executing observation must be at least as fresh as the
  runner observation and no later than the corresponding durable state update.
  Azure `Executing` and `Succeeded` schedule states are preserved as executed
  evidence but cannot protect a new assignment. Immediately before the
  write-once assignment, the worker repeats the exact online-idle runner check,
  refreshes the accepted schedule after that observation, persists it, and checks
  the independent ten-minute/latest-safe-start cutoff again. The Run Command ID must be the canonical
  `launch-jit-g1` child of that exact VM. Controller faults never become
  fallback.
- Azure unavailable settlement atomically records its classified outcome, settles the
  attempt and releases its counters only after every physical generation and owned cleanup
  item is settled. Final settlement requires terminal evidence, settled allocation cleanup and settled
  cleanup for every Azure generation. One transaction ends the allocation, releases
  concurrency and changes the admission-day allowance from the held worst case to the final
  conservative estimate. The final estimate remains charged to that day, so sequential
  jobs cannot recycle the daily allowance. The pre-settlement revision, final cost and
  settlement timestamp are persisted, so only the exact original settlement request is
  retry-idempotent, including after a lost response.
- Job-terminal evidence contains the positive numeric GitHub job ID and can release a final
  reservation only when workload binding is `bound` to that identical ID. Awaiting or failed
  shared-label correlation can use only whole-run terminal evidence whose repository ID, run
  ID and run attempt exactly match the allocation identity.
- A lost response after a committed transaction is safe. The retry reads the deterministic
  allocation or generation key and returns the existing exact result without changing a
  counter twice. Conflicting reuse and stale non-idempotent updates fail closed.
- Lifecycle, binding, Check Run coordination/delivery, heartbeat, branch and generation evidence updates use ETags.
  They are not claimed to be atomic with GitHub, VM, Compute Schedule or resource-group
  operations. The future controller must persist intent and observed evidence, then let
  reconciliation repair any external partial failure.

The generation-one worker implements the production-disabled provisioning and
general cleanup slice without registering a live runtime. Provider side
effects use a short durable lease atomically fenced by the allocation, attempt and
generation revisions; fatal cleanup cannot race an active lease. It
persists the fixed zone deployment, deterministic CompleteBy submission identity and
one-shot JIT mint intent before their side effects, then observes the exact resource on
re-entry. If a persisted mint intent has lost its one-use payload before launch, the
worker fences and cleans up instead of minting a second runner. Run Command deletion
is mandatory before readiness. An Azure `202` deletion response remains
pending; only synchronous deletion or a later exact-resource `404` proves
absence, and retry polls never repeat the delete mutation. The mint intent also
persists the exact resource-group JIT deployment ID. Cleanup has two independent
proof chains. The provider chain fences compute, settles every exact deployment,
requests resource-group deletion and confirms absence. The GitHub chain fences
the exact expected registration and proves
label-wide absence. Each chain uses canonical, future-bounded timestamps monotonic
from its latest durable generation update; there is deliberately no false ordering
claim between the two external systems. Stale or impossible evidence keeps that
branch open while valid proof from the other branch remains durable.
Assignment uses a second, strictly newer exact online-and-idle runner
observation followed by a schedule check at least as fresh as that observation.
If the first delivery arrives after the cutoff and authoritative state still has no
generation row, the worker knows no provisioning side effect was permitted. It still
uses the same deterministic identities and ordered defensive absence proofs before
releasing the reservation, so an ambiguous provider response can never be inferred
from silence.

Only all-three-zone absence evidence, the independent ten-minute readiness cutoff
and the typed management-plane provisioning result become provider unavailability
in this package. Every no-VM result includes durable residual-resource settlement.
Wrong schedule or template identity, schedule
rejection, JIT failure, ambiguous registration, and runner loss after provider
success record an explicit fatal abort intent. They release neither concurrency nor
allowance until runner fencing and complete resource-group absence are durable.
Unknown failures remain open for reconciliation, while partial cleanup is alerted and
retried; an already absent runner or resource group is success.

The `@switchyard/reconciler` package enumerates all allocation rows through a bounded
20-page, 50-row scan. Storage adapters validate every encountered schema and ledger
instance before filtering out only ended allocations whose lifecycle Check Run is
conclusively delivered. A repeated token, duplicate allocation, oversized page,
storage error, corrupt row or the 1,000-row pilot ceiling suppresses the successful
heartbeat, while already obtained allocations are still repaired independently.
One allocation failure does not starve later rows. The cycle finishes every safety
repair and records the successful heartbeat before it attempts Check Run delivery.
Best-effort delivery receives both a per-call and whole-phase cancellation deadline;
a port that ignores cancellation is detached after that deadline and its later
rejection is observed. Visibility failure is counted separately and cannot delay a
later Azure deletion, the heartbeat, or cycle completion.

GitHub job observation is independently bounded to 20 pages and 1,000 jobs for the
exact repository, run and attempt. The remote API display name, expected runner label
and positive numeric job ID perform correlation; the immutable workflow verifier,
not a claimed jobs-API field, remains the source of the approved job key. Duplicate
IDs, ambiguous names or multiple label consumers fail closed and become durable
binding incidents. A terminal result outside the supported success, cancellation and
timeout vocabulary is conservatively recorded as failed so cleanup still proceeds.

Accepted work with no provider side effect may be durably abandoned after 15 minutes,
with explicit `allocation-never-returned` evidence. A held Blacksmith reservation is
never abandoned: a lost response is repaired into the already-authorised managed
assignment, even when that label was never delivered to the caller. A terminal
workflow, or a cutoff that cannot be verified because GitHub observation failed,
records a non-fallback fatal abort before the worker may create a VM. A healthy active
workflow at the Azure readiness cutoff instead drives the worker's ordinary
`readiness-timeout` cleanup and provider-unavailable settlement, preserving the
approved Blacksmith fallback after Azure cleanup. Expiry starts cleanup but cannot
end either final provider without exact job or whole-run terminal evidence.

Every Azure worker result is runtime-validated at the reconciler seam, including its
exact allocation ID, outcome fields, stage or classification and unique runner label.
Malformed output, an incident or an unexpected stage suppresses the successful
heartbeat, even when the worker already persisted useful cleanup. Once cleanup is
due, one timer invocation drives a bounded sequence of durable worker stages until it
reaches external pending work, complete cleanup, an incident or the progress ceiling.
Repeated stages are rejected as no progress. This lets expiry equality request
deletion in that same cycle rather than waiting for the next minute.

The one-minute cadence is a repair mechanism, not exact latest-safe-start enforcement.
After each GitHub or Azure observation it reads a fresh clock before making cutoff,
expiry or mutation decisions; the final heartbeat uses a separate post-scan reading.
At equality the reconciler cleans a job that lacks canonical `startedAt` evidence no
later than the cutoff, and it begins overdue cleanup at absolute-expiry equality. A
bounded two-pass final deadline sweep re-reads every processed candidate before that
heartbeat. It repairs a deadline that crossed while later rows were running and
suppresses the heartbeat if crossings remain unstable after the bound. A
reviewed exact-cutoff watchdog remains a production activation blocker.

`apps/control-function` is the production-disabled Azure Functions composition.
Its safety runtime starts from schema-10 ledger, queue, Azure worker and reconciler
configuration without parsing admission-only GitHub, Doppler or proof settings. Its
admission runtime is lazy and returns 503 when those settings or dependencies are
unavailable; the timer and Azure cleanup remain available. The app registers one
anonymous HTTP route behind mandatory Easy Auth, one raw provisioning queue, its
poison handler and a monitored one-minute timer. Queue progress is re-enqueued after
five seconds only after the durable worker result. Poison handling never replays work.

The live GitHub adapter pages jobs and runner registrations through locally generated
bounded cursors. Runner cleanup deletes every registration carrying the allocation's
unique label and requires two complete absence scans separated by a bounded
cancellable wait. Any registration seen between scans resets that proof. Every
runner response must contain exactly one well-formed Switchyard allocation
label; reviewed GitHub defaults are allowed, but duplicate, malformed or
competing Switchyard labels fail closed. The lazy safety gateway can reconstruct
these reduced GitHub capabilities from a timer or queue call after restart
without an allocation HTTP request, and it never caches the App private key. The
live Azure adapter uses one
explicit managed identity, bounded raw ARM calls and no automatic retry for Schedule
submission or JIT minting. It re-derives the exact dedicated subscription, allocation
group, generation and immutable tags from authoritative state before every read or
mutation. Compute Schedule persists separate request-correlation and Azure-generated
operation identifiers; an unconfirmed submission is never repeated and instead drives
fatal cleanup.

The Function bundle contains the exact generated ARM templates and the pinned,
hash-verified non-secret runner bootstrap. The bootstrap prepares the Ddsv6 local NVMe,
Docker and runner workspace, runs one update-disabled runner as an unprivileged account
and writes only a root-owned readiness marker. The bundle remains deployment-disabled
until its digest, plan and two-dispatch infrastructure approval are reviewed.

The immutable registry, both provider controls and empty heartbeat share this partition and are created
together by the provisioning-only bootstrap transaction. Normal ledger operations require
all four rows to agree with their configured instance and schema evidence. Deleting either
provider control, both provider controls, the heartbeat or the registry therefore fails closed and the
runtime has no API that can reset them. Complete deletion of the whole table is
indistinguishable from a genuinely new table only to the separately authorised provisioning
capability, which is why complete destructive table replacement is an explicit provisioning
event rather than runtime recovery.

Azure Tables cannot transact across partitions or tables, and this design does not claim
otherwise. The single control partition is therefore a conscious V1 throughput limit.
The largest transition uses four entities, below Azure Tables' 100-operation and
less-than-4-MiB entity-group limits. Azure's published target for one partition is up to
2,000 1-KiB entities per second, and each entity touched by a batch counts towards that
target. Switchyard deliberately accepts that hot-partition ceiling for a pilot with at
most six final-provider jobs. Moving counters or allocations into different partitions
would require a different reservation protocol and must not be done as a scaling tweak.
Treat sustained throttling, timeouts or growth towards those limits as a reason to stop
admission and redesign the protocol, not as permission to weaken atomicity. See
[Azure Table Storage scalability targets](https://learn.microsoft.com/en-us/azure/storage/tables/scalability-targets).
