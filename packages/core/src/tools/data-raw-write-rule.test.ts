import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { BaseTool } from "@zero-os/core";
import type { ToolContext, ToolLogger, ToolResult } from "@zero-os/shared";
import {
  createPolicyGateEvaluator,
  createPolicyGatedToolRegistry
} from "./policy-gate-registry";
import { appendPolicyGateAuditRow, getPolicyGateAuditDir } from "./policy-gate-audit";
import {
  DATA_RAW_WRITE_DENY_RULE,
  DATA_RAW_WRITE_DENY_RULE_ID,
  DATA_RAW_WRITE_GUARD_CLASS,
  makeDataRawPolicyGateContext
} from "./data-raw-write-rule";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("data/raw write deny policy", () => {
  const deniedCommands = [
    {
      name: "redirect write",
      command: "printf x > data/raw/input.csv"
    },
    {
      name: "fd redirect write with separated target",
      command: "printf x >& data/raw/input.csv"
    },
    {
      name: "fd redirect write with attached target",
      command: "printf x >&data/raw/input.csv"
    },
    {
      name: "command substitution remove",
      command: "echo $(rm data/raw/input.csv)"
    },
    {
      name: "backtick command substitution remove",
      command: "echo `rm data/raw/input.csv`"
    },
    {
      name: "double-quoted command substitution remove",
      command: 'echo "$(rm data/raw/input.csv)"'
    },
    {
      name: "read-only command substitution with quoted open paren remove",
      command: 'cat "$(echo "("; rm data/raw/input.csv)"'
    },
    {
      name: "read-only command substitution with quoted open paren redirect write",
      command: 'grep needle "$(echo "("; printf x > data/raw/input.csv)"'
    },
    {
      name: "read-only command substitution with nested quoted command substitution remove",
      command: 'cat "$(echo "$(echo ")")"; rm data/raw/input.csv)"'
    },
    {
      name: "read-only command substitution with nested quoted backtick remove",
      command: 'cat "$(echo "`echo )`"; rm data/raw/input.csv)"'
    },
    {
      name: "command substitution redirect write",
      command: "echo $(printf x > data/raw/input.csv)"
    },
    {
      name: "command substitution after single quote backslash sequence",
      command: "echo $(echo '\\'; rm data/raw/input.csv)"
    },
    {
      name: "process substitution remove from input",
      command: "cat <(rm data/raw/input.csv)"
    },
    {
      name: "process substitution remove from output",
      command: "cat >(rm data/raw/input.csv)"
    },
    {
      name: "backtick command substitution redirect write",
      command: "echo `printf x > data/raw/input.csv`"
    },
    {
      name: "backtick command substitution escaped backtick",
      command: "echo `printf \\`; rm data/raw/input.csv`"
    },
    {
      name: "eval single-quoted shell string remove",
      command: "eval 'rm data/raw/input.csv'"
    },
    {
      name: "eval double-quoted shell string redirect write",
      command: 'eval "printf x > data/raw/input.csv"'
    },
    {
      name: "python executable code string raw write",
      command: 'python -c \'open("data/raw/x","w").write("x")\''
    },
    {
      name: "variable-expanded remove",
      command: 'RAW=data/raw; rm "$RAW/input.csv"'
    },
    {
      name: "exported variable-expanded touch",
      command: 'export RAW=data/raw; touch "$RAW/input.csv"'
    },
    {
      name: "braced variable-expanded remove",
      command: 'RAW=data/raw; rm "${RAW}/input.csv"'
    },
    {
      name: "partial variable-expanded remove",
      command: "RAW=raw; rm data/$RAW/file"
    },
    {
      name: "exported variable-expanded shell wrapper remove",
      command: 'export RAW=data/raw; bash -c \'rm "$RAW/input.csv"\''
    },
    {
      name: "curl short output option",
      command: "curl -o data/raw/input.csv https://example.invalid/input.csv"
    },
    {
      name: "curl clustered short output option",
      command: "curl -Lo data/raw/input.csv https://example.invalid/input.csv"
    },
    {
      name: "curl clustered flags short output option",
      command: "curl -fsSLo data/raw/input.csv https://example.invalid/input.csv"
    },
    {
      name: "curl attached short output option",
      command: "curl -odata/raw/input.csv https://example.invalid/input.csv"
    },
    {
      name: "curl long output option",
      command: "curl --output data/raw/input.csv https://example.invalid/input.csv"
    },
    {
      name: "curl long output assignment option",
      command: "curl --output=data/raw/input.csv https://example.invalid/input.csv"
    },
    {
      name: "sed long in-place option",
      command: "sed --in-place 's/a/b/' data/raw/input.csv"
    },
    {
      name: "sed combined in-place edit option",
      command: "sed -Ei 's/a/b/' data/raw/input.csv"
    },
    {
      name: "sed combined no-print in-place edit option",
      command: "sed -nEi 's/a/b/' data/raw/input.csv"
    },
    {
      name: "find delete under raw",
      command: "find data/raw -delete"
    },
    {
      name: "find exec remove under raw",
      command: "find data/raw -type f -exec rm {} +"
    },
    {
      name: "find execdir remove under raw",
      command: "find data/raw -type f -execdir rm {} +"
    },
    {
      name: "find ok remove under raw",
      command: "find data/raw -type f -ok rm {} +"
    },
    {
      name: "rsync destination under raw",
      command: "rsync /tmp/input.csv data/raw/input.csv"
    },
    {
      name: "tar extraction into raw",
      command: "tar -xf archive.tar -C data/raw"
    },
    {
      name: "unzip extraction into raw",
      command: "unzip archive.zip -d data/raw"
    },
    {
      name: "wget output document under raw",
      command: "wget -O data/raw/input.csv https://example.invalid/input.csv"
    },
    {
      name: "git clone destination under raw",
      command: "git clone https://example.invalid/repo.git data/raw/repo"
    },
    {
      name: "brace expansion touching raw",
      command: "touch data/{raw,processed}/x"
    },
    {
      name: "nested brace expansion touching raw",
      command: "touch data/{processed,{raw,tmp}}/x"
    },
    {
      name: "partially quoted brace expansion touching raw",
      command: 'touch data/{ra"w",processed}/x'
    },
    {
      name: "brace expansion raw alternative beyond budget",
      command:
        "touch data/{a00,a01,a02,a03,a04,a05,a06,a07,a08,a09,a10,a11,a12,a13,a14,a15,a16,a17,a18,a19,a20,a21,a22,a23,a24,a25,a26,a27,a28,a29,a30,a31,a32,a33,a34,a35,a36,a37,a38,a39,a40,a41,a42,a43,a44,a45,a46,a47,a48,a49,a50,a51,a52,a53,a54,a55,a56,a57,a58,a59,a60,a61,a62,a63,a64,raw}/x"
    },
    {
      name: "raw path containing workspace tasks segment",
      command: "touch data/raw/workspace/tasks/TASK-001/out.csv"
    },
    {
      name: "fallback long option assignment raw output",
      command: "unknown-writer --output=data/raw/out.csv"
    },
    {
      name: "fallback long option assignment raw directory",
      command: "unknown-writer --dest=data/raw"
    },
    {
      name: "fallback attached short option raw output",
      command: "unknown-writer -odata/raw/out.csv"
    },
    {
      name: "fallback script option assignment raw output",
      command: "python script.py --out=data/raw/out.csv"
    },
    {
      name: "fallback quoted script option assignment raw output",
      command: 'python script.py --out="data/raw/out.csv"'
    },
    {
      name: "fallback quoted long option assignment raw output",
      command: 'unknown-writer "--out=data/raw/out.csv"'
    },
    {
      name: "fallback quoted attached short option raw output",
      command: 'unknown-writer -o"data/raw/out.csv"'
    },
    {
      name: "ansi-c quoted literal remove",
      command: "rm $'data/raw/input.csv'"
    },
    {
      name: "ansi-c quoted literal redirect write",
      command: "printf x > $'data/raw/input.csv'"
    },
    {
      name: "ansi-c quoted literal hex escape remove",
      command: "rm $'data/ra\\x77/input.csv'"
    },
    {
      name: "ansi-c quoted literal octal escape redirect write",
      command: "printf x > $'data\\057raw/input.csv'"
    },
    {
      name: "ansi-c quoted literal unicode slash redirect write",
      command: "printf x > $'data\\u002fraw/input.csv'"
    },
    {
      name: "ansi-c quoted literal unicode character remove",
      command: "rm $'data/ra\\u0077/input.csv'"
    },
    {
      name: "localized quoted literal remove",
      command: 'rm $"data/raw/input.csv"'
    },
    {
      name: "single quote does not escape command separator",
      command: "echo '\\'; rm data/raw/input.csv"
    },
    {
      name: "newline command list",
      command: "cat data/raw/input.csv\nrm data/raw/input.csv"
    },
    {
      name: "background command list",
      command: "cat data/raw/input.csv & rm data/raw/input.csv"
    },
    {
      name: "nice short adjustment wrapper remove",
      command: "nice -n 5 rm data/raw/input.csv"
    },
    {
      name: "nice long adjustment wrapper remove",
      command: "nice --adjustment 5 rm data/raw/input.csv"
    },
    {
      name: "env short unset wrapper remove",
      command: "env -u FOO rm data/raw/input.csv"
    },
    {
      name: "env long unset wrapper remove",
      command: "env --unset FOO rm data/raw/input.csv"
    },
    {
      name: "env long unset assignment wrapper remove",
      command: "env --unset=FOO rm data/raw/input.csv"
    },
    {
      name: "sudo short user wrapper remove",
      command: "sudo -u root rm data/raw/input.csv"
    },
    {
      name: "sudo long user wrapper remove",
      command: "sudo --user root rm data/raw/input.csv"
    },
    {
      name: "sudo unknown short group wrapper raw uncertainty",
      command: "sudo -g cat rm data/raw/input.csv"
    },
    {
      name: "sudo unknown long group wrapper raw uncertainty",
      command: "sudo --group cat rm data/raw/input.csv"
    },
    {
      name: "doas short user wrapper remove",
      command: "doas -u root rm data/raw/input.csv"
    },
    {
      name: "time format wrapper remove",
      command: "time -f '%E' rm data/raw/input.csv"
    },
    {
      name: "env chdir wrapper remove",
      command: "env --chdir /tmp rm data/raw/input.csv"
    },
    {
      name: "dd output file",
      command: "dd if=/dev/zero of=data/raw/input.csv"
    },
    {
      name: "truncate target",
      command: "truncate -s 0 data/raw/input.csv"
    },
    {
      name: "cp short target directory",
      command: "cp -t data/raw /tmp/input.csv"
    },
    {
      name: "cp long target directory",
      command: "cp --target-directory=data/raw /tmp/input.csv"
    },
    {
      name: "bash shell wrapper",
      command: "bash -c 'printf x > data/raw/input.csv'"
    },
    {
      name: "sh shell wrapper",
      command: "sh -c 'printf x > data/raw/input.csv'"
    },
    {
      name: "zsh shell wrapper",
      command: "zsh -c 'printf x > data/raw/input.csv'"
    }
  ] as const;

  for (const { name, command } of deniedCommands) {
    test(`denies ${name} before the command implementation executes`, async () => {
      const { result, bashTool } = await runWrappedBashCommand(command);

      expect(result?.success).toBe(false);
      expect(bashTool.calls).toBe(0);

      const payload = parseDeniedPayload(result);
      expect(payload.rule_id).toBe(DATA_RAW_WRITE_DENY_RULE_ID);
      expect(payload.guard_class).toBe(DATA_RAW_WRITE_GUARD_CLASS);
      expect(payload.remediation?.next_action).toBeTruthy();
      expect(payload.remediation?.hint).toBeTruthy();
      expect(payload.remediation?.ref).toBeTruthy();
    });
  }

  const allowedCommands = [
    {
      name: "cat raw input",
      command: "cat data/raw/input.csv"
    },
    {
      name: "copy raw input outside raw",
      command: "cp data/raw/input.csv /tmp/out.csv"
    },
    {
      name: "read-only multiline command list",
      command: "cat data/raw/input.csv\ncp data/raw/input.csv /tmp/out.csv"
    },
    {
      name: "quoted operator pattern",
      command: "grep '>' data/raw/input.csv"
    },
    {
      name: "single-quoted backtick literal",
      command: "grep '`' data/raw/input.csv"
    },
    {
      name: "curl read-only request",
      command: "curl -fsSL https://example.invalid/input.csv"
    },
    {
      name: "read-only find under raw",
      command: "find data/raw -maxdepth 1 -type f"
    },
    {
      name: "ls raw directory",
      command: "ls data/raw"
    },
    {
      name: "wc raw file",
      command: "wc -l data/raw/input.csv"
    },
    {
      name: "head raw file",
      command: "head -n 1 data/raw/input.csv"
    },
    {
      name: "tail raw file",
      command: "tail -n 1 data/raw/input.csv"
    },
    {
      name: "non-in-place sed raw file",
      command: "sed -n 1p data/raw/input.csv"
    },
    {
      name: "task scratch path containing data raw",
      command: "touch workspace/tasks/TASK-001/scratch/data/raw/out.csv"
    },
    {
      name: "quoted brace fallback option",
      command: 'unknown-writer "--out=data/{raw,processed}/out.csv"'
    }
  ] as const;

  for (const { name, command } of allowedCommands) {
    test(`allows ${name} through the wrapper`, async () => {
      const { result, bashTool } = await runWrappedBashCommand(command);

      expect(result?.success).toBe(true);
      expect(result?.output).toBe("bash executed");
      expect(bashTool.calls).toBe(1);
    });
  }

  test("audit helper appends a minimal row under the no-TaskCard fixture path", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "shud-policy-audit-"));
    tempDirs.push(workspaceRoot);

    const result = await appendPolicyGateAuditRow(
      {
        event: "tool.failed",
        tool_id: "bash",
        rule: DATA_RAW_WRITE_DENY_RULE_ID,
        decision: "deny",
        guard_class: DATA_RAW_WRITE_GUARD_CLASS
      },
      {
        workspaceRoot,
        now: () => "2026-07-03T00:00:00.000Z"
      }
    );

    expect(path.relative(workspaceRoot, result.auditDir)).toBe(
      "workspace/tasks/TASK-M1-SPIKE/audit"
    );

    const rows = (await readFile(result.auditPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event: "tool.failed",
      tool_id: "bash",
      rule: DATA_RAW_WRITE_DENY_RULE_ID,
      decision: "deny",
      ts: "2026-07-03T00:00:00.000Z"
    });
  });

  test("audit helper rejects traversal task ids before writing outside the task audit directory", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "shud-policy-audit-"));
    tempDirs.push(workspaceRoot);

    expect(() => getPolicyGateAuditDir({ workspaceRoot, taskId: "../../outside" })).toThrow(
      "Invalid policy gate audit taskId: must be a single path segment."
    );
    await expect(
      appendPolicyGateAuditRow(sampleAuditRow(), {
        workspaceRoot,
        taskId: "../../outside"
      })
    ).rejects.toThrow("Invalid policy gate audit taskId: must be a single path segment.");

    expect(
      await pathExists(
        path.join(workspaceRoot, "workspace", "outside", "audit", "policy-gate-audit.ndjson")
      )
    ).toBe(false);
  });

  test("audit helper rejects path-bearing file names before writing outside the audit directory", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "shud-policy-audit-"));
    tempDirs.push(workspaceRoot);

    expect(() => getPolicyGateAuditDir({ workspaceRoot, fileName: "../outside.ndjson" })).toThrow(
      "Invalid policy gate audit fileName: must be a single path segment."
    );
    await expect(
      appendPolicyGateAuditRow(sampleAuditRow(), {
        workspaceRoot,
        fileName: "../outside.ndjson"
      })
    ).rejects.toThrow("Invalid policy gate audit fileName: must be a single path segment.");

    expect(
      await pathExists(
        path.join(workspaceRoot, "workspace", "tasks", "TASK-M1-SPIKE", "outside.ndjson")
      )
    ).toBe(false);
  });

  test("audit helper rejects an audit directory symlink that resolves outside the workspace", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "shud-policy-audit-"));
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), "shud-policy-audit-outside-"));
    tempDirs.push(workspaceRoot, outsideDir);

    const taskDir = path.join(workspaceRoot, "workspace", "tasks", "TASK-M1-SPIKE");
    await mkdir(taskDir, { recursive: true });
    await symlink(outsideDir, path.join(taskDir, "audit"), "dir");

    await expect(
      appendPolicyGateAuditRow(sampleAuditRow(), {
        workspaceRoot
      })
    ).rejects.toThrow("Invalid policy gate audit directory: resolves outside workspace.");

    expect(await pathExists(path.join(outsideDir, "policy-gate-audit.ndjson"))).toBe(false);
  });

  test("audit helper rejects an audit file symlink that resolves outside the audit directory", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "shud-policy-audit-"));
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), "shud-policy-audit-outside-"));
    tempDirs.push(workspaceRoot, outsideDir);

    const auditDir = path.join(workspaceRoot, "workspace", "tasks", "TASK-M1-SPIKE", "audit");
    const outsideFile = path.join(outsideDir, "policy-gate-audit.ndjson");
    const auditPath = path.join(auditDir, "policy-gate-audit.ndjson");
    await mkdir(auditDir, { recursive: true });
    await writeFile(outsideFile, "original\n", "utf8");
    await symlink(outsideFile, auditPath);

    await expect(
      appendPolicyGateAuditRow(sampleAuditRow(), {
        workspaceRoot
      })
    ).rejects.toThrow("Invalid policy gate audit fileName: resolves outside audit directory.");

    expect(await readFile(outsideFile, "utf8")).toBe("original\n");
  });

  test("audit helper rejects an audit file symlink before appending through it", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "shud-policy-audit-"));
    tempDirs.push(workspaceRoot);

    const auditDir = path.join(workspaceRoot, "workspace", "tasks", "TASK-M1-SPIKE", "audit");
    const realAuditFile = path.join(auditDir, "real-policy-gate-audit.ndjson");
    const auditPath = path.join(auditDir, "policy-gate-audit.ndjson");
    await mkdir(auditDir, { recursive: true });
    await writeFile(realAuditFile, "original\n", "utf8");
    await symlink(realAuditFile, auditPath);

    await expect(
      appendPolicyGateAuditRow(sampleAuditRow(), {
        workspaceRoot
      })
    ).rejects.toThrow("Invalid policy gate audit fileName: must not be a symlink.");

    expect(await readFile(realAuditFile, "utf8")).toBe("original\n");
  });

  test("data/raw rule exposes a legal guard_class marker", () => {
    expect(DATA_RAW_WRITE_DENY_RULE.guard_class).toBe("authority");
  });
});

