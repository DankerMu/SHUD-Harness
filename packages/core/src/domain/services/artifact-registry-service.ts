import { join, resolve } from "node:path";
import { ArtifactSchema, ArtifactTypeSchema, type Artifact } from "../schemas/artifact";
import { TaskServiceError } from "./task-card-service";
import {
  assertSafeRecordSegment,
  assertSafeRelativeRecordPath,
  createJsonRecordIfAbsent,
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

        const created = await createJsonRecordIfAbsent(
          workspaceRoot,
          artifactManifestDirectorySegments(),
          artifactManifestFileName(parsedArtifact.data.artifact_id),
          parsedArtifact.data,
          artifactManifestEvidenceRef(parsedArtifact.data.artifact_id),
          ArtifactSchema
        );
        if (created.status === "created") {
          return created.record;
        }

        const existing = await readArtifactManifest(workspaceRoot, parsedArtifact.data.artifact_id);
        if (existing && canonicalJson(existing) === canonicalJson(parsedArtifact.data)) {
          return existing;
        }

        throw artifactManifestImmutableError(parsedArtifact.data.artifact_id);
      }

      return await writeJsonRecord(
        workspaceRoot,
        artifactManifestDirectorySegments(),
        "invalid.json",
        artifact,
        "workspace/artifacts/manifests",
        ArtifactSchema
      );
    },

    async getArtifact(artifactId: string): Promise<Artifact | undefined> {
      assertSafeRecordSegment(artifactId, "artifact.artifact_id");
      const artifact = await readArtifactManifest(workspaceRoot, artifactId);
      if (!artifact) {
        return undefined;
      }
      return artifact;
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

async function readArtifactManifest(
  workspaceRoot: string,
  artifactId: string
): Promise<Artifact | undefined> {
  const recordPath = workspaceRecordPath(
    workspaceRoot,
    [...artifactManifestDirectorySegments(), artifactManifestFileName(artifactId)],
    artifactManifestEvidenceRef(artifactId)
  );
  const artifact = await readJsonRecord(
    recordPath,
    artifactManifestEvidenceRef(artifactId),
    ArtifactSchema
  );
  if (!artifact) {
    return undefined;
  }
  assertArtifactLookupIdentity(artifact, artifactId);
  return artifact;
}

function assertArtifactLookupIdentity(artifact: Artifact, artifactId: string): void {
  if (artifact.artifact_id === artifactId) {
    return;
  }

  throw new TaskServiceError({
    code: "record_malformed",
    status: 500,
    category: "workspace_error",
    message: "Artifact manifest identity does not match its lookup path.",
    userMessage: "The artifact manifest cannot be used safely.",
    evidenceRefs: [artifactManifestEvidenceRef(artifactId), "artifact.artifact_id"],
    retryable: false,
    recommendedNextActions: ["Inspect and repair the artifact manifest before retrying."]
  });
}

function artifactManifestImmutableError(artifactId: string): TaskServiceError {
  return new TaskServiceError({
    code: "record_schema_error",
    status: 400,
    category: "schema_error",
    message: "Artifact manifest already exists with different metadata.",
    userMessage: "An existing artifact manifest cannot be overwritten.",
    evidenceRefs: [artifactManifestEvidenceRef(artifactId), "artifact.artifact_id"],
    retryable: false,
    recommendedNextActions: ["Use the existing artifact manifest or choose a new artifact id."]
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}
