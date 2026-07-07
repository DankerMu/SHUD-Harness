import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import {
  IdempotencyRecordSchema,
  IdempotencyScopeSchema,
  type IdempotencyRecord,
  type IdempotencyScope
} from "../schemas/idempotency";
import { TaskServiceError } from "./task-card-service";
import {
  readJsonRecord,
  workspaceRecordPath,
  writeJsonRecord
} from "./workspace-record-store";

export interface IdempotencyRecordServiceOptions {
  workspaceRoot: string;
  now?: () => Date;
}

export interface IdempotencyRecordLookupInput {
  scope: IdempotencyScope;
  key: string;
  requestDigest: string;
}

export type IdempotencyReplayLookup =
  | { status: "missing" }
  | { status: "mismatch"; record: IdempotencyRecord }
  | { status: "incomplete"; record: IdempotencyRecord }
  | { status: "completed"; record: IdempotencyRecord & { result_ref: string } };

export interface CompleteIdempotencyRecordInput extends IdempotencyRecordLookupInput {
  resultRef: string;
}

export interface IdempotencyRecordService {
  storeRecord: (record: IdempotencyRecord) => Promise<IdempotencyRecord>;
  getRecord: (scope: IdempotencyScope, key: string) => Promise<IdempotencyRecord | undefined>;
  lookupReplay: (input: IdempotencyRecordLookupInput) => Promise<IdempotencyReplayLookup>;
  completeRecord: (input: CompleteIdempotencyRecordInput) => Promise<IdempotencyRecord>;
}

export function createIdempotencyRecordService(
  options: IdempotencyRecordServiceOptions
): IdempotencyRecordService {
  const workspaceRoot = resolve(options.workspaceRoot);
  const now = options.now ?? (() => new Date());

  const service: IdempotencyRecordService = {
    async storeRecord(record: IdempotencyRecord): Promise<IdempotencyRecord> {
      const parsedRecord = IdempotencyRecordSchema.safeParse(record);
      if (!parsedRecord.success) {
        return await writeJsonRecord(
          workspaceRoot,
          idempotencyRecordDirectorySegments("task"),
          "invalid.json",
          record,
          "workspace/tasks/_idempotency",
          IdempotencyRecordSchema
        );
      }

      return await writeJsonRecord(
        workspaceRoot,
        idempotencyRecordDirectorySegments(parsedRecord.data.scope),
        idempotencyRecordFileName(parsedRecord.data.key),
        parsedRecord.data,
        idempotencyRecordEvidenceRef(parsedRecord.data.scope, parsedRecord.data.key),
        IdempotencyRecordSchema
      );
    },

    async getRecord(
      scope: IdempotencyScope,
      key: string
    ): Promise<IdempotencyRecord | undefined> {
      const parsedScope = assertIdempotencyScope(scope);
      assertNonblankIdempotencyKey(key);
      const recordPath = workspaceRecordPath(
        workspaceRoot,
        [...idempotencyRecordDirectorySegments(parsedScope), idempotencyRecordFileName(key)],
        idempotencyRecordEvidenceRef(parsedScope, key)
      );

      return await readJsonRecord(
        recordPath,
        idempotencyRecordEvidenceRef(parsedScope, key),
        IdempotencyRecordSchema
      );
    },

    async lookupReplay(input: IdempotencyRecordLookupInput): Promise<IdempotencyReplayLookup> {
      const parsedScope = assertIdempotencyScope(input.scope);
      assertNonblankIdempotencyKey(input.key);
      const record = await service.getRecord(parsedScope, input.key);
      if (!record) {
        return { status: "missing" };
      }
      if (record.request_digest !== input.requestDigest) {
        return { status: "mismatch", record };
      }
      if (record.status === "completed") {
        if (!record.result_ref) {
          throw new TaskServiceError({
            code: "record_malformed",
            status: 500,
            category: "workspace_error",
            message: "Completed idempotency record is missing result_ref.",
            userMessage: "A completed idempotency record is missing its result reference.",
            evidenceRefs: [
              idempotencyRecordEvidenceRef(parsedScope, input.key),
              "idempotency.result_ref"
            ],
            recommendedNextActions: ["Inspect and repair the idempotency record before retrying."]
          });
        }

        return { status: "completed", record: record as IdempotencyRecord & { result_ref: string } };
      }

      return { status: "incomplete", record };
    },

    async completeRecord(input: CompleteIdempotencyRecordInput): Promise<IdempotencyRecord> {
      const parsedScope = assertIdempotencyScope(input.scope);
      assertNonblankIdempotencyKey(input.key);
      const existing = await service.lookupReplay({ ...input, scope: parsedScope });
      if (existing.status === "mismatch") {
        throw createIdempotencyMismatchError();
      }
      if (existing.status === "completed") {
        return existing.record;
      }

      const timestamp = now().toISOString();
      return await service.storeRecord({
        key: input.key,
        scope: parsedScope,
        request_digest: input.requestDigest,
        status: "completed",
        result_ref: input.resultRef,
        created_at: existing.status === "incomplete" ? existing.record.created_at : timestamp,
        updated_at: timestamp
      });
    }
  };

  return service;
}

export function idempotencyRecordFileName(key: string): string {
  assertNonblankIdempotencyKey(key);
  return `${sha256Hex(key)}.json`;
}

export function idempotencyRecordEvidenceRef(scope: IdempotencyScope, key: string): string {
  const parsedScope = assertIdempotencyScope(scope);
  assertNonblankIdempotencyKey(key);
  return join("workspace", "tasks", "_idempotency", parsedScope, idempotencyRecordFileName(key));
}

export function idempotencyRecordDirectorySegments(
  scope: IdempotencyScope
): readonly string[] {
  return ["tasks", "_idempotency", assertIdempotencyScope(scope)];
}

export function createIdempotencyMismatchError(): TaskServiceError {
  return new TaskServiceError({
    code: "idempotency_mismatch",
    status: 422,
    category: "idempotency_mismatch",
    message: "Idempotency key mismatch for task create request.",
    userMessage: "This idempotency key was already used with different request content.",
    evidenceRefs: [
      "request.headers.Idempotency-Key",
      "idempotency.scope:task",
      "idempotency.request_digest"
    ],
    retryable: false,
    recommendedNextActions: ["Use the original request body or choose a new idempotency key."]
  });
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertNonblankIdempotencyKey(key: string): void {
  if (typeof key === "string" && key.trim().length > 0) {
    return;
  }

  throw new TaskServiceError({
    code: "record_id_not_safe",
    status: 400,
    category: "schema_error",
    message: "Idempotency key must be nonblank.",
    userMessage: "The idempotency key must be nonblank when provided.",
    evidenceRefs: ["request.headers.Idempotency-Key"],
    recommendedNextActions: ["Provide a nonblank idempotency key or omit the header."]
  });
}

function assertIdempotencyScope(scope: IdempotencyScope): IdempotencyScope {
  const parsedScope = IdempotencyScopeSchema.safeParse(scope);
  if (parsedScope.success) {
    return parsedScope.data;
  }

  throw new TaskServiceError({
    code: "record_id_not_safe",
    status: 400,
    category: "schema_error",
    message: "Idempotency scope is not supported.",
    userMessage: "The idempotency scope is not supported.",
    evidenceRefs: ["idempotency.scope"],
    recommendedNextActions: ["Use a supported idempotency scope."]
  });
}
