import path from "node:path";
import type { PolicyGateToolCall, PolicyRule } from "./policy-gate-core";

export const DATA_RAW_WRITE_DENY_RULE_ID = "policy-gate-spike.data_raw_write_forbidden" as const;
export const DATA_RAW_WRITE_GUARD_CLASS = "authority" as const;
export const DATA_RAW_WRITE_RULE_REF =
  "openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md" as const;

const BASH_TOOL_IDS = new Set(["bash"]);
const REDIRECT_WRITE_OPERATORS = new Set([">", ">>", ">|", "1>", "1>>", "2>", "2>>", "&>", "&>>", ">&"]);
const SEGMENT_SEPARATORS = new Set([";", "&&", "||", "|", "&"]);
const ANY_RAW_PATH_MUTATION_COMMANDS = new Set([
  "chmod",
  "chown",
  "mkdir",
  "rm",
  "rmdir",
  "touch",
  "truncate"
]);
const DESTINATION_RAW_PATH_COMMANDS = new Set(["cp", "install", "ln", "rsync"]);
const ANY_ENDPOINT_RAW_PATH_COMMANDS = new Set(["mv"]);
const READ_ONLY_RAW_PATH_COMMANDS = new Set(["cat", "grep", "head", "ls", "tail", "wc"]);
const WRAPPER_COMMANDS = new Set(["command", "doas", "env", "nice", "nohup", "sudo", "time"]);
const WRAPPER_OPTIONS_WITH_OPERANDS = new Map<string, ReadonlySet<string>>([
  ["doas", new Set(["-u"])],
  ["env", new Set(["-C", "--chdir", "-u", "--unset"])],
  ["nice", new Set(["-n", "--adjustment"])],
  ["sudo", new Set(["-u", "--user"])],
  ["time", new Set(["-f", "--format"])]
]);
const SHELL_COMMANDS = new Set(["bash", "sh", "zsh"]);
const FIND_MUTATION_ACTIONS = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir"]);

type ShellToken = {
  value: string;
  fromOperator: boolean;
  quoted: boolean;
  fullyQuoted: boolean;
  expandsParameters: boolean;
};

type ShellQuote = {
  char: "'" | '"';
  ansiC: boolean;
  expandsParameters: boolean;
};

type PathCandidate = {
  value: string;
  quoted: boolean;
  fullyQuoted: boolean;
};

export const DATA_RAW_WRITE_DENY_RULE: PolicyRule = {
  ruleId: DATA_RAW_WRITE_DENY_RULE_ID,
  guard_class: DATA_RAW_WRITE_GUARD_CLASS,
  description: "Deny bash mutations targeting protected data/raw paths.",
  evaluate(call) {
    if (!BASH_TOOL_IDS.has(call.toolId)) {
      return { decision: "allow" };
    }

    const command = extractBashCommand(call.input);
    if (!command) {
      return { decision: "allow" };
    }

    const target = findProtectedDataRawWriteTarget(command);
    if (!target) {
      return { decision: "allow" };
    }

    return {
      decision: "deny",
      reason: `bash command attempts to mutate protected raw data path: ${target}`,
      remediation: {
        next_action: "adjust_scope",
        hint:
          "Write generated or edited data under a governed task workspace path instead of data/raw.",
        ref: DATA_RAW_WRITE_RULE_REF
      }
    };
  }
};

export function extractBashCommand(input: unknown): string | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }

  const record = input as Record<string, unknown>;
  if (typeof record.command === "string") {
    return record.command;
  }
  if (typeof record.cmd === "string") {
    return record.cmd;
  }
  return undefined;
}

export function findProtectedDataRawWriteTarget(
  command: string,
  initialVariables: ReadonlyMap<string, string> = new Map()
): string | undefined {
  const substitutionTarget = findCommandSubstitutionWriteTarget(command, initialVariables);
  if (substitutionTarget) {
    return substitutionTarget;
  }

  const tokens = tokenizeShellCommand(command);
  const variables = new Map(initialVariables);

  for (const segment of splitCommandSegments(tokens)) {
    const expandedSegment = expandSegmentParameterReferences(segment, variables);
    const redirectTarget = findRedirectWriteTarget(expandedSegment);
    if (redirectTarget) {
      return redirectTarget;
    }

    const mutationTarget = findMutationCommandTarget(expandedSegment, variables);
    if (mutationTarget) {
      return mutationTarget;
    }

    recordVariableAssignments(segment, variables);
  }

  return undefined;
}

export function makeDataRawPolicyGateContext() {
  return {
    rules: [DATA_RAW_WRITE_DENY_RULE]
  };
}

export type DataRawWritePolicyCall = PolicyGateToolCall;

function findRedirectWriteTarget(tokens: readonly ShellToken[]): string | undefined {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!isUnquotedOperatorToken(token, REDIRECT_WRITE_OPERATORS)) {
      continue;
    }

    const target = tokens[index + 1];
    if (target && isProtectedDataRawCandidate(target)) {
      return target.value;
    }
  }

  return undefined;
}

