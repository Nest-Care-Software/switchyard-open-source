# An authenticated public HTTPS service controls allocations

Switchyard uses one identity-protected Azure Function App for its allocation
API, provisioning worker, and one-minute reconciler. The API is an
internet-routable public HTTPS endpoint, not a network-private endpoint or a
public product. A pinned reusable workflow exchanges GitHub OIDC as a federated
client assertion for an Entra token addressed to the API and receives no Azure
subscription role. Azure Table Storage remains authoritative, and an API or
ledger outage stops every new allocation rather than bypassing control through
Blacksmith.
