# Infrastructure approval foundation rollback

This runbook is for the separately deployed Azure state and approval-control
foundation. It is not an OpenTofu rollback and it does not authorise either
disabled infrastructure dispatcher.

The completed resource group has a `CanNotDelete` lock, the state account has
30-day blob and container soft delete plus versioning, and plan receipts have a
locked one-day immutability policy. ARM first creates the exact policy without a
writable state field. The owner wrapper must then read its ETag, invoke Azure's
Lock Immutability Policy operation and prove the reread state is Locked. A locked
immutability policy cannot be shortened or removed. Do not try to work around
those controls.

## Before the first deployment

1. Confirm `swexampleapprovalstate` and `swexampleapprovalreceipt` are still globally
   available using a live read-only check. Local validation is not availability
   evidence.
2. Review the exact generated `main.json` digest and the final reusable-engine
   commit. The disabled `49be281` engine is rejected by both the template and
   wrapper.
3. Run the wrapper in `validate`, then `what-if`, mode against subscription
   `a0000000-0000-4000-8000-000000000001`. Do not use `create` until those live
   results and all three Entra federated identity contracts have been reviewed.
   Use Azure CLI 2.89.1, the version pinned by these scripts.

## Failed or partial deployment

A successful ARM deployment followed by a failed policy read, lock or final
Locked-state verification is a partial deployment. The wrapper exits nonzero and
prints this classification. Treat the resources as present even when the ARM
operation itself says `Succeeded`. Re-running `create` is safe only when review
shows the existing policy already matches the exact one-day Locked contract, or
is still the exact one-day Unlocked policy whose current ETag can be supplied to
the lock operation. Any other state requires recovery, not an idempotence
workaround.

1. Stop. Do not run OpenTofu, initialise state, change GitHub OIDC settings or
   rerun `create` while the deployment result is failed, partial or unknown.
2. Save the deployment operation IDs and redacted status only. Do not copy
   tokens or request bodies into an issue or private working notes.
3. Inventory the exact resource group, its lock, both accounts, three identities,
   role definitions, role assignments, federated credentials and the receipt
   immutability policy including its current state and ETag from Azure.
4. If no state, apply-control or receipt blob exists, the owner may remove the
   assignments and federated credentials, remove the resource-group lock, then
   delete the empty foundation resources after reviewing a fresh Azure what-if.
5. If any blob exists, preserve the resource group and lock. Restore or reconcile
   only from Azure version, soft-delete and immutability evidence. Never replace
   lineage, lower serial, copy state from another backend or overwrite the
   initial-state record.
6. Current-name absence is not state-history absence. Before bootstrap, enumerate
   the exact decoded state and initial-record names including versions, deleted
   versions, snapshots and uncommitted blobs, following every bounded page. A
   retained match, pre-existing state blob, nonzero serial, any managed resource,
   SHA-256/ETag mismatch or retained initial-state record is a fail-closed
   incident. The bootstrap adapter will not repair it. Resolve ownership and
   state history before proposing a new reviewed foundation deployment.

## Temporary initial-control authority

The foundation defines the create-only initial-control custom role but deliberately
does not assign it. The existing limited foundation approval does not authorise a
grant. Grant is permitted only immediately before a separately reviewed and
approved create-only initial plan apply whose plan and control-template digests
are known.

1. With Azure CLI 2.89.1 already signed in to the exact reviewed tenant and
   subscription, run `manage-bootstrap-authority.sh grant` with the two lowercase
   64-hex digests and the complete acknowledgement printed by the wrapper. The
   wrapper performs no login and accepts no caller-selected principal or role.
2. Run only the separately approved initial saved-plan apply. Do not reuse the
   grant for a new plan, changed template, retry with new evidence or routine
   foundation maintenance.
3. After every success, failure, cancellation, timeout or unknown apply result,
   run `manage-bootstrap-authority.sh revoke` with the same two digests. Revoke
   targets only their deterministic assignment and is safe to repeat.
4. Run `manage-bootstrap-authority.sh verify-absent` with the same digests and
   require proved absence before closing the operation. A missing, changed or
   ambiguous assignment is an incident, not permission to delete another role
   assignment.
5. For a partial control-foundation apply, leave all created resources and state
   untouched until the exact saved-plan result and OpenTofu state are reconciled.
   Remove lingering temporary authority first using the digest-bound revoke path.
   Never use a new grant, destroy plan or manual resource deletion as an
   idempotence workaround.
