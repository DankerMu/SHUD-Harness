import { resolve } from "node:path";
import { ERROR_SCHEMA, SOURCE_PROFILE, SUCCESS_SCHEMA } from "./constants";
import { checkCurrentSourceOracle, checkCurrentSourceOracleForTest } from "./current-source";
import { ContractError, readBoundedFile, type DescriptorAdmissionHook } from "./ingress";
import { admitSourceInput, type SourceInputKind } from "./schemas";

export type CheckIo = Readonly<{ stdout: (text: string) => void; stderr: (text: string) => void }>;
type Options =
  | Readonly<{ mode: "input"; input: string; kind: SourceInputKind }>
  | Readonly<{ mode: "current"; repositoryRoot: string; manifest: string }>;

const KINDS = new Set<SourceInputKind>(["source_input_record", "source_identity_projection"]);

function parseArgs(args: readonly string[]): Options {
  const values = new Map<string, string>();
  let current = false;
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index]!;
    if (name === "--check-current") {
      if (current) throw new ContractError("CONTRACT_SCHEMA_INVALID");
      current = true;
      continue;
    }
    if (!["--input", "--kind", "--repository-root", "--manifest"].includes(name) || values.has(name)) {
      throw new ContractError("CONTRACT_SCHEMA_INVALID");
    }
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new ContractError("CONTRACT_SCHEMA_INVALID");
    values.set(name, value);
  }
  if (!current && values.size === 2 && values.has("--input") && values.has("--kind")) {
    const kind = values.get("--kind") as SourceInputKind;
    if (!KINDS.has(kind)) throw new ContractError("CONTRACT_SCHEMA_INVALID");
    return { mode: "input", input: values.get("--input")!, kind };
  }
  if (current && values.size === 2 && values.has("--repository-root") && values.has("--manifest")) {
    return { mode: "current", repositoryRoot: values.get("--repository-root")!, manifest: values.get("--manifest")! };
  }
  throw new ContractError("CONTRACT_SCHEMA_INVALID");
}
function line(value: Record<string, string>): string {
  return `${JSON.stringify(value)}\n`;
}

async function execute(options: Options, afterAdmission?: DescriptorAdmissionHook): Promise<string> {
  if (options.mode === "input") {
    const bytes = await readBoundedFile(resolve(options.input), SOURCE_PROFILE.bytes, afterAdmission);
    admitSourceInput(options.kind, bytes);
    return options.kind;
  }
  if (afterAdmission) {
    await checkCurrentSourceOracleForTest(options.repositoryRoot, options.manifest, afterAdmission);
  } else {
    await checkCurrentSourceOracle(options.repositoryRoot, options.manifest);
  }
  return "current_source_authority";
}

async function runCheckWithHook(
  args: readonly string[],
  io: CheckIo,
  afterAdmission?: DescriptorAdmissionHook
): Promise<number> {
  try {
    const inputKind = await execute(parseArgs(args), afterAdmission);
    io.stdout(line({ schema_version: SUCCESS_SCHEMA, status: "ok", input_kind: inputKind }));
    return 0;
  } catch (error) {
    const code = error instanceof ContractError ? error.code : "CONTRACT_SCHEMA_INVALID";
    io.stderr(line({ schema_version: ERROR_SCHEMA, status: "error", code }));
    return 2;
  }
}

export async function runCheck(args: readonly string[], io: CheckIo): Promise<number> {
  return await runCheckWithHook(args, io);
}

/** Deterministic path-replacement seam for contract tests. */
export async function runCheckForTest(
  args: readonly string[],
  io: CheckIo,
  afterAdmission: DescriptorAdmissionHook
): Promise<number> {
  return await runCheckWithHook(args, io, afterAdmission);
}
