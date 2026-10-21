# OpenTofu defines long-lived cloud infrastructure

Switchyard uses OpenTofu rather than an Azure-only infrastructure language to
define long-lived Azure control resources and the dormant Cloudflare reporting
module. V1 applies only its Azure foundation. Runtime allocation resource groups
and VMs have a different lifecycle, so the controller creates them from an exact
checked-in, validated subscription-scope ARM template rather than adding and
removing them from OpenTofu state. Provider details stay outside the reusable
workflow contract.

Real applies require the separate plan-review and apply-approval dispatches
recorded in ADR 0011. The owner-dispatch gate used for workloads is not
sufficient infrastructure approval.
