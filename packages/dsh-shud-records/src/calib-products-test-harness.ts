import { writeFileSync } from "node:fs";
import type { AnalysisPlan, CALIB_WHITELIST } from "@shud-harness/dsh-shud-core";
import { sections, smallInputs } from "./shud-text-test-harness.ts";

export type CalibKey = keyof typeof CALIB_WHITELIST;

export function parameterSets(
  changes: AnalysisPlan["parameter_sets"][number]["changes"][],
): AnalysisPlan["parameter_sets"] {
  return [
    { parameter_set_id: "PSET-1", label: null, baseline: true, changes: {} },
    ...changes.map((change, index) => ({
      parameter_set_id: `PSET-${index + 2}`,
      label: null,
      baseline: false,
      changes: change,
    })),
  ];
}

export const categoryCases = [
  {
    key: "GEOL_KSATH",
    path: "mini.para.geol",
    text: sections.geol,
    token: "13 1.5",
    prefix: "13 ",
  },
  {
    key: "GEOL_KSATV",
    path: "mini.para.geol",
    text: sections.geol,
    token: "1.5 0.25",
    prefix: "1.5 ",
  },
  {
    key: "LC_ROUGH",
    path: "mini.para.lc",
    text: sections.lc,
    token: "0 0.135 0 0.035",
    prefix: "0 0.135 0 ",
  },
  {
    key: "RIV_ROUGH",
    path: "mini.sp.riv",
    text: smallInputs["sp.riv"],
    token: "4 7 0 8 1 0.04",
    prefix: "4 7 0 8 1 ",
  },
] as const;

/** Independent writer-shaped inputs; unused categories make accidental discovery observable. */
export function seedCalibInputs(root: string): void {
  writeFileSync(`${root}/mini.cfg.calib`, "GEOL_KSATH 1\nGEOL_KSATV 1\nLC_ROUGH 1\nRIV_ROUGH 1\n");
  writeFileSync(`${root}/mini.para.geol`, sections.geol);
  writeFileSync(`${root}/mini.para.lc`, sections.lc);
  writeFileSync(`${root}/mini.sp.riv`, smallInputs["sp.riv"]);
}

export function writeCategory(root: string, key: CalibKey, raw: string): string {
  const fixture = categoryCases.find((entry) => entry.key === key)!;
  writeFileSync(
    `${root}/${fixture.path}`,
    fixture.text.replace(fixture.token, fixture.prefix + raw),
  );
  return fixture.path;
}
