export const CORE_SERVICE_NAMESPACE = "core/domain/services" as const;

export type CoreServiceNamespace = typeof CORE_SERVICE_NAMESPACE;

export * from "./artifact-registry-service";
export * from "./idempotency-service";
export * from "./lock-service";
export * from "./task-card-service";