function splitCommandSegments(tokens: readonly ShellToken[]): ShellToken[][] {
  const segments: ShellToken[][] = [];
  let current: ShellToken[] = [];

  for (const token of tokens) {
    if (isUnquotedOperatorToken(token, SEGMENT_SEPARATORS)) {
      if (current.length > 0) {
        segments.push(current);
        current = [];
      }
      continue;
    }
    current.push(token);
  }

  if (current.length > 0) {
    segments.push(current);
  }

  return segments;
}

function isUnquotedOperatorToken(token: ShellToken, operators: ReadonlySet<string>): boolean {
  return token.fromOperator && !token.quoted && operators.has(token.value);
}

function findMutationCommandTarget(
  segment: readonly ShellToken[],
  variables: ReadonlyMap<string, string>
): string | undefined {
  const wrapperUncertaintyTarget = findWrapperUncertaintyRawCandidate(segment);
  if (wrapperUncertaintyTarget) {
    return wrapperUncertaintyTarget;
  }

  const commandIndex = findCommandTokenIndex(segment);
  if (commandIndex === undefined) {
    return undefined;
  }

  const command = path.posix.basename(segment[commandIndex].value);
  const args = segment.slice(commandIndex + 1);
  if (command === "eval") {
    const target = findEvalCommandTarget(args, variables);
    if (target) {
      return target;
    }
  }
  if (isExecutableCodeStringCommand(command)) {
    const target = findExecutableCodeStringRawTarget(command, args);
    if (target) {
      return target;
    }
  }
  if (ANY_RAW_PATH_MUTATION_COMMANDS.has(command)) {
    const target = findRawPathArgument(args);
    if (target) {
      return target;
    }
  }
  if (DESTINATION_RAW_PATH_COMMANDS.has(command)) {
    const target = findDestinationRawPathTarget(args);
    if (target) {
      return target;
    }
  }
  if (ANY_ENDPOINT_RAW_PATH_COMMANDS.has(command)) {
    const target = findRawPathArgument(args);
    if (target) {
      return target;
    }
  }
  if (command === "dd") {
    const target = findDdOutputTarget(args);
    if (target) {
      return target;
    }
  }
  if (command === "tee") {
    const target = args.find((arg) => !arg.value.startsWith("-") && isProtectedDataRawCandidate(arg))
      ?.value;
    if (target) {
      return target;
    }
  }
  if (command === "sed" && args.some(isSedInPlaceOption)) {
    const target = findRawPathArgument(args);
    if (target) {
      return target;
    }
  }
  if (command === "curl") {
    const target = findCurlOutputTarget(args);
    if (target) {
      return target;
    }
  }
  if (command === "find") {
    const target = findFindMutationTarget(args);
    if (target) {
      return target;
    }
  }
  if (command === "git") {
    const target = findGitCloneTarget(args);
    if (target) {
      return target;
    }
  }
  if (command === "tar") {
    const target = findTarExtractionTarget(args);
    if (target) {
      return target;
    }
  }
  if (command === "unzip") {
    const target = findUnzipExtractionTarget(args);
    if (target) {
      return target;
    }
  }
  if (command === "wget") {
    const target = findWgetOutputTarget(args);
    if (target) {
      return target;
    }
  }
  if (SHELL_COMMANDS.has(command)) {
    const shellCommand = findShellCommandArgument(args);
    const target = shellCommand ? findProtectedDataRawWriteTarget(shellCommand, variables) : undefined;
    if (target) {
      return target;
    }
  }

  const rawPathCandidate = findRawPathCandidate(segment);
  if (!rawPathCandidate || isReadOnlySafeRawPathCommand(command, args)) {
    return undefined;
  }

  return rawPathCandidate;
}

function findCommandTokenIndex(segment: readonly ShellToken[]): number | undefined {
  let index = 0;
  while (index < segment.length) {
    const token = segment[index];
    if (isAssignment(token)) {
      index += 1;
      continue;
    }

    const command = path.posix.basename(token.value);
    if (WRAPPER_COMMANDS.has(command)) {
      const parsedOptions = parseWrapperOptions(command, segment, index + 1);
      index = parsedOptions.nextIndex;
      continue;
    }

    return index;
  }

  return undefined;
}

function findWrapperUncertaintyRawCandidate(segment: readonly ShellToken[]): string | undefined {
  const rawPathCandidate = findRawPathCandidate(segment);
  if (!rawPathCandidate) {
    return undefined;
  }

  let index = 0;
  while (index < segment.length) {
    const token = segment[index];
    if (isAssignment(token)) {
      index += 1;
      continue;
    }

    const command = path.posix.basename(token.value);
    if (!WRAPPER_COMMANDS.has(command)) {
      return undefined;
    }

    const parsedOptions = parseWrapperOptions(command, segment, index + 1);
    if (parsedOptions.uncertain) {
      return rawPathCandidate;
    }

    index = parsedOptions.nextIndex;
  }

  return undefined;
}

function parseWrapperOptions(
  command: string,
  segment: readonly ShellToken[],
  startIndex: number
): { nextIndex: number; uncertain: boolean } {
  let index = startIndex;
  while (index < segment.length && segment[index].value.startsWith("-")) {
    const option = segment[index].value;
    if (option === "--") {
      return { nextIndex: index + 1, uncertain: false };
    }

    const operandMode = wrapperOptionOperandMode(command, option);
    if (!operandMode) {
      return { nextIndex: index + 1, uncertain: true };
    }

    index += 1;
    if (operandMode === "separate") {
      if (index >= segment.length) {
        return { nextIndex: index, uncertain: true };
      }
      index += 1;
    }
  }

  return { nextIndex: index, uncertain: false };
}

