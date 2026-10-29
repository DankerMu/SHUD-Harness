import type * as NodeFs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { vi } from "vitest";
import {
  makeRenderingFixture,
  renderingInputs,
  type RenderingFixture,
} from "./report-workspace-test-harness.ts";

export const realFs = await vi.importActual<typeof NodeFs>("node:fs");
export const PRIVATE_PAYLOAD = "private-untrusted-validator-payload-441";
// Synthetic candidates, assembled to avoid resembling a committed credential.
export const SECRET = ["sk", "abcdefgh12345678"].join("-");
export const INVARIANTS = [
  "单流域/单事件指标提升不等于模型改进",
  "校准结果不等于结构验证",
  "不得宣称模型机制已验证",
  "不得宣称普遍改进",
] as const;

// Literal oracle from the reviewed thirteen-clause contract, never production-derived.
export const CHECK_SHAPE = [
  { id: 1, vacuous: false },
  { id: 2, vacuous: false },
  { id: 3, vacuous: false },
  { id: 4, vacuous: true },
  { id: 5, vacuous: false },
  { id: 6, vacuous: false },
  { id: 7, vacuous: false },
  { id: 8, vacuous: false },
  { id: 9, vacuous: false },
  { id: 10, vacuous: true },
  { id: 11, vacuous: true },
  { id: 12, vacuous: false },
  { id: 13, vacuous: false },
] as const;

export interface ValidationWorkspace {
  root: string;
  cwd: string;
  fixture: RenderingFixture;
  reportPath: string;
  markdownPath: string;
  publish(relative: string, value: unknown): void;
  publishFixture(): void;
  snapshot(): { path: string; bytes: Buffer; mtime: number }[];
}

export function makeValidationWorkspace(): ValidationWorkspace {
  const root = realFs.mkdtempSync(join(tmpdir(), "report-validate-"));
  // Root-error diagnostics must not expose even a secret-shaped trusted cwd.
  const cwd = join(root, `${SECRET}-workspace`);
  const fixture = makeRenderingFixture();
  const reportPath = `reports/${fixture.report.report_id}.json`;
  const markdownPath = `reports/${fixture.report.report_id}.md`;
  const publish = (relative: string, value: unknown): void => {
    const path = join(cwd, relative);
    realFs.mkdirSync(dirname(path), { recursive: true });
    realFs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  };
  const publishFixture = (): void => {
    for (const input of renderingInputs(fixture)) publish(input.path, input.value);
  };
  const snapshot = () =>
    [...renderingInputs(fixture).map(({ path }) => path), markdownPath].flatMap((path) => {
      const absolute = join(cwd, path);
      // Never follow an unsafe test target or block on a FIFO.
      if (!realFs.existsSync(absolute) || !realFs.lstatSync(absolute).isFile()) return [];
      return [
        { path, bytes: realFs.readFileSync(absolute), mtime: realFs.statSync(absolute).mtimeMs },
      ];
    });
  publishFixture();
  realFs.writeFileSync(join(cwd, markdownPath), `stale Markdown ${PRIVATE_PAYLOAD} ${SECRET}\n`);
  return { root, cwd, fixture, reportPath, markdownPath, publish, publishFixture, snapshot };
}

export function selectInput(
  workspace: ValidationWorkspace,
  kind: "report" | "stack" | "data" | "run",
) {
  const input = renderingInputs(workspace.fixture).find((entry) => entry.kind === kind);
  if (input === undefined) throw new Error("Missing validation test input");
  return input;
}

/** An independently written section-3 fixture; never obtained from renderReport. */
export const DIRTY_SOURCES = `### StackLock STACK-20261029T080000-b002

| Repository | Commit | Branch | Dirty | Dirty paths truncated |
| --- | --- | --- | --- | --- |
| SHUD | 1111111111111111111111111111111111111111 | main | true | false |
| rSHUD | 2222222222222222222222222222222222222222 | main | true | false |
| AutoSHUD | 3333333333333333333333333333333333333333 | main | true | false |

- SHUD dirty_path: src/a.cpp
- SHUD dirty_path: src/z.cpp
- rSHUD dirty_path: R/a.R
- AutoSHUD dirty_path: scripts/a.R

### StackLock STACK-20261029T080000-a001

| Repository | Commit | Branch | Dirty | Dirty paths truncated |
| --- | --- | --- | --- | --- |
| SHUD | 1111111111111111111111111111111111111111 | main | true | false |
| rSHUD | 2222222222222222222222222222222222222222 | main | false | false |
| AutoSHUD | 3333333333333333333333333333333333333333 | main | false | false |

- SHUD dirty_path: src/a.cpp
- SHUD dirty_path: src/z.cpp`;

export function makeDirtyStacks(workspace: ValidationWorkspace): void {
  const [first, second] = workspace.fixture.stacks;
  first.repos.SHUD.branch = "main";
  first.repos.SHUD.dirty_paths_truncated = false;
  first.repos.rSHUD.dirty = true;
  first.repos.rSHUD.dirty_paths = ["R/a.R"];
  first.repos.AutoSHUD.dirty = true;
  first.repos.AutoSHUD.dirty_paths = ["scripts/a.R"];
  second.repos.SHUD.dirty = true;
  second.repos.SHUD.dirty_paths = ["src/a.cpp", "src/z.cpp"];
  workspace.publishFixture();
}
