export * from "./artifact";
export * from "./artifact-manifest";
export * from "./data-provenance";
export * from "./error";
export * from "./idempotency";
export * from "./lock";
export * from "./stack-lock";
export * from "./task";

export const CORE_SCHEMA_NAMESPACE = "core/domain/schemas" as const;

export type CoreSchemaNamespace = typeof CORE_SCHEMA_NAMESPACE;