function wrapperOptionOperandMode(
  command: string,
  option: string
): "inline" | "separate" | undefined {
  const optionsWithOperands = WRAPPER_OPTIONS_WITH_OPERANDS.get(command);
  if (!optionsWithOperands) {
    return undefined;
  }

  if (optionsWithOperands.has(option)) {
    return "separate";
  }

  if (option.startsWith("--")) {
    const assignmentIndex = option.indexOf("=");
    if (assignmentIndex > 2 && optionsWithOperands.has(option.slice(0, assignmentIndex))) {
      return "inline";
    }
    return undefined;
  }

  const shortOption = option.slice(0, 2);
  return optionsWithOperands.has(shortOption) && option.length > shortOption.length
    ? "inline"
    : undefined;
}

function findRawPathArgument(args: readonly ShellToken[]): string | undefined {
  return args.find(isProtectedDataRawCandidate)?.value;
}

function findRawPathCandidate(tokens: readonly ShellToken[]): string | undefined {
  for (const token of tokens) {
    const candidate = findProtectedRawPathCandidate(token);
    if (candidate) {
      return candidate.value;
    }
  }

  return undefined;
}

function findProtectedRawPathCandidate(token: ShellToken): PathCandidate | undefined {
  const wholeTokenCandidate = pathCandidateFromToken(token);
  if (isProtectedDataRawCandidate(wholeTokenCandidate)) {
    return wholeTokenCandidate;
  }

  if (!token.value.startsWith("-")) {
    return undefined;
  }

  if (token.value.startsWith("--")) {
    const assignmentIndex = token.value.indexOf("=");
    if (assignmentIndex > 2 && assignmentIndex < token.value.length - 1) {
      const assignmentCandidate = pathCandidateFromToken(
        token,
        token.value.slice(assignmentIndex + 1)
      );
      return isProtectedDataRawCandidate(assignmentCandidate) ? assignmentCandidate : undefined;
    }

    return undefined;
  }

  return findAttachedShortOptionRawPathCandidate(token);
}

function findAttachedShortOptionRawPathCandidate(token: ShellToken): PathCandidate | undefined {
  for (let valueStart = 2; valueStart < token.value.length; valueStart += 1) {
    const candidate = pathCandidateFromToken(token, token.value.slice(valueStart));
    if (isProtectedDataRawCandidate(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function isReadOnlySafeRawPathCommand(
  command: string,
  args: readonly ShellToken[]
): boolean {
  if (READ_ONLY_RAW_PATH_COMMANDS.has(command)) {
    return true;
  }
  if (command === "find") {
    return !hasFindMutationAction(args);
  }
  if (command === "sed") {
    return !args.some(isSedInPlaceOption);
  }

  return command === "cp" && isCopyOutOfRawCommand(args);
}

function isCopyOutOfRawCommand(args: readonly ShellToken[]): boolean {
  const targetDirectory = findTargetDirectoryArgument(args);
  if (targetDirectory !== undefined) {
    return !isProtectedDataRawCandidate(targetDirectory) && args.some(isProtectedDataRawCandidate);
  }

  const positionalArgs = args.filter((arg) => !arg.value.startsWith("-"));
  const destination = positionalArgs.at(-1);
  if (!destination || isProtectedDataRawCandidate(destination)) {
    return false;
  }

  return positionalArgs.slice(0, -1).some(isProtectedDataRawCandidate);
}

function lastNonOptionArgument(args: readonly ShellToken[]): string | undefined {
  const target = args.filter((arg) => !arg.value.startsWith("-")).at(-1);
  return target && isProtectedDataRawCandidate(target) ? target.value : undefined;
}

function findDestinationRawPathTarget(args: readonly ShellToken[]): string | undefined {
  const targetDirectory = findTargetDirectoryArgument(args);
  if (targetDirectory !== undefined) {
    return isProtectedDataRawCandidate(targetDirectory) ? targetDirectory.value : undefined;
  }

  return lastNonOptionArgument(args);
}

function findTargetDirectoryArgument(args: readonly ShellToken[]): PathCandidate | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index].value;
    if (arg === "-t" || arg === "--target-directory") {
      const target = args[index + 1];
      return target ? pathCandidateFromToken(target) : { value: "", quoted: false, fullyQuoted: false };
    }
    if (arg.startsWith("--target-directory=")) {
      return pathCandidateFromToken(args[index], arg.slice("--target-directory=".length));
    }
    if (arg.startsWith("-t") && !arg.startsWith("--") && arg.length > 2) {
      return pathCandidateFromToken(args[index], arg.slice(2));
    }
  }

  return undefined;
}

function findDdOutputTarget(args: readonly ShellToken[]): string | undefined {
  for (const arg of args) {
    if (!arg.value.startsWith("of=")) {
      continue;
    }

    const target = pathCandidateFromToken(arg, arg.value.slice("of=".length));
    if (isProtectedDataRawCandidate(target)) {
      return target.value;
    }
  }

  return undefined;
}

function findCurlOutputTarget(args: readonly ShellToken[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index].value;
    if (arg === "-o" || arg === "--output") {
      const target = args[index + 1];
      if (target && isProtectedDataRawCandidate(target)) {
        return target.value;
      }
      continue;
    }
    if (arg.startsWith("--output=")) {
      const target = pathCandidateFromToken(args[index], arg.slice("--output=".length));
      if (isProtectedDataRawCandidate(target)) {
        return target.value;
      }
      continue;
    }

    const shortOptionTarget = findCurlShortOutputTarget(args, index);
    if (shortOptionTarget) {
      return shortOptionTarget;
    }
  }

  return undefined;
}

