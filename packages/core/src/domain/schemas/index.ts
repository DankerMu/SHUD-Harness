export * from "./artifact";
export * from "./error";
export * from "./idempotency";
export * from "./lock";
export * from "./task";

export const CORE_SCHEMA_NAMESPACE = "core/domain/schemas" as const;

export type CoreSchemaNamespace = typeof CORE_SCHEMA_NAMESPACE;
