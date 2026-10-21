# Azure may hold one Doppler bootstrap token

Switchyard uses Doppler OIDC wherever it is supported, keeping the GitHub App
private key solely in Doppler and handling it only transiently in trusted
controller memory. Doppler documents GitHub OIDC but not the proposed Azure
managed-identity exchange, so that path must be proven live. Only if it fails,
one narrowly scoped Doppler service token may be stored in Azure Key Vault as
an explicit exception to the Doppler-only secret rule; the control Function is
its sole reader, and no project secret is copied into Azure. If Doppler cannot
be reached or verified, all new allocations fail closed, including Blacksmith.
