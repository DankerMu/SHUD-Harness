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
const READ_ONLY_RAW_PATH_COMMANDS = new Set([
  "cat",
  "grep",
  "head",
  "ls",
  "sha256sum",
  "stat",
  "tail",
  "wc"
]);
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
const LOCAL_URL_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const EXECUTABLE_CODE_STDIN_ARG = "-";

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
  expandsParameters: boolean;
};

type PathEvaluationContext = {
  cwd?: string;
};

type ShellScanState = {
  variables: Map<string, string>;
  cwd?: string;
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

    const target = findProtectedDataRawWriteTarget(command, new Map(), call.workDir);
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
  initialVariables: ReadonlyMap<string, string> = new Map(),
  workDir?: string
): string | undefined {
  return findProtectedDataRawWriteTargetWithState(command, {
    variables: new Map(initialVariables),
    cwd: normalizeInitialCwd(workDir)
  });
}

function findProtectedDataRawWriteTargetWithState(
  command: string,
  state: ShellScanState
): string | undefined {
  const heredocTarget = findExecutableHeredocRawWriteTarget(command, state);
  if (heredocTarget) {
    return heredocTarget;
  }

  const substitutionTarget = findCommandSubstitutionWriteTarget(command, state);
  if (substitutionTarget) {
    return substitutionTarget;
  }

  const tokens = tokenizeShellCommand(command);
  const pathContext = (): PathEvaluationContext => ({ cwd: state.cwd });

  for (const segment of splitCommandSegments(tokens)) {
    const expandedSegment = expandSegmentParameterReferences(segment, state.variables);
    const redirectTarget = findRedirectWriteTarget(expandedSegment, pathContext());
    if (redirectTarget) {
      return redirectTarget;
    }

    const mutationTarget = findMutationCommandTarget(
      expandedSegment,
      state.variables,
      pathContext()
    );
    if (mutationTarget) {
      return mutationTarget;
    }

    updateCwdFromCdSegment(expandedSegment, state);
    recordVariableAssignments(expandedSegment, state.variables);
  }

  return undefined;
}

export function makeDataRawPolicyGateContext() {
  return {
    rules: [DATA_RAW_WRITE_DENY_RULE]
  };
}

export type DataRawWritePolicyCall = PolicyGateToolCall;

