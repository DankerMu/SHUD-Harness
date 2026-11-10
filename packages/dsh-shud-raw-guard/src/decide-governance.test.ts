import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { decideRawAccess, normalizeRawDirs } from "./decide.ts";

let cwd: string;
beforeEach(() => {
  cwd = realpathSync.native(mkdtempSync(join(tmpdir(), "governance-decisions-")));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

function decide(name: string, args: unknown, rawDirs = ["unrelated-raw"], session = cwd) {
  return decideRawAccess({ name, arguments: args, cwd: session }, normalizeRawDirs({ rawDirs }));
}
const immutable = { kind: "deny", code: "governance-immutable" };
const delegated = { kind: "next", code: "unrelated" };

// Literal roots and expected decisions come from D16, not production exports.
test.each([
  "tasks",
  "stacks",
  "provenance",
  "reports",
  "runs",
  "changes",
  "patches",
  "verifications",
  "builds",
  "analyses",
])("%s protects absent and existing records, not reads or sibling names", (root) => {
  const target = `${root}/record.json`;
  expect(decide("write", { file_path: target })).toMatchObject(immutable);
  expect(existsSync(join(cwd, root))).toBe(false);
  mkdirSync(join(cwd, root));
  writeFileSync(join(cwd, target), "original governance bytes\n");
  const before = statSync(join(cwd, target), { bigint: true });
  symlinkSync(join(cwd, root), join(cwd, "alias"));
  for (const file_path of ["alias/record.json", "alias/missing/child.json"]) {
    expect(decide("write", { file_path })).toMatchObject(immutable);
  }
  expect(decide("bash", { command: "touch record.json", workdir: "alias" })).toMatchObject(
    immutable,
  );
  expect(decide("bash", { command: "cat record.json", workdir: "alias" })).toEqual(delegated);
  for (const file_path of [root, target, `${root}/missing/child.json`, join(cwd, target)]) {
    expect(decide("write", { file_path })).toMatchObject(immutable);
  }
  expect(decide("bash", { command: `touch ${target}` })).toMatchObject(immutable);
  expect(decide("bash", { command: `cat ${target}` })).toEqual(delegated);
  expect(decide("read", { file_path: target })).toEqual(delegated);
  expect(decide("write", { file_path: `${root}-old/record.json` })).toEqual(delegated);
  expect(decide("write", { file_path: `${root}.bak` })).toEqual(delegated);
  expect(decide("bash", { command: `rm ${root}x/record.json` })).toEqual(delegated);
  expect(readFileSync(join(cwd, target), "utf8")).toBe("original governance bytes\n");
  expect(statSync(join(cwd, target), { bigint: true }).mtimeNs).toBe(before.mtimeNs);
});

test.each(["write", "edit", "str_replace_editor"])(
  "%s follows physical aliases and session cwd, ignoring file workdir",
  (name) => {
    mkdirSync(join(cwd, "changes/nested"), { recursive: true });
    mkdirSync(join(cwd, "repos/SHUD"), { recursive: true });
    symlinkSync(join(cwd, "changes"), join(cwd, "alias"));
    symlinkSync(join(cwd, "changes/nested"), join(cwd, "deep-link"));
    symlinkSync(cwd, join(cwd, "session"));
    symlinkSync(join(cwd, "repos/SHUD"), join(cwd, "changes/source-link"));
    for (const path of ["alias/new.json", "deep-link/../new.json", "changes/new.json"]) {
      expect(
        decide(
          name,
          { file_path: path, path, command: "create", workdir: "repos/SHUD" },
          ["unrelated-raw"],
          join(cwd, "session"),
        ),
      ).toMatchObject(immutable);
    }
    for (const path of ["repos/SHUD/new.cpp", "changes/source-link/new.cpp"]) {
      expect(
        decide(name, { file_path: path, path, command: "create", workdir: "changes" }),
      ).toEqual(delegated);
    }
  },
);

test.each(["create", "str_replace", "insert", "undo_edit"])(
  "editor %s is a mutation but view is not",
  (command) => {
    expect(decide("str_replace_editor", { command, path: "changes/new.json" })).toMatchObject(
      immutable,
    );
    expect(decide("str_replace_editor", { command: "view", path: "changes/new.json" })).toEqual(
      delegated,
    );
  },
);

test("native case aliases follow the actual filesystem without assuming its sensitivity", () => {
  mkdirSync(join(cwd, "changes"));
  const aliases = existsSync(join(cwd, "CHANGES"));
  const expected = aliases ? immutable : delegated;
  expect(decide("edit", { file_path: "CHANGES/new.json" })).toMatchObject(expected);
  expect(decide("bash", { command: "touch CHANGES/new.json" })).toMatchObject(expected);
  expect(decide("bash", { command: "touch new.json", workdir: "CHANGES" })).toMatchObject(expected);
});

test("analyses case aliases deny when proven and fail closed when unprovable", () => {
  expect(decide("write", { file_path: "ANALYSES/x.json" })).toMatchObject({
    kind: "deny",
    code: "raw-path-unavailable",
  });
  mkdirSync(join(cwd, "analyses"));
  const expected = existsSync(join(cwd, "ANALYSES")) ? immutable : delegated;
  expect(decide("write", { file_path: "ANALYSES/x.json" })).toMatchObject(expected);
  expect(decide("bash", { command: "echo {} > ANALYSES/x.json" })).toMatchObject(expected);
  expect(decide("write", { file_path: "analyses-old/x.json" })).toEqual(delegated);
});

test.each([
  ["bash", "echo '{}' > ./changes//./x.json"],
  ["bash", "cat > changes/x.json <<'J'\n{}\nJ"],
  ["bash", 'rm -rf chan"ges"/x.json'],
  ["bash", "rm -rf chan\\\nges/x.json"],
  ["bash", "touch scratch/../changes/x.json"],
  ["bash", "python -c \"open('tasks/x.json','w').write('{}')\""],
  ["bash", "chmod 600 patches/x.patch"],
  ["bash", "cp builds/shud repos/SHUD/shud"],
  ["bash", "grep -rn runs src > out.txt"],
  ["bash", "echo x >&changes/x.json"],
  ["bash", "cat changes/x.json >&2:output"],
  ["bash", "cat changes/x.json <>derived.txt"],
  ["bash", "tar -C changes -xf input.tar"],
  ["bash", "tar --extract --file=input.tar -C verifications"],
  ["bash", "tar -cf changes/archive.tar source"],
  ["bash", "tar -uf changes/archive.tar source"],
  ["bash", "tar -cf alias/archive.tar changes"],
  ["pwsh", "Set-Content changes\\x.json '{}'"],
  ["pwsh", "Remove-Item changes\\nested\\..\\x.json"],
  ["bash", 'pwsh -c "Out-File changes\\x.json"'],
])("%s recognized governance write denies: %s", (name, command) => {
  mkdirSync(join(cwd, "changes"));
  symlinkSync(join(cwd, "changes"), join(cwd, "alias"));
  expect(decide(name, { command })).toMatchObject(immutable);
});

test.each([
  ["bash", "cat changes/x.json"],
  ["bash", "ls builds"],
  ["bash", "cat chan'ges'/x.json > /dev/null"],
  ["bash", "cat changes/x.json 2>&1"],
  ["bash", "cat changes/x.json >&/dev/null"],
  ["bash", "cat changes/x.json <>/dev/null"],
  ["bash", "tar -tf changes/archive.tar"],
  ["bash", "tar -cf outside.tar changes"],
  ["bash", "tar -cf - changes"],
  ["bash", "rm -rf change*"],
  ["bash", "rm -rf chan{g,}es"],
  ["bash", "sed -i s/a/b/ repos/SHUD/Makefile"],
  ["pwsh", "Get-Content changes\\x.json"],
  ["pwsh", "Remove-Item changes-old\\x.json"],
])("%s read or outside write delegates: %s", (name, command) => {
  expect(decide(name, { command })).toEqual(delegated);
});

test("shell workdir remains effective, including physical aliases and relative archive outputs", () => {
  mkdirSync(join(cwd, "changes"));
  symlinkSync(join(cwd, "changes"), join(cwd, "alias"));
  for (const workdir of ["changes", "alias", join(cwd, "changes")]) {
    expect(decide("bash", { command: "echo '{}' > x.json", workdir })).toMatchObject(immutable);
    expect(decide("bash", { command: "cat x.json", workdir })).toEqual(delegated);
  }
  expect(
    decide("bash", { command: "tar -cf archive.tar source", workdir: "changes" }),
  ).toMatchObject(immutable);
  expect(decide("bash", { command: "tar -cf ../outside.tar source", workdir: "changes" })).toEqual(
    delegated,
  );
  expect(decide("pwsh", { command: "Set-Content x.json '{}'", workdir: "changes" })).toMatchObject(
    immutable,
  );
});

// The contract gives persistent bash the same tool id; decisions must not retain cd state.
test("bash preserves the documented persistent-cd gap under the same tool id", () => {
  expect(decide("bash", { command: "cd changes" })).toEqual(delegated);
  expect(decide("bash", { command: "touch x.json" })).toEqual(delegated);
  expect(decide("bash", { command: "touch changes/x.json" })).toMatchObject(immutable);
});

test("raw denial, approval and ancestor protection take precedence over governance", () => {
  expect(decide("write", { file_path: "changes/x.json" }, ["changes"])).toMatchObject({
    kind: "deny",
    code: "raw-immutable",
  });
  expect(decide("bash", { command: "cat data/raw/x > tasks/x" }, ["data/raw"])).toMatchObject({
    kind: "deny",
    code: "raw-immutable",
  });
  expect(decide("bash", { command: "cat data/raw/x; ls tasks" }, ["data/raw"])).toMatchObject({
    kind: "ask",
    code: "raw-read-provenance",
  });
  expect(decide("bash", { command: "rm -rf data tasks" }, ["data/raw"])).toMatchObject({
    kind: "deny",
    code: "raw-ancestor-write",
  });
  for (const command of ["rm -rf .", "rm -rf *", "rm -rf ./*"]) {
    expect(decide("bash", { command }, ["/unrelated-raw"])).toEqual(delegated);
  }
});

test("session root and raw configuration cannot redirect fixed governance protection", () => {
  mkdirSync(join(cwd, "other"));
  for (const rawDirs of [["data/raw"], ["elsewhere"], [join(cwd, "other/raw")]]) {
    expect(decide("write", { file_path: "changes/x.json" }, rawDirs)).toMatchObject(immutable);
  }
  expect(
    decide("write", { file_path: join(cwd, "changes/x.json") }, ["elsewhere"], join(cwd, "other")),
  ).toEqual(delegated);
});

test.each<[string, unknown]>([
  ["write", undefined],
  ["write", null],
  ["edit", []],
  ["edit", 7],
  ["write", {}],
  ["write", { file_path: false }],
  ["str_replace_editor", { command: "insert", path: 7 }],
  ["str_replace_editor", { path: "changes/x.json" }],
  ["str_replace_editor", { command: null, path: "changes/x.json" }],
  ["str_replace_editor", { command: 7, path: "changes/x.json" }],
  ["bash", { command: false, workdir: "changes" }],
  ["pwsh", { workdir: "changes" }],
  ["read", { file_path: "changes/x.json" }],
  ["unrelated", { command: "rm changes", file_path: "changes/x.json" }],
])("%s ignores absent or inapplicable target %j", (name, args) => {
  expect(decide(name, args)).toEqual(delegated);
});

test.each([
  { path: "changes/x.json" },
  { command: null, path: "changes/x.json" },
  { command: 7, path: "changes/x.json" },
])("raw overlap still denies malformed editor arguments %j", (args) => {
  expect(decide("str_replace_editor", args, ["changes"])).toMatchObject({
    kind: "deny",
    code: "raw-immutable",
  });
});

test("governance denial names the domain tools rather than offering file write approval", () => {
  const result = decide("write", { file_path: "changes/x.json" });
  expect(result).toMatchObject(immutable);
  expect(result.reason).toContain("immutable");
  for (const tool of [
    "task_create",
    "shud_run",
    "change_create",
    "change_submit",
    "shud_build",
    "verification_run",
    "analysis_create",
    "report_generate",
    "report_validate",
    "report_submit",
    "report_decide",
  ]) {
    expect(result.reason).toContain(tool);
  }
});
