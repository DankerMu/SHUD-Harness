// Checked by the normal package typecheck; excluded from emitting builds.
import type {
  TaskCard,
  StackLock,
  DataProvenance,
  EvidenceReport,
} from "@shud-harness/dsh-shud-core";
import { readWorkspaceRecord, writeWorkspaceRecord } from "./index.ts";

declare const cwd: string;
declare const id: unknown;
declare const value: unknown;
const task: TaskCard = readWorkspaceRecord(cwd, "task", id);
const stack: StackLock = readWorkspaceRecord(cwd, "stack", id);
const data: DataProvenance = readWorkspaceRecord(cwd, "data", id);
const report: EvidenceReport = readWorkspaceRecord(cwd, "report", id);
const written: void = writeWorkspaceRecord(cwd, "task", value);
writeWorkspaceRecord(cwd, "data", value);
writeWorkspaceRecord(cwd, "report", value);
// @ts-expect-error StackLocks have no mutable write API.
writeWorkspaceRecord(cwd, "stack", value);
// @ts-expect-error The file layer has four fixed record kinds, not arbitrary path plugins.
readWorkspaceRecord(cwd, "custom", id);
// @ts-expect-error Kind-specific reads must not erase their domain result type.
const crossed: TaskCard = readWorkspaceRecord(cwd, "report", id);
void [task, stack, data, report, written, crossed];
