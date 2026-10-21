import type { GitHubJobEvidence, GitHubRunEvidence, RepositoryOidcSettings } from "./contracts.js";

/** Read-only independent GitHub API evidence supplied by one short-lived workflow token. */
export interface InfrastructureGitHubEvidencePort {
  getActivationConfiguration(commitSha: string): Promise<Uint8Array>;
  getCurrentMainSha(): Promise<string>;
  getJob(input: {
    readonly checkRunId: string;
    readonly runId: string;
  }): Promise<GitHubJobEvidence>;
  getOidcSettings(): Promise<RepositoryOidcSettings>;
  getRun(runId: string): Promise<GitHubRunEvidence>;
}
