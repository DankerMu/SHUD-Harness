import {
  withCompiledProductionTreeTransform,
  type MutatedProductionTree,
  type ProductionTreeTransform
} from "./authority-descriptor-vocabulary";

type RawTarget = "open_sync" | "openat" | "fstat_sync" | "read_sync" | "close_sync";
type NodeTarget = Exclude<RawTarget, "openat">;
type NodeAcquisitionFamily =
  | "renamed_import"
  | "namespace_property"
  | "require_loader"
  | "builtin_loader"
  | "dynamic_loader"
  | "cross_lib_helper";
type OpenAtAcquisitionFamily =
  | "renamed_import"
  | "namespace_property"
  | "require_loader"
  | "builtin_loader"
  | "dynamic_loader"
  | "cached_callable"
  | "fresh_dlopen"
  | "extra_resolver"
  | "cross_lib_helper";
type AcquisitionMutation =
  | `acquisition_${NodeTarget}_${NodeAcquisitionFamily}`
  | `acquisition_openat_${OpenAtAcquisitionFamily}`;
type RawAcquisitionDenial =
  | "raw_open_root_not_handle"
  | "openat_parent_not_handle"
  | "raw_fstat_descriptor_not_handle"
  | "raw_read_descriptor_not_handle"
  | "raw_close_descriptor_not_handle";
type MutationSite = Readonly<{ anchor: string; indent: string; arguments: string; guard: string; primitive: string }>;

const NODE_TARGETS = ["open_sync", "fstat_sync", "read_sync", "close_sync"] as const satisfies readonly NodeTarget[];
const NODE_FAMILIES = [
  "renamed_import",
  "namespace_property",
  "require_loader",
  "builtin_loader",
  "dynamic_loader",
  "cross_lib_helper"
] as const satisfies readonly NodeAcquisitionFamily[];
const OPENAT_FAMILIES = [
  "renamed_import",
  "namespace_property",
  "require_loader",
  "builtin_loader",
  "dynamic_loader",
  "cached_callable",
  "fresh_dlopen",
  "extra_resolver",
  "cross_lib_helper"
] as const satisfies readonly OpenAtAcquisitionFamily[];
const NODE_FS_IMPORT = 'import { closeSync, constants, fstatSync, openSync, readSync, type BigIntStats } from "node:fs";';
const OPENAT_SYMBOLS = '{ openat: { args: ["i32", "cstring", "i32"], returns: "i32" } } as const';
const MUTATION_SITE: Readonly<Record<RawTarget, MutationSite>> = Object.freeze({
  open_sync: {
    anchor: '    const descriptor = invokeDescriptorPrimitive("open_root", () => openSync(root, DIRECTORY_OPEN_FLAGS));',
    indent: "    ",
    arguments: "root, DIRECTORY_OPEN_FLAGS",
    guard: 'root === "/"',
    primitive: "openSync"
  },
  openat: {
    anchor: "    const descriptor = invokeDescriptorPrimitive(\n" +
      '      "openat",\n' +
      "      () => openAtPrimitive(parentRecord.fd, childPath, flags)\n" +
      "    );",
    indent: "    ",
    arguments: "parentRecord.fd, childPath, flags",
    guard: 'childName === "__raw_acquisition__"',
    primitive: "openAtPrimitive"
  },
  fstat_sync: {
    anchor: '    const stats = invokeDescriptorPrimitive("fstat_sync", () => fstatSync(record.fd, { bigint: true }));',
    indent: "    ",
    arguments: "record.fd, { bigint: true }",
    guard: "record.fd === -424242",
    primitive: "fstatSync"
  },
  read_sync: {
    anchor: '    return invokeDescriptorPrimitive("read_sync", () => readSync(record.fd, buffer, offset, length, position));',
    indent: "    ",
    arguments: "record.fd, buffer, offset, length, position",
    guard: "position === 424242",
    primitive: "readSync"
  },
  close_sync: {
    anchor: "      invokeDescriptorPrimitive(\"close_sync\", () => {\n" +
      "        rawCloseAttempted = true;\n" +
      "        closeSync(record.fd);\n" +
      "      });",
    indent: "      ",
    arguments: "record.fd",
    guard: "record.fd === -424242",
    primitive: "closeSync"
  }
});

