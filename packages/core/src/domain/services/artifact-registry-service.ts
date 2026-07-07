import { join, resolve } from "node:path";
import { ArtifactSchema, ArtifactTypeSchema, type Artifact } from "../schemas/artifact";
import {
  assertSafeRecordSegment,
  assertSafeRelativeRecordPath,
  readJsonRecord,
  workspaceRecordPath,
  writeJsonRecord
} from "./workspace-record-store";

export interface ArtifactRegistryServiceOptions {
  workspaceRoot: string;
}

export interface ArtifactRegistryService {
  registerArtifact: (artifact: Artifact) => Promise<Artifact>;
  getArtifact: (artifactId: string) => Promise<Artifact | undefined>;
}

export function createArtifactRegistryService(
  options: ArtifactRegistryServiceOptions
): ArtifactRegistryService {
  const workspaceRoot = resolve(options.workspaceRoot);

  return {
    async registerArtifact(artifact: Artifact): Promise<Artifact> {
      const parsedArtifact = ArtifactSchema.safeParse(artifact);
      if (parsedArtifact.success) {
        assertSafeRecordSegment(parsedArtifact.data.artifact_id, "artifact.artifact_id");
        assertSafeRelativeRecordPath(parsedArtifact.data.path, "artifact.path");
        ArtifactTypeSchema.parse(parsedArtifact.data.type);
      }

      return await writeJsonRecord(
        workspaceRoot,
        artifactManifestDirectorySegments(),
        parsedArtifact.success
          ? artifactManifestFileName(parsedArtifact.data.artifact_id)
          : "invalid.json",
        artifact,
        parsedArtifact.success
          ? artifactManifestEvidenceRef(parsedArtifact.data.artifact_id)
          : "workspace/artifacts/manifests",
        ArtifactSchema
      );
    },

    async getArtifact(artifactId: string): Promise<Artifact | undefined> {
      assertSafeRecordSegment(artifactId, "artifact.artifact_id");
      const recordPath = workspaceRecordPath(
        workspaceRoot,
        [...artifactManifestDirectorySegments(), artifactManifestFileName(artifactId)],
        artifactManifestEvidenceRef(artifactId)
      );

      return await readJsonRecord(recordPath, artifactManifestEvidenceRef(artifactId), ArtifactSchema);
    }
  };
}

export function artifactManifestDirectorySegments(): readonly string[] {
  return ["artifacts", "manifests"];
}

export function artifactManifestFileName(artifactId: string): string {
  assertSafeRecordSegment(artifactId, "artifact.artifact_id");
  return `${artifactId}.json`;
}

export function artifactManifestEvidenceRef(artifactId: string): string {
  return join("workspace", "artifacts", "manifests", artifactManifestFileName(artifactId));
}