function findRedirectWriteTarget(
  tokens: readonly ShellToken[],
  context: PathEvaluationContext
): string | undefined {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!isUnquotedOperatorToken(token, REDIRECT_WRITE_OPERATORS)) {
      continue;
    }

    const target = tokens[index + 1];
    if (target && isProtectedDataRawCandidate(target, context)) {
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
  variables: ReadonlyMap<string, string>,
  context: PathEvaluationContext
): string | undefined {
  const wrapperUncertaintyTarget = findWrapperUncertaintyRawCandidate(segment, context);
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
    const target = findEvalCommandTarget(args, variables, context);
    if (target) {
      return target;
    }
  }
  if (isExecutableCodeStringCommand(command)) {
    const target = findExecutableCodeStringRawMutationTarget(command, args, context);
    if (target) {
      return target;
    }
  }
  if (ANY_RAW_PATH_MUTATION_COMMANDS.has(command)) {
    const target = findRawPathArgument(args, context);
    if (target) {
      return target;
    }
  }
  if (DESTINATION_RAW_PATH_COMMANDS.has(command)) {
    const target = findDestinationRawPathTarget(args, context);
    if (target) {
      return target;
    }
  }
  if (ANY_ENDPOINT_RAW_PATH_COMMANDS.has(command)) {
    const target = findRawPathArgument(args, context);
    if (target) {
      return target;
    }
  }
  if (command === "dd") {
    const target = findDdOutputTarget(args, context);
    if (target) {
      return target;
    }
  }
  if (command === "tee") {
    const target = args.find(
      (arg) => !arg.value.startsWith("-") && isProtectedDataRawCandidate(arg, context)
    )?.value;
    if (target) {
      return target;
    }
  }
  if (command === "sed" && args.some(isSedInPlaceOption)) {
    const target = findRawPathArgument(args, context);
    if (target) {
      return target;
    }
  }
  if (command === "curl") {
    const target = findCurlOutputTarget(args, context);
    if (target) {
      return target;
    }
  }
  if (command === "find") {
    const target = findFindMutationTarget(args, context);
    if (target) {
      return target;
    }
  }
  if (command === "git") {
    const target = findGitCloneTarget(args, context);
    if (target) {
      return target;
    }
  }
  if (command === "tar") {
    const target = findTarExtractionTarget(args, context);
    if (target) {
      return target;
    }
  }
  if (command === "unzip") {
    const target = findUnzipExtractionTarget(args, context);
    if (target) {
      return target;
    }
  }
  if (command === "wget") {
    const target = findWgetOutputTarget(args, context);
    if (target) {
      return target;
    }
  }
  if (SHELL_COMMANDS.has(command)) {
    const shellCommand = findShellCommandArgument(args);
    const target = shellCommand
      ? findProtectedDataRawWriteTargetWithState(shellCommand, {
          variables: new Map(variables),
          cwd: context.cwd
        })
      : undefined;
    if (target) {
      return target;
    }
  }

  const rawPathCandidate = findRawPathCandidate(segment, context);
  if (!rawPathCandidate || isReadOnlySafeRawPathCommand(command, args, context)) {
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

function findWrapperUncertaintyRawCandidate(
  segment: readonly ShellToken[],
  context: PathEvaluationContext
): string | undefined {
  const rawPathCandidate = findRawPathCandidate(segment, context);
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

function findRawPathArgument(
  args: readonly ShellToken[],
  context: PathEvaluationContext
): string | undefined {
  return args.find((arg) => isProtectedDataRawCandidate(arg, context))?.value;
}

function findRawPathCandidate(
  tokens: readonly ShellToken[],
  context: PathEvaluationContext
): string | undefined {
  for (const token of tokens) {
    const candidate = findProtectedRawPathCandidate(token, context);
    if (candidate) {
      return candidate.value;
    }
  }

  return undefined;
}

function findProtectedRawPathCandidate(
  token: ShellToken,
  context: PathEvaluationContext
): PathCandidate | undefined {
  const wholeTokenCandidate = pathCandidateFromToken(token);
  if (isProtectedDataRawCandidate(wholeTokenCandidate, context)) {
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
      return isProtectedDataRawCandidate(assignmentCandidate, context)
        ? assignmentCandidate
        : undefined;
    }

    return undefined;
  }

  return findAttachedShortOptionRawPathCandidate(token, context);
}

function findAttachedShortOptionRawPathCandidate(
  token: ShellToken,
  context: PathEvaluationContext
): PathCandidate | undefined {
  for (let valueStart = 2; valueStart < token.value.length; valueStart += 1) {
    const candidate = pathCandidateFromToken(token, token.value.slice(valueStart));
    if (isProtectedDataRawCandidate(candidate, context)) {
      return candidate;
    }
  }

  return undefined;
}

function isReadOnlySafeRawPathCommand(
  command: string,
  args: readonly ShellToken[],
  context: PathEvaluationContext
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
  if (command === "curl") {
    return findCurlOutputTarget(args, context) === undefined;
  }
  if (command === "wget") {
    return findWgetOutputTarget(args, context) === undefined;
  }

  return command === "cp" && isCopyOutOfRawCommand(args, context);
}

function isCopyOutOfRawCommand(
  args: readonly ShellToken[],
  context: PathEvaluationContext
): boolean {
  const targetDirectory = findTargetDirectoryArgument(args);
  if (targetDirectory !== undefined) {
    return (
      !isProtectedDataRawCandidate(targetDirectory, context) &&
      args.some((arg) => isProtectedDataRawCandidate(arg, context))
    );
  }

  const positionalArgs = args.filter((arg) => !arg.value.startsWith("-"));
  const destination = positionalArgs.at(-1);
  if (!destination || isProtectedDataRawCandidate(destination, context)) {
    return false;
  }

  return positionalArgs.slice(0, -1).some((arg) => isProtectedDataRawCandidate(arg, context));
}

function lastNonOptionArgument(
  args: readonly ShellToken[],
  context: PathEvaluationContext
): string | undefined {
  const target = args.filter((arg) => !arg.value.startsWith("-")).at(-1);
  return target && isProtectedDataRawCandidate(target, context) ? target.value : undefined;
}

function findDestinationRawPathTarget(
  args: readonly ShellToken[],
  context: PathEvaluationContext
): string | undefined {
  const targetDirectory = findTargetDirectoryArgument(args);
  if (targetDirectory !== undefined) {
    return isProtectedDataRawCandidate(targetDirectory, context)
      ? targetDirectory.value
      : undefined;
  }

  return lastNonOptionArgument(args, context);
}

function findTargetDirectoryArgument(args: readonly ShellToken[]): PathCandidate | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index].value;
    if (arg === "-t" || arg === "--target-directory") {
      const target = args[index + 1];
      return target
        ? pathCandidateFromToken(target)
        : { value: "", quoted: false, fullyQuoted: false, expandsParameters: false };
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

function findDdOutputTarget(
  args: readonly ShellToken[],
  context: PathEvaluationContext
): string | undefined {
  for (const arg of args) {
    if (!arg.value.startsWith("of=")) {
      continue;
    }

    const target = pathCandidateFromToken(arg, arg.value.slice("of=".length));
    if (isProtectedDataRawCandidate(target, context)) {
      return target.value;
    }
  }

  return undefined;
}

function findCurlOutputTarget(
  args: readonly ShellToken[],
  context: PathEvaluationContext
): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index].value;
    if (arg === "-o" || arg === "--output") {
      const target = args[index + 1];
      if (target && isProtectedDataRawCandidate(target, context)) {
        return target.value;
      }
      continue;
    }
    if (arg.startsWith("--output=")) {
      const target = pathCandidateFromToken(args[index], arg.slice("--output=".length));
      if (isProtectedDataRawCandidate(target, context)) {
        return target.value;
      }
      continue;
    }

    const shortOptionTarget = findCurlShortOutputTarget(args, index, context);
    if (shortOptionTarget) {
      return shortOptionTarget;
    }
  }

  return undefined;
}

