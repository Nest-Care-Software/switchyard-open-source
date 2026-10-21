# Infrastructure application requires two owner dispatches

GitHub Free cannot pause a private-repository job behind a protected-environment
approval immediately before apply, so Switchyard uses one owner dispatch to
create an immutable plan bundle and a separate fresh owner dispatch to approve
that exact saved plan after its derived views and publication chronology are
verified. Both dispatches bind one raw GitHub OIDC token to pinned reusable
workflow code and the same Entra exchange. Planning is state-read-only and uses
an unlocked plan bounded by matching state SHA-256 and ETag observations. Apply
verifies GitHub evidence and the saved plan before exchanging its token; only
the selected applier session may create or read the private receipt and access
state, lease or intent storage. Apply also requires unchanged `main`,
exact state, a separate apply lease and an atomic non-replayable intent.
