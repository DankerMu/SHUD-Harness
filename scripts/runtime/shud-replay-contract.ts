export const REPLAY_COMMIT = "9a422e5eb708df7d2f8b4066a3083a031d679a82";
export const REPLAY_FILES = [
  "Makefile",
  "src/Model/MD_rhs_core.cpp",
  "src/Model/Macros.hpp",
  "src/Model/f.cpp",
  "src/Model/shud.cpp",
] as const;
/**
 * PI 2026-11-09 (#662 option A): real keliya `.sp.mesh` carries `NA` cells, so collect metrics
 * are pinned as unavailable with exactly this top-level reason.
 */
export const KELIYA_METRICS_UNAVAILABLE_REASON = "parse:input/keliya/keliya.sp.mesh";