function findCurlShortOutputTarget(
  args: readonly ShellToken[],
  index: number
): string | undefined {
  const arg = args[index].value;
  if (!arg.startsWith("-") || arg.startsWith("--") || arg.length < 3) {
    return undefined;
  }

  const optionCluster = arg.slice(1);
  const outputOptionIndex = optionCluster.indexOf("o");
  if (outputOptionIndex === -1) {
    return undefined;
  }

  const attachedTarget = optionCluster.slice(outputOptionIndex + 1);
  const target =
    attachedTarget.length > 0
      ? pathCandidateFromToken(args[index], attachedTarget)
      : args[index + 1];
  return target && isProtectedDataRawCandidate(target) ? target.value : undefined;
}

function isSedInPlaceOption(arg: ShellToken): boolean {
  return (
    arg.value === "-i" ||
    arg.value.startsWith("-i") ||
    (arg.value.startsWith("-") && !arg.value.startsWith("--") && arg.value.slice(1).includes("i")) ||
    arg.value === "--in-place" ||
    arg.value.startsWith("--in-place=")
  );
}

function findFindMutationTarget(args: readonly ShellToken[]): string | undefined {
  if (!hasFindMutationAction(args)) {
    return undefined;
  }

  return findRawPathArgument(args);
}

function hasFindMutationAction(args: readonly ShellToken[]): boolean {
  return args.some((arg) => FIND_MUTATION_ACTIONS.has(arg.value));
}

function findGitCloneTarget(args: readonly ShellToken[]): string | undefined {
  const cloneIndex = args.findIndex((arg) => arg.value === "clone");
  if (cloneIndex === -1) {
    return undefined;
  }

  const positionalArgs = args
    .slice(cloneIndex + 1)
    .filter((arg) => !arg.value.startsWith("-"));
  if (positionalArgs.length < 2) {
    return undefined;
  }

  const destination = positionalArgs.at(-1);
  return destination && isProtectedDataRawCandidate(destination) ? destination.value : undefined;
}

function findTarExtractionTarget(args: readonly ShellToken[]): string | undefined {
  if (!isTarExtractCommand(args)) {
    return undefined;
  }

  const targetDirectory = findOptionValue(args, {
    separate: new Set(["-C", "--directory"]),
    longAssignments: ["--directory="],
    shortAttached: "-C"
  });
  if (targetDirectory && isProtectedDataRawCandidate(targetDirectory)) {
    return targetDirectory.value;
  }

  return undefined;
}

function isTarExtractCommand(args: readonly ShellToken[]): boolean {
  return args.some((arg, index) => {
    if (arg.value === "--extract") {
      return true;
    }
    if (arg.value.startsWith("-") && !arg.value.startsWith("--")) {
      return arg.value.includes("x");
    }
    return index === 0 && /^[A-Za-z]+$/.test(arg.value) && arg.value.includes("x");
  });
}

function findUnzipExtractionTarget(args: readonly ShellToken[]): string | undefined {
  const targetDirectory = findOptionValue(args, {
    separate: new Set(["-d"]),
    shortAttached: "-d"
  });
  return targetDirectory && isProtectedDataRawCandidate(targetDirectory)
    ? targetDirectory.value
    : undefined;
}

function findWgetOutputTarget(args: readonly ShellToken[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.value === "-O" || arg.value === "--output-document") {
      const target = args[index + 1];
      if (target && isProtectedDataRawCandidate(target)) {
        return target.value;
      }
      continue;
    }
    if (arg.value.startsWith("--output-document=")) {
      const target = pathCandidateFromToken(
        arg,
        arg.value.slice("--output-document=".length)
      );
      if (isProtectedDataRawCandidate(target)) {
        return target.value;
      }
      continue;
    }
    if (arg.value.startsWith("-O") && !arg.value.startsWith("--") && arg.value.length > 2) {
      const target = pathCandidateFromToken(arg, arg.value.slice("-O".length));
      if (isProtectedDataRawCandidate(target)) {
        return target.value;
      }
      continue;
    }

    const targetDirectory = findWgetDirectoryPrefixTarget(args, index);
    if (targetDirectory) {
      return targetDirectory;
    }
  }

  return undefined;
}

function findWgetDirectoryPrefixTarget(
  args: readonly ShellToken[],
  index: number
): string | undefined {
  const target = findOptionValueAt(args, index, {
    separate: new Set(["-P", "--directory-prefix"]),
    longAssignments: ["--directory-prefix="],
    shortAttached: "-P"
  });
  return target && isProtectedDataRawCandidate(target) ? target.value : undefined;
}

