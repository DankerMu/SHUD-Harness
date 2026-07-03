#!/usr/bin/env python3
"""Run the M1 P0 readiness gates and write the readiness signoff YAML."""

from __future__ import annotations

import argparse
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


VERSION = "v0.8.1"
OUTPUT_RELATIVE = Path("workspace/readiness/readiness_gate_v0_8_1.yaml")
EXPECTED_SUBMODULES = ("SHUD", "rSHUD", "AutoSHUD", "zero")
P0_KEYS = (
    "gitmodules_parse",
    "submodules_checkout",
    "canonical_index",
    "core_schema",
    "support_schema",
    "api_registry",
    "error_idempotency",
    "artifact_registry",
    "lock_recovery",
)


@dataclass(frozen=True)
class GateResult:
    status: str
    summary: str


@dataclass(frozen=True)
class SubmoduleState:
    name: str
    path: str
    gitlink: str | None
    head: str | None
    branch: str | None
    branchish: str | None
    dirty: bool | None
    status_short: tuple[str, ...]
    worktree_top_level: str | None
    errors: tuple[str, ...]


@dataclass(frozen=True)
class RepoState:
    path: str
    git_top_level: str | None
    is_top_level: bool
    head: str | None
    branch: str | None
    branchish: str | None
    dirty: bool | None
    status_short: tuple[str, ...]
    errors: tuple[str, ...]
    submodules: tuple[SubmoduleState, ...]


def pass_gate(summary: str) -> GateResult:
    return GateResult("pass", summary)


def pass_with_notes_gate(summary: str) -> GateResult:
    return GateResult("pass_with_notes", summary)


def block_gate(summary: str) -> GateResult:
    return GateResult("block", summary)