export const RAW_ACQUISITION_MUTATIONS: readonly AcquisitionMutation[] = Object.freeze([
  ...NODE_TARGETS.flatMap((target) => NODE_FAMILIES.map(
    (family) => `acquisition_${target}_${family}` as AcquisitionMutation
  )),
  ...OPENAT_FAMILIES.map((family) => `acquisition_openat_${family}` as AcquisitionMutation)
]);

function targetOf(mutation: AcquisitionMutation): RawTarget {
  if (mutation.startsWith("acquisition_openat_")) return "openat";
  for (const target of NODE_TARGETS) {
    if (mutation.startsWith(`acquisition_${target}_`)) return target;
  }
  throw new Error(`unknown acquisition mutation: ${mutation}`);
}

function familyOf(mutation: AcquisitionMutation): NodeAcquisitionFamily | OpenAtAcquisitionFamily {
  const target = targetOf(mutation);
  return mutation.slice(`acquisition_${target}_`.length) as NodeAcquisitionFamily | OpenAtAcquisitionFamily;
}

export function expectedRawAcquisitionDenial(mutation: AcquisitionMutation): RawAcquisitionDenial {
  const target = targetOf(mutation);
  if (target === "open_sync") return "raw_open_root_not_handle";
  if (target === "openat") return "openat_parent_not_handle";
  if (target === "fstat_sync") return "raw_fstat_descriptor_not_handle";
  if (target === "read_sync") return "raw_read_descriptor_not_handle";
  return "raw_close_descriptor_not_handle";
}

function addBeforeSite(source: string, target: RawTarget, addition: string): string {
  const site = MUTATION_SITE[target];
  if (!source.includes(site.anchor)) throw new Error(`raw acquisition anchor is absent: ${target}`);
  return source.replace(site.anchor, `${addition}${site.anchor}`);
}


function nodeLoaderCall(target: NodeTarget, loader: string): string {
  const site = MUTATION_SITE[target];
  return `${site.indent}const rawLoader = ${loader};\n` +
    `${site.indent}if (${site.guard}) rawLoader.${site.primitive}(${site.arguments});\n`;
}

function nodeCrossLibHelper(target: NodeTarget): string {
  const body = target === "open_sync"
    ? 'openSync("/", DIRECTORY_OPEN_FLAGS);'
    : target === "fstat_sync"
      ? "fstatSync(0, { bigint: true });"
      : target === "read_sync"
        ? "readSync(0, Buffer.alloc(1), 0, 1, 0);"
        : "closeSync(0);";
  return `\nexport function rawAcquisitionHelper(): void { ${body} }\n`;
}

function mutateNodeCapability(source: string, target: NodeTarget, family: NodeAcquisitionFamily): string {
  const site = MUTATION_SITE[target];
  if (family === "renamed_import") {
    const alias = `bypass${site.primitive[0]!.toUpperCase()}${site.primitive.slice(1)}`;
    const importLine = NODE_FS_IMPORT.replace(site.primitive, `${site.primitive}, ${site.primitive} as ${alias}`);
    return addBeforeSite(source.replace(NODE_FS_IMPORT, importLine), target,
      `${site.indent}if (${site.guard}) ${alias}(${site.arguments});\n`);
  }
  if (family === "namespace_property") {
    return addBeforeSite(source.replace(NODE_FS_IMPORT, `${NODE_FS_IMPORT}\nimport * as rawNamespace from "node:fs";`), target,
      `${site.indent}if (${site.guard}) rawNamespace.${site.primitive}(${site.arguments});\n`);
  }
  if (family === "require_loader") {
    return addBeforeSite(source, target, nodeLoaderCall(target, 'require("node:fs")'));
  }
  if (family === "builtin_loader") {
    return addBeforeSite(source, target, nodeLoaderCall(target, 'process.getBuiltinModule("node:fs")'));
  }
  if (family === "dynamic_loader") {
    return addBeforeSite(source, target,
      `${site.indent}void import("node:fs").then((rawLoader) => { if (${site.guard}) rawLoader.${site.primitive}(${site.arguments}); });\n`);
  }
  return `${source}${nodeCrossLibHelper(target)}`;
}

