import { readFile } from "node:fs/promises";
import { FORBIDDEN_REPORT_PHRASES, GOVERNANCE_INVARIANTS } from "@shud-harness/dsh-shud-core";
import { beforeAll, describe, expect, it } from "vitest";

let coordinator: string;
let worker: string;
let coder: string;
let reviewer: string;
beforeAll(async () => {
  [coordinator, worker, coder, reviewer] = await Promise.all([
    readFile(new URL("../prompts/coordinator.md", import.meta.url), "utf8"),
    readFile(new URL("../prompts/worker.md", import.meta.url), "utf8"),
    readFile(new URL("../prompts/coder.md", import.meta.url), "utf8"),
    readFile(new URL("../prompts/reviewer.md", import.meta.url), "utf8"),
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

  const cases = [
    { role: "coordinator", prompt: () => coordinator },
    { role: "coder", prompt: () => coder },
    { role: "reviewer", prompt: () => reviewer },
  ].flatMap((role) => lists.map((list) => ({ ...role, ...list })));

  it.each(cases)(
    "$role carries exactly the $count canonical $heading entries",
    ({ prompt, heading, expected, count }) => {
      const markdown = prompt();
      expect(expected).toHaveLength(count);
      expect(canonicalList(markdown, heading).sort()).toEqual([...expected].sort());
      expect(wordingDrift(markdown, heading, expected)).toEqual({
        missing: [],
        unexpected: [],
        duplicates: [],
      });
    },
  );

  it.each(cases)(
    "$role rejects missing, changed, extra obsolete and duplicate $heading wording",
    ({ prompt, heading, expected }) => {
      const markdown = prompt();
      const phrase = expected[0];
      const headingLine = markdown
        .split(/\r?\n/)
        .find((line) => /^#{1,6}\s/.test(line) && line.includes(heading));
      expect(headingLine).toBeDefined();
      if (!headingLine || !phrase) throw new Error("Canonical wording fixture is incomplete");
      const entry = `\n- ${phrase}\n`;
      expect(markdown).toContain(entry);
      // In-memory list-entry mutations only; explanatory prose is not the oracle.
      const missing = markdown.replace(entry, "\n");
      expect(wordingDrift(missing, heading, expected).missing).toContain(phrase);
      const changed = markdown.replace(entry, `\n- ${phrase}（改写）\n`);
      expect(wordingDrift(changed, heading, expected)).toMatchObject({
        missing: [phrase],
        unexpected: [`${phrase}（改写）`],
      });
      const extra = markdown.replace(headingLine, `${headingLine}\n- obsolete governance entry`);
      expect(wordingDrift(extra, heading, expected).unexpected).toEqual([
        "obsolete governance entry",
      ]);
      const duplicate = markdown.replace(headingLine, `${headingLine}\n- ${phrase}`);
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

  it("orders the eight code_change stages through explicit delegates and preserves PI approval", () => {
    const text = coordinator.replace(/`/g, "").replace(/\r/g, "");
    const flow = text
      .split(/(?=^## )/m)
      .find((section) => /^## [^\n]*\bcode_change\b/i.test(section));
    expect(flow, "Missing coordinator code_change orchestration section").toBeDefined();
    if (!flow) throw new Error("Missing coordinator code_change orchestration section");

    const sequence = [
      { step: /\btask_create\b/, clauses: [/\bcode_change\b/, /\btask_id\b/] },
      {
        step: /\bshud_build\b/,
        clauses: [/\bsubagent_coder\b/, /\bcoder\b/, /\bbase\b/i, /clean|干净/i],
      },
      {
        step: /\bchange_create\b[^\n]*\bchange_submit\b/,
        clauses: [/\bcoder\b/, /repos\/SHUD/, /edit|modif|改码|修改/i],
      },
      {
        step: /\bshud_run\b/,
        clauses: [/\bsubagent\b/, /\bworker\b/, /\bbase\b/i, /\bbuild_id\b/, /collect|收集/i],
      },
      {
        step: /\bshud_build\b/,
        clauses: [
          /\bsubagent_coder\b/,
          /\bcoder\b/,
          /candidate|候选/i,
          /\bchange_id\b/,
          /(?:only after|after|once|if).*approv|获批后|已批/i,
        ],
      },
      {
        step: /\bshud_run\b/,
        clauses: [/\bsubagent\b/, /\bworker\b/, /candidate|候选/i, /\bbuild_id\b/, /collect|收集/i],
      },
      {
        step: /\bverification_run\b/,
        clauses: [/\bsubagent_reviewer\b/, /\breviewer\b/],
      },
      {
        step: /\breport_generate\b[^\n]*\breport_validate\b[^\n]*\breport_submit\b/,
        clauses: [/PI/, /approval|审批/i],
      },
    ];
    const paragraphs = flow.split(/\n\s*\n/);
    let paragraphIndex = 0;
    let cursor = 0;
    for (const { step, clauses } of sequence) {
      let match = step.exec((paragraphs[paragraphIndex] ?? "").slice(cursor));
      while (!match && paragraphIndex < paragraphs.length - 1) {
        paragraphIndex += 1;
        cursor = 0;
        match = step.exec(paragraphs[paragraphIndex] ?? "");
      }
      expect(match, `Missing ordered code_change step ${String(step)}`).not.toBeNull();
      if (!match) throw new Error(`Missing ordered code_change step ${String(step)}`);
      for (const clause of clauses) {
        expect(paragraphs[paragraphIndex], `code_change step ${String(step)}`).toMatch(clause);
      }
      cursor += match.index + match[0].length;
    }

    const denial = paragraphMatching(
      flow,
      /(?:ChangeRequest|\bCR\b|change_submit).*(?:not allowed|denied|拒绝|未获放行)/i,
    );
    expect(denial).toMatch(/(?:relay|pass|转述).*PI.*coder/i);
    expect(denial).toMatch(/(?:never|do not|must not).*approv|不自行批准/i);
    expect(denial).toMatch(/(?:never|do not|must not).*submit.*(?:behalf|for)|不.*代为提交/i);
    expect(denial).toMatch(
      /(?:never|do not|must not).*(?:candidate.*build|build.*candidate)|不.*候选构建/i,
    );
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

  it("runs supplied builds with one thread and preserves the no-build collection path", () => {
    const run = paragraphMatching(
      worker,
      /task (?:text|message).*(?:includes|supplies|contains|provides)\s+(?:a\s+)?build_id/i,
    );
    expect(run).toMatch(/\bshud_run\b/);
    expect(run).toMatch(/\binput_dir\b/);
    expect(run).toMatch(/\btask_id\b/);
    expect(run).toMatch(/\bbuild_id\b/);
    expect(run).toMatch(/\bthreads\s*:\s*1\b/);
    expect(run).toMatch(/(?:do not pass|omit|without|不传)\s+end_days/i);

    const completion = paragraphMatching(worker, /return.*\bbuild_id\b/i);
    expect(completion).toMatch(/only after.*collect.*terminal.*(?:RunRecord|evidence).*return/i);
    expect(completion).toMatch(/return.*\brun_id\b/);
    expect(completion).toMatch(/return.*\bbuild_id\b/);

    const legacy = paragraphMatching(
      worker,
      /(?:no|without|lacks)\s+build_id|build_id.*(?:absent|not supplied)/i,
    );
    expect(legacy).toMatch(/(?:omit|do not pass|不传)\s+build_id\s*(?:and|\/|、)\s*threads/i);
    expect(legacy).toMatch(/M3|unchanged|same.*(?:run|collect)|原样/i);
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

  it("keeps all four static prompt assets free of persona interpolation tokens", () => {
    expect(coordinator).not.toContain("{{");
    expect(worker).not.toContain("{{");
    expect(coder).not.toContain("{{");
    expect(reviewer).not.toContain("{{");
  });
});

describe("coder prompt change contract", () => {
  it("bounds coder edits and builds by task identity, approval and engineering-only authority", () => {
    const text = coder.replace(/`/g, "").replace(/\r/g, "");

    const base = paragraphMatching(coder, /base.*shud_build/i);
    expect(base).toMatch(/\btask_id\b/);
    expect(base).toMatch(/clean|干净/i);
    expect(base).toMatch(/(?:omit|without|不传)\s+change_id/i);
    expect(base).toMatch(/rhs_openmp.*(?:default.*false|false.*default)/i);
    expect(base).toMatch(/(?:before.*edit|先.*构建.*再.*改)/i);
    expect(base).toMatch(/success|成功/i);
    expect(base).toMatch(/return.*\bbuild_id\b/i);

    const edit = paragraphMatching(coder, /(?:edit|modify) only tracked/i);
    expect(edit).toContain("repos/SHUD");
    expect(edit).toMatch(/workspace|工作区/i);
    expect(edit).toMatch(/\bchange_create\b.*\btask_id\b.*\bchange_submit\b/);
    expect(edit).toMatch(/return.*\bchange_id\b/i);
    expect(text.indexOf(base)).toBeLessThan(text.indexOf(edit));

    const denial = paragraphMatching(coder, /change_submit.*(?:not allowed|denied)/i);
    expect(denial).toMatch(/stop.*report/i);
    expect(denial).toMatch(/(?:do not|never|must not).*retry/i);

    const candidate = paragraphMatching(coder, /only after.*approv.*shud_build/i);
    expect(candidate).toMatch(/coordinator/i);
    expect(candidate).toMatch(/collect.*base|base.*collect/i);
    expect(candidate).toMatch(/candidate/i);
    expect(candidate).toMatch(/\btask_id\b/);
    expect(candidate).toMatch(/approved\s+change_id/i);
    expect(candidate).toMatch(/rhs_openmp\s*:\s*true/);
    expect(candidate).toMatch(/return.*\bbuild_id\b/i);
    expect(text.indexOf(edit)).toBeLessThan(text.indexOf(candidate));

    const commits = paragraphMatching(coder, /git commit/);
    expect(commits).toMatch(/(?:never|do not|must not).*git commit/i);
    const execution = paragraphMatching(coder, /run SHUD/i);
    expect(execution).toMatch(/(?:never|do not|must not).*run SHUD/i);
    const governance = paragraphMatching(coder, /governance (?:directories|roots)/i);
    expect(governance).toMatch(/(?:never|do not|must not).*(?:write|modify)/i);
    expect(governance).toMatch(/(?:tools|guard).*(?:reject|deny)/i);
    const science = paragraphMatching(coder, /scientific conclusions/i);
    expect(science).toMatch(/(?:never|do not|must not).*scientific conclusions/i);
    expect(science).toMatch(/engineering facts/i);
  });
});

describe("reviewer prompt verdict contract", () => {
  it("produces verification verdicts through the tool without scientific or performance claims", () => {
    const verdict = paragraphMatching(reviewer, /verification_run/);
    expect(verdict).toMatch(/only.*verification_run.*(?:produce|obtain).*verdict/i);
    for (const parameter of [
      "task_id",
      "base_run_id",
      "candidate_run_id",
      "reviewer_notes",
      "compatibility_verdict",
    ]) {
      expect(verdict).toContain(parameter);
    }
    expect(verdict).toMatch(/non[- ]?empty\s+reviewer_notes/i);
    expect(verdict).toMatch(/reviewer_notes.*only engineering facts/i);

    const bitwise = paragraphMatching(reviewer, /bitwise/i);
    expect(bitwise).toMatch(
      /bitwise (?:equality|相等).*(?:does not (?:establish|prove)|≠).*(?:parallel correctness|并行正确性)/i,
    );
    expect(bitwise).toMatch(
      /bitwise (?:equality|相等).*(?:does not (?:establish|prove)|≠).*(?:performance|性能)/i,
    );
    const science = paragraphMatching(reviewer, /scientific conclusions/i);
    expect(science).toMatch(/(?:never|do not|must not).*scientific conclusions/i);
    expect(science).toMatch(/(?:never|do not|must not).*model improvement/i);
  });
});
