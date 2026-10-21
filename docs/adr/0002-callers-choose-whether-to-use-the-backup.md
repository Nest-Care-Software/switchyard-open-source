# Calling projects choose whether to use the backup

The reusable workflow offers a provider-neutral backup choice: `Keep going`
uses Blacksmith when lower-cost cloud capacity is unavailable, while `Save
money` stops instead. Only a healthy Switchyard controller may make that choice,
and only after classifying Azure capacity or provisioning as unavailable. Loss
of the Switchyard API, authoritative ledger, trust verification, Doppler, or
reconciliation fails closed; the workflow never bypasses the controller to
select a shared Blacksmith label.

Blacksmith is bounded by three jobs and an estimated $5 UTC-daily admission
allowance. Each approved mapping has a literal GitHub-enforced timeout, and the
controller reserves the public list-price worst case for that complete timeout.
Switchyard authorises the immutable mapping before returning the shared label,
then correlates the expected numeric GitHub job. A missing or ambiguous job is
an incident, not permission to choose another runner or rerun. Switchyard does
not manage Blacksmith's machine. Once either final-provider ceiling is reached,
both choices stop.
