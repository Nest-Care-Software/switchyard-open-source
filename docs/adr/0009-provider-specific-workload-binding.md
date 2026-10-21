# Workload binding is provider-specific

Allocation identity is
`{repository_id, run_id, run_attempt, allocator_check_run_id}`, so exact retries
reuse one allocation while reruns and multiple allocator jobs remain distinct.
Every provider first requires an immutable approved job mapping and literal
timeout. Azure binds with a unique JIT label and accepts work only before its
calculated latest safe start. Blacksmith authorises the mapping, timeout,
profile, and shared label before return, then correlates the expected numeric
GitHub job after return. Missing, different, or ambiguous correlation fails
visibly while reservations remain conservative; it never selects another runner
or reruns.
