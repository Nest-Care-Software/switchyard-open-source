/**
 * Synthetic redacted fixture matching the reviewed GitHub-hosted reusable-workflow
 * claim shape. Production still requires a separately reviewed live redacted capture.
 */
export const REDACTED_REUSABLE_WORKFLOW_OIDC_PAYLOAD = Object.freeze({
  iss: "https://token.actions.githubusercontent.com",
  aud: "api://switchyard-allocation-proof",
  exp: 1_787_659_500,
  nbf: 1_787_659_195,
  iat: 1_787_659_195,
  jti: "00000000-0000-0000-0000-000000000001",
  sub: "repo:example-org/example-workload:ref:refs/heads/main",
  repository: "example-org/example-workload",
  repository_id: "900000002",
  repository_owner: "example-org",
  repository_owner_id: "12345678",
  run_id: "81001",
  run_number: "701",
  run_attempt: "1",
  check_run_id: "91001",
  actor: "example-owner",
  actor_id: "900000001",
  workflow: "Workload CI",
  event_name: "workflow_dispatch",
  head_ref: "",
  base_ref: "",
  ref: "refs/heads/main",
  ref_protected: "false",
  ref_type: "branch",
  sha: "abcdef0123456789abcdef0123456789abcdef01",
  repository_visibility: "private",
  runner_environment: "github-hosted",
  workflow_ref: "example-org/example-workload/.github/workflows/ci.yml@refs/heads/main",
  workflow_sha: "abcdef0123456789abcdef0123456789abcdef01",
  job_workflow_ref:
    "example-org/switchyard/.github/workflows/allocate-runner.yml@123456789abcdef0123456789abcdef012345678",
  job_workflow_sha: "123456789abcdef0123456789abcdef012345678",
});
