#!/usr/bin/env python3
"""Collect SHUD build and rSHUD installed-package readiness evidence."""

from __future__ import annotations

import argparse
import json
import os
import platform
import re
import secrets
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


VERSION = "v0.1.0"
DEFAULT_OUTPUT_RELATIVE = Path("workspace/readiness/shud_rshud_readiness.json")
MIN_RSHUD_VERSION = "2.5.0"
TEXT_TAIL_LIMIT = 12000


class OutputSafetyError(Exception):
    """Raised when an output path could write outside the readiness evidence boundary."""


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def default_repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def truncate_tail(text: str, limit: int = TEXT_TAIL_LIMIT) -> tuple[str, bool]:
    if len(text) <= limit:
        return text, False
    return text[-limit:], True


def run_command(args: list[str], cwd: Path | None = None, timeout: int | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {
        "command": args,
        "cwd": str(cwd) if cwd else None,
        "exit_code": None,
        "stdout_tail": "",
        "stderr_tail": "",
        "stdout_truncated": False,
        "stderr_truncated": False,
        "error": None,
    }
    try:
        completed = subprocess.run(
            args,
            cwd=str(cwd) if cwd else None,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=timeout,
        )
    except FileNotFoundError as exc:
        result["error"] = str(exc)
        return result
    except subprocess.TimeoutExpired as exc:
        stdout = exc.stdout or ""
        stderr = exc.stderr or ""
        if isinstance(stdout, bytes):
            stdout = stdout.decode("utf-8", errors="replace")
        if isinstance(stderr, bytes):
            stderr = stderr.decode("utf-8", errors="replace")
        result["error"] = f"command timed out after {timeout}s"
        result["stdout_tail"], result["stdout_truncated"] = truncate_tail(stdout)
        result["stderr_tail"], result["stderr_truncated"] = truncate_tail(stderr)
        return result

    result["exit_code"] = completed.returncode
    result["stdout_tail"], result["stdout_truncated"] = truncate_tail(completed.stdout)
    result["stderr_tail"], result["stderr_truncated"] = truncate_tail(completed.stderr)
    return result


def git_stdout(args: list[str], cwd: Path) -> tuple[str | None, str | None]:
    result = run_command(["git", "-C", str(cwd), *args], timeout=20)
    if result["exit_code"] != 0:
        detail = (result["stderr_tail"] or result["stdout_tail"] or result["error"] or "").strip()
        return None, detail or f"git {' '.join(args)} failed"
    return str(result["stdout_tail"]).strip(), None


def command_text(result: dict[str, Any]) -> str:
    return " ".join(shlex.quote(part) for part in result.get("command", []))


def is_relative_to(path: Path, base: Path) -> bool:
    try:
        path.relative_to(base)
        return True
    except ValueError:
        return False


def lexical_relative_to(path: Path, base: Path) -> Path | None:
    absolute_path = Path(os.path.abspath(path))
    absolute_base = Path(os.path.abspath(base))
    try:
        return absolute_path.relative_to(absolute_base)
    except ValueError:
        return None


def output_path(repo_root: Path, raw_output: str | None) -> Path:
    if raw_output:
        candidate = Path(raw_output)
        return candidate if candidate.is_absolute() else repo_root / candidate
    return repo_root / DEFAULT_OUTPUT_RELATIVE


def check_git_ignored(repo_root: Path, output: Path) -> bool:
    try:
        rel = output.resolve(strict=False).relative_to(repo_root.resolve())
    except ValueError:
        return False
    result = run_command(["git", "-C", str(repo_root), "check-ignore", "--no-index", "-q", str(rel)], timeout=20)
    return result["exit_code"] == 0


def temp_roots() -> tuple[Path, ...]:
    roots: list[Path] = []
    for raw in (tempfile.gettempdir(), os.environ.get("TMPDIR")):
        if not raw:
            continue
        path = Path(raw).expanduser().resolve()
        if path not in roots:
            roots.append(path)
    return tuple(roots)


def validate_output_scope(
    repo_root: Path,
    output: Path,
    lexical_repo_root: Path | None = None,
    *,
    raw_output_is_absolute: bool = False,
) -> None:
    repo_resolved = repo_root.resolve()
    lexical_rel = lexical_relative_to(output, lexical_repo_root or repo_root)
    output_resolved = output.resolve(strict=False)
    if lexical_rel is not None and not is_relative_to(output_resolved, repo_resolved):
        raise OutputSafetyError(f"output path escapes repo through a symlink: {lexical_rel.as_posix()}")
    if lexical_rel is not None or is_relative_to(output_resolved, repo_resolved):
        rel = output_resolved.relative_to(repo_resolved)
        if len(rel.parts) < 3 or rel.parts[0] != "workspace" or rel.parts[1] != "readiness":
            raise OutputSafetyError(
                f"output path inside repo must be under workspace/readiness: {rel.as_posix()}"
            )
        if not check_git_ignored(repo_root, output):
            raise OutputSafetyError(f"output path is not ignored by git: {rel.as_posix()}")
        return

    if not raw_output_is_absolute:
        raise OutputSafetyError("relative output path must stay under repo workspace/readiness")
    allowed_temp_roots = temp_roots()
    if not any(is_relative_to(output_resolved, temp_root) for temp_root in allowed_temp_roots):
        allowed = ", ".join(str(path) for path in allowed_temp_roots)
        raise OutputSafetyError(f"repo-external output path must be under a system temp directory: {allowed}")


def ensure_no_symlink_parent(path: Path) -> None:
    if path.parent.is_symlink():
        raise OutputSafetyError(f"output parent is a symlink: {path.parent}")


def write_json_safely(path: Path, payload: dict[str, Any]) -> None:
    ensure_no_symlink_parent(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    ensure_no_symlink_parent(path)
    if path.is_symlink():
        raise OutputSafetyError(f"output file is a symlink: {path}")
    if path.exists():
        file_stat = path.stat()
        if not stat.S_ISREG(file_stat.st_mode):
            raise OutputSafetyError(f"output path is not a regular file: {path}")
        if file_stat.st_nlink > 1:
            raise OutputSafetyError(f"output file has multiple hard links: {path}")

    temp = path.with_name(f".{path.name}.tmp.{os.getpid()}.{secrets.token_hex(8)}")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(temp, flags, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, sort_keys=True)
            handle.write("\n")
        os.replace(temp, path)
    finally:
        try:
            temp.unlink()
        except FileNotFoundError:
            pass


def parse_make_assignment(path: Path, key: str) -> str | None:
    if not path.is_file():
        return None
    pattern = re.compile(rf"^\s*{re.escape(key)}\s*(?::=|\+=|\?=|=)\s*(?P<value>.*?)\s*$")
    try:
        for raw_line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = raw_line.split("#", 1)[0].strip()
            match = pattern.match(line)
            if match:
                value = match.group("value").strip()
                return value or None
    except OSError:
        return None
    return None


def expand_make_path(value: str, env: dict[str, str]) -> str:
    expanded = value.replace("$(HOME)", env.get("HOME", "")).replace("${HOME}", env.get("HOME", ""))
    expanded = os.path.expandvars(expanded)
    expanded = os.path.expanduser(expanded)
    return expanded


def collect_os() -> dict[str, Any]:
    info: dict[str, Any] = {
        "system": platform.system(),
        "release": platform.release(),
        "version": platform.version(),
        "machine": platform.machine(),
        "platform": platform.platform(),
    }
    if platform.system() == "Darwin":
        sw_vers = run_command(["sw_vers"], timeout=10)
        info["sw_vers"] = sw_vers
    return info


def collect_compiler(shud_dir: Path, errors: list[str], notes: list[str]) -> dict[str, Any]:
    makefile = shud_dir / "Makefile"
    cc_value = parse_make_assignment(makefile, "CC")
    source = "SHUD Makefile CC" if cc_value else "PATH fallback"
    command: list[str] | None = None
    if cc_value:
        command = shlex.split(expand_make_path(cc_value, os.environ))
    else:
        for candidate in ("g++", "clang++", "c++", "cc"):
            found = shutil.which(candidate)
            if found:
                command = [found]
                break
    result: dict[str, Any] | None = None
    ok = False
    if command:
        result = run_command([*command, "--version"], timeout=20)
        ok = result["exit_code"] == 0
    else:
        notes.append("No compiler command was found in SHUD Makefile or PATH.")

    compiler = {
        "source": source,
        "command": command,
        "version_command": result,
        "ok": ok,
    }
    if not ok:
        errors.append("compiler evidence could not be collected with exit code 0")
    return compiler


def sundials_candidates(shud_dir: Path) -> list[Path]:
    env = os.environ
    makefile_value = parse_make_assignment(shud_dir / "Makefile", "SUNDIALS_DIR")
    raw_candidates = [
        env.get("SUNDIALS_DIR"),
        expand_make_path(makefile_value, env) if makefile_value else None,
        str(Path.home() / "sundials"),
        "/usr/local/sundials",
        "/usr/local/opt/sundials",
        "/opt/homebrew/opt/sundials",
    ]
    seen: set[str] = set()
    candidates: list[Path] = []
    for raw in raw_candidates:
        if not raw:
            continue
        path = Path(raw).expanduser()
        key = str(path)
        if key not in seen:
            seen.add(key)
            candidates.append(path)
    return candidates


def parse_sundials_version(header: Path) -> str | None:
    try:
        text = header.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    match = re.search(r'#\s*define\s+SUNDIALS_VERSION\s+"([^"]+)"', text)
    if match:
        return match.group(1)
    major = re.search(r"#\s*define\s+SUNDIALS_VERSION_MAJOR\s+(\d+)", text)
    minor = re.search(r"#\s*define\s+SUNDIALS_VERSION_MINOR\s+(\d+)", text)
    patch = re.search(r"#\s*define\s+SUNDIALS_VERSION_PATCH\s+(\d+)", text)
    if major and minor and patch:
        return f"{major.group(1)}.{minor.group(1)}.{patch.group(1)}"
    return None


def collect_sundials(shud_dir: Path, errors: list[str]) -> dict[str, Any]:
    candidate_records: list[dict[str, Any]] = []
    selected: dict[str, Any] | None = None
    for candidate in sundials_candidates(shud_dir):
        header = candidate / "include" / "sundials" / "sundials_config.h"
        lib_dir = candidate / "lib"
        cvode_libraries = sorted(str(path) for path in lib_dir.glob("libsundials_cvode*"))
        nvecserial_libraries = sorted(str(path) for path in lib_dir.glob("libsundials_nvecserial*"))
        version = parse_sundials_version(header) if header.is_file() else None
        record = {
            "path": str(candidate),
            "config_header": str(header),
            "config_header_exists": header.is_file(),
            "version": version,
            "lib_dir": str(lib_dir),
            "lib_dir_exists": lib_dir.is_dir(),
            "cvode_libraries": cvode_libraries,
            "nvecserial_libraries": nvecserial_libraries,
            "ok": bool(version and cvode_libraries and nvecserial_libraries),
        }
        candidate_records.append(record)
        if record["ok"] and selected is None:
            selected = record

    ok = selected is not None
    if not ok:
        errors.append("SUNDIALS evidence is incomplete: need version header plus cvode and nvecserial libraries")
    return {
        "ok": ok,
        "selected": selected,
        "candidates": candidate_records,
    }


def parse_version_text(text: str) -> str | None:
    match = re.search(r"(\d+(?:\.\d+)+)", text)
    return match.group(1) if match else None


def version_tuple(version: str) -> tuple[int, ...]:
    return tuple(int(part) for part in re.findall(r"\d+", version))


def version_at_least(version: str, minimum: str) -> bool:
    left = version_tuple(version)
    right = version_tuple(minimum)
    width = max(len(left), len(right))
    return left + (0,) * (width - len(left)) >= right + (0,) * (width - len(right))


def parse_description_version(description: Path) -> tuple[str | None, str | None]:
    try:
        text = description.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return None, str(exc)
    match = re.search(r"^Version:\s*(?P<version>\S+)\s*$", text, re.MULTILINE)
    if not match:
        return None, "Version field not found"
    return match.group("version"), None


def collect_rshud(repo_root: Path, errors: list[str]) -> dict[str, Any]:
    command = ["Rscript", "-e", 'cat(as.character(packageVersion("rSHUD")))']
    result = run_command(command, timeout=30)
    version = parse_version_text(f"{result['stdout_tail']}\n{result['stderr_tail']}")
    command_ok = result["exit_code"] == 0 and version is not None
    meets_minimum = bool(version and version_at_least(version, MIN_RSHUD_VERSION))
    if not command_ok:
        errors.append("installed rSHUD version could not be read from local Rscript packageVersion")
    elif not meets_minimum:
        errors.append(f"installed rSHUD version {version} is below required {MIN_RSHUD_VERSION}")

    description = repo_root / "rSHUD" / "DESCRIPTION"
    description_version, description_error = parse_description_version(description)
    return {
        "minimum_version": MIN_RSHUD_VERSION,
        "installed": {
            "command": result,
            "version": version,
            "ok": command_ok,
            "meets_minimum": meets_minimum,
        },
        "submodule_description": {
            "path": str(description),
            "version": description_version,
            "error": description_error,
            "supporting_evidence_only": True,
        },
    }


def artifact_state(path: Path) -> dict[str, Any]:
    exists = path.exists()
    executable = exists and os.access(path, os.X_OK) and path.is_file()
    return {
        "path": str(path),
        "exists": exists,
        "executable": executable,
        "size_bytes": path.stat().st_size if exists and path.is_file() else None,
    }


def collect_shud(repo_root: Path, skip_build: bool, cleanup: bool, errors: list[str], notes: list[str]) -> dict[str, Any]:
    shud_dir = repo_root / "SHUD"
    shud: dict[str, Any] = {
        "path": str(shud_dir),
        "commit": None,
        "commit_error": None,
        "build": {
            "skipped": skip_build,
            "pre_clean": None,
            "command": ["make", "shud"],
            "exit_code": None,
            "result": None,
            "artifact": artifact_state(shud_dir / "shud"),
            "cleanup_requested": cleanup,
            "cleanup": None,
            "artifact_after_cleanup": None,
        },
    }

    if not shud_dir.is_dir():
        errors.append("SHUD directory is missing")
        return shud

    commit, commit_error = git_stdout(["rev-parse", "--verify", "HEAD"], shud_dir)
    shud["commit"] = commit
    shud["commit_error"] = commit_error
    if commit_error:
        notes.append(f"SHUD commit could not be read: {commit_error}")

    if skip_build:
        notes.append("SHUD build was skipped by --skip-build.")
        return shud

    pre_clean = run_command(["make", "clean"], cwd=shud_dir)
    shud["build"]["pre_clean"] = pre_clean
    if pre_clean["exit_code"] != 0:
        errors.append("SHUD pre-build make clean failed")
        shud["build"]["artifact"] = artifact_state(shud_dir / "shud")
        return shud

    build_result = run_command(["make", "shud"], cwd=shud_dir)
    shud["build"]["result"] = build_result
    shud["build"]["exit_code"] = build_result["exit_code"]
    shud["build"]["artifact"] = artifact_state(shud_dir / "shud")
    if build_result["exit_code"] != 0:
        errors.append(f"SHUD build command failed: {command_text(build_result)}")
    elif not shud["build"]["artifact"]["exists"]:
        errors.append("SHUD build command exited 0 but SHUD/shud does not exist")
    elif not shud["build"]["artifact"]["executable"]:
        errors.append("SHUD build command exited 0 but SHUD/shud is not executable")

    if cleanup:
        cleanup_result = run_command(["make", "clean"], cwd=shud_dir)
        shud["build"]["cleanup"] = cleanup_result
        shud["build"]["artifact_after_cleanup"] = artifact_state(shud_dir / "shud")
        if cleanup_result["exit_code"] != 0:
            errors.append("SHUD cleanup make clean failed")
        elif shud["build"]["artifact_after_cleanup"]["exists"]:
            errors.append("SHUD cleanup completed but SHUD/shud still exists")

    return shud


def collect_source_boundary(repo_root: Path) -> dict[str, Any]:
    root_status = run_command(["git", "-C", str(repo_root), "status", "--short", "--", "SHUD", "rSHUD", "workspace"], timeout=20)
    shud_status = run_command(["git", "-C", str(repo_root / "SHUD"), "status", "--short"], timeout=20)
    rshud_status = run_command(["git", "-C", str(repo_root / "rSHUD"), "status", "--short"], timeout=20)
    return {
        "repo_status_shud_rshud_workspace": root_status,
        "shud_status": shud_status,
        "rshud_status": rshud_status,
    }


def build_payload(repo_root: Path, output: Path, skip_build: bool, cleanup: bool) -> dict[str, Any]:
    notes: list[str] = []
    errors: list[str] = []
    shud_dir = repo_root / "SHUD"
    payload: dict[str, Any] = {
        "readiness_check": "shud_rshud",
        "version": VERSION,
        "checked_at": utc_now(),
        "repo_root": str(repo_root),
        "output": {
            "path": str(output),
            "default_relative_path": str(DEFAULT_OUTPUT_RELATIVE),
        },
        "os": collect_os(),
    }
    payload["compiler"] = collect_compiler(shud_dir, errors, notes)
    payload["sundials"] = collect_sundials(shud_dir, errors)
    payload["shud"] = collect_shud(repo_root, skip_build, cleanup, errors, notes)
    payload["rshud"] = collect_rshud(repo_root, errors)
    payload["source_boundary"] = collect_source_boundary(repo_root)
    payload["notes"] = notes
    payload["errors"] = errors
    payload["conclusion"] = "pass" if not errors else "block"
    return payload


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", default=None, help="Repository root to inspect. Defaults to this script's repo.")
    parser.add_argument(
        "--output",
        default=None,
        help=f"Evidence output path. Defaults to {DEFAULT_OUTPUT_RELATIVE}. Relative paths are under repo root.",
    )
    parser.add_argument("--skip-build", action="store_true", help="Skip make clean/make shud and collect env/version evidence only.")
    parser.add_argument("--cleanup", action="store_true", help="Run make clean after a non-skipped build and verify SHUD/shud is removed.")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    repo_root_input = Path(args.repo_root) if args.repo_root else default_repo_root()
    repo_root_lexical = Path(os.path.abspath(repo_root_input))
    repo_root = repo_root_input.resolve()
    output = output_path(repo_root_lexical, args.output)
    try:
        validate_output_scope(
            repo_root,
            output,
            repo_root_lexical,
            raw_output_is_absolute=bool(args.output and Path(args.output).is_absolute()),
        )
    except OutputSafetyError as exc:
        print(f"readiness output path rejected: {exc}", file=sys.stderr)
        return 2

    payload = build_payload(repo_root, output, args.skip_build, args.cleanup)
    try:
        write_json_safely(output, payload)
    except OutputSafetyError as exc:
        print(f"readiness output write rejected: {exc}", file=sys.stderr)
        return 2
    except OSError as exc:
        print(f"readiness output write failed: {exc}", file=sys.stderr)
        return 2

    print(f"wrote {output}")
    print(f"conclusion: {payload['conclusion']}")
    if payload["errors"]:
        for error in payload["errors"]:
            print(f"block: {error}", file=sys.stderr)
    return 0 if payload["conclusion"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
