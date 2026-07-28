import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ContractError, canonicalReceipt, ingestJson, type InputKind } from "./ingestion";
import {
  enumerateSourceCandidates,
  loadAndValidateContract,
  validateManifest,
  validateGitCandidateSet,
  validateSupplyFiles,
  validateSyntheticGolden,
  validatorForInputKind
} from "./schema";

export type CheckIo = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

type CurrentOptions = { mode: "current"; repositoryRoot: string; manifest: string };
type InputOptions = { mode: "input"; input: string; kind: InputKind };
type Options = CurrentOptions | InputOptions;

const INPUT_KINDS = new Set<InputKind>([
  "catalog", "dependency_graph", "schema", "source_input_record", "row_evidence", "platform_bundle", "final_bundle", "decision"
]);

function parseArgs(args: string[]): Options {
  const values = new Map<string, string>();
  let checkCurrent = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--check-current") {
      if (checkCurrent) throw new ContractError("CONTRACT_SCHEMA_INVALID");
      checkCurrent = true;
      continue;
    }
    if (!["--repository-root", "--manifest", "--input", "--kind"].includes(arg) || values.has(arg)) throw new ContractError("CONTRACT_SCHEMA_INVALID");
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new ContractError("CONTRACT_SCHEMA_INVALID");
    values.set(arg, value);
  }
  if (checkCurrent && values.size === 2 && values.has("--repository-root") && values.has("--manifest")) {
    return { mode: "current", repositoryRoot: values.get("--repository-root")!, manifest: values.get("--manifest")! };
  }
  if (!checkCurrent && values.size === 2 && values.has("--input") && values.has("--kind")) {
    const kind = values.get("--kind") as InputKind;
    if (!INPUT_KINDS.has(kind)) throw new ContractError("CONTRACT_SCHEMA_INVALID");
    return { mode: "input", input: values.get("--input")!, kind };
  }
  throw new ContractError("CONTRACT_SCHEMA_INVALID");
}

export async function checkCurrent(repositoryRoot: string, manifest: string): Promise<Record<string, unknown>> {
  const root = resolve(repositoryRoot);
  const spikeRoot = resolve(root, "spikes/git-status-capability");
  await loadAndValidateContract(resolve(spikeRoot, "contracts/contract-v1.json"));
  await validateSupplyFiles(spikeRoot);
  await validateSyntheticGolden(spikeRoot);
  const sourceEntries = await validateManifest(root, resolve(root, manifest));
  validateGitCandidateSet(root, await enumerateSourceCandidates(root));
  return {
    schema_version: "shud.git-status-capability.contract-check-receipt.v1",
    status: "ok",
    catalog_rows: 174,
    floor_mappings: 25,
    fixture_owners: 174,
    native_owners: 174,
    source_entries: sourceEntries,
    rust_version: "1.88.0",
    git_oracle_version: "2.49.0"
  };
}

async function execute(options: Options): Promise<Record<string, unknown>> {
  if (options.mode === "input") {
    const bytes = new Uint8Array(await readFile(options.input));
    ingestJson(bytes, options.kind, validatorForInputKind(options.kind));
    return {
      schema_version: "shud.git-status-capability.contract-check-receipt.v1",
      status: "ok",
      input_kind: options.kind
    };
  }
  return await checkCurrent(options.repositoryRoot, options.manifest);
}

export async function runCheck(args: string[], io: CheckIo): Promise<number> {
  try {
    const receipt = await execute(parseArgs(args));
    io.stdout(canonicalReceipt(receipt));
    return 0;
  } catch (error) {
    const code = error instanceof ContractError ? error.code : "CONTRACT_SCHEMA_INVALID";
    io.stderr(canonicalReceipt({
      schema_version: "shud.git-status-capability.contract-error.v1",
      status: "error",
      code
    }));
    return 2;
  }
}
