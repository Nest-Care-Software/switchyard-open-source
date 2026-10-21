# One organisation per deployment

Each deployment serves one GitHub organisation and has one designated owner.
Customer accounts, billing, multi-tenancy and an unauthenticated control plane
are outside V1. The allocation API uses authenticated public HTTPS so approved
GitHub-hosted workflows can reach it. Publishing the source does not grant
access to any deployment.