function findCurlShortOutputTarget(
  args: readonly ShellToken[],
  index: number,
  context: PathEvaluationContext
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
  return target && isProtectedDataRawCandidate(target, context) ? target.value : undefined;
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

function findFindMutationTarget(
  args: readonly ShellToken[],
  context: PathEvaluationContext
): string | undefined {
  if (!hasFindMutationAction(args)) {
    return undefined;
  }

  return findRawPathArgument(args, context);
}

function hasFindMutationAction(args: readonly ShellToken[]): boolean {
  return args.some((arg) => FIND_MUTATION_ACTIONS.has(arg.value));
}

function findGitCloneTarget(
  args: readonly ShellToken[],
  context: PathEvaluationContext
): string | undefined {
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
  return destination && isProtectedDataRawCandidate(destination, context)
    ? destination.value
    : undefined;
}

function findTarExtractionTarget(
  args: readonly ShellToken[],
  context: PathEvaluationContext
): string | undefined {
  if (!isTarExtractCommand(args)) {
    return undefined;
  }

  const targetDirectory = findOptionValue(args, {
    separate: new Set(["-C", "--directory"]),
    longAssignments: ["--directory="],
    shortAttached: "-C"
  });
  if (targetDirectory && isProtectedDataRawCandidate(targetDirectory, context)) {
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

function findUnzipExtractionTarget(
  args: readonly ShellToken[],
  context: PathEvaluationContext
): string | undefined {
  const targetDirectory = findOptionValue(args, {
    separate: new Set(["-d"]),
    shortAttached: "-d"
  });
  return targetDirectory && isProtectedDataRawCandidate(targetDirectory, context)
    ? targetDirectory.value
    : undefined;
}

function findWgetOutputTarget(
  args: readonly ShellToken[],
  context: PathEvaluationContext
): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.value === "-O" || arg.value === "--output-document") {
      const target = args[index + 1];
      if (target && isProtectedDataRawCandidate(target, context)) {
        return target.value;
      }
      continue;
    }
    if (arg.value.startsWith("--output-document=")) {
      const target = pathCandidateFromToken(
        arg,
        arg.value.slice("--output-document=".length)
      );
      if (isProtectedDataRawCandidate(target, context)) {
        return target.value;
      }
      continue;
    }
    if (arg.value.startsWith("-O") && !arg.value.startsWith("--") && arg.value.length > 2) {
      const target = pathCandidateFromToken(arg, arg.value.slice("-O".length));
      if (isProtectedDataRawCandidate(target, context)) {
        return target.value;
      }
      continue;
    }

    const targetDirectory = findWgetDirectoryPrefixTarget(args, index, context);
    if (targetDirectory) {
      return targetDirectory;
    }
  }

  return undefined;
}

