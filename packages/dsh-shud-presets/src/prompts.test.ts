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

function promptSection(markdown: string, heading: string) {
  const section = markdown
    .replace(/`/g, "")
    .replace(/\r/g, "")
    .split(/(?=^## )/m)
    .find((text) => text.startsWith(`## ${heading}\n`));
  expect(section, `Missing prompt section ## ${heading}`).toBeDefined();
  if (!section) throw new Error(`Missing prompt section ## ${heading}`);
  return section;
}

function sentences(text: string) {
  return text
    .split(/(?<=[.!?。])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

// Sentences that tie a guard/validation pass to compliance or sufficiency; each
// such sentence in a sensitivity section must be explicitly negated.
function complianceClaims(candidates: readonly string[]) {
  return candidates.filter(
    (sentence) =>
      /report_validate|guard|lint|validat/i.test(sentence) &&
      /pass|validates/i.test(sentence) &&
      /complian|sufficient/i.test(sentence),
  );
}

// Returns the clauses that do not match in order; each search starts after the
// previous match.
function cursorOrderedMisses(text: string, clauses: readonly RegExp[]) {
  const misses: string[] = [];
  let cursor = 0;
  for (const clause of clauses) {
    const match = clause.exec(text.slice(cursor));
    if (!match) {
      misses.push(String(clause));
      continue;
    }
    cursor += match.index + match[0].length;
  }
  return misses;
}

const FIRST_TASK_SETTLED_CLAUSES = [
  /^3\. Wait for the worker to return run_id and terminal status with collected evidence\./,
  /immediate subagent result \(started subagent <id>\) is not the worker's return/i,
  /worker's return arrives as the later subagent-settled message/i,
  /(?:may|can) end (?:your|the) turn while waiting/i,
  /(?:do not|never) call report_generate before (?:that|the) settled message arrives/i,
];

const CODE_CHANGE_SETTLED_CLAUSES = [
  /\bsubagent_coder\b, \bsubagent\b, \bsubagent_reviewer\b/,
  /immediate result (?:that )?is only started subagent <id>/i,
  /not that subagent's return/i,
  /later subagent-settled message/i,
  /wait for (?:it|that message) before using its build_id, run_id or verification evidence or moving to the next stage/i,
];

function withoutCanonicalLists(markdown: string) {
  return markdown
    .split(/(?=^## )/m)
    .filter((section) => !/^## (?:FORBIDDEN_REPORT_PHRASES|GOVERNANCE_INVARIANTS)\n/.test(section))
    .join("");
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

  it("retains the returned task identity while task creation persists the source pin internally", () => {
    const creation = paragraphMatching(coordinator, /\btask_create\b.*\bcode_change\b/);
    expect(creation).toMatch(/retain.*returned\s+task_id/i);
    expect(creation).not.toMatch(/\b(?:retain|keep)\b[^.\n]*\bsource_base_commit\b/i);
    expect(creation).toMatch(/tool.*(?:pin|persist).*source_base_commit.*internally/i);
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

  it("orders the sensitivity card, single plan, plan-bound worker delegation and report submission", () => {
    const flow = promptSection(coordinator, "sensitivity workflow");
    const sequence = [
      { step: /\btask_create\b/, clauses: [/\btype:\s*sensitivity\b/, /retain.*\btask_id\b/i] },
      {
        step: /\banalysis_create\b/,
        clauses: [
          /exactly (?:once|one)/i,
          /\bparameter_sets\b.*only whitelisted-key multipliers/i,
          /never absolute calib values/i,
          /retain.*\banalysis_plan_id\b.*\bparameter_set_id\b/i,
        ],
      },
      {
        step: /\bsubagent\b/,
        clauses: [
          /delegate to preset worker/i,
          /task text must include/i,
          /\btask_id\b/,
          /\banalysis_plan_id\b/,
          /\bparameter_set_id\b/,
          /\binput_dir\b/,
        ],
      },
      {
        step: /\bthen call report_generate for the card\b/i,
        clauses: [
          /wait for the worker's report.*subagent-settled message/i,
          /immediate subagent result \(started subagent <id>\) is not (?:that|the) report/i,
          /(?:do not|never) call report_generate before the settled message arrives/i,
          /then call report_generate for the card and retain the resulting report_id/i,
        ],
      },
      { step: /\breport_validate\b/, clauses: [/before submission/i] },
      { step: /\breport_submit\b/, clauses: [/PI/, /approval gate/i] },
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
      expect(match, `Missing ordered sensitivity step ${String(step)}`).not.toBeNull();
      if (!match) throw new Error(`Missing ordered sensitivity step ${String(step)}`);
      for (const clause of clauses) {
        expect(paragraphs[paragraphIndex], `sensitivity step ${String(step)}`).toMatch(clause);
      }
      cursor += match.index + match[0].length;
    }

    expect(flow).toMatch(
      /do not call analysis_create again for a card that already has a linked plan/i,
    );
    const fallback = paragraphMatching(flow, /shud_collect/);
    expect(fallback).toMatch(
      /^If the worker's settled report lacks collected terminal evidence for a parameter set, use shud_collect/,
    );
    expect(fallback).toMatch(/poll.*persistent run_id/i);
    const summary = paragraphMatching(flow, /summary table/i);
    expect(summary).toMatch(/states only changes relative to baseline/i);
    expect(summary).toMatch(/no sensitivity indices, rankings or mechanism explanations/i);
    expect(summary).toMatch(/parameter ranges are agent suggestions that PI has not confirmed/i);
    const inherited = paragraphMatching(flow, /rules above apply to this flow/i);
    expect(inherited).toMatch(/never call shud_run/i);
    expect(inherited).toMatch(/report_validate/);
    expect(inherited).toMatch(/PI decision conversation/);

    const plain = coordinator.replace(/`/g, "");
    expect(plain.indexOf("## code_change workflow")).toBeGreaterThanOrEqual(0);
    expect(plain.indexOf("## sensitivity workflow")).toBeGreaterThan(
      plain.indexOf("## code_change workflow"),
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

  // Scoped by section and paragraph: the sensitivity section already carries a
  // settled sentence, so whole-file matches would pass vacuously.
  it("anchors the first-task worker return and the collect fallback to the subagent-settled message", () => {
    const firstTask = promptSection(coordinator, "First-task workflow");
    const paragraphs = firstTask.split(/\n\s*\n/);
    const step3 = paragraphs.find((paragraph) => paragraph.startsWith("3. "));
    expect(step3, "Missing first-task step 3").toBeDefined();
    expect(cursorOrderedMisses(step3 ?? "", FIRST_TASK_SETTLED_CLAUSES)).toEqual([]);
    expect(step3).toContain(
      "A started job or an uncollected terminal process is not completion of this step.",
    );
    const step4 = paragraphs.findIndex((paragraph) => paragraph.startsWith("4. "));
    expect(paragraphs.indexOf(step3 ?? "")).toBe(step4 - 1);

    const fallback = paragraphMatching(firstTask, /shud_collect/);
    expect(fallback).toMatch(
      /^If the worker's settled message arrives without collected terminal evidence, use shud_collect to poll that run by its persistent run_id/,
    );
    expect(fallback).toMatch(/(?:never|not|do not)[^.]*before (?:that|the) settled message/i);
    expect(fallback).toMatch(/do not treat a running response as success/i);
    expect(paragraphs.indexOf(fallback)).toBeGreaterThan(paragraphs.indexOf(step3 ?? ""));

    expect(coordinator.replace(/`/g, "")).not.toMatch(
      /If the worker returns without collected terminal evidence/i,
    );
  });

  it("anchors every code_change delegation and the step 8 report to the settled message", () => {
    const flow = promptSection(coordinator, "code_change workflow");
    const paragraphs = flow.split(/\n\s*\n/);
    const anchor = paragraphMatching(flow, /started subagent <id>/);
    expect(cursorOrderedMisses(anchor, CODE_CHANGE_SETTLED_CLAUSES)).toEqual([]);
    const firstDelegation = paragraphs.findIndex((paragraph) => paragraph.startsWith("2. "));
    expect(firstDelegation).toBeGreaterThan(0);
    expect(paragraphs.indexOf(anchor)).toBeLessThan(firstDelegation);

    const step8 = paragraphs.find((paragraph) => paragraph.startsWith("8. "));
    expect(step8).toMatch(
      /^8\. After the reviewer's subagent-settled message arrives, [^\n]*\breport_generate\b/,
    );
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

  it("runs supplied builds with one thread and keeps the no-build, no-plan path for science_assist", () => {
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

    const legacy = paragraphMatching(worker, /neither\s+build_id\s+nor\s+analysis_plan_id/i);
    expect(legacy).toMatch(/neither build_id nor analysis_plan_id \(a science_assist card\)/i);
    expect(legacy).toMatch(
      /(?:omit|do not pass|不传)\s+build_id\s*(?:,|and|\/|、)\s*threads\s*,?\s*(?:and|\/|、)\s*plan parameters/i,
    );
    expect(legacy).toMatch(/M3|unchanged|same.*(?:run|collect)|原样/i);
    const plain = worker.replace(/`/g, "");
    expect(plain.indexOf(legacy)).toBeLessThan(plain.indexOf("## Plan-bound sensitivity runs"));
  });

  it("submits one plan-bound run per parameter set, never retries around a rejection and reports failures", () => {
    const flow = promptSection(worker, "Plan-bound sensitivity runs");
    const callForm = "shud_run(task_id, input_dir, analysis_plan_id, parameter_set_id)";
    const call = sentences(flow).find((sentence) => sentence.includes(callForm));
    expect(call, "Missing plan-bound shud_run call form").toBeDefined();
    expect(call).toMatch(/task text includes analysis_plan_id and a list of parameter sets/i);
    expect(call).toMatch(/\bsensitivity card\b/);
    expect(call).toMatch(/once for each parameter set/i);
    expect(call).toMatch(/both analysis_plan_id and parameter_set_id every time/i);
    expect(call).toMatch(/never passing calib values, end_days, build_id or threads/i);

    const rejection = paragraphMatching(flow, /rejected/);
    expect(rejection).toMatch(
      /shud_run without plan parameters on a sensitivity card is rejected/i,
    );
    expect(rejection).toMatch(/do not retry by omitting the plan parameters or task_id/i);
    expect(rejection).toMatch(/report the error/i);
    expect(rejection).toMatch(
      /no-plan path, with neither build_id nor analysis_plan_id, is only for science_assist cards/i,
    );

    const batch = paragraphMatching(flow, /submit all parameter sets first/i);
    const submitAt = batch.search(/submit all parameter sets first/i);
    const waitAt = batch.indexOf("job_output(wait: true)");
    const collectAt = batch.search(/shud_collect.*persistent run_id/);
    expect(waitAt).toBeGreaterThan(submitAt);
    expect(collectAt).toBeGreaterThan(waitAt);
    expect(batch).toMatch(/for each run/i);
    expect(batch).toMatch(
      /do not rely on SHUD wake for these runs; a still-running response is not collected evidence/i,
    );

    const failure = paragraphMatching(flow, /resubmit/i);
    expect(failure).toMatch(/do not resubmit a failed parameter set/i);
    expect(failure).toMatch(/parameter_set_id, run_id and terminal status/);
    expect(failure).toMatch(/to the coordinator/i);
    expect(failure).toMatch(
      /preserving failed or cancelled runs as they are rather than describing them as successful/i,
    );
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

describe("sensitivity prompt wording guard", () => {
  it("keeps indices, rankings, mechanisms, compliance claims and forbidden phrases out of the sensitivity sections", () => {
    const sections = [
      promptSection(coordinator, "sensitivity workflow"),
      promptSection(worker, "Plan-bound sensitivity runs"),
    ];
    const negation = /\b(?:no|not|never)\b|不/i;
    const steering = sections
      .flatMap(sentences)
      .filter((sentence) => /sensitivity ind|rank|mechanism/i.test(sentence));
    expect(steering.length).toBeGreaterThan(0);
    for (const sentence of steering) expect(sentence).toMatch(negation);
    const violation = "A passing report_validate is sufficient for compliance.";
    expect(complianceClaims([violation])).toEqual([violation]);
    expect(violation).not.toMatch(negation);
    expect(complianceClaims(["The guard/validation pass is sufficient."])).toHaveLength(1);
    expect(complianceClaims(["The report validates, which proves compliance."])).toHaveLength(1);
    for (const sentence of complianceClaims(sections.flatMap(sentences))) {
      expect(sentence).toMatch(negation);
    }

    const coordinatorProse = withoutCanonicalLists(coordinator);
    expect(coordinatorProse).toContain("## sensitivity workflow");
    for (const phrase of FORBIDDEN_REPORT_PHRASES) {
      expect(worker).not.toContain(phrase);
      expect(coordinatorProse).not.toContain(phrase);
    }
  });
});

// Issue #718: bounded recovery after a sensitivity closure failure. Ordered per
// design (a) collect once, (b) re-delegate once, job_not_terminal fallback, (c) stop.
const SENSITIVITY_RECOVERY_CLAUSES = [
  /^If report_generate fails because closure names a parameter_set_id/,
  /\bmissing_parameter_set\b/,
  /\binadmissible_effective_run\b/,
  /For inadmissible_effective_run, first call shud_collect once on the named job_id, then call report_generate again/,
  /at most once per named job_id and is not a re-delegation/i,
  /If that set is still named by missing_parameter_set or inadmissible_effective_run/,
  /use subagent to delegate preset worker once for that set only/,
  /task_id, analysis_plan_id, input_dir and that single parameter_set_id/,
  /one plan-bound run with collected terminal evidence/,
  /Wait for that worker's subagent-settled message, then call report_generate again/,
  /Re-delegate at most once per parameter set/,
  /If closure fails with job_not_terminal, a linked run is still in progress: use the shud_collect fallback above for that run, by the named job_id or its run_id, until collection confirms terminal evidence, then call report_generate again/,
  /If the same set is still named after its one re-delegation, or closure fails for a reason other than missing_parameter_set, inadmissible_effective_run or job_not_terminal \(a different parameter set newly named by either of the first two starts its own recovery above\), stop and give the PI the error and the collected evidence/,
];

const RECOVERY_PROHIBITION =
  /do not create a new card or plan, do not call analysis_create again and do not call shud_run/;
const UNBOUNDED_RETRY = /until it succeeds|\brepeat|keep retrying|retry until|as many times/i;

describe("sensitivity recovery prompt contract", () => {
  it("places one bounded coordinator recovery paragraph after the collect fallback", () => {
    const flow = promptSection(coordinator, "sensitivity workflow");
    const paragraphs = flow.split(/\n\s*\n/);
    const fallback = paragraphMatching(flow, /shud_collect/);
    expect(fallback).toMatch(
      /^If the worker's settled report lacks collected terminal evidence for a parameter set, use shud_collect/,
    );
    const recovery = paragraphMatching(flow, /missing_parameter_set/);
    expect(paragraphs.indexOf(recovery)).toBe(paragraphs.indexOf(fallback) + 1);
    expect(paragraphs.indexOf(paragraphMatching(flow, /summary table/i))).toBe(
      paragraphs.indexOf(recovery) + 1,
    );
    expect(paragraphs.indexOf(recovery)).toBeLessThan(
      paragraphs.indexOf(paragraphMatching(flow, /rules above apply to this flow/i)),
    );
    expect(cursorOrderedMisses(recovery, SENSITIVITY_RECOVERY_CLAUSES)).toEqual([]);
  });

  it("keeps the coordinator recovery from creating plans, running SHUD or retrying without bound", () => {
    const flow = promptSection(coordinator, "sensitivity workflow");
    const recovery = paragraphMatching(flow, /missing_parameter_set/);
    expect(recovery).toMatch(RECOVERY_PROHIBITION);
    const remainder = recovery.replace(RECOVERY_PROHIBITION, "");
    expect(remainder).not.toMatch(/analysis_create|task_create|\bshud_run\b|new (?:card|plan)/i);
    expect(recovery).not.toMatch(UNBOUNDED_RETRY);
    expect(recovery.match(/at most once/gi)).toHaveLength(2);
    expect(flow).toMatch(
      /Do not call analysis_create again for a card that already has a linked plan/,
    );
    expect(paragraphMatching(flow, /rules above apply to this flow/i)).toMatch(
      /never call shud_run as coordinator/,
    );
  });

  it("points generic step 1 to the build-bound and plan-bound sections without moving existing lookups", () => {
    const section = promptSection(worker, "Run and collect");
    const step1 = paragraphMatching(section, /^1\. /);
    expect(step1).toBe(paragraphMatching(worker, /shud_run/));
    expect(step1).toMatch(
      /^1\. Call shud_run with the task_id and input_dir from the task text \(for task text that names a build_id or an analysis_plan_id, take the arguments from the matching section below\)\. Retain the returned/,
    );
    expect(step1).not.toMatch(/return.*\bbuild_id\b/i);
    expect(step1).not.toMatch(/(?:includes|supplies|contains|provides)\s+(?:a\s+)?build_id/i);
    expect(paragraphMatching(worker, /return.*\bbuild_id\b/i)).toMatch(/^Use the same job_output/);
  });

  it("retries a plan-parameter rejection once in the correct form and reports every other rejection", () => {
    const flow = promptSection(worker, "Plan-bound sensitivity runs");
    const rejection = paragraphMatching(flow, /rejected/);
    const retry = sentences(rejection).find((sentence) => /once more/i.test(sentence));
    expect(retry, "Missing plan-bound retry sentence").toBeDefined();
    expect(
      cursorOrderedMisses(rejection, [
        /do not retry by omitting the plan parameters or task_id/,
        /a rejection saying only that a plan parameter or task_id is missing/,
      ]),
    ).toEqual([]);
    expect(
      cursorOrderedMisses(retry ?? "", [
        /only that a plan parameter or task_id is missing/,
        /requires parameter_set_id/,
        /requires analysis_plan_id/,
        /require task_id/,
        /requires its plan binding/,
        /submit that parameter set once more with task_id, input_dir, analysis_plan_id and parameter_set_id/,
        /every other rejection/,
        /malformed id/,
        /plan read failure/,
        /plan of another task/,
        /parameter set not in the plan/,
        /input_dir, project, end_days or threads mismatch/,
        /plan not linked to the card/,
        /\bbuild_id\b/,
        /duplicate parameter set/,
        /input digest mismatch/,
        /is reported as returned without submitting that set again/,
      ]),
    ).toEqual([]);
    expect(retry).not.toMatch(/resubmi/i);
    expect(retry).not.toMatch(/analysis_create|task_create|\bshud_run\b|new (?:card|plan)/i);
    expect(retry).not.toMatch(UNBOUNDED_RETRY);
    expect(paragraphMatching(flow, /resubmit/i)).toMatch(
      /^Do not resubmit a failed parameter set yourself/,
    );
  });
});

describe("coder prompt change contract", () => {
  it("names all ten guarded governance roots, including analyses/", () => {
    const governance = paragraphMatching(coder, /governance (?:directories|roots)/i);
    const roots = [
      "tasks/",
      "stacks/",
      "provenance/",
      "reports/",
      "runs/",
      "changes/",
      "patches/",
      "verifications/",
      "builds/",
      "analyses/",
    ];
    for (const root of roots) expect(governance).toContain(root);
    expect(governance.match(/\b[a-z]+\/(?=[,\s.])/g)).toEqual(roots);
  });

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
