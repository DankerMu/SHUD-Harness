#!/usr/bin/env python3
"""Run the M1 P0 readiness gates and write the readiness signoff YAML."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
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


def pass_gate(summary: str) -> GateResult:
    return GateResult("pass", summary)


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


def missing_tokens(text: str, tokens: list[str], *, case_sensitive: bool = True) -> list[str]:
    haystack = text if case_sensitive else text.lower()
    misses: list[str] = []
    for token in tokens:
        needle = token if case_sensitive else token.lower()
        if needle not in haystack:
            misses.append(token)
    return misses


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
    commits: list[str] = []
    missing: list[str] = []
    for name in EXPECTED_SUBMODULES:
        submodule_path = repo_root / name
        if not submodule_path.is_dir():
            missing.append(f"{name}: missing directory")
            continue
        result = run_command(["git", "-C", str(submodule_path), "rev-parse", "--verify", "HEAD"])
        if result.returncode != 0:
            missing.append(f"{name}: no checked-out commit")
            continue
        commit = result.stdout.strip()
        if not re.fullmatch(r"[0-9a-fA-F]{40}", commit):
            missing.append(f"{name}: invalid commit {commit!r}")
            continue
        commits.append(f"{name}@{commit[:12]}")

    if missing:
        return block_gate(f"Submodule checkout incomplete: {', '.join(missing)}.")
    return pass_gate("Submodule directories exist with commits: " + ", ".join(commits) + ".")


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
    required = [
        "interface Artifact",
        "interface ErrorRecord",
        "interface PiGate",
        "interface NotificationRecord",
        "interface ReportExport",
        "AuditEvent",
        "LockRecord",
        "runner result",
    ]
    misses = missing_tokens(text, required, case_sensitive=False)
    if misses:
        return block_gate("Support schema contract is missing required definitions or references: " + ", ".join(misses) + ".")
    return pass_gate("Support schema covers Artifact, ErrorRecord, PiGate, Notification, ReportExport, Audit, Lock, and runner result.")


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


def resolve_output_path(repo_root: Path) -> Path:
    repo_real = repo_root.resolve()
    output_path = repo_root / OUTPUT_RELATIVE
    readiness_dir = output_path.parent

    resolved_parent = readiness_dir.resolve(strict=False)
    resolved_output = output_path.resolve(strict=False)
    if not is_relative_to(resolved_parent, repo_real) or not is_relative_to(resolved_output, repo_real):
        raise RuntimeError(f"Refusing to write outside repo root: {OUTPUT_RELATIVE}")
    if readiness_dir.exists() and readiness_dir.is_symlink():
        raise RuntimeError(f"Refusing to write through symlinked directory: {readiness_dir}")
    if output_path.exists() and output_path.is_symlink():
        raise RuntimeError(f"Refusing to overwrite symlinked output file: {output_path}")

    readiness_dir.mkdir(parents=True, exist_ok=True)
    if not readiness_dir.is_dir():
        raise RuntimeError(f"Readiness output parent is not a directory: {readiness_dir}")
    return output_path


def yaml_quote(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def build_yaml(*, checked_at: str, checked_by: str, decision: str, results: dict[str, GateResult]) -> str:
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
    return "\n".join(lines) + "\n"


def run_readiness(repo_root: Path) -> dict[str, GateResult]:
    results: dict[str, GateResult] = {}
    for key in P0_KEYS:
        try:
            results[key] = GATE_RUNNERS[key](repo_root)
        except Exception as exc:  # Defensive: a checker crash is a blocking readiness failure.
            results[key] = block_gate(f"Gate checker failed: {exc}.")
    return results


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", default=".", help="Repository root to inspect.")
    parser.add_argument("--checked-by", default=os.environ.get("USER", "unknown"), help="Signer recorded in YAML.")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    repo_root = Path(args.repo_root).expanduser().resolve()
    if not repo_root.is_dir():
        print(f"error: repo root is not a directory: {repo_root}", file=sys.stderr)
        return 2

    results = run_readiness(repo_root)
    decision = "pass" if all(result.status == "pass" for result in results.values()) else "block"
    checked_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    try:
        output_path = resolve_output_path(repo_root)
        output_path.write_text(
            build_yaml(checked_at=checked_at, checked_by=args.checked_by, decision=decision, results=results),
            encoding="utf-8",
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
    return 0 if decision == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
