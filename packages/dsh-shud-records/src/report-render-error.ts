export type ReportRenderStage =
  | "id"
  | "directory"
  | "target"
  | "missing"
  | "read"
  | "parse"
  | "schema"
  | "identity"
  | "decision_history"
  | "template";

/** Diagnostics contain only a controlled stage and, when available, a validated path. */
export class ReportRenderError extends Error {
  constructor(
    readonly stage: ReportRenderStage,
    readonly path?: string,
  ) {
    super(`Report rendering ${stage} failed${path === undefined ? "" : `: ${path}`}`);
    this.name = "ReportRenderError";
  }
}
