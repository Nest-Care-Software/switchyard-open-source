# Runtime applications

Runtime entry points live here as separate npm workspaces. `reporting-worker` is the
Access-authenticated Cloudflare Worker for fixed best-effort D1 usage writes, reports and
retention. It is isolated from the allocation control plane and contains no provider SDK,
allocation decision or live infrastructure identifier.