function findWgetDirectoryPrefixTarget(
  args: readonly ShellToken[],
  index: number,
  context: PathEvaluationContext
): string | undefined {
  const target = findOptionValueAt(args, index, {
    separate: new Set(["-P", "--directory-prefix"]),
    longAssignments: ["--directory-prefix="],
    shortAttached: "-P"
  });
  return target && isProtectedDataRawCandidate(target, context) ? target.value : undefined;
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
  variables: ReadonlyMap<string, string>,
  context: PathEvaluationContext
): string | undefined {
  const command = args.map((arg) => arg.value).join(" ").trim();
  return command
    ? findProtectedDataRawWriteTargetWithState(command, {
        variables: new Map(variables),
        cwd: context.cwd
      })
    : undefined;
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

function findExecutableCodeStringRawMutationTarget(
  command: string,
  args: readonly ShellToken[],
  context: PathEvaluationContext
): string | undefined {
  const denoEvalTarget = findDenoEvalRawMutationTarget(command, args, context);
  if (denoEvalTarget) {
    return denoEvalTarget;
  }

  for (let index = 0; index < args.length; index += 1) {
    const codeString = findExecutableCodeStringAt(args, index);
    if (!codeString) {
      continue;
    }

    const target = findExecutableCodeRawMutationTargetInText(codeString, context);
    if (target) {
      return target;
    }
  }

  return undefined;
}

function findDenoEvalRawMutationTarget(
  command: string,
  args: readonly ShellToken[],
  context: PathEvaluationContext
): string | undefined {
  if (command.toLowerCase() !== "deno" || args[0]?.value !== "eval") {
    return undefined;
  }

  const codeString = args.find((arg, index) => index > 0 && !arg.value.startsWith("-"))?.value;
  return codeString ? findExecutableCodeRawMutationTargetInText(codeString, context) : undefined;
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

function findExecutableHeredocRawWriteTarget(
  command: string,
  state: ShellScanState
): string | undefined {
  const lines = command.split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const heredoc = parseHeredocStart(lines[lineIndex]);
    if (!heredoc) {
      continue;
    }

    const bodyLines: string[] = [];
    let bodyIndex = lineIndex + 1;
    for (; bodyIndex < lines.length; bodyIndex += 1) {
      const delimiterLine = heredoc.stripLeadingTabs
        ? lines[bodyIndex].replace(/^\t+/, "")
        : lines[bodyIndex];
      if (delimiterLine === heredoc.delimiter) {
        break;
      }
      bodyLines.push(lines[bodyIndex]);
    }

    if (bodyIndex >= lines.length) {
      continue;
    }

    const target = findExecutableStdinRawWriteTarget(
      heredoc.preamble,
      bodyLines.join("\n"),
      state
    );
    if (target) {
      return target;
    }

    lineIndex = bodyIndex;
  }

  return undefined;
}

function parseHeredocStart(line: string):
  | {
      preamble: string;
      delimiter: string;
      stripLeadingTabs: boolean;
    }
  | undefined {
  const match = line.match(/<<(-)?\s*(?:"([^"]+)"|'([^']+)'|([^ \t;&|<>]+))/);
  if (!match || match.index === undefined) {
    return undefined;
  }

  return {
    preamble: line.slice(0, match.index).trimEnd(),
    delimiter: match[2] ?? match[3] ?? match[4] ?? "",
    stripLeadingTabs: match[1] === "-"
  };
}

function findExecutableStdinRawWriteTarget(
  preamble: string,
  body: string,
  state: ShellScanState
): string | undefined {
  const tokens = tokenizeShellCommand(preamble);
  const segment = splitCommandSegments(tokens).at(-1);
  if (!segment) {
    return undefined;
  }

  const expandedSegment = expandSegmentParameterReferences(segment, state.variables);
  const commandIndex = findCommandTokenIndex(expandedSegment);
  if (commandIndex === undefined) {
    return undefined;
  }

  const command = path.posix.basename(expandedSegment[commandIndex].value);
  const args = expandedSegment.slice(commandIndex + 1);
  if (SHELL_COMMANDS.has(command)) {
    return findProtectedDataRawWriteTargetWithState(body, {
      variables: new Map(state.variables),
      cwd: state.cwd
    });
  }

  if (!isExecutableCodeStringCommand(command) || !receivesExecutableCodeFromStdin(args)) {
    return undefined;
  }

  return findExecutableCodeRawMutationTargetInText(body, { cwd: state.cwd });
}

function receivesExecutableCodeFromStdin(args: readonly ShellToken[]): boolean {
  const firstPositional = args.find((arg) => !arg.value.startsWith("-"));
  return firstPositional === undefined || firstPositional.value === EXECUTABLE_CODE_STDIN_ARG;
}

function updateCwdFromCdSegment(segment: readonly ShellToken[], state: ShellScanState): void {
  const commandIndex = findCommandTokenIndex(segment);
  if (commandIndex === undefined) {
    return;
  }

  const command = path.posix.basename(segment[commandIndex].value);
  if (command !== "cd") {
    return;
  }

  const target = segment.slice(commandIndex + 1).find((arg) => !arg.value.startsWith("-"));
  if (!target || target.value === "-" || !isSimpleLiteralCdTarget(target)) {
    return;
  }

  state.cwd = resolveShellPath(state.cwd, target.value);
}

function isSimpleLiteralCdTarget(target: ShellToken): boolean {
  return !/[`$*?\[\]{}]/.test(target.value);
}

function resolveShellPath(cwd: string | undefined, target: string): string {
  if (path.isAbsolute(target) || path.posix.isAbsolute(target)) {
    return path.resolve(target);
  }
  return path.resolve(cwd ?? process.cwd(), target);
}

function normalizeInitialCwd(workDir: string | undefined): string | undefined {
  return workDir ? path.resolve(workDir) : undefined;
}

function findExecutableCodeRawMutationTargetInText(
  value: string,
  context: PathEvaluationContext
): string | undefined {
  for (const target of findProtectedRawPathsInText(value, context)) {
    if (hasExecutableCodeWriteIntentForRawPath(value, target)) {
      return target;
    }
  }

  return undefined;
}

function findProtectedRawPathsInText(
  value: string,
  context: PathEvaluationContext
): string[] {
  const targets: string[] = [];
  const rawPathPattern = /(?:file:\/\/)?[A-Za-z0-9_./@%:+-]*data\/raw(?:\/[A-Za-z0-9_./@%:+-]*)?/g;
  for (const match of value.matchAll(rawPathPattern)) {
    const candidate = match[0];
    if (isProtectedDataRawPath(candidate, context)) {
      targets.push(candidate);
      continue;
    }

    const rawPathIndex = candidate.indexOf("data/raw");
    if (rawPathIndex !== -1) {
      const relativeCandidate = candidate.slice(rawPathIndex);
      if (isProtectedDataRawPath(relativeCandidate, context)) {
        targets.push(relativeCandidate);
      }
    }
  }

  return targets;
}

function hasExecutableCodeWriteIntentForRawPath(value: string, target: string): boolean {
  const escapedTarget = escapeRegExp(target);
  const codeBeforeRawCloseParen = `[^)]*${escapedTarget}[^)]*`;

  return [
    new RegExp(`\\bopen\\s*\\(${codeBeforeRawCloseParen},\\s*["'][^"']*[wax+][^"']*["']`, "i"),
    new RegExp(`\\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream)\\s*\\(${codeBeforeRawCloseParen}`, "i"),
    new RegExp(`\\b(?:unlink|unlinkSync|rm|rmSync|remove|removeSync|rename|renameSync|mkdir|mkdirSync|rmdir|rmdirSync|truncate|truncateSync)\\s*\\(${codeBeforeRawCloseParen}`, "i"),
    new RegExp(`\\bPath\\s*\\(${codeBeforeRawCloseParen}\\)\\.write_(?:text|bytes)\\s*\\(`, "i"),
    new RegExp(`${escapedTarget}[^\\n;)]*\\.write_(?:text|bytes)\\s*\\(`, "i")
  ].some((pattern) => pattern.test(value));
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
    fullyQuoted: token.fullyQuoted,
    expandsParameters: token.expandsParameters
  };
}

