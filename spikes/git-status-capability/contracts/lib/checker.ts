import { ERROR_SCHEMA, SOURCE_PROFILE, SUCCESS_SCHEMA } from "./constants";
import {
  ContractError,
  readBoundedFile,
  type DescriptorIngressHooks
} from "./ingress";
import { admitSourceInput, type SourceInputKind } from "./schemas";

export type CheckIo = Readonly<{ stdout: (text: string) => void; stderr: (text: string) => void }>;
type Options = Readonly<{ input: string; kind: SourceInputKind }>;
const KINDS = new Set<SourceInputKind>(["source_input_record", "source_identity_projection"]);

function parseArgs(args: readonly string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index]!;
    if (!["--input", "--kind"].includes(name) || values.has(name)) throw new ContractError("CONTRACT_SCHEMA_INVALID");
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new ContractError("CONTRACT_SCHEMA_INVALID");
    values.set(name, value);
  }
  if (values.size !== 2 || !values.has("--input") || !values.has("--kind")) {
    throw new ContractError("CONTRACT_SCHEMA_INVALID");
  }
  const kind = values.get("--kind") as SourceInputKind;
  if (!KINDS.has(kind)) throw new ContractError("CONTRACT_SCHEMA_INVALID");
  return { input: values.get("--input")!, kind };
}

function line(value: Record<string, string>): string {
  return `${JSON.stringify(value)}\n`;
}

async function runCheckWithHooks(args: readonly string[], io: CheckIo, hooks: DescriptorIngressHooks): Promise<number> {
  try {
    const options = parseArgs(args);
    const bytes = await readBoundedFile(options.input, SOURCE_PROFILE.bytes, hooks);
    admitSourceInput(options.kind, bytes);
    io.stdout(line({ schema_version: SUCCESS_SCHEMA, status: "ok", input_kind: options.kind }));
    return 0;
  } catch (error) {
    const code = error instanceof ContractError ? error.code : "CONTRACT_SCHEMA_INVALID";
    io.stderr(line({ schema_version: ERROR_SCHEMA, status: "error", code }));
    return 2;
  }
}

export async function runCheck(args: readonly string[], io: CheckIo): Promise<number> {
  return await runCheckWithHooks(args, io, {});
}

/** Deterministic descriptor replacement and syscall-observation seam for contract tests. */
export async function runCheckForTest(
  args: readonly string[],
  io: CheckIo,
  hooks: DescriptorIngressHooks
): Promise<number> {
  return await runCheckWithHooks(args, io, hooks);
}
