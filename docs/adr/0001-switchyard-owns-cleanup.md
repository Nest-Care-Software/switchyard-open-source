# Switchyard owns allocation cleanup

Switchyard remains responsible until the workload is terminal and its owned
runner registrations, Azure resources, and reservations are settled. Callers do
not run cleanup. Blacksmith owns its machines, while Switchyard owns the job
binding and controller reservations around their use.

Azure safety has independent layers. Compute Schedule must accept a
`CompleteBy` operation at minute 40 for V1's fixed 45-minute allocation. The
single V1 physical generation has one persisted Switchyard request correlation
ID and, after Azure confirms submission, one separately persisted provider
operation ID targeting its exact VM at the allocation's original absolute
deadline. Switchyard never resubmits when the first response is lost because
Azure does not provide a recovery guarantee for that correlation ID. Such a
generation is fenced and cleaned up, and no generation can become ready without
an accepted operation. If that runner disappears, Switchyard cleans it up and
reports failure rather than replacing it or rerunning the caller.

The reconciler targets complete deletion at minute 45 and keeps retrying
afterwards. This bounds VM compute independently; asynchronous deletion of
disks, IPs, or other residual resources is retried and alerted, never guaranteed
or described as a hard post-target cost bound. Reservations remain held until
cleanup settles, and a tag-based recovery path works without the ledger.