function isProtectedDataRawCandidate(
  candidate: PathCandidate,
  context: PathEvaluationContext
): boolean {
  if (isProtectedDataRawPath(candidate.value, context)) {
    return true;
  }
  if (
    !candidate.fullyQuoted &&
    expandShellBraceAlternatives(candidate.value).some((expanded) =>
      isProtectedDataRawPath(expanded, context)
    )
  ) {
    return true;
  }

  return canUnresolvedShellPathResolveToProtectedRaw(candidate, context);
}

function isProtectedDataRawPath(
  candidate: string,
  context: PathEvaluationContext = {}
): boolean {
  return candidatePathVariants(candidate, context).some((variant) =>
    isProtectedDataRawPathVariant(variant)
  );
}

function isProtectedDataRawPathVariant(candidate: string): boolean {
  const normalized = path.posix.normalize(candidate).replace(/^\.\/+/, "");
  const segments = pathSegments(normalized);
  const rawIndex = findAdjacentSegmentIndex(segments, "data", "raw");
  if (rawIndex === -1) {
    return false;
  }

  const workspaceIndex = findAdjacentSegmentIndex(segments, "workspace", "tasks");
  return workspaceIndex === -1 || rawIndex < workspaceIndex;
}

function candidatePathVariants(
  candidate: string,
  context: PathEvaluationContext
): string[] {
  const localCandidate = normalizeLocalPathCandidate(candidate);
  if (!localCandidate) {
    return [];
  }

  const variants = [localCandidate];
  if (context.cwd && isRelativeLocalPath(localCandidate)) {
    variants.push(path.resolve(context.cwd, localCandidate));
  }

  return variants;
}

