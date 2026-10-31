import { readFile } from "node:fs/promises";
import { FORBIDDEN_REPORT_PHRASES, GOVERNANCE_INVARIANTS } from "@shud-harness/dsh-shud-core";
import { beforeAll, describe, expect, it } from "vitest";

let coordinator: string;
let worker: string;
beforeAll(async () => {
  [coordinator, worker] = await Promise.all([
    readFile(new URL("../prompts/coordinator.md", import.meta.url), "utf8"),
    readFile(new URL("../prompts/worker.md", import.meta.url), "utf8"),
  ]);
});

// These two dedicated Markdown sections make the exact lists reviewable without
// duplicating the canonical Chinese wording in a second hand-maintained oracle.
function canonicalList(markdown: string, heading: string) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => /^#{1,6}\s/.test(line) && line.includes(heading));
  if (start < 0) throw new Error(`Missing canonical section ${heading}`);
  const entries: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) break;
    const item = /^\s*(?:[-*+] |\d+[.)] )(.+?)\s*$/.exec(line);
    if (item?.[1]) entries.push(item[1].replace(/^`(.*)`$/, "$1"));
  }
  return entries;
}

function wordingDrift(markdown: string, heading: string, expected: readonly string[]) {
  const entries = canonicalList(markdown, heading);
  return {
    missing: expected.filter((phrase) => !entries.includes(phrase)),
    unexpected: entries.filter((phrase) => !expected.includes(phrase)),
    duplicates: entries.filter((phrase, index) => entries.indexOf(phrase) !== index),
  };
}

function paragraphMatching(markdown: string, expression: RegExp) {
  const paragraphs = markdown
    .replace(/`/g, "")
    .replace(/\r/g, "")
    .split(/\n\s*\n/);
  const paragraph = paragraphs.find((text) => expression.test(text));
  expect(paragraph, `Missing prompt clause ${String(expression)}`).toBeDefined();
  return paragraph ?? "";
}

describe("preset canonical governance wording", () => {
  const lists = [
    { heading: "FORBIDDEN_REPORT_PHRASES", expected: FORBIDDEN_REPORT_PHRASES, count: 10 },
    { heading: "GOVERNANCE_INVARIANTS", expected: GOVERNANCE_INVARIANTS, count: 4 },
  ];

  it.each(lists)(
    "carries exactly the $count canonical $heading entries",
    ({ heading, expected, count }) => {
      expect(expected).toHaveLength(count);
      expect(canonicalList(coordinator, heading).sort()).toEqual([...expected].sort());
      expect(wordingDrift(coordinator, heading, expected)).toEqual({
        missing: [],
        unexpected: [],
        duplicates: [],
      });
    },
  );

  it.each(lists)(
    "rejects missing, changed, extra obsolete and duplicate $heading wording",
    ({ heading, expected }) => {
      const phrase = expected[0];
      const headingLine = coordinator
        .split(/\r?\n/)
        .find((line) => /^#{1,6}\s/.test(line) && line.includes(heading));
      expect(headingLine).toBeDefined();
      if (!headingLine || !phrase) throw new Error("Canonical wording fixture is incomplete");
      // In-memory copies only: never mutate prompt assets, core, or consumed evidence.
      const missing = coordinator.replace(phrase, "");
      expect(wordingDrift(missing, heading, expected).missing).toContain(phrase);
      const changed = coordinator.replace(phrase, `${phrase}（改写）`);
      expect(wordingDrift(changed, heading, expected)).toMatchObject({
        missing: [phrase],
        unexpected: [`${phrase}（改写）`],
      });
      const extra = coordinator.replace(headingLine, `${headingLine}\n- obsolete governance entry`);
      expect(wordingDrift(extra, heading, expected).unexpected).toEqual([
        "obsolete governance entry",
      ]);
      const duplicate = coordinator.replace(headingLine, `${headingLine}\n- ${phrase}`);
      expect(wordingDrift(duplicate, heading, expected).duplicates).toEqual([phrase]);
    },
  );
});

describe("coordinator prompt orchestration contract", () => {
  it("orders card creation, worker delegation, collected terminal evidence and report submission", () => {
    const text = coordinator.replace(/`/g, "").replace(/\r/g, "");
    const sequence = [
      /task_create/,
      /subagent/,
      /(?:wait|等待)[\s\S]*?run_id[\s\S]*?(?:terminal|终态)/i,
      /report_generate/,
      /report_validate/,
      /report_submit/,
    ];
    let cursor = 0;
    for (const step of sequence) {
      const match = step.exec(text.slice(cursor));
      expect(match, `Missing ordered coordinator step ${String(step)}`).not.toBeNull();
      if (!match) throw new Error(`Missing ordered coordinator step ${String(step)}`);
      cursor += match.index + match[0].length;
    }
    const delegation = paragraphMatching(coordinator, /subagent/);
    expect(delegation).toMatch(/preset\s*(?:=|:)?\s*worker|worker\s*preset/i);
    expect(delegation).toMatch(/task_id/);
    expect(delegation).toMatch(/input_dir/);
    expect(delegation).toMatch(/task (?:text|message)|任务文本/i);
    const wait = paragraphMatching(coordinator, /(?:wait|等待).*run_id/i);
    expect(wait).toMatch(/collected|已收集/i);
  });

  it("forbids direct SHUD execution and polls only when the worker lacks collected terminal evidence", () => {
    const direct = paragraphMatching(coordinator, /shud_run/);
    expect(direct).toMatch(/(?:never|do not|must not).*\bshud_run\b|不直接调用\s*shud_run/i);
    const fallback = paragraphMatching(coordinator, /shud_collect/);
    expect(fallback).toMatch(/(?:if|when|若|如果|未)/i);
    expect(fallback).toMatch(/worker/i);
    expect(fallback).toMatch(/(?:not|without|missing|未).*(?:collected|已收集)/i);
    expect(fallback).toMatch(/terminal|终态/i);
    expect(fallback).toMatch(/poll|轮询/i);
    expect(fallback).toMatch(/run_id/);
  });

  it("requires corrected inputs and a newly generated report after validation fails", () => {
    const recovery = paragraphMatching(coordinator, /report_validate.*(?:fail|失败)/i);
    expect(recovery).toMatch(/(?:correct|fix|修正).*input|修正输入/i);
    expect(recovery).toMatch(/report_generate/);
    expect(recovery).toMatch(/(?:new|新的?|新)\s*report_id/i);
  });

  it("requires both PI comment and explicit disposition before the exact report_decide call", () => {
    const decision = paragraphMatching(coordinator, /report_submit.*(?:not|denied|reject|未|不)/i);
    expect(decision).toMatch(/(?:ask|request|索要).*PI|向\s*PI\s*索要/i);
    expect(decision).toMatch(/non[- ]?empty\s+comment|非空\s*comment/i);
    expect(decision).toMatch(/explicit\s+disposition|明确处置/i);
    expect(decision).toMatch(/rejected/);
    expect(decision).toMatch(/revision_requested/);
    expect(decision).toMatch(/(?:both|二者|两者)/i);
    expect(decision).toMatch(
      /(?:before|until|之前|前).*report_decide|report_decide.*(?:until|之前)/i,
    );
    expect(decision).toMatch(/(?:never|do not|must not).*default|不得默认/i);
    expect(decision).toMatch(/ask again|再问/i);
    expect(decision).toContain("report_decide(report_id, disposition, comment)");
  });

  it("limits the language guard to enumerated lint, not compliance or PI replacement", () => {
    const boundary = paragraphMatching(coordinator, /lint/i);
    expect(boundary).toMatch(/enumerat|枚举/i);
    expect(boundary).toMatch(/pass.*(?:not|≠).*complian|通过\s*≠\s*合规/i);
    expect(boundary).toContain("PI 审阅是最终防线");
  });
});