function openAtLoaderCall(loader: string): string {
  const site = MUTATION_SITE.openat;
  return `${site.indent}const rawLibrary = ${loader};\n` +
    `${site.indent}if (${site.guard}) rawLibrary.symbols.openat(${site.arguments});\n`;
}

function mutateOpenAtCapability(source: string, family: OpenAtAcquisitionFamily): string {
  const site = MUTATION_SITE.openat;
  if (family === "renamed_import") {
    return addBeforeSite(source.replace('import { dlopen } from "bun:ffi";',
      'import { dlopen } from "bun:ffi";\nimport { dlopen as bypassDlopen } from "bun:ffi";'), "openat",
      openAtLoaderCall(`bypassDlopen("/usr/lib/libSystem.B.dylib", ${OPENAT_SYMBOLS})`));
  }
  if (family === "namespace_property") {
    return addBeforeSite(source.replace('import { dlopen } from "bun:ffi";',
      'import { dlopen } from "bun:ffi";\nimport * as rawFfiNamespace from "bun:ffi";'), "openat",
      openAtLoaderCall(`rawFfiNamespace.dlopen("/usr/lib/libSystem.B.dylib", ${OPENAT_SYMBOLS})`));
  }
  if (family === "require_loader") return addBeforeSite(source, "openat", openAtLoaderCall(`require("bun:ffi").dlopen("/usr/lib/libSystem.B.dylib", ${OPENAT_SYMBOLS})`));
  if (family === "builtin_loader") return addBeforeSite(source, "openat", openAtLoaderCall(`process.getBuiltinModule("bun:ffi").dlopen("/usr/lib/libSystem.B.dylib", ${OPENAT_SYMBOLS})`));
  if (family === "dynamic_loader") {
    return addBeforeSite(source, "openat",
      `${site.indent}void import("bun:ffi").then((rawFfi) => { if (${site.guard}) rawFfi.dlopen("/usr/lib/libSystem.B.dylib", ${OPENAT_SYMBOLS}).symbols.openat(${site.arguments}); });\n`);
  }
  if (family === "cached_callable") {
    return addBeforeSite(source, "openat", `${site.indent}if (${site.guard}) cachedOpenAt!(${site.arguments});\n`);
  }
  if (family === "fresh_dlopen") {
    return addBeforeSite(source, "openat", openAtLoaderCall(`dlopen("/usr/lib/libSystem.B.dylib", ${OPENAT_SYMBOLS})`));
  }
  if (family === "extra_resolver") {
    return addBeforeSite(source, "openat",
      `${site.indent}const extraOpenAt = openAt();\n${site.indent}if (${site.guard}) extraOpenAt(${site.arguments});\n`);
  }
  return `${source}\nexport function rawAcquisitionHelper(): void { cachedOpenAt!(-100, Buffer.from("raw\\0"), FILE_OPEN_FLAGS); }\n`;
}

function crossLibImport(source: string): string {
  return `import { rawAcquisitionHelper } from "./capabilities";\n${source}\nvoid rawAcquisitionHelper;\n`;
}

function transformForMutation(mutation: AcquisitionMutation): ProductionTreeTransform {
  const target = targetOf(mutation);
  const family = familyOf(mutation);
  return (sourceName, source) => {
    if (sourceName === "capabilities.ts") {
      return target === "openat"
        ? mutateOpenAtCapability(source, family as OpenAtAcquisitionFamily)
        : mutateNodeCapability(source, target, family as NodeAcquisitionFamily);
    }
    if (sourceName === "ingress.ts" && family === "cross_lib_helper") return crossLibImport(source);
    return source;
  };
}

/** Compiles each complete copied production graph before the caller reads its denials. */
export async function withCompiledRawAcquisitionMutation(
  mutation: AcquisitionMutation,
  action: (tree: MutatedProductionTree) => Promise<void>
): Promise<void> {
  await withCompiledProductionTreeTransform(transformForMutation(mutation), action);
}