def run_command(args: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        cwd=str(cwd) if cwd else None,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def read_contract(repo_root: Path, relative_path: str) -> tuple[str | None, GateResult | None]:
    path = repo_root / relative_path
    if not path.is_file():
        return None, block_gate(f"Missing required contract file: {relative_path}.")
    try:
        return path.read_text(encoding="utf-8"), None
    except OSError as exc:
        return None, block_gate(f"Cannot read required contract file {relative_path}: {exc}.")


def contract_has_crlf(repo_root: Path, relative_path: str) -> bool:
    try:
        return b"\r\n" in (repo_root / relative_path).read_bytes()
    except OSError:
        return False


def missing_tokens(text: str, tokens: list[str], *, case_sensitive: bool = True) -> list[str]:
    haystack = text if case_sensitive else text.lower()
    misses: list[str] = []
    for token in tokens:
        needle = token if case_sensitive else token.lower()
        if needle not in haystack:
            misses.append(token)
    return misses


def code_blocks(text: str) -> tuple[str, ...]:
    return tuple(
        match.group("body")
        for match in re.finditer(r"^```[^\n]*\n(?P<body>.*?)^```", text, re.MULTILINE | re.DOTALL)
    )


def has_interface_definition(text: str, interface_name: str) -> bool:
    interface_re = re.compile(rf"^\s*(?:export\s+)?interface\s+{re.escape(interface_name)}\s*\{{", re.MULTILINE)
    return any(interface_re.search(block) for block in code_blocks(text))


def find_interface_definition(
    repo_root: Path, interface_name: str, candidate_paths: tuple[str, ...]
) -> tuple[str | None, str | None]:
    read_errors: list[str] = []
    for relative_path in candidate_paths:
        text, error = read_contract(repo_root, relative_path)
        if error:
            read_errors.append(f"{relative_path}: {error.summary}")
            continue
        assert text is not None
        if has_interface_definition(text, interface_name):
            return relative_path, None
    if read_errors and len(read_errors) == len(candidate_paths):
        return None, "; ".join(read_errors)
    return None, None


def git_stdout(args: list[str], cwd: Path) -> tuple[str | None, str | None]:
    result = run_command(["git", "-C", str(cwd), *args])
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        return None, detail or f"git {' '.join(args)} failed"
    return result.stdout.strip(), None


def git_head(cwd: Path) -> tuple[str | None, str | None]:
    output, error = git_stdout(["rev-parse", "--verify", "HEAD"], cwd)
    if error:
        return None, error
    if output and re.fullmatch(r"[0-9a-fA-F]{40}", output):
        return output, None
    return None, f"invalid HEAD {output!r}"


def git_branch(cwd: Path) -> str | None:
    output, error = git_stdout(["symbolic-ref", "--short", "-q", "HEAD"], cwd)
    if error or not output:
        return None
    return output


def git_branchish(cwd: Path, branch: str | None) -> str | None:
    if branch:
        return branch
    output, error = git_stdout(["describe", "--tags", "--always", "--dirty"], cwd)
    if error:
        return None
    return output


def git_status_short(cwd: Path) -> tuple[str, ...]:
    result = run_command(["git", "-C", str(cwd), "status", "--short", "--untracked-files=all"])
    if result.returncode != 0:
        return ()
    return tuple(line for line in result.stdout.splitlines() if line)


def git_top_level(cwd: Path) -> tuple[str | None, str | None]:
    return git_stdout(["rev-parse", "--show-toplevel"], cwd)


def superproject_gitlink(repo_root: Path, name: str) -> tuple[str | None, str | None]:
    result = run_command(["git", "-C", str(repo_root), "ls-tree", "HEAD", "--", name])
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        return None, detail or f"cannot read gitlink for {name}"
    line = result.stdout.strip()
    if not line:
        return None, "missing superproject gitlink"
    match = re.fullmatch(r"160000\s+commit\s+([0-9a-fA-F]{40})\t(.+)", line)
    if not match:
        return None, f"expected 160000 commit gitlink, got {line!r}"
    if match.group(2) != name:
        return None, f"gitlink path mismatch: expected {name}, got {match.group(2)}"
    return match.group(1), None


def collect_repo_state(repo_root: Path) -> RepoState:
    root_errors: list[str] = []
    root_top_level, top_error = git_top_level(repo_root)
    if top_error:
        root_errors.append(top_error)
    root_resolved = str(repo_root.resolve())
    top_resolved = str(Path(root_top_level).resolve()) if root_top_level else None
    is_top_level = top_resolved == root_resolved
    if root_top_level and not is_top_level:
        root_errors.append(f"repo_root is not git worktree top-level: top-level is {root_top_level}")

    root_head, head_error = git_head(repo_root)
    if head_error:
        root_errors.append(head_error)
    root_branch = git_branch(repo_root)
    root_branchish = git_branchish(repo_root, root_branch)
    root_status = git_status_short(repo_root)

    submodules: list[SubmoduleState] = []
    for name in EXPECTED_SUBMODULES:
        submodule_path = repo_root / name
        errors: list[str] = []
        gitlink, gitlink_error = superproject_gitlink(repo_root, name)
        if gitlink_error:
            errors.append(gitlink_error)

        head: str | None = None
        branch: str | None = None
        branchish: str | None = None
        dirty: bool | None = None
        status_short: tuple[str, ...] = ()
        worktree_top_level: str | None = None

        if not submodule_path.is_dir():
            errors.append("missing directory")
        else:
            worktree_top_level, worktree_error = git_top_level(submodule_path)
            if worktree_error:
                errors.append(f"not a git worktree: {worktree_error}")
            else:
                expected_top = str(submodule_path.resolve())
                actual_top = str(Path(worktree_top_level).resolve()) if worktree_top_level else None
                if actual_top != expected_top:
                    errors.append(f"submodule worktree top-level mismatch: {worktree_top_level}")
            head, sub_head_error = git_head(submodule_path)
            if sub_head_error:
                errors.append(f"no checked-out commit: {sub_head_error}")
            branch = git_branch(submodule_path)
            branchish = git_branchish(submodule_path, branch)
            status_short = git_status_short(submodule_path)
            dirty = bool(status_short)

        submodules.append(
            SubmoduleState(
                name=name,
                path=str(submodule_path),
                gitlink=gitlink,
                head=head,
                branch=branch,
                branchish=branchish,
                dirty=dirty,
                status_short=status_short,
                worktree_top_level=worktree_top_level,
                errors=tuple(errors),
            )
        )

    return RepoState(
        path=str(repo_root),
        git_top_level=root_top_level,
        is_top_level=is_top_level,
        head=root_head,
        branch=root_branch,
        branchish=root_branchish,
        dirty=bool(root_status),
        status_short=root_status,
        errors=tuple(root_errors),
        submodules=tuple(submodules),
    )


def gate_gitmodules_parse(repo_root: Path) -> GateResult:
    gitmodules = repo_root / ".gitmodules"
    if not gitmodules.is_file():
        return block_gate("Missing .gitmodules.")

    result = run_command(
        [
            "git",
            "config",
            "--file",
            str(gitmodules),
            "--get-regexp",
            r"^submodule\..*\.(path|url)$",
        ]
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        return block_gate(f".gitmodules could not be parsed by git config: {detail}.")

    parsed: dict[str, dict[str, str]] = {}
    key_re = re.compile(r"^submodule\.([^.]+)\.(path|url)$")
    for line in result.stdout.splitlines():
        parts = line.split(None, 1)
        if len(parts) != 2:
            continue
        match = key_re.match(parts[0])
        if not match:
            continue
        parsed.setdefault(match.group(1), {})[match.group(2)] = parts[1].strip()

    missing: list[str] = []
    for name in EXPECTED_SUBMODULES:
        entry = parsed.get(name, {})
        if entry.get("path") != name:
            missing.append(f"{name}.path")
        if not entry.get("url"):
            missing.append(f"{name}.url")

    if missing:
        return block_gate(f".gitmodules is missing expected entries: {', '.join(missing)}.")
    return pass_gate(".gitmodules defines path and url for SHUD, rSHUD, AutoSHUD, and zero.")


def gate_submodules_checkout(repo_root: Path) -> GateResult:
    state = collect_repo_state(repo_root)
    blockers: list[str] = []
    commits: list[str] = []

    if state.errors:
        blockers.extend(f"root: {error}" for error in state.errors)

    for submodule in state.submodules:
        if submodule.errors:
            blockers.extend(f"{submodule.name}: {error}" for error in submodule.errors)
        if submodule.gitlink and submodule.head and submodule.gitlink != submodule.head:
            blockers.append(
                f"{submodule.name}: gitlink {submodule.gitlink[:12]} != checkout HEAD {submodule.head[:12]}"
            )
        if submodule.dirty:
            detail = "; ".join(submodule.status_short[:5])
            blockers.append(f"{submodule.name}: dirty checkout ({detail})")
        if submodule.gitlink and submodule.head and submodule.gitlink == submodule.head:
            commits.append(f"{submodule.name}@{submodule.head[:12]}")

    if blockers:
        return block_gate("Submodule state is not bound to superproject gitlinks: " + "; ".join(blockers) + ".")
    return pass_gate("Submodule gitlinks match checkout HEAD and checkouts are clean: " + ", ".join(commits) + ".")


def gate_canonical_index(repo_root: Path) -> GateResult:
    text, error = read_contract(repo_root, "docs/00_INDEX/CANONICAL_CONTRACTS.md")
    if error:
        return error
    assert text is not None
    required = [
        "canonical_for: [canonical-source-index]",
        "docs/03_SPEC/Minimal_Schemas.md",
        "docs/03_SPEC/Support_Schema_Contracts.md",
        "docs/04_IMPLEMENTATION/Schemas_APIs_CLIs.md",
        "docs/04_IMPLEMENTATION/API_Error_And_Idempotency_Contracts.md",
        "docs/03_SPEC/WebSocket_Protocol.md",
        "docs/03_SPEC/Artifact_Registry_Spec.md",
        "docs/03_SPEC/Workspace_Conventions.md",
        "docs/03_SPEC/Idempotency_Concurrency_Locking_Spec.md",
        "docs/03_SPEC/Workspace_Snapshot_And_Recovery_Spec.md",
        "## 4. API registry",
        "## 5. WebSocket event registry",
        "## 6. Artifact registry",
        "## 9. Schema drift policy",
    ]
    misses = missing_tokens(text, required)
    if misses:
        return block_gate("Canonical index is missing required source-of-truth entries: " + ", ".join(misses) + ".")
    if contract_has_crlf(repo_root, "docs/00_INDEX/CANONICAL_CONTRACTS.md"):
        return pass_with_notes_gate(
            "Canonical index content is complete; document format note: CRLF line endings should be normalized in M1 CI."
        )
    return pass_gate("Canonical index identifies unique sources for schema, API, events, paths, artifacts, locks, and recovery.")


def markdown_section(text: str, name: str) -> str | None:
    heading_re = re.compile(rf"^(?P<marks>##+)\s+.*\b{re.escape(name)}\b.*$", re.MULTILINE)
    match = heading_re.search(text)
    if not match:
        return None
    start = match.end()
    level = len(match.group("marks"))
    next_re = re.compile(rf"^#{{2,{level}}}\s+", re.MULTILINE)
    next_match = next_re.search(text, start)
    end = next_match.start() if next_match else len(text)
    return text[start:end]


def extract_enum(section: str, field: str) -> tuple[str, ...] | None:
    match = re.search(rf"^\s*{re.escape(field)}:\s*([^\n#]+)", section, re.MULTILINE)
    if not match:
        return None
    raw = match.group(1).strip()
    raw = re.sub(r"\s+#.*$", "", raw).strip()
    values = []
    for value in raw.split("|"):
        normalized = value.strip().strip("`'\"")
        if normalized:
            values.append(normalized)
    return tuple(values)


def gate_core_schema(repo_root: Path) -> GateResult:
    minimal, minimal_error = read_contract(repo_root, "docs/03_SPEC/Minimal_Schemas.md")
    if minimal_error:
        return minimal_error
    spec, spec_error = read_contract(repo_root, "docs/SPEC_v0.8_Final.md")
    if spec_error:
        return spec_error
    assert minimal is not None and spec is not None

    checks = [
        ("TaskCard", "status"),
        ("RunJob", "status"),
        ("RunRecord", "status"),
        ("EvidenceReport", "status"),
        ("AnalysisPlan", "mode"),
    ]
    conflicts: list[str] = []
    for object_name, field in checks:
        minimal_section = markdown_section(minimal, object_name)
        spec_section = markdown_section(spec, object_name)
        if minimal_section is None:
            conflicts.append(f"{object_name}: missing in Minimal_Schemas.md")
            continue
        if spec_section is None:
            conflicts.append(f"{object_name}: missing in SPEC_v0.8_Final.md")
            continue
        minimal_enum = extract_enum(minimal_section, field)
        spec_enum = extract_enum(spec_section, field)
        if minimal_enum is None:
            conflicts.append(f"{object_name}.{field}: missing in Minimal_Schemas.md")
            continue
        if spec_enum is None:
            conflicts.append(f"{object_name}.{field}: missing in SPEC_v0.8_Final.md")
            continue
        if minimal_enum != spec_enum:
            conflicts.append(
                f"{object_name}.{field}: Minimal_Schemas={minimal_enum} SPEC_v0.8_Final={spec_enum}"
            )

    if conflicts:
        return block_gate("Core schema conflicts detected: " + "; ".join(conflicts) + ".")
    return pass_gate("TaskCard, RunJob, RunRecord, EvidenceReport status enums and AnalysisPlan mode align.")


def gate_support_schema(repo_root: Path) -> GateResult:
    text, error = read_contract(repo_root, "docs/03_SPEC/Support_Schema_Contracts.md")
    if error:
        return error
    assert text is not None
    checks: tuple[tuple[str, str, tuple[str, ...]], ...] = (
        ("Artifact", "Artifact", ("docs/03_SPEC/Support_Schema_Contracts.md",)),
        ("ErrorRecord", "ErrorRecord", ("docs/03_SPEC/Support_Schema_Contracts.md",)),
        ("PiGate", "PiGate", ("docs/03_SPEC/Support_Schema_Contracts.md",)),
        ("NotificationRecord", "NotificationRecord", ("docs/03_SPEC/Support_Schema_Contracts.md",)),
        ("ReportExport", "ReportExport", ("docs/03_SPEC/Support_Schema_Contracts.md",)),
        (
            "AuditEvent",
            "AuditEvent",
            (
                "docs/03_SPEC/Support_Schema_Contracts.md",
                "docs/03_SPEC/User_Session_And_Audit_Schema.md",
            ),
        ),
        (
            "LockRecord",
            "LockRecord",
            (
                "docs/03_SPEC/Support_Schema_Contracts.md",
                "docs/03_SPEC/Idempotency_Concurrency_Locking_Spec.md",
            ),
        ),
        (
            "RunnerResult",
            "RunnerResult",
            (
                "docs/03_SPEC/Support_Schema_Contracts.md",
                "docs/03_SPEC/Runner_Adapter_Contracts.md",
            ),
        ),
    )
    misses: list[str] = []
    evidence: list[str] = []
    read_errors: list[str] = []
    for label, interface_name, candidate_paths in checks:
        found_path, read_error = find_interface_definition(repo_root, interface_name, candidate_paths)
        if found_path:
            evidence.append(f"{label}={interface_name}@{found_path}")
            continue
        misses.append(label)
        if read_error:
            read_errors.append(f"{label}: {read_error}")

    if misses:
        detail = "missing definition-level evidence for " + ", ".join(misses)
        if read_errors:
            detail += "; read errors: " + "; ".join(read_errors)
        return block_gate(detail + ".")
    return pass_gate("Support schema definition evidence: " + "; ".join(evidence) + ".")


def gate_api_registry(repo_root: Path) -> GateResult:
    text, error = read_contract(repo_root, "docs/04_IMPLEMENTATION/Schemas_APIs_CLIs.md")
    if error:
        return error
    assert text is not None
    required = [
        "Canonical data API",
        "Convenience API",
        "canonical API",
        "Visualization_Data_Spec.md",
        "/api/artifacts/:artifactId/data",
        "/api/runs/:runId/series",
    ]
    misses = missing_tokens(text, required)
    if misses:
        return block_gate("API registry does not clearly separate canonical and convenience APIs: " + ", ".join(misses) + ".")
    return pass_gate("API registry explicitly separates canonical data APIs from convenience APIs.")


def gate_error_idempotency(repo_root: Path) -> GateResult:
    text, error = read_contract(repo_root, "docs/04_IMPLEMENTATION/API_Error_And_Idempotency_Contracts.md")
    if error:
        return error
    assert text is not None
    required = [
        "interface ApiErrorResponse",
        "Idempotency-Key",
        "Retry policy",
        "idempotency key mismatch",
        "422",
        "retryable",
    ]
    misses = missing_tokens(text, required)
    if misses:
        return block_gate("API error/idempotency contract is missing required rules: " + ", ".join(misses) + ".")
    return pass_gate("Non-2xx envelope, Idempotency-Key, mismatch handling, and retry policy are defined.")


def gate_artifact_registry(repo_root: Path) -> GateResult:
    text, error = read_contract(repo_root, "docs/03_SPEC/Artifact_Registry_Spec.md")
    if error:
        return error
    assert text is not None
    required = [
        "## 2. Artifact",
        "retention_class",
        "redaction_status",
        "evidence_usable",
        "Artifact manifest",
        "Retention",
    ]
    misses = missing_tokens(text, required)
    if misses:
        return block_gate("Artifact registry is missing required artifact, retention, redaction, or evidence rules: " + ", ".join(misses) + ".")
    return pass_gate("Artifact type, retention, redaction_status, evidence_usable, and manifest rules are defined.")


def gate_lock_recovery(repo_root: Path) -> GateResult:
    locking, locking_error = read_contract(repo_root, "docs/03_SPEC/Idempotency_Concurrency_Locking_Spec.md")
    if locking_error:
        return locking_error
    recovery, recovery_error = read_contract(repo_root, "docs/03_SPEC/Workspace_Snapshot_And_Recovery_Spec.md")
    if recovery_error:
        return recovery_error
    assert locking is not None and recovery is not None
    locking_required = [
        "POST /api/jobs/:id/collect",
        "export",
        "Notification send",
        "PI gate decision",
        "LockRecord",
        "stolen_after_recovery",
    ]
    recovery_required = [
        "Service startup recovery",
        "lock expired",
        "snapshot_required",
        "parked_state.yaml",
    ]
    misses = missing_tokens(locking, locking_required) + missing_tokens(recovery, recovery_required)
    if misses:
        return block_gate("Lock/recovery contracts are missing required idempotency or recovery rules: " + ", ".join(misses) + ".")
    return pass_gate("Collect/export/notification/PI decision idempotency and startup lock recovery rules are defined.")


GATE_RUNNERS = {
    "gitmodules_parse": gate_gitmodules_parse,
    "submodules_checkout": gate_submodules_checkout,
    "canonical_index": gate_canonical_index,
    "core_schema": gate_core_schema,
    "support_schema": gate_support_schema,
    "api_registry": gate_api_registry,
    "error_idempotency": gate_error_idempotency,
    "artifact_registry": gate_artifact_registry,
    "lock_recovery": gate_lock_recovery,
}


def is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def lstat_or_none(path: Path) -> os.stat_result | None:
    try:
        return os.lstat(path)
    except FileNotFoundError:
        return None


def assert_existing_output_file_safe(output_path: Path) -> None:
    output_stat = lstat_or_none(output_path)
    if output_stat is None:
        return
    if stat.S_ISLNK(output_stat.st_mode):
        raise RuntimeError(f"Refusing to overwrite symlinked output file: {output_path}")
    if not stat.S_ISREG(output_stat.st_mode):
        raise RuntimeError(f"Readiness output target is not a regular file: {output_path}")
    if output_stat.st_nlink != 1:
        raise RuntimeError(f"Refusing to overwrite hardlinked output file: {output_path}")


def ensure_output_ancestors(repo_root: Path, *, create: bool) -> Path:
    current = repo_root
    for part in OUTPUT_RELATIVE.parts[:-1]:
        current = current / part
        current_stat = lstat_or_none(current)
        if current_stat is None:
            if not create:
                raise RuntimeError(f"Readiness output parent disappeared: {current}")
            current.mkdir()
            current_stat = lstat_or_none(current)
            if current_stat is None:
                raise RuntimeError(f"Readiness output parent could not be created: {current}")
        if stat.S_ISLNK(current_stat.st_mode):
            raise RuntimeError(f"Refusing to write through symlinked output ancestor: {current}")
        if not stat.S_ISDIR(current_stat.st_mode):
            raise RuntimeError(f"Readiness output ancestor is not a directory: {current}")
    return current


def resolve_output_path(repo_root: Path) -> Path:
    repo_real = repo_root.resolve()
    output_path = repo_root / OUTPUT_RELATIVE
    if repo_root != repo_real:
        raise RuntimeError(f"Repository root must be the resolved git top-level: {repo_root}")
    readiness_dir = ensure_output_ancestors(repo_root, create=True)
    if readiness_dir != output_path.parent:
        raise RuntimeError(f"Unexpected readiness output parent: {readiness_dir}")
    assert_existing_output_file_safe(output_path)
    resolved_parent = readiness_dir.resolve(strict=True)
    if not is_relative_to(resolved_parent, repo_real):
        raise RuntimeError(f"Refusing to write outside repo root: {OUTPUT_RELATIVE}")
    return output_path


def yaml_quote(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def yaml_scalar(value: object) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    return yaml_quote(str(value))


def append_yaml_list(lines: list[str], indent: str, key: str, values: tuple[str, ...]) -> None:
    if not values:
        lines.append(f"{indent}{key}: []")
        return
    lines.append(f"{indent}{key}:")
    for value in values:
        lines.append(f"{indent}  - {yaml_quote(value)}")


def append_repo_state_yaml(lines: list[str], repo_state: RepoState) -> None:
    lines.extend(
        [
            "  repo_state:",
            "    root:",
            f"      path: {yaml_scalar(repo_state.path)}",
            f"      git_top_level: {yaml_scalar(repo_state.git_top_level)}",
            f"      is_top_level: {yaml_scalar(repo_state.is_top_level)}",
            f"      head: {yaml_scalar(repo_state.head)}",
            f"      branch: {yaml_scalar(repo_state.branch)}",
            f"      branchish: {yaml_scalar(repo_state.branchish)}",
            f"      dirty: {yaml_scalar(repo_state.dirty)}",
        ]
    )
    append_yaml_list(lines, "      ", "status_short", repo_state.status_short)
    append_yaml_list(lines, "      ", "errors", repo_state.errors)
    lines.append("    submodules:")
    for submodule in repo_state.submodules:
        lines.extend(
            [
                f"      {submodule.name}:",
                f"        path: {yaml_scalar(submodule.path)}",
                f"        gitlink: {yaml_scalar(submodule.gitlink)}",
                f"        head: {yaml_scalar(submodule.head)}",
                f"        branch: {yaml_scalar(submodule.branch)}",
                f"        branchish: {yaml_scalar(submodule.branchish)}",
                f"        dirty: {yaml_scalar(submodule.dirty)}",
                f"        worktree_top_level: {yaml_scalar(submodule.worktree_top_level)}",
            ]
        )
        append_yaml_list(lines, "        ", "status_short", submodule.status_short)
        append_yaml_list(lines, "        ", "errors", submodule.errors)


def write_text_atomic(output_path: Path, content: str, repo_root: Path) -> None:
    temp_path: str | None = None
    try:
        ensure_output_ancestors(repo_root, create=False)
        assert_existing_output_file_safe(output_path)
        fd, temp_path = tempfile.mkstemp(
            prefix=f".{output_path.name}.",
            suffix=".tmp",
            dir=str(output_path.parent),
            text=True,
        )
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())

        ensure_output_ancestors(repo_root, create=False)
        assert_existing_output_file_safe(output_path)
        os.replace(temp_path, output_path)
        temp_path = None
        ensure_output_ancestors(repo_root, create=False)
        assert_existing_output_file_safe(output_path)
        resolved_output = output_path.resolve(strict=True)
        if not is_relative_to(resolved_output, repo_root.resolve()):
            raise RuntimeError(f"Readiness output escaped repo root after replace: {output_path}")
    finally:
        if temp_path and os.path.exists(temp_path):
            os.unlink(temp_path)


def build_yaml(
    *, checked_at: str, checked_by: str, decision: str, results: dict[str, GateResult], repo_state: RepoState
) -> str:
    lines = [
        "readiness_gate:",
        f"  version: {VERSION}",
        f"  checked_at: {yaml_quote(checked_at)}",
        f"  checked_by: {yaml_quote(checked_by)}",
        f"  decision: {decision}",
        "  p0:",
    ]
    for key in P0_KEYS:
        lines.append(f"    {key}: {results[key].status}")
    lines.append("  notes:")
    for key in P0_KEYS:
        result = results[key]
        lines.append(f"    - {yaml_quote(f'[{key}] {result.status}: {result.summary}')}")
    lines.append(
        "    - "
        + yaml_quote(
            "Scope: #12 verifies the nine P0 readiness gates only; link check, DependencyLock, SHUD make, and rSHUD version checks are separate M1 issues."
        )
    )
    append_repo_state_yaml(lines, repo_state)
    return "\n".join(lines) + "\n"


def run_readiness(repo_root: Path) -> tuple[dict[str, GateResult], RepoState]:
    repo_state = collect_repo_state(repo_root)
    results: dict[str, GateResult] = {}
    for key in P0_KEYS:
        try:
            results[key] = GATE_RUNNERS[key](repo_root)
        except Exception as exc:  # Defensive: a checker crash is a blocking readiness failure.
            results[key] = block_gate(f"Gate checker failed: {exc}.")
    return results, repo_state


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", default=".", help="Repository root to inspect.")
    parser.add_argument("--checked-by", default=os.environ.get("USER", "unknown"), help="Signer recorded in YAML.")
    return parser.parse_args(argv)


def normalize_repo_root(repo_root_arg: str) -> Path:
    candidate = Path(repo_root_arg).expanduser().resolve()
    if not candidate.is_dir():
        raise RuntimeError(f"repo root is not a directory: {candidate}")
    top_level, error = git_top_level(candidate)
    if error or top_level is None:
        raise RuntimeError(f"repo root is not a git worktree: {candidate}: {error}")
    top_path = Path(top_level).resolve()
    if top_path != candidate:
        raise RuntimeError(f"repo root must be the git worktree top-level: got {candidate}, top-level is {top_path}")
    return top_path


def aggregate_decision(results: dict[str, GateResult]) -> str:
    statuses = [result.status for result in results.values()]
    if any(status == "block" for status in statuses):
        return "block"
    if any(status == "pass_with_notes" for status in statuses):
        return "pass_with_notes"
    return "pass"


def short_ref(value: str | None) -> str:
    if value is None:
        return "null"
    if re.fullmatch(r"[0-9a-fA-F]{40}", value):
        return value[:12]
    return value


def print_repo_state(repo_state: RepoState) -> None:
    print(
        "repo_state: "
        f"head={short_ref(repo_state.head)} "
        f"branch={repo_state.branch or 'detached'} "
        f"dirty={repo_state.dirty}"
    )
    for submodule in repo_state.submodules:
        print(
            "submodule_state: "
            f"{submodule.name} "
            f"gitlink={short_ref(submodule.gitlink)} "
            f"head={short_ref(submodule.head)} "
            f"branch={submodule.branch or 'detached'} "
            f"dirty={submodule.dirty}"
        )


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    try:
        repo_root = normalize_repo_root(args.repo_root)
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    results, repo_state = run_readiness(repo_root)
    decision = aggregate_decision(results)
    checked_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    try:
        output_path = resolve_output_path(repo_root)
        write_text_atomic(
            output_path,
            build_yaml(
                checked_at=checked_at,
                checked_by=args.checked_by,
                decision=decision,
                results=results,
                repo_state=repo_state,
            ),
            repo_root,
        )
    except OSError as exc:
        print(f"error: failed to write readiness YAML: {exc}", file=sys.stderr)
        return 1
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(f"wrote: {output_path}")
    print(f"decision: {decision}")
    for key in P0_KEYS:
        result = results[key]
        print(f"{key}: {result.status} - {result.summary}")
    print_repo_state(repo_state)
    return 0 if decision != "block" else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