describe("worker prompt collection contract", () => {
  it("runs the task supplied by its parent and distinguishes transient from persistent ids", () => {
    const run = paragraphMatching(worker, /shud_run/);
    expect(run).toMatch(/task_id/);
    expect(run).toMatch(/task (?:text|message)|任务文本/i);
    const wait = paragraphMatching(worker, /job_output/);
    expect(wait).toMatch(/dsh_job_id/);
    expect(wait).toMatch(/wait|等待/i);
    const collect = paragraphMatching(worker, /shud_collect/);
    expect(collect).toMatch(/persistent|持久/i);
    expect(collect).toMatch(/run_id/);
    expect(collect).toMatch(/\bjob_id\b/);
    expect(collect).toMatch(/(?:not|never|不是|不可).*dsh_job_id/i);
  });

  it("requires a collected terminal RunRecord before returning run_id and terminal status", () => {
    const completion = paragraphMatching(worker, /RunRecord/);
    expect(completion).toMatch(/terminal|终态/i);
    expect(completion).toMatch(/collect|收集/i);
    expect(completion).toMatch(/(?:only (?:then|after)|not.*until|before.*return|后才返回)/i);
    expect(completion).toMatch(/run_id/);
    expect(completion).toMatch(/status|终态/i);
    const reports = paragraphMatching(worker, /report tools|报告工具/i);
    expect(reports).toMatch(/never|do not|must not|不调用/i);
  });

  it("does not rely on SHUD wake or generalize the undiagnosed spike failure to all subagents", () => {
    const wake = paragraphMatching(worker, /SHUD.*wake|SHUD.*唤醒/i);
    expect(wake).toMatch(/(?:do not|must not|never).*rely|不依赖/i);
    expect(wake).toMatch(/spike/i);
    expect(wake).toMatch(/undiagnosed|not diagnosed|未诊断/i);
    expect(wake).toMatch(/(?:not|does not|must not).*all.*subagent|不.*全部.*子代理/i);
  });

  it("keeps both static prompt assets free of persona interpolation tokens", () => {
    expect(coordinator).not.toContain("{{");
    expect(worker).not.toContain("{{");
  });
});
