import {
  type GitHubRunEvidence,
  InfrastructureApprovalError,
  instant,
  PLAN_MAX_AGE_MS,
} from "./contracts.js";

const GITHUB_ARTIFACT_TIMESTAMP_ROUNDING_MS = 1_000;

export interface PublicationTimeEvidence {
  readonly createdAt: string;
  readonly publishedAt: string;
}

export interface ArtifactTimeEvidence extends PublicationTimeEvidence {
  readonly expired: boolean;
  readonly expiresAt: string;
  readonly present: boolean;
}

export function verifyPublicationPair(input: {
  readonly artifact: ArtifactTimeEvidence;
  readonly manifestCreatedAt: string;
  readonly now: Date;
  readonly planRunCreatedAt: string;
}): void {
  const planCreated = instant(input.planRunCreatedAt, "planRun.createdAt").getTime();
  const manifestCreated = instant(input.manifestCreatedAt, "manifest.createdAt").getTime();
  const artifactCreated = instant(input.artifact.createdAt, "artifact.createdAt").getTime();
  const artifactPublished = instant(input.artifact.publishedAt, "artifact.publishedAt").getTime();
  const artifactExpires = instant(input.artifact.expiresAt, "artifact.expiresAt").getTime();
  const expectedArtifactExpires = manifestCreated + PLAN_MAX_AGE_MS;
  const now = input.now.getTime();
  if (
    planCreated > manifestCreated ||
    manifestCreated - artifactCreated > GITHUB_ARTIFACT_TIMESTAMP_ROUNDING_MS ||
    artifactCreated - artifactPublished > GITHUB_ARTIFACT_TIMESTAMP_ROUNDING_MS ||
    artifactExpires < expectedArtifactExpires - GITHUB_ARTIFACT_TIMESTAMP_ROUNDING_MS ||
    artifactExpires > expectedArtifactExpires ||
    [planCreated, manifestCreated, artifactCreated, artifactPublished].some((value) => value > now)
  ) {
    throw new InfrastructureApprovalError("plan-publication-chronology-invalid");
  }
  if (!input.artifact.present || input.artifact.expired || now >= artifactExpires) {
    throw new InfrastructureApprovalError("plan-artifact-absent-or-expired");
  }
}

export function verifyApprovalChronology(input: {
  readonly approvalRun: GitHubRunEvidence;
  readonly artifact: ArtifactTimeEvidence;
  readonly manifestCreatedAt: string;
  readonly now: Date;
  readonly planRun: GitHubRunEvidence;
}): void {
  verifyPublicationPair({
    artifact: input.artifact,
    manifestCreatedAt: input.manifestCreatedAt,
    now: input.now,
    planRunCreatedAt: input.planRun.createdAt,
  });
  if (
    input.planRun.status !== "completed" ||
    input.planRun.conclusion !== "success" ||
    input.planRun.completedAt === null ||
    input.approvalRun.status !== "in_progress" ||
    input.approvalRun.conclusion !== null ||
    input.approvalRun.completedAt !== null
  ) {
    throw new InfrastructureApprovalError("workflow-run-terminal-state-invalid");
  }
  const planCompleted = instant(input.planRun.completedAt, "planRun.completedAt").getTime();
  const approvalCreated = instant(input.approvalRun.createdAt, "approvalRun.createdAt").getTime();
  const artifactPublished = instant(input.artifact.publishedAt, "artifact.publishedAt").getTime();
  if (
    artifactPublished > planCompleted ||
    artifactPublished >= approvalCreated ||
    planCompleted >= approvalCreated ||
    approvalCreated > input.now.getTime()
  ) {
    throw new InfrastructureApprovalError("approval-precedes-plan-publication");
  }
}
