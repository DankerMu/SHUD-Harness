import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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
      name: "command substitution redirect write",
      command: "echo $(printf x > data/raw/input.csv)"
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
      name: "newline command list",
      command: "cat data/raw/input.csv\nrm data/raw/input.csv"
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
