# D1 remains a deferred reporting store only

Switchyard keeps its implemented Cloudflare D1 reporting components dormant in
V1 so the Azure runner pilot is not delayed by a second live cloud integration.
V1 visibility comes from the Switchyard Check Run, redacted Azure lifecycle
logs, and owner alerts. V2 may activate D1 for allocation history, statistics,
estimated costs, and scheduled reports.

When activated, D1 remains a disposable reporting copy outside the control
plane: no unavailable or ambiguous write may block or change allocation,
readiness, provider selection, fallback, expiry, cleanup, or reconciliation.
It uses an EU-jurisdiction database behind an Access-protected Worker with fixed
operations; no caller receives a D1 API token or arbitrary SQL access.
