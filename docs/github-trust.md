# GitHub trust and Check Run adapter

This phase provides GitHub trust verification and lifecycle reporting plus portable
controller contracts. It does not register an API runtime, call Doppler, provision
infrastructure, change Workload, or make a live GitHub request during tests.

## Trust verification

The request contributes only the allocation identity:
`{repository_id, run_id, run_attempt, allocator_check_run_id}`. None of its values
are accepted as proof. The adapter obtains a reduced Workload installation token and
fetches the following evidence independently from GitHub:

1. The private repository and its exact numeric repository ID.
2. The exact run attempt, event, branch name, workflow path, immutable head SHA,
   original actor, triggering actor, repository, head repository, head commit,
   check suite and empty pull request association.
3. On the initial attempt, the exact Git ref `refs/heads/main`, whose commit
   target must equal the run SHA. This approved branch evidence is recorded
   atomically in authoritative durable state only after all trust checks pass.
4. The attempt-specific job list and exact allocator Actions Check Run. The
   numeric Check Run ID is strictly parsed from `check_run_url`; the separate
   numeric Actions job ID, Check Run name, run ID, immutable SHA and suite must
   agree and are retained separately.
5. The commit at the immutable run SHA.
6. The caller workflow bytes from the Contents API with that full SHA as `ref`.

Both actor IDs must equal `900000001` for every attempt. A rerun has a new
allocation identity and repeats the complete attempt-level verification. It must
load matching approved branch evidence for the same repository, run, exact ref and
SHA. It does not require the now-moving `main` ref still to point to that SHA, but
it does reverify the rerun's triggering actor. Missing, malformed or conflicting
evidence fails closed. The branch ref is never inferred from `head_branch` or the
workflow path. Two approved allocator jobs in one run are selected by their
distinct Actions Check Run IDs and centrally approved Check Run names.

The workflow parser uses YAML's core schema, rejects aliases, duplicate keys,
unknown top-level and security-relevant job fields, malformed UTF-8 and incomplete
shapes. It requires the approved caller gate dependency, a reusable Switchyard
workflow reference at a full lowercase commit SHA, the literal capability profile,
the allocator job's exact `id-token: write` permission and no other permission,
the exact future job and `runner_label` dependency, and the literal centrally
approved `timeout-minutes`. The mapped workload may not use `strategy` or a matrix.
All job display names must be literal when supplied. The mapped workload display
name, allocator display name and allocator Check Run identity must each remain
unambiguous across the complete workflow. Every job and property is scanned for
allocator dependencies and output references, including compact property notation
and bracket or index notation. Exactly one mapped consumer is permitted; every
other possible consumer fails closed.

The production Workload entry is checked in as disabled. It records the known
workload display name `Example approved build` and no allocator
block. The exact allocator job and Actions Check Run names and the full commit SHA
of an approved reusable Switchyard workflow remain unknown. Organisation access to
the private allocation action is currently `none`. Until the disabled mapping is
replaced through the reviewed activation sequence, verification stops before any
GitHub request or authoritative branch-evidence ledger read.

Activation follows this order:

1. Merge this disabled hardening phase. Its SHA is preliminary and
   non-activatable because the current `vars` remain non-production scaffolding.
2. Obtain and independently review the real immutable non-secret configuration.
3. Commit and merge that configuration into the reusable workflow as literal or
   digest-bound values.
4. Only after that merge, record the final post-configuration reusable-workflow
   SHA. A separate Workload change may then pin the approved gate and allocator to
   that exact SHA with exactly `id-token: write`; the mapping remains disabled.
5. Review and enable private Actions access and GitHub-hosted billing, capture live
   redacted proof evidence against the final SHA, and record the exact allocator
   job and Actions Check Run names while the mapping remains disabled.
6. Only after every remaining safety blocker is reviewed may a separate authorised
   change enable the mapping.

The application-facing approved-branch store is a distinct capability from the
post-trust allocation-control ledger, although the Azure class implements both.
This keeps immutable trust and branch persistence ahead of any allocation or
counter access. The authoritative ledger durably stores approved branch evidence
and lifecycle Check Run creation state. Check Run creation uses a bounded
owner/expiry lease with a monotonically increasing lease revision, persists
bounded retry evidence, and records the numeric Check Run ID before any provider
reservation. The in-memory and Azure Table implementations share the same
fail-closed contract.

## Installation token isolation

One injected credential provider supplies the GitHub App private key in memory for
JWT signing. The adapter does not persist it, include it in errors or logs, or call
Doppler. Each high-level operation mints a fresh reduced installation token.

| Purpose | Repository restriction | Requested permissions |
| --- | --- | --- |
| Workload trust/checks | Workload only | Actions read, Contents read, Checks write |
| V2 incident issue | Disabled in V1 | Issues write |
| JIT registration | Organisation only | Self-hosted runners write |

The adapter requests no Administration permission and does not cache a broad token
between these purposes. GitHub response bodies, tokens, workflow bytes and private
keys are excluded from returned error data.

## Switchyard Check Run lifecycle

The lifecycle record is created on the immutable workload SHA when the controller
accepts an allocation. Its numeric ID becomes persisted state. Reconciliation may
publish monotonic updates through provider selection, readiness, workload execution
and cleanup. Only the `ended` stage, which requires settled cleanup, may conclude
the Check Run. The ledger validates those transitions authoritatively before a
transaction: published revisions and stages cannot decrease, a revision may be
reused only for an identical lifecycle, and a concluded Check Run cannot reopen.
Retry evidence follows its own bounded attempt and alert transitions without
weakening the lifecycle rules.

The final output contains provider, duration, estimated cost, fallback and cleanup
result. It makes no post-job summary promise. API failures become redacted retry
records with bounded backoff and an alert flag. They leave the lifecycle and safety
state unchanged, so reporting can never delay cleanup.

Every list/create sequence runs inside a required authoritative creation
coordinator. The ledger atomically leases one repository, SHA and allocation
identity, but the separate GitHub lookup and create requests are not atomic. Each
coordinator invocation has a distinct opaque lease token, while one acquisition
request keeps that token when recovering a lost ledger response. Each GitHub
request and the complete external operation are time-bounded. Lease contention
has a configurable two-second coordination deadline and returns a typed deferred
result rather than waiting through 512 quarter-second polls. The holder renews
and revision-fences its lease after lookup/create and before persisting the
numeric ID. A timed-out operation leaves its lease held for later lookup recovery,
and a stale holder cannot persist after takeover. Local token reuse protection is
expiry-aware and size-bounded: every active or still-recoverable lease remains
fenced, expired recoverable entries are reclaimed, and reaching the bound fails
closed. There is no in-memory production default.
Retries search the immutable commit for the same app, Check Run name and allocation
external ID. One match is adopted, no match creates, and multiple matches fail closed
as an idempotency ambiguity.

The injected controller clock enforces every retry record's `notBefore` before a
GitHub App token is minted, the creation coordinator is entered or any GitHub API
request is made.

## Pinned GitHub surface

The fetch wrappers send GitHub REST API version `2026-03-10`. The implemented
surface follows GitHub's documentation for
[workflow run attempts](https://docs.github.com/en/rest/actions/workflow-runs),
[attempt-specific jobs](https://docs.github.com/en/rest/actions/workflow-jobs),
[Git references](https://docs.github.com/en/rest/git/refs),
[repository contents](https://docs.github.com/en/rest/repos/contents),
[Check Runs](https://docs.github.com/en/rest/checks/runs), and
[installation access tokens](https://docs.github.com/en/rest/apps/apps).
