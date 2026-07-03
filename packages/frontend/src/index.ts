import {
  SHUD_HARNESS_CORE_PACKAGE,
  ZERO_PROVISIONAL_REFERENCE
} from "@shud-harness/core";

export * from "./api/index";
export * from "./components/index";
export * from "./hooks/index";
export * from "./layouts/index";
export * from "./pages/index";

export const SHUD_HARNESS_FRONTEND_PACKAGE = "@shud-harness/frontend" as const;

export const frontendSkeleton = {
  packageName: SHUD_HARNESS_FRONTEND_PACKAGE,
  corePackage: SHUD_HARNESS_CORE_PACKAGE,
  zeroReferenceStatus: ZERO_PROVISIONAL_REFERENCE.status
} as const;