function findOptionValue(
  args: readonly ShellToken[],
  options: {
    separate?: ReadonlySet<string>;
    longAssignments?: readonly string[];
    shortAttached?: string;
  }
): PathCandidate | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const target = findOptionValueAt(args, index, options);
    if (target !== undefined) {
      return target;
    }
  }

  return undefined;
}

function findOptionValueAt(
  args: readonly ShellToken[],
  index: number,
  options: {
    separate?: ReadonlySet<string>;
    longAssignments?: readonly string[];
    shortAttached?: string;
  }
): PathCandidate | undefined {
  const arg = args[index];
  if (!arg) {
    return undefined;
  }

  if (options.separate?.has(arg.value)) {
    return args[index + 1] ? pathCandidateFromToken(args[index + 1]) : undefined;
  }

  for (const assignmentPrefix of options.longAssignments ?? []) {
    if (arg.value.startsWith(assignmentPrefix)) {
      return pathCandidateFromToken(arg, arg.value.slice(assignmentPrefix.length));
    }
  }

  if (
    options.shortAttached &&
    arg.value.startsWith(options.shortAttached) &&
    !arg.value.startsWith("--") &&
    arg.value.length > options.shortAttached.length
  ) {
    return pathCandidateFromToken(arg, arg.value.slice(options.shortAttached.length));
  }

  return undefined;
}

function findEvalCommandTarget(
  args: readonly ShellToken[],
  variables: ReadonlyMap<string, string>
): string | undefined {
  const command = args.map((arg) => arg.value).join(" ").trim();
  return command ? findProtectedDataRawWriteTarget(command, variables) : undefined;
}

function isExecutableCodeStringCommand(command: string): boolean {
  const normalized = command.toLowerCase();
  return (
    normalized === "bun" ||
    normalized === "deno" ||
    normalized === "node" ||
    normalized === "perl" ||
    normalized === "php" ||
    normalized === "r" ||
    normalized === "rscript" ||
    normalized === "ruby" ||
    normalized === "python" ||
    /^python\d+(?:\.\d+)?$/.test(normalized)
  );
}

function findExecutableCodeStringRawTarget(
  command: string,
  args: readonly ShellToken[]
): string | undefined {
  const denoEvalTarget = findDenoEvalRawTarget(command, args);
  if (denoEvalTarget) {
    return denoEvalTarget;
  }

  for (let index = 0; index < args.length; index += 1) {
    const codeString = findExecutableCodeStringAt(args, index);
    if (!codeString) {
      continue;
    }

    const target = findProtectedRawPathInText(codeString);
    if (target) {
      return target;
    }
  }

  return undefined;
}

function findDenoEvalRawTarget(command: string, args: readonly ShellToken[]): string | undefined {
  if (command.toLowerCase() !== "deno" || args[0]?.value !== "eval") {
    return undefined;
  }

  const codeString = args.find((arg, index) => index > 0 && !arg.value.startsWith("-"))?.value;
  return codeString ? findProtectedRawPathInText(codeString) : undefined;
}

function findExecutableCodeStringAt(
  args: readonly ShellToken[],
  index: number
): string | undefined {
  const arg = args[index];
  if (!arg) {
    return undefined;
  }

  if (arg.value === "-c" || arg.value === "-e" || arg.value === "-E" || arg.value === "-p") {
    return args[index + 1]?.value;
  }
  if (arg.value === "--eval" || arg.value === "--print") {
    return args[index + 1]?.value;
  }
  if (arg.value.startsWith("--eval=")) {
    return arg.value.slice("--eval=".length);
  }
  if (arg.value.startsWith("--print=")) {
    return arg.value.slice("--print=".length);
  }
  if (
    !arg.value.startsWith("--") &&
    (arg.value.startsWith("-c") ||
      arg.value.startsWith("-e") ||
      arg.value.startsWith("-E") ||
      arg.value.startsWith("-p")) &&
    arg.value.length > 2
  ) {
    return arg.value.slice(2);
  }
  if (!arg.value.startsWith("--") && arg.value.startsWith("-r") && arg.value.length > 2) {
    return arg.value.slice(2);
  }
  if (arg.value === "-r") {
    return args[index + 1]?.value;
  }

  return undefined;
}

function findShellCommandArgument(args: readonly ShellToken[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index].value;
    if (arg === "--") {
      continue;
    }
    if (arg === "-c") {
      return args[index + 1]?.value;
    }
    if (arg.startsWith("-") && !arg.startsWith("--") && arg.includes("c")) {
      return args[index + 1]?.value;
    }
  }

  return undefined;
}

function expandSegmentParameterReferences(
  segment: readonly ShellToken[],
  variables: ReadonlyMap<string, string>
): ShellToken[] {
  if (variables.size === 0) {
    return [...segment];
  }

  return segment.map((token) => expandTokenParameterReferences(token, variables));
}

