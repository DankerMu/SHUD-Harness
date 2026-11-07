// SHUD checks these inclusive ranges after read conversion and calibration.
// Geology/landcover checkValue calls only warn; harness product validation is separate.
export const CALIB_MULTIPLIER_RANGE = Object.freeze([0.5, 2] as const);

export const CALIB_WHITELIST = Object.freeze({
  GEOL_KSATH: Object.freeze({
    key: "GEOL_KSATH",
    table: "<project>.para.geol",
    column: "KsatH(m_d)",
    read_transform: Object.freeze({ operation: "divide", divisor: 1440 }),
    check_range: Object.freeze([0, 1000] as const),
    source: Object.freeze([
      "SHUD/src/ModelData/MD_readin.cpp:324",
      "SHUD/src/classes/ModelConfigure.cpp:98",
      "SHUD/src/classes/ModelConfigure.cpp:110",
    ] as const),
  }),
  GEOL_KSATV: Object.freeze({
    key: "GEOL_KSATV",
    table: "<project>.para.geol",
    column: "KsatV(m_d)",
    read_transform: Object.freeze({ operation: "divide", divisor: 1440 }),
    check_range: Object.freeze([0, 1000] as const),
    source: Object.freeze([
      "SHUD/src/ModelData/MD_readin.cpp:325",
      "SHUD/src/classes/ModelConfigure.cpp:99",
      "SHUD/src/classes/ModelConfigure.cpp:111",
    ] as const),
  }),
  LC_ROUGH: Object.freeze({
    key: "LC_ROUGH",
    table: "<project>.para.lc",
    column: "ROUGH",
    read_transform: Object.freeze({ operation: "divide", divisor: 60 }),
    check_range: Object.freeze([0, 1] as const),
    source: Object.freeze([
      "SHUD/src/ModelData/MD_readin.cpp:349",
      "SHUD/src/classes/ModelConfigure.cpp:121",
      "SHUD/src/classes/ModelConfigure.cpp:130",
    ] as const),
  }),
  RIV_ROUGH: Object.freeze({
    key: "RIV_ROUGH",
    table: "<project>.sp.riv",
    // Manning is in the second table (river types), at zero-based column 5.
    column: "Manning",
    read_transform: Object.freeze({ operation: "divide", divisor: 60 }),
    check_range: null,
    source: Object.freeze([
      "SHUD/src/classes/River.cpp:29",
      "SHUD/src/classes/River.cpp:40",
      // CheckInputData enumerates input checks without a river validation step.
      "SHUD/src/ModelData/MD_CheckInputData.cpp:2",
    ] as const),
  }),
});