function normalizeLocalPathCandidate(candidate: string): string | undefined {
  if (candidate.startsWith("file://")) {
    return candidate.slice("file://".length);
  }
  if (LOCAL_URL_SCHEME_PATTERN.test(candidate)) {
    return undefined;
  }
  return candidate;
}

function isRelativeLocalPath(candidate: string): boolean {
  return !path.isAbsolute(candidate) && !path.posix.isAbsolute(candidate);
}

function pathSegments(candidate: string): string[] {
  return candidate.split(/[\\/]+/).filter((segment) => segment.length > 0);
}

function findAdjacentSegmentIndex(
  segments: readonly string[],
  first: string,
  second: string
): number {
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (segments[index] === first && segments[index + 1] === second) {
      return index;
    }
  }

  return -1;
}

function canUnresolvedShellPathResolveToProtectedRaw(
  candidate: PathCandidate,
  context: PathEvaluationContext
): boolean {
  if (candidate.fullyQuoted && !candidate.expandsParameters) {
    return false;
  }

  for (const expandedDefault of expandParameterDefaultCandidates(candidate.value)) {
    if (isProtectedDataRawPath(expandedDefault, context)) {
      return true;
    }
  }

  const pattern = shellExpansionPattern(candidate);
  if (!pattern) {
    return false;
  }

  return candidatePathVariants(pattern, context).some((variant) =>
    shellPathPatternCanMatchProtectedRaw(variant)
  );
}

function expandParameterDefaultCandidates(value: string): string[] {
  if (!value.includes("${")) {
    return [];
  }

  const expanded = value.replace(
    /\$\{[A-Za-z_][A-Za-z0-9_]*(?::[-=+?]|[-=+?])([^}]*)\}/g,
    (_match, defaultValue: string) => defaultValue
  );
  return expanded === value ? [] : [expanded];
}