function expandTokenParameterReferences(
  token: ShellToken,
  variables: ReadonlyMap<string, string>
): ShellToken {
  if (!token.expandsParameters || !token.value.includes("$")) {
    return token;
  }

  const expandedValue = token.value.replace(
    /\$(?:{([A-Za-z_][A-Za-z0-9_]*)}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (match, bracedName: string | undefined, bareName: string | undefined) => {
      const variableName = bracedName ?? bareName;
      const value = variableName ? variables.get(variableName) : undefined;
      return value ?? match;
    }
  );

  return expandedValue === token.value ? token : { ...token, value: expandedValue };
}

function recordVariableAssignments(
  segment: readonly ShellToken[],
  variables: Map<string, string>
): void {
  const commandIndex = findCommandTokenIndex(segment);
  if (commandIndex === undefined) {
    for (const token of segment) {
      recordVariableAssignment(token, variables);
    }
    return;
  }

  const command = path.posix.basename(segment[commandIndex].value);
  if (command !== "export") {
    return;
  }

  for (const arg of segment.slice(commandIndex + 1)) {
    if (arg.value.startsWith("-")) {
      continue;
    }
    recordVariableAssignment(arg, variables);
  }
}

function recordVariableAssignment(token: ShellToken, variables: Map<string, string>): void {
  const assignment = token.value.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!assignment) {
    return;
  }

  const [, name, value] = assignment;
  if (!isSimpleLiteralVariableValue(value)) {
    variables.delete(name);
    return;
  }

  variables.set(name, value);
}

function isAssignment(token: ShellToken): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token.value);
}

function isSimpleLiteralVariableValue(value: string): boolean {
  return !/[`$]/.test(value);
}

function pathCandidateFromToken(token: ShellToken, value = token.value): PathCandidate {
  return {
    value,
    quoted: token.quoted,
    fullyQuoted: token.fullyQuoted
  };
}

function isProtectedDataRawCandidate(candidate: PathCandidate): boolean {
  if (isProtectedDataRawPath(candidate.value)) {
    return true;
  }
  return (
    !candidate.fullyQuoted &&
    expandShellBraceAlternatives(candidate.value).some((expanded) =>
      isProtectedDataRawPath(expanded)
    )
  );
}

function findProtectedRawPathInText(value: string): string | undefined {
  const rawPathPattern = /(?:file:\/\/)?[A-Za-z0-9_./@%:+-]*data\/raw(?:\/[A-Za-z0-9_./@%:+-]*)?/g;
  for (const match of value.matchAll(rawPathPattern)) {
    const candidate = match[0];
    if (isProtectedDataRawPath(candidate)) {
      return candidate;
    }

    const rawPathIndex = candidate.indexOf("data/raw");
    if (rawPathIndex !== -1) {
      const relativeCandidate = candidate.slice(rawPathIndex);
      if (isProtectedDataRawPath(relativeCandidate)) {
        return relativeCandidate;
      }
    }
  }

  return undefined;
}

function isProtectedDataRawPath(candidate: string): boolean {
  const normalized = path.posix.normalize(candidate.replace(/^file:\/\//, ""));
  const withoutDotPrefix = normalized.replace(/^\.\/+/, "");
  if (isGovernedTaskWorkspacePath(withoutDotPrefix)) {
    return false;
  }
  return (
    withoutDotPrefix === "data/raw" ||
    withoutDotPrefix.startsWith("data/raw/") ||
    withoutDotPrefix.endsWith("/data/raw") ||
    withoutDotPrefix.includes("/data/raw/")
  );
}

function isGovernedTaskWorkspacePath(candidate: string): boolean {
  const withoutLeadingSlash = candidate.replace(/^\/+/, "");
  return withoutLeadingSlash.startsWith("workspace/tasks/");
}

function expandShellBraceAlternatives(candidate: string): string[] {
  if (!candidate.includes("{")) {
    return [];
  }

  let expanded = [candidate];
  for (let pass = 0; pass < 4; pass += 1) {
    const next: string[] = [];
    let changed = false;

    for (const value of expanded) {
      const expansion = expandFirstBraceExpression(value);
      if (!expansion) {
        next.push(value);
        continue;
      }

      changed = true;
      next.push(...expansion);
      if (next.length > 64) {
        return ["data/raw"];
      }
    }

    expanded = next;
    if (!changed) {
      break;
    }
  }

  if (expanded.some((value) => value.includes("{"))) {
    return ["data/raw"];
  }

  return expanded.filter((value) => value !== candidate);
}

function expandFirstBraceExpression(candidate: string): string[] | undefined {
  const openIndex = candidate.indexOf("{");
  if (openIndex === -1) {
    return undefined;
  }

  let depth = 0;
  for (let index = openIndex; index < candidate.length; index += 1) {
    const char = candidate[index];
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char !== "}") {
      continue;
    }

    depth -= 1;
    if (depth !== 0) {
      continue;
    }

    const body = candidate.slice(openIndex + 1, index);
    const alternatives = splitBraceAlternatives(body);
    if (alternatives.length < 2) {
      return undefined;
    }

    const prefix = candidate.slice(0, openIndex);
    const suffix = candidate.slice(index + 1);
    return alternatives.map((alternative) => `${prefix}${alternative}${suffix}`);
  }

  return undefined;
}

function splitBraceAlternatives(body: string): string[] {
  const alternatives: string[] = [];
  let current = "";
  let depth = 0;

  for (const char of body) {
    if (char === "{") {
      depth += 1;
      current += char;
      continue;
    }
    if (char === "}") {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }
    if (char === "," && depth === 0) {
      alternatives.push(current);
      current = "";
      continue;
    }
    current += char;
  }

  alternatives.push(current);
  return alternatives;
}

function tokenizeShellCommand(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let current = "";
  let currentQuoted = false;
  let currentHasUnquotedContent = false;
  let currentExpandsParameters = false;
  let quote: ShellQuote | undefined;
  let index = 0;

  const flush = () => {
    if (current.length > 0) {
      tokens.push({
        value: current,
        fromOperator: false,
        quoted: currentQuoted,
        fullyQuoted: currentQuoted && !currentHasUnquotedContent,
        expandsParameters: currentExpandsParameters
      });
      current = "";
      currentQuoted = false;
      currentHasUnquotedContent = false;
      currentExpandsParameters = false;
    }
  };

  while (index < command.length) {
    const char = command[index];

    if (quote) {
      if (char === "\\" && quote.ansiC) {
        const escape = readAnsiCEscape(command, index);
        current += escape.value;
        index = escape.nextIndex;
        continue;
      }
      if (char === "\\" && quote.char === `"`) {
        const next = command[index + 1];
        if (next !== undefined) {
          current += next;
          currentExpandsParameters =
            currentExpandsParameters || (quote.expandsParameters && next !== "$");
          index += 2;
          continue;
        }
      }
      if (char === quote.char) {
        quote = undefined;
        index += 1;
        continue;
      }
      current += char;
      currentExpandsParameters = currentExpandsParameters || quote.expandsParameters;
      index += 1;
      continue;
    }

    const quoteStart = readShellQuoteStart(command, index);
    if (quoteStart) {
      quote = quoteStart.quote;
      currentQuoted = true;
      index += quoteStart.length;
      continue;
    }

    if (char === "\n" || char === "\r") {
      flush();
      tokens.push({
        value: ";",
        fromOperator: true,
        quoted: false,
        fullyQuoted: false,
        expandsParameters: false
      });
      index += 1;
      continue;
    }

    if (/\s/.test(char)) {
      flush();
      index += 1;
      continue;
    }

    const operator = readShellOperator(command, index);
    if (operator) {
      flush();
      tokens.push({
        value: operator,
        fromOperator: true,
        quoted: false,
        fullyQuoted: false,
        expandsParameters: false
      });
      index += operator.length;
      continue;
    }

    if (char === "\\") {
      const next = command[index + 1];
      if (next !== undefined) {
        current += next;
        currentHasUnquotedContent = true;
        currentExpandsParameters = currentExpandsParameters || next !== "$";
        index += 2;
        continue;
      }
    }

    current += char;
    currentHasUnquotedContent = true;
    currentExpandsParameters = true;
    index += 1;
  }

  flush();
  return tokens;
}

