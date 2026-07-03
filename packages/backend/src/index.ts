import {
  SHUD_HARNESS_CORE_PACKAGE,
  ZERO_PROVISIONAL_REFERENCE
} from "@shud-harness/core";

export * from "./middleware/index";
export * from "./routes/index";
export * from "./ws/index";

export const SHUD_HARNESS_BACKEND_PACKAGE = "@shud-harness/backend" as const;

export const backendSkeleton = {
  packageName: SHUD_HARNESS_BACKEND_PACKAGE,
  corePackage: SHUD_HARNESS_CORE_PACKAGE,
  zeroReferenceStatus: ZERO_PROVISIONAL_REFERENCE.status
} as const;