function shellExpansionPattern(candidate: PathCandidate): string | undefined {
  let pattern = candidate.value;
  let changed = false;

  if (candidate.expandsParameters) {
    const withCommandSubstitutions = replaceCommandSubstitutionsWithWildcard(pattern);
    changed = changed || withCommandSubstitutions !== pattern;
    pattern = withCommandSubstitutions;

    const withParameterExpansions = pattern.replace(/\$\{[^}]+\}/g, "*");
    changed = changed || withParameterExpansions !== pattern;
    pattern = withParameterExpansions;
  }

  if (!candidate.quoted && /[*?\[]/.test(pattern)) {
    changed = true;
  }

  return changed ? pattern : undefined;
}

function replaceCommandSubstitutionsWithWildcard(value: string): string {
  let result = "";
  let index = 0;

  while (index < value.length) {
    if (value[index] === "$" && value[index + 1] === "(") {
      const substitution = readCommandSubstitution(value, index + 1);
      if (!substitution) {
        result += "*";
        index += 2;
        continue;
      }
      result += "*";
      index = substitution.endIndex + 1;
      continue;
    }

    if (value[index] === "`") {
      const substitution = readBacktickCommandSubstitution(value, index);
      if (!substitution) {
        result += "*";
        index += 1;
        continue;
      }
      result += "*";
      index = substitution.endIndex + 1;
      continue;
    }

    result += value[index];
    index += 1;
  }

  return result;
}

function shellPathPatternCanMatchProtectedRaw(pattern: string): boolean {
  const segments = pathSegments(path.posix.normalize(pattern));
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (
      shellSegmentPatternCanMatchLiteral(segments[index], "data") &&
      shellSegmentPatternCanMatchLiteral(segments[index + 1], "raw")
    ) {
      const workspaceIndex = findAdjacentSegmentIndex(segments, "workspace", "tasks");
      return workspaceIndex === -1 || index < workspaceIndex;
    }
  }

  return false;
}

function shellSegmentPatternCanMatchLiteral(pattern: string, literal: string): boolean {
  const regex = globSegmentPatternToRegex(pattern);
  return regex ? regex.test(literal) : pattern === literal;
}

function globSegmentPatternToRegex(pattern: string): RegExp | undefined {
  let source = "";
  let changed = false;

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      source += ".*";
      changed = true;
      continue;
    }
    if (char === "?") {
      source += ".";
      changed = true;
      continue;
    }
    if (char === "[") {
      const closeIndex = pattern.indexOf("]", index + 1);
      if (closeIndex !== -1) {
        source += pattern.slice(index, closeIndex + 1);
        index = closeIndex;
        changed = true;
        continue;
      }
    }
    source += escapeRegExp(char);
  }

  return changed ? new RegExp(`^${source}$`) : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
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

    if (char === "$" && command[index + 1] === "(") {
      const substitution = readCommandSubstitution(command, index + 1);
      if (substitution) {
        current += command.slice(index, substitution.endIndex + 1);
        currentHasUnquotedContent = true;
        currentExpandsParameters = true;
        index = substitution.endIndex + 1;
        continue;
      }
    }

    if (char === "`") {
      const substitution = readBacktickCommandSubstitution(command, index);
      if (substitution) {
        current += command.slice(index, substitution.endIndex + 1);
        currentHasUnquotedContent = true;
        currentExpandsParameters = true;
        index = substitution.endIndex + 1;
        continue;
      }
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
  state: ShellScanState
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

      const target = findProtectedDataRawWriteTargetWithState(substitution.content, {
        variables: new Map(state.variables),
        cwd: state.cwd
      });
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

      const target = findProtectedDataRawWriteTargetWithState(substitution.content, {
        variables: new Map(state.variables),
        cwd: state.cwd
      });
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

      const target = findProtectedDataRawWriteTargetWithState(substitution.content, {
        variables: new Map(state.variables),
        cwd: state.cwd
      });
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