function findCommandSubstitutionWriteTarget(
  command: string,
  variables: ReadonlyMap<string, string> = new Map()
): string | undefined {
  let quote: ShellQuote | undefined;
  let index = 0;

  while (index < command.length) {
    const char = command[index];

    if (quote?.char === "'") {
      if (char === "\\" && quote.ansiC) {
        index = readAnsiCEscape(command, index).nextIndex;
        continue;
      }
      if (char === quote.char) {
        quote = undefined;
      }
      index += 1;
      continue;
    }

    if (quote?.char === `"`) {
      if (char === "\\") {
        index += command[index + 1] === undefined ? 1 : 2;
        continue;
      }
      if (char === `"`) {
        quote = undefined;
        index += 1;
        continue;
      }
      if (
        !(char === "$" && command[index + 1] === "(") &&
        !((char === "<" || char === ">") && command[index + 1] === "(") &&
        char !== "`"
      ) {
        index += 1;
        continue;
      }
    }

    const quoteStart = quote ? undefined : readShellQuoteStart(command, index);
    if (quoteStart) {
      quote = quoteStart.quote;
      index += quoteStart.length;
      continue;
    }

    if (char === "\\") {
      index += command[index + 1] === undefined ? 1 : 2;
      continue;
    }

    if (char === "$" && command[index + 1] === "(") {
      const substitution = readCommandSubstitution(command, index + 1);
      if (!substitution) {
        return undefined;
      }

      const target = findProtectedDataRawWriteTarget(substitution.content, variables);
      if (target) {
        return target;
      }
      index = substitution.endIndex + 1;
      continue;
    }

    if ((char === "<" || char === ">") && command[index + 1] === "(") {
      const substitution = readCommandSubstitution(command, index + 1);
      if (!substitution) {
        return undefined;
      }

      const target = findProtectedDataRawWriteTarget(substitution.content, variables);
      if (target) {
        return target;
      }
      index = substitution.endIndex + 1;
      continue;
    }

    if (char === "`") {
      const substitution = readBacktickCommandSubstitution(command, index);
      if (!substitution) {
        return undefined;
      }

      const target = findProtectedDataRawWriteTarget(substitution.content, variables);
      if (target) {
        return target;
      }
      index = substitution.endIndex + 1;
      continue;
    }

    index += 1;
  }

  return undefined;
}