async function runWrappedBashCommand(command: string): Promise<{
  result: ToolResult | undefined;
  bashTool: RecordingTool;
}> {
  const bashTool = new RecordingTool("bash");
  const registry = createPolicyGatedToolRegistry([bashTool], {
    evaluate: createPolicyGateEvaluator(makeDataRawPolicyGateContext())
  });

  const result = await registry.get("bash")?.run(createToolContext("worker"), {
    command
  });

  return {
    result,
    bashTool
  };
}

function parseDeniedPayload(result: ToolResult | undefined): {
  rule_id?: string;
  guard_class?: string;
  remediation?: {
    next_action?: string;
    hint?: string;
    ref?: string;
  };
} {
  return JSON.parse(result?.output ?? "{}") as {
    rule_id?: string;
    guard_class?: string;
    remediation?: {
      next_action?: string;
      hint?: string;
      ref?: string;
    };
  };
}

function sampleAuditRow() {
  return {
    event: "tool.failed",
    tool_id: "bash",
    rule: DATA_RAW_WRITE_DENY_RULE_ID,
    decision: "deny" as const,
    guard_class: DATA_RAW_WRITE_GUARD_CLASS
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

class RecordingTool extends BaseTool {
  description: string;
  parameters: Record<string, unknown> = {
    type: "object",
    properties: {
      command: { type: "string" }
    },
    required: ["command"]
  };
  calls = 0;

  constructor(readonly name: string) {
    super();
    this.description = `Test tool ${name}`;
  }

  protected async execute(): Promise<ToolResult> {
    this.calls += 1;
    return {
      success: true,
      output: `${this.name} executed`,
      outputSummary: `${this.name} executed`
    };
  }
}

function createToolContext(role: string): ToolContext & { role: string } {
  return {
    role,
    sessionId: "TEST-SESSION",
    workDir: "/tmp/shud-harness-test",
    logger: testLogger
  };
}

const testLogger: ToolLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {}
};
