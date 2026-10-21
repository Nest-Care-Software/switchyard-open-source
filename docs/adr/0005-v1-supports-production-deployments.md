# V1 supports production deployments

Switchyard V1 allocates runners for trusted production deployments as well as
builds and tests. Production approval must complete in an approved caller gate
before allocation. On the current GitHub Free private plan, the V1 approval is
an owner `workflow_dispatch` whose original actor and triggering actor both
equal the owner's numeric ID on every attempt, with the approved main ref, captured
immutable SHA, workflow path, and future job mapping verified independently.
The dispatch approves that SHA; it does not provide branch protection. A future
paid pre-allocation environment or branch control may replace or strengthen the
fallback, but an environment on the workload job remains too late.

Both providers receive only short-lived, least-privilege authority for the exact
job. Switchyard never automatically reruns a production workflow. Allocation
status is published through a Switchyard Check Run because the workload job
cannot write a reliable summary after it has ended and cleanup has settled.