function readShellQuoteStart(
  command: string,
  index: number
): { quote: ShellQuote; length: number } | undefined {
  const char = command[index];
  if (char === "'" || char === `"`) {
    return { quote: { char, ansiC: false, expandsParameters: char === `"` }, length: 1 };
  }

  const next = command[index + 1];
  if (char === "$" && (next === "'" || next === `"`)) {
    return {
      quote: { char: next, ansiC: next === "'", expandsParameters: next === `"` },
      length: 2
    };
  }

  return undefined;
}

function readAnsiCEscape(command: string, index: number): { value: string; nextIndex: number } {
  const escaped = command[index + 1];
  if (escaped === undefined) {
    return { value: "\\", nextIndex: index + 1 };
  }

  const simpleEscapes: Record<string, string> = {
    a: "\u0007",
    b: "\b",
    e: "\u001B",
    E: "\u001B",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
    "\\": "\\",
    "'": "'",
    '"': '"'
  };
  const simpleEscape = simpleEscapes[escaped];
  if (simpleEscape !== undefined) {
    return { value: simpleEscape, nextIndex: index + 2 };
  }

  if (escaped === "x") {
    const match = command.slice(index + 2).match(/^[0-9A-Fa-f]{1,2}/);
    if (match) {
      return {
        value: String.fromCharCode(Number.parseInt(match[0], 16)),
        nextIndex: index + 2 + match[0].length
      };
    }
    return { value: "x", nextIndex: index + 2 };
  }

  if (escaped === "u" || escaped === "U") {
    const maxDigits = escaped === "u" ? 4 : 8;
    const match = command.slice(index + 2).match(new RegExp(`^[0-9A-Fa-f]{1,${maxDigits}}`));
    if (match) {
      const codePoint = Number.parseInt(match[0], 16);
      return {
        value: Number.isNaN(codePoint) ? "" : String.fromCodePoint(codePoint),
        nextIndex: index + 2 + match[0].length
      };
    }
    return { value: escaped, nextIndex: index + 2 };
  }

  if (/[0-7]/.test(escaped)) {
    const match = command.slice(index + 1).match(/^[0-7]{1,3}/);
    if (match) {
      return {
        value: String.fromCharCode(Number.parseInt(match[0], 8)),
        nextIndex: index + 1 + match[0].length
      };
    }
  }

  return { value: escaped, nextIndex: index + 2 };
}

function readCommandSubstitution(
  command: string,
  openParenIndex: number
): { content: string; endIndex: number } | undefined {
  let quote: ShellQuote | undefined;
  let depth = 1;
  let index = openParenIndex + 1;

  while (index < command.length) {
    const char = command[index];

    if (quote?.char === "'") {
      if (char === "\\" && quote.ansiC) {
        index = readAnsiCEscape(command, index).nextIndex;
        continue;
      }
      if (char === quote.char) {
        quote = undefined;
      }
      index += 1;
      continue;
    }

    if (quote?.char === `"`) {
      if (char === "$" && command[index + 1] === "(") {
        const substitution = readCommandSubstitution(command, index + 1);
        if (!substitution) {
          return undefined;
        }
        index = substitution.endIndex + 1;
        continue;
      }
      if ((char === "<" || char === ">") && command[index + 1] === "(") {
        const substitution = readCommandSubstitution(command, index + 1);
        if (!substitution) {
          return undefined;
        }
        index = substitution.endIndex + 1;
        continue;
      }
      if (char === "`") {
        const substitution = readBacktickCommandSubstitution(command, index);
        if (!substitution) {
          return undefined;
        }
        index = substitution.endIndex + 1;
        continue;
      }
      if (char === "\\") {
        index += command[index + 1] === undefined ? 1 : 2;
        continue;
      }
      if (char === `"`) {
        quote = undefined;
        index += 1;
        continue;
      }
      index += 1;
      continue;
    }

    const quoteStart = quote ? undefined : readShellQuoteStart(command, index);
    if (quoteStart) {
      quote = quoteStart.quote;
      index += quoteStart.length;
      continue;
    }

    if (char === "\\") {
      index += command[index + 1] === undefined ? 1 : 2;
      continue;
    }

    if (char === "(") {
      depth += 1;
      index += 1;
      continue;
    }

    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return {
          content: command.slice(openParenIndex + 1, index),
          endIndex: index
        };
      }
    }

    index += 1;
  }

  return undefined;
}

function readBacktickCommandSubstitution(
  command: string,
  openBacktickIndex: number
): { content: string; endIndex: number } | undefined {
  let content = "";
  let index = openBacktickIndex + 1;

  while (index < command.length) {
    const char = command[index];

    if (char === "\\") {
      const next = command[index + 1];
      if (next !== undefined) {
        content += `${char}${next}`;
        index += 2;
        continue;
      }
    }

    if (char === "`") {
      return {
        content,
        endIndex: index
      };
    }

    content += char;
    index += 1;
  }

  return undefined;
}

function readShellOperator(command: string, index: number): string | undefined {
  for (const operator of [
    "&>>",
    "&>",
    "&&",
    ">&",
    "1>>",
    "2>>",
    ">>",
    ">|",
    "1>",
    "2>",
    "||",
    ">",
    "|",
    ";",
    "&"
  ]) {
    if (command.startsWith(operator, index)) {
      return operator;
    }
  }

  return undefined;
}
