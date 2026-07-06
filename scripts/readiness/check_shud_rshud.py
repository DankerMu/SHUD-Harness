#!/usr/bin/env python3
"""Collect SHUD build and rSHUD installed-package readiness evidence."""

from __future__ import annotations

import argparse
import copy
import fnmatch
import json
import os
import platform
import re
import secrets
import shlex
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


VERSION = "v0.2.2"
DEFAULT_OUTPUT_RELATIVE = Path("workspace/readiness/shud_rshud_readiness.json")
CANONICAL_READINESS_DIR = Path("workspace/readiness")
HERMETIC_GIT_CONFIG_ARGS = (
    "-c",
    "core.excludesFile=/dev/null",
    "-c",
    "status.showUntrackedFiles=all",
)
MIN_RSHUD_VERSION = "2.5.0"
TEXT_TAIL_LIMIT = 12000
COMMAND_TAIL_READ_BYTES = TEXT_TAIL_LIMIT * 4
DEFAULT_MAKE_TIMEOUT_SECONDS = 300
MAX_MAKE_TIMEOUT_SECONDS = 900
MAKE_TIMEOUT_ENV = "SHUD_RSHUD_READINESS_MAKE_TIMEOUT_SECONDS"
SELF_TEST_TOOL_ALLOWANCE_DIR_ENV = "SHUD_RSHUD_READINESS_SELF_TEST_TOOL_DIR"
SELF_TEST_TOOL_ALLOWANCE_ENABLE_ENV = "SHUD_RSHUD_READINESS_ENABLE_SELF_TEST_TOOL_ALLOWANCE"
SELF_TEST_TOOL_ALLOWANCE_TOKEN = "allow-fixture-tools"
SELF_TEST_FIXTURE_REASON = (
    "self-test fixture mode was requested by --self-test; evidence may use fixture tools and is not consumable."
)
IDENTITY_GUARDED_TOOLS = {"git", "make", "Rscript"}
TRUSTED_EXECUTABLE_RESOLVED_PREFIXES = (
    Path("/bin"),
    Path("/usr/bin"),
    Path("/usr/local/bin"),
    Path("/usr/local/sbin"),
    Path("/usr/local/Cellar"),
    Path("/opt/homebrew/bin"),
    Path("/opt/homebrew/sbin"),
    Path("/opt/homebrew/Cellar"),
    Path("/Library/Apple/usr/bin"),
    Path("/Library/Frameworks/R.framework"),
    Path("/Library/Frameworks/R.framework/Resources/bin"),
)
SELF_TEST_FIXTURE_MODE = False
UNSUPPORTED_MAKE_ENV_VARS = ("MAKEFLAGS", "GNUMAKEFLAGS", "MFLAGS", "MAKEFILES")
MAKE_ENV_OVERRIDE_VARS = ("CC", "CXX", "SUNDIALS_DIR")
SHUD_TARGET_ENV_OVERRIDE_VARS = (
    "STCFLAG",
    "CFLAGS",
    "INCLUDES",
    "LIBRARIES",
    "RPATH",
    "LK_FLAGS",
    "LK_OMP",
    "LK_DYLN",
    "TARGET_EXEC",
    "TARGET_OMP",
    "TARGET_DEBUG",
    "MAIN_shud",
    "MAIN_OMP",
    "MAIN_DEBUG",
    "SRC",
    "SRC_H",
    "BUILDDIR",
    "SRC_DIR",
    "LIB_SUN",
    "LIB_SYS",
    "INC_OMP",
    "LIB_OMP",
    "INC_MPI",
    "MPICC",
)
SHUD_EXACT_ARTIFACT_NAMES = {"shud", "shud_omp", "shud_debug", "shud.dSYM"}
SHUD_CURRENT_BUILD_ARTIFACT_PATTERNS = ("*.o", "*.dSYM")
SHUD_BROAD_RESIDUE_PATTERNS = ("shud.*", "SHUD.*")
SHUD_ARTIFACT_PATTERNS = (*SHUD_CURRENT_BUILD_ARTIFACT_PATTERNS, *SHUD_BROAD_RESIDUE_PATTERNS)
RSHUD_VERSION_PREFIX = "RSHUD_VERSION="
PROVISIONAL_POSTFLIGHT_REASON = (
    "postflight source-boundary evidence is pending; provisional output is not a readiness pass."
)
REDACTED_ENV_VALUE = "[REDACTED]"
ENV_VALUE_REDACTION_REASON = (
    "environment values may contain secrets or machine-local paths; readiness telemetry records names only"
)
BUILD_SOURCE_KEYS = ("MAIN_shud", "MAIN_OMP", "MAIN_DEBUG", "SRC", "SRC_H")
BUILD_SOURCE_SUFFIXES = (".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx")
MAX_BUILD_SOURCE_CANDIDATES = 10000


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


class BoundedCapture:
    def __init__(self, limit_bytes: int) -> None:
        self.limit_bytes = limit_bytes
        self.total_bytes = 0
        self._tail = bytearray()
        self._lock = threading.Lock()

    def append(self, chunk: bytes) -> None:
        if not chunk:
            return
        with self._lock:
            self.total_bytes += len(chunk)
            self._tail.extend(chunk)
            if len(self._tail) > self.limit_bytes:
                del self._tail[: len(self._tail) - self.limit_bytes]

    def text_tail(self, limit_chars: int = TEXT_TAIL_LIMIT) -> tuple[str, bool]:
        with self._lock:
            raw = bytes(self._tail)
            byte_truncated = self.total_bytes > len(raw)
        text = raw.decode("utf-8", errors="replace")
        tail, text_truncated = truncate_tail(text, limit_chars)
        return tail, byte_truncated or text_truncated


def read_pipe_tail(pipe: Any, capture: BoundedCapture) -> None:
    try:
        while True:
            chunk = pipe.read(8192)
            if not chunk:
                break
            capture.append(chunk)
    finally:
        try:
            pipe.close()
        except OSError:
            pass


def terminate_process_group(process: subprocess.Popen[Any]) -> None:
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except (AttributeError, ProcessLookupError):
        process.terminate()
    except OSError:
        process.terminate()
    try:
        process.wait(timeout=5)
        return
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except (AttributeError, ProcessLookupError):
        process.kill()
    except OSError:
        process.kill()
    process.wait()


def sanitized_git_environment() -> dict[str, str]:
    env = {name: value for name, value in os.environ.items() if not name.startswith("GIT_")}
    env.update(
        {
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_ATTR_NOSYSTEM": "1",
            "HOME": "/nonexistent/shud-rshud-readiness-home",
            "XDG_CONFIG_HOME": "/nonexistent/shud-rshud-readiness-xdg",
        }
    )
    return env


def path_under_prefix(path: Path, prefix: Path) -> bool:
    try:
        path.relative_to(prefix)
        return True
    except ValueError:
        return False


def executable_path_trusted(path: Path) -> bool:
    resolved = path.expanduser().resolve(strict=False)
    for prefix in TRUSTED_EXECUTABLE_RESOLVED_PREFIXES:
        resolved_prefix = prefix.expanduser().resolve(strict=False)
        if path_under_prefix(resolved, resolved_prefix):
            return True
    return False


def self_test_tool_allowance(path: Path) -> dict[str, Any]:
    token = os.environ.get(SELF_TEST_TOOL_ALLOWANCE_ENABLE_ENV)
    raw_dir = os.environ.get(SELF_TEST_TOOL_ALLOWANCE_DIR_ENV)
    token_ok = token == SELF_TEST_TOOL_ALLOWANCE_TOKEN
    dir_present = bool(raw_dir)
    dir_matches = False
    if raw_dir:
        try:
            dir_matches = path.parent.resolve(strict=False) == Path(raw_dir).expanduser().resolve(strict=False)
        except OSError:
            dir_matches = False
    active = SELF_TEST_FIXTURE_MODE and token_ok and dir_matches
    if active:
        reason = "explicit --self-test fixture executable allowance"
    elif not SELF_TEST_FIXTURE_MODE:
        reason = "self-test executable allowance requires the --self-test CLI flag"
    else:
        reason = "self-test executable allowance is absent or incomplete"
    return {
        "active": active,
        "self_test_flag": SELF_TEST_FIXTURE_MODE,
        "enable_env": SELF_TEST_TOOL_ALLOWANCE_ENABLE_ENV,
        "dir_env": SELF_TEST_TOOL_ALLOWANCE_DIR_ENV,
        "token_present": token is not None,
        "token_ok": token_ok,
        "dir_present": dir_present,
        "dir_matches_executable_parent": dir_matches,
        "env_values_recorded": False,
        "reason": reason,
    }


def executable_identity(command: str) -> dict[str, Any]:
    command_path = Path(command)
    explicit_path = command_path.name != command
    discovered = str(command_path) if explicit_path else shutil.which(command)
    identity: dict[str, Any] = {
        "name": command_path.name,
        "lookup": "explicit_path" if explicit_path else "PATH",
        "path": discovered,
        "realpath": None,
        "exists": None,
        "is_file": None,
        "executable": None,
        "trusted": False,
        "self_test_allowance": None,
        "ok": False,
        "block_reason": None,
        "selected_path": None,
        "selected_realpath": None,
        "selected_by_trusted_fallback": False,
        "blocked_path": None,
        "blocked_realpath": None,
        "blocked_reason": None,
        "trusted_fallback": None,
        "executed_untrusted": False,
    }
    if not discovered:
        identity["exists"] = False
        identity["block_reason"] = "executable not found on PATH"
        return identity

    path = Path(discovered)
    realpath = path.resolve(strict=False)
    exists = path.exists()
    is_file = path.is_file()
    executable = os.access(path, os.X_OK)
    trusted = executable_path_trusted(path)
    allowance = self_test_tool_allowance(path)
    ok = bool(exists and is_file and executable and (trusted or allowance["active"]))
    identity.update(
        {
            "path": str(path),
            "realpath": str(realpath),
            "exists": exists,
            "is_file": is_file,
            "executable": executable,
            "trusted": trusted,
            "self_test_allowance": allowance,
            "ok": ok,
            "selected_path": str(path) if ok else None,
            "selected_realpath": str(realpath) if ok else None,
        }
    )
    if not exists:
        identity["block_reason"] = "executable path does not exist"
    elif not is_file:
        identity["block_reason"] = "executable path is not a regular file"
    elif not executable:
        identity["block_reason"] = "executable path is not executable"
    elif not ok:
        identity["block_reason"] = "executable path is outside trusted tool prefixes and has no self-test allowance"
    return identity


def trusted_fallback_identity(command: str, blocked_path: str | None) -> dict[str, Any] | None:
    if Path(command).name != command:
        return None
    blocked_resolved = Path(blocked_path).resolve(strict=False) if blocked_path else None
    for directory in os.get_exec_path():
        if not directory:
            continue
        candidate = Path(directory) / command
        if not candidate.exists() or not candidate.is_file() or not os.access(candidate, os.X_OK):
            continue
        if blocked_resolved and candidate.resolve(strict=False) == blocked_resolved:
            continue
        identity = executable_identity(str(candidate))
        if identity["ok"] and identity["trusted"]:
            identity["lookup"] = "trusted_fallback"
            identity["selected_by_trusted_fallback"] = True
            return identity
    return None


def apply_trusted_git_fallback(identity: dict[str, Any]) -> None:
    if identity["ok"] or identity["name"] != "git":
        return
    fallback = trusted_fallback_identity(identity["name"], identity.get("path"))
    if not fallback:
        return
    identity["blocked_path"] = identity.get("path")
    identity["blocked_realpath"] = identity.get("realpath")
    identity["blocked_reason"] = identity.get("block_reason")
    identity["selected_path"] = fallback["selected_path"]
    identity["selected_realpath"] = fallback["selected_realpath"]
    identity["selected_by_trusted_fallback"] = True
    identity["trusted_fallback"] = {
        "path": fallback["path"],
        "realpath": fallback["realpath"],
        "trusted": fallback["trusted"],
    }
    identity["ok"] = True
    identity["block_reason"] = None


def command_identity_error(identity: dict[str, Any]) -> str:
    path = identity.get("path") or identity.get("name")
    reason = identity.get("block_reason") or "identity check failed"
    return f"{identity.get('name')} executable identity is not trusted: {path}: {reason}"


def run_command(
    args: list[str],
    cwd: Path | None = None,
    timeout: int | None = None,
    env: dict[str, str] | None = None,
    allow_trusted_fallback_for_blocked_tool: bool = False,
) -> dict[str, Any]:
    identity = executable_identity(args[0]) if args else None
    execution_path = identity.get("selected_realpath") if identity else None
    if (
        identity
        and not identity["ok"]
        and allow_trusted_fallback_for_blocked_tool
        and identity["name"] == "git"
    ):
        apply_trusted_git_fallback(identity)
        execution_path = identity.get("selected_realpath")

    result: dict[str, Any] = {
        "command": args,
        "executed_command": [execution_path, *args[1:]] if execution_path else None,
        "cwd": str(cwd) if cwd else None,
        "exit_code": None,
        "stdout_tail": "",
        "stderr_tail": "",
        "stdout_truncated": False,
        "stderr_truncated": False,
        "timeout_seconds": timeout,
        "timed_out": False,
        "output_tail_limit_chars": TEXT_TAIL_LIMIT,
        "error": None,
        "executable": identity,
    }
    guarded_tool = bool(identity and identity.get("name") in IDENTITY_GUARDED_TOOLS)
    if identity and guarded_tool and not identity["ok"] and not execution_path:
        result["error"] = command_identity_error(identity)
        return result
    if identity and not identity["ok"] and not execution_path:
        result["error"] = command_identity_error(identity)
        return result

    try:
        process = subprocess.Popen(
            [execution_path, *args[1:]] if execution_path else args,
            cwd=str(cwd) if cwd else None,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
    except (FileNotFoundError, OSError) as exc:
        result["error"] = str(exc)
        return result

    stdout_capture = BoundedCapture(COMMAND_TAIL_READ_BYTES)
    stderr_capture = BoundedCapture(COMMAND_TAIL_READ_BYTES)
    stdout_thread = threading.Thread(target=read_pipe_tail, args=(process.stdout, stdout_capture), daemon=True)
    stderr_thread = threading.Thread(target=read_pipe_tail, args=(process.stderr, stderr_capture), daemon=True)
    stdout_thread.start()
    stderr_thread.start()

    try:
        result["exit_code"] = process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        result["timed_out"] = True
        result["error"] = f"command timed out after {timeout}s"
        terminate_process_group(process)
        result["exit_code"] = process.returncode

    stdout_thread.join(timeout=2)
    stderr_thread.join(timeout=2)
    result["stdout_tail"], result["stdout_truncated"] = stdout_capture.text_tail()
    result["stderr_tail"], result["stderr_truncated"] = stderr_capture.text_tail()
    return result


def run_git_command(cwd: Path, args: list[str], timeout: int = 20) -> dict[str, Any]:
    return run_command(
        ["git", *HERMETIC_GIT_CONFIG_ARGS, "-C", str(cwd), *args],
        timeout=timeout,
        env=sanitized_git_environment(),
        allow_trusted_fallback_for_blocked_tool=True,
    )


def git_stdout(args: list[str], cwd: Path) -> tuple[str | None, str | None]:
    result = run_git_command(cwd, args)
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


def parse_check_ignore_verbose(stdout: str) -> dict[str, Any]:
    line = stdout.strip().splitlines()[-1] if stdout.strip() else ""
    proof: dict[str, Any] = {
        "raw": line or None,
        "source": None,
        "line_number": None,
        "pattern": None,
        "matched_path": None,
        "parse_error": None,
    }
    if not line:
        proof["parse_error"] = "git check-ignore -v produced no stdout"
        return proof
    if "\t" not in line:
        proof["parse_error"] = "git check-ignore -v output did not contain a tab separator"
        return proof
    source_pattern, matched_path = line.split("\t", 1)
    source_parts = source_pattern.split(":", 2)
    if len(source_parts) != 3:
        proof["parse_error"] = "git check-ignore -v source metadata did not contain source:line:pattern"
        proof["matched_path"] = matched_path
        return proof
    source, line_number, pattern = source_parts
    proof.update(
        {
            "source": source,
            "line_number": line_number,
            "pattern": pattern,
            "matched_path": matched_path,
        }
    )
    return proof


def repo_owned_gitignore_source(repo_root: Path, source: str | None) -> dict[str, Any]:
    proof = {
        "path": source,
        "absolute_path": None,
        "relative_path": None,
        "under_worktree": False,
        "tracked": None,
        "clean": None,
        "error": None,
        "repo_owned": False,
    }
    if not source:
        proof["error"] = "ignore source is missing"
        return proof
    source_path = Path(source)
    absolute_source = source_path if source_path.is_absolute() else repo_root / source_path
    proof["absolute_path"] = str(absolute_source)
    try:
        relative_source = absolute_source.resolve(strict=False).relative_to(repo_root.resolve())
    except ValueError:
        proof["error"] = "ignore source is outside the worktree"
        return proof
    proof["relative_path"] = relative_source.as_posix()
    proof["under_worktree"] = bool(relative_source.parts and relative_source.parts[0] != ".git")
    if not proof["under_worktree"]:
        proof["error"] = "ignore source is not under the worktree"
        return proof
    if absolute_source.name != ".gitignore":
        proof["error"] = "ignore source is not a repo-owned .gitignore"
        return proof

    relative_posix = relative_source.as_posix()
    tracked_result = run_git_command(repo_root, ["ls-files", "--error-unmatch", "--", relative_posix])
    if tracked_result["exit_code"] == 0:
        proof["tracked"] = True
    elif tracked_result["exit_code"] == 1:
        proof["tracked"] = False
        proof["clean"] = False
        proof["error"] = "ignore source is not tracked by HEAD/index"
        return proof
    else:
        proof["tracked"] = None
        proof["clean"] = None
        proof["error"] = "ignore source tracked state could not be proven"
        return proof

    unstaged_result = run_git_command(repo_root, ["diff", "--quiet", "--", relative_posix])
    if unstaged_result["exit_code"] == 1:
        proof["clean"] = False
        proof["error"] = "ignore source has unstaged changes"
        return proof
    if unstaged_result["exit_code"] != 0:
        proof["clean"] = None
        proof["error"] = "ignore source unstaged-clean state could not be proven"
        return proof

    staged_result = run_git_command(repo_root, ["diff", "--cached", "--quiet", "--", relative_posix])
    if staged_result["exit_code"] == 1:
        proof["clean"] = False
        proof["error"] = "ignore source has staged changes"
        return proof
    if staged_result["exit_code"] != 0:
        proof["clean"] = None
        proof["error"] = "ignore source staged-clean state could not be proven"
        return proof

    proof["clean"] = True
    proof["repo_owned"] = True
    return proof


def check_git_ignore_proof(repo_root: Path, output: Path) -> dict[str, Any]:
    try:
        rel = output.resolve(strict=False).relative_to(repo_root.resolve())
    except ValueError:
        return {
            "ignored": False,
            "repo_owned": False,
            "relative_path": None,
            "source": None,
            "error": None,
        }
    result = run_git_command(repo_root, ["check-ignore", "-v", "--no-index", "--", rel.as_posix()])
    if result["exit_code"] == 1:
        return {
            "ignored": False,
            "repo_owned": False,
            "relative_path": rel.as_posix(),
            "source": None,
            "error": None,
        }
    if result["exit_code"] != 0:
        return {
            "ignored": None,
            "repo_owned": False,
            "relative_path": rel.as_posix(),
            "source": None,
            "error": command_failure_detail(result),
        }
    verbose = parse_check_ignore_verbose(str(result.get("stdout_tail") or ""))
    source = repo_owned_gitignore_source(repo_root, verbose.get("source"))
    proof_error = source.get("error") if not source["repo_owned"] else None
    return {
        "ignored": True,
        "repo_owned": source["repo_owned"] and verbose.get("parse_error") is None,
        "relative_path": rel.as_posix(),
        "source": source,
        "line_number": verbose.get("line_number"),
        "pattern": verbose.get("pattern"),
        "matched_path": verbose.get("matched_path"),
        "parse_error": verbose.get("parse_error"),
        "raw": verbose.get("raw"),
        "error": verbose.get("parse_error") or proof_error,
    }


def check_git_ignored(repo_root: Path, output: Path) -> bool:
    return check_git_ignore_proof(repo_root, output)["ignored"] is True


def check_git_tracked(repo_root: Path, output: Path) -> tuple[bool | None, str | None]:
    try:
        rel = output.resolve(strict=False).relative_to(repo_root.resolve())
    except ValueError:
        return False, None
    result = run_git_command(repo_root, ["ls-files", "--", rel.as_posix()])
    if result["exit_code"] != 0:
        return None, command_failure_detail(result)
    return bool(str(result.get("stdout_tail") or "").strip()), None


def tracked_runtime_readiness_artifacts(repo_root: Path) -> tuple[list[str] | None, str | None]:
    result = run_git_command(repo_root, ["ls-files", "--", CANONICAL_READINESS_DIR.as_posix()])
    if result["exit_code"] != 0:
        return None, command_failure_detail(result)
    paths = [line.strip() for line in str(result.get("stdout_tail") or "").splitlines() if line.strip()]
    return paths, None


def validate_no_tracked_runtime_readiness_artifacts(repo_root: Path) -> None:
    tracked_paths, tracked_error = tracked_runtime_readiness_artifacts(repo_root)
    if tracked_paths is None:
        raise OutputSafetyError(f"canonical readiness tracked state could not be proven: {tracked_error}")
    if tracked_paths:
        paths = ", ".join(tracked_paths)
        raise OutputSafetyError(
            f"tracked readiness artifact(s) exist under {CANONICAL_READINESS_DIR.as_posix()}: {paths}"
        )


def output_git_guard(repo_root: Path, output: Path) -> dict[str, Any]:
    try:
        rel = output.resolve(strict=False).relative_to(repo_root.resolve())
    except ValueError:
        return {
            "inside_repo": False,
            "relative_path": None,
            "tracked": None,
            "tracked_error": None,
            "git_ignored": None,
            "git_ignore_proof": None,
        }
    tracked, tracked_error = check_git_tracked(repo_root, output)
    git_ignore_proof = check_git_ignore_proof(repo_root, output)
    return {
        "inside_repo": True,
        "relative_path": rel.as_posix(),
        "tracked": tracked,
        "tracked_error": tracked_error,
        "git_ignored": git_ignore_proof["ignored"],
        "git_ignore_proof": git_ignore_proof,
    }


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
        tracked, tracked_error = check_git_tracked(repo_root, output)
        if tracked is None:
            raise OutputSafetyError(f"output tracked state could not be proven: {tracked_error}")
        if tracked:
            raise OutputSafetyError(f"output path is tracked by git: {rel.as_posix()}")
        ignore_proof = check_git_ignore_proof(repo_root, output)
        if ignore_proof["ignored"] is None:
            raise OutputSafetyError(
                f"output git ignore state could not be proven: {ignore_proof['error']}"
            )
        if not ignore_proof["ignored"]:
            raise OutputSafetyError(f"output path is not ignored by git: {rel.as_posix()}")
        if not ignore_proof["repo_owned"]:
            if ignore_proof.get("error"):
                raise OutputSafetyError(
                    f"output ignore source is not tracked-clean repo .gitignore: {ignore_proof['error']}"
                )
            raise OutputSafetyError(
                f"output path is not ignored by a repo-owned .gitignore: {rel.as_posix()}"
            )
        validate_no_tracked_runtime_readiness_artifacts(repo_root)
        return

    if not raw_output_is_absolute:
        raise OutputSafetyError("relative output path must stay under repo workspace/readiness")
    allowed_temp_roots = temp_roots()
    if not any(is_relative_to(output_resolved, temp_root) for temp_root in allowed_temp_roots):
        allowed = ", ".join(str(path) for path in allowed_temp_roots)
        raise OutputSafetyError(f"repo-external output path must be under a system temp directory: {allowed}")
    validate_no_tracked_runtime_readiness_artifacts(repo_root)


def ensure_no_symlink_parent(path: Path) -> None:
    if path.parent.is_symlink():
        raise OutputSafetyError(f"output parent is a symlink: {path.parent}")


def validate_replacement_target(path: Path) -> None:
    ensure_no_symlink_parent(path)
    if path.is_symlink():
        raise OutputSafetyError(f"output file is a symlink: {path}")
    if path.exists():
        file_stat = path.stat()
        if not stat.S_ISREG(file_stat.st_mode):
            raise OutputSafetyError(f"output path is not a regular file: {path}")
        if file_stat.st_nlink > 1:
            raise OutputSafetyError(f"output file has multiple hard links: {path}")


def write_json_safely(
    path: Path,
    payload: dict[str, Any],
    validate_before_replace: Callable[[], None] | None = None,
) -> None:
    ensure_no_symlink_parent(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    validate_replacement_target(path)
    temp = path.with_name(f".{path.name}.tmp.{os.getpid()}.{secrets.token_hex(8)}")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(temp, flags, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, sort_keys=True)
            handle.write("\n")
        validate_replacement_target(path)
        if validate_before_replace:
            validate_before_replace()
        os.replace(temp, path)
    finally:
        try:
            temp.unlink()
        except FileNotFoundError:
            pass


def parse_make_assignment_detail(path: Path, key: str) -> dict[str, str] | None:
    if not path.is_file():
        return None
    pattern = re.compile(
        rf"^\s*{re.escape(key)}\s*(?P<operator>:=|\+=|\?=|=)\s*(?P<value>.*?)\s*$"
    )
    try:
        for raw_line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = raw_line.split("#", 1)[0].strip()
            match = pattern.match(line)
            if match:
                value = match.group("value").strip()
                if value:
                    return {"operator": match.group("operator"), "value": value}
    except OSError:
        return None
    return None


def parse_make_assignment(path: Path, key: str) -> str | None:
    detail = parse_make_assignment_detail(path, key)
    return detail["value"] if detail else None


def expand_make_path(value: str, env: dict[str, str]) -> str:
    expanded = value.replace("$(HOME)", env.get("HOME", "")).replace("${HOME}", env.get("HOME", ""))
    expanded = os.path.expandvars(expanded)
    expanded = os.path.expanduser(expanded)
    return expanded


def makefile_logical_lines(path: Path) -> list[str]:
    if not path.is_file():
        return []
    try:
        physical_lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    logical_lines: list[str] = []
    current = ""
    for raw_line in physical_lines:
        line = raw_line.split("#", 1)[0].rstrip()
        if not line and not current:
            continue
        if line.endswith("\\"):
            current = f"{current}{line[:-1]} "
            continue
        logical = f"{current}{line}".strip()
        current = ""
        if logical:
            logical_lines.append(logical)
    if current.strip():
        logical_lines.append(current.strip())
    return logical_lines


def parse_make_assignments(path: Path) -> dict[str, str]:
    assignments: dict[str, str] = {}
    pattern = re.compile(r"^\s*(?P<key>[A-Za-z_][A-Za-z0-9_]*)\s*(?P<operator>:=|\+=|\?=|=)\s*(?P<value>.*?)\s*$")
    for line in makefile_logical_lines(path):
        match = pattern.match(line)
        if not match:
            continue
        key = match.group("key")
        value = match.group("value").strip()
        if match.group("operator") == "+=" and key in assignments:
            assignments[key] = f"{assignments[key]} {value}".strip()
        else:
            assignments[key] = value
    return assignments


def expand_make_variables(value: str, assignments: dict[str, str], depth: int = 0) -> str:
    if depth > 8:
        return value

    def replace_var(match: re.Match[str]) -> str:
        name = match.group("paren") or match.group("brace") or ""
        if name in assignments:
            return expand_make_variables(assignments[name], assignments, depth + 1)
        return os.environ.get(name, "")

    return re.sub(r"\$\((?P<paren>[A-Za-z_][A-Za-z0-9_]*)\)|\$\{(?P<brace>[A-Za-z_][A-Za-z0-9_]*)\}", replace_var, value)


def make_value_tokens(value: str) -> list[str]:
    wildcard_pattern = re.compile(r"\$\(wildcard\s+([^)]+)\)")
    value = wildcard_pattern.sub(r"\1", value)
    try:
        return shlex.split(value)
    except ValueError:
        return value.split()


def build_source_specs(shud_dir: Path) -> list[dict[str, Any]]:
    makefile = shud_dir / "Makefile"
    assignments = parse_make_assignments(makefile)
    specs: list[dict[str, Any]] = []
    for key in BUILD_SOURCE_KEYS:
        raw_value = assignments.get(key)
        if not raw_value:
            continue
        expanded = expand_make_variables(raw_value, assignments)
        for token in make_value_tokens(expanded):
            if not token or token.startswith("-"):
                continue
            suffix = Path(token).suffix.lower()
            has_glob = any(char in token for char in "*?[")
            if not has_glob and suffix not in BUILD_SOURCE_SUFFIXES:
                continue
            token_path = Path(token)
            if token_path.is_absolute():
                continue
            specs.append({"key": key, "pattern": token, "has_glob": has_glob})
    return specs


def ignored_build_source_scan(shud_dir: Path) -> dict[str, Any]:
    specs = build_source_specs(shud_dir)
    records: list[dict[str, Any]] = []
    errors: list[str] = []
    candidate_count = 0
    for spec in specs:
        pattern = spec["pattern"]
        matches = sorted(shud_dir.glob(pattern), key=lambda candidate: candidate.as_posix())
        candidate_count += len(matches)
        if candidate_count > MAX_BUILD_SOURCE_CANDIDATES:
            errors.append(
                f"SHUD build source scan exceeded {MAX_BUILD_SOURCE_CANDIDATES} candidates; refusing readiness pass"
            )
            break
        for path in matches:
            if not path.is_file():
                continue
            try:
                rel = path.resolve(strict=False).relative_to(shud_dir.resolve()).as_posix()
            except ValueError:
                continue
            result = run_git_command(shud_dir, ["check-ignore", "-v", "--", rel])
            if result["exit_code"] == 1:
                continue
            if result["exit_code"] != 0:
                errors.append(f"SHUD build source ignore state could not be proven for {rel}: {command_failure_detail(result)}")
                continue
            verbose = parse_check_ignore_verbose(str(result.get("stdout_tail") or ""))
            records.append(
                {
                    "path": rel,
                    "spec": spec,
                    "ignore": verbose,
                    "command": result,
                }
            )
    if records:
        paths = ", ".join(record["path"] for record in records)
        errors.append(f"SHUD build-glob source is ignored by git: {paths}")
    return {
        "ok": not errors,
        "makefile": str(shud_dir / "Makefile"),
        "specs": specs,
        "candidate_count": candidate_count,
        "candidate_limit": MAX_BUILD_SOURCE_CANDIDATES,
        "ignored_sources": records,
        "errors": errors,
    }


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
    cc_assignment = parse_make_assignment_detail(makefile, "CC")
    cc_value = cc_assignment["value"] if cc_assignment else None
    cc_operator = cc_assignment["operator"] if cc_assignment else None
    env_cc = os.environ.get("CC")
    selected_cc: str | None = None
    if cc_value and cc_operator == "?=" and env_cc:
        selected_cc = env_cc
        source = "environment CC via SHUD Makefile ?="
    elif cc_value:
        selected_cc = cc_value
        source = f"SHUD Makefile CC {cc_operator}"
    elif env_cc:
        selected_cc = env_cc
        source = "environment CC"
    else:
        source = "PATH fallback"
    command: list[str] | None = None
    if selected_cc:
        command = shlex.split(expand_make_path(selected_cc, os.environ))
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
        "makefile_operator": cc_operator,
        "environment_cc_present": bool(env_cc),
        "command": command,
        "version_command": result,
        "ok": ok,
    }
    if not ok:
        errors.append("compiler evidence could not be collected with exit code 0")
    return compiler


def sundials_candidates(shud_dir: Path) -> list[dict[str, Any]]:
    env = dict(os.environ)
    makefile_assignment = parse_make_assignment_detail(shud_dir / "Makefile", "SUNDIALS_DIR")
    makefile_value = makefile_assignment["value"] if makefile_assignment else None
    makefile_operator = makefile_assignment["operator"] if makefile_assignment else None
    selected_raw: str | None = None
    selected_source: str | None = None
    env_value = env.get("SUNDIALS_DIR")
    env_value_blocked = bool(env_value and makefile_value and makefile_operator != "?=")
    make_path_env = dict(env)
    if env_value_blocked:
        make_path_env.pop("SUNDIALS_DIR", None)
    if makefile_value and makefile_operator == "?=" and env_value:
        selected_raw = env_value
        selected_source = "environment SUNDIALS_DIR via Makefile ?="
    elif makefile_value:
        selected_raw = expand_make_path(makefile_value, make_path_env)
        selected_source = f"SHUD Makefile SUNDIALS_DIR {makefile_operator}"
    elif env_value:
        selected_raw = env_value
        selected_source = "environment SUNDIALS_DIR"
    else:
        selected_raw = str(Path.home() / "sundials")
        selected_source = "default ~/sundials fallback"

    raw_candidates = [
        (selected_raw, selected_source, True),
        (
            expand_make_path(makefile_value, make_path_env) if makefile_value else None,
            f"SHUD Makefile SUNDIALS_DIR {makefile_operator}" if makefile_value else None,
            False,
        ),
        (str(Path.home() / "sundials"), "default ~/sundials fallback", False),
        ("/usr/local/sundials", "common local fallback", False),
        ("/usr/local/opt/sundials", "common local fallback", False),
        ("/opt/homebrew/opt/sundials", "Homebrew fallback", False),
    ]
    if env_value and not env_value_blocked:
        raw_candidates.insert(2, (env_value, "environment SUNDIALS_DIR", False))
    seen: set[str] = set()
    candidates: list[dict[str, Any]] = []
    for raw, source, build_selected in raw_candidates:
        if not raw:
            continue
        path = Path(raw).expanduser()
        key = str(path)
        if key not in seen:
            seen.add(key)
            candidates.append(
                {
                    "path": path,
                    "source": source,
                    "build_selected": build_selected,
                    "makefile_operator": makefile_operator if source and "Makefile" in source else None,
                }
            )
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
    for candidate_info in sundials_candidates(shud_dir):
        candidate = candidate_info["path"]
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
            "source": candidate_info["source"],
            "build_selected": candidate_info["build_selected"],
            "makefile_operator": candidate_info["makefile_operator"],
        }
        candidate_records.append(record)
        if record["build_selected"]:
            selected = record

    ok = bool(selected and selected["ok"])
    if not ok:
        errors.append(
            "SUNDIALS evidence is incomplete for the SHUD Makefile-selected build path: "
            "need version header plus cvode and nvecserial libraries"
        )
    return {
        "ok": ok,
        "selected": selected,
        "candidates": candidate_records,
    }


def parse_rshud_version_stdout(stdout: str, stdout_truncated: bool) -> dict[str, Any]:
    sentinel_pattern = re.compile(rf"^{re.escape(RSHUD_VERSION_PREFIX)}(?P<version>\d+(?:\.\d+)+)\n?$")
    exact_match = sentinel_pattern.fullmatch(stdout)
    sentinel_lines = re.findall(
        rf"(?m)^{re.escape(RSHUD_VERSION_PREFIX)}(?P<version>\d+(?:\.\d+)+)\s*$",
        stdout,
    )
    version = exact_match.group("version") if exact_match else (sentinel_lines[0] if len(sentinel_lines) == 1 else None)
    errors: list[str] = []
    if stdout_truncated:
        errors.append("stdout was truncated")
    if not exact_match:
        errors.append(f"stdout must contain exactly {RSHUD_VERSION_PREFIX}<version> and a trailing newline")
    if len(sentinel_lines) > 1:
        errors.append("stdout contained multiple rSHUD version sentinels")
    return {
        "version": version,
        "contract_ok": bool(exact_match and not stdout_truncated),
        "errors": errors,
        "sentinel_prefix": RSHUD_VERSION_PREFIX,
    }


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


def collect_rshud(repo_root: Path, errors: list[str], include_description: bool = True) -> dict[str, Any]:
    command = [
        "Rscript",
        "--vanilla",
        "-e",
        'cat("RSHUD_VERSION=", as.character(packageVersion("rSHUD")), "\\n", sep="")',
    ]
    result = run_command(command, timeout=30)
    parser = parse_rshud_version_stdout(str(result["stdout_tail"]), bool(result["stdout_truncated"]))
    version = parser["version"]
    command_ok = result["exit_code"] == 0 and parser["contract_ok"] and version is not None
    meets_minimum = bool(version and version_at_least(version, MIN_RSHUD_VERSION))
    if not command_ok:
        detail = "; ".join(parser["errors"]) or command_failure_detail(result)
        errors.append(f"installed rSHUD version did not match the strict Rscript sentinel contract: {detail}")
    if version and not meets_minimum:
        errors.append(f"installed rSHUD version {version} is below required {MIN_RSHUD_VERSION}")

    description = repo_root / "rSHUD" / "DESCRIPTION"
    if include_description:
        description_version, description_error = parse_description_version(description)
    else:
        description_version = None
        description_error = "skipped because source-boundary preflight did not pass"
    return {
        "minimum_version": MIN_RSHUD_VERSION,
        "installed": {
            "command": result,
            "version": version,
            "ok": command_ok,
            "meets_minimum": meets_minimum,
            "parser": parser,
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


def command_failure_detail(result: dict[str, Any]) -> str:
    detail = (result.get("stderr_tail") or result.get("stdout_tail") or result.get("error") or "").strip()
    return detail.splitlines()[-1] if detail else "no detail"


def collect_tool_identity(errors: list[str]) -> dict[str, Any]:
    tools = {name: executable_identity(name) for name in ("git", "make", "Rscript")}
    apply_trusted_git_fallback(tools["git"])
    for name, identity in tools.items():
        if not identity["ok"]:
            errors.append(command_identity_error(identity))
    return tools


def tool_identity_ok(tool_identity: dict[str, Any] | None, names: tuple[str, ...]) -> bool:
    if not tool_identity:
        return False
    return all(bool(tool_identity.get(name, {}).get("ok")) for name in names)


def make_timeout_policy(notes: list[str]) -> dict[str, Any]:
    raw_value = os.environ.get(MAKE_TIMEOUT_ENV)
    policy: dict[str, Any] = {
        "env_var": MAKE_TIMEOUT_ENV,
        "raw_value": REDACTED_ENV_VALUE if raw_value else None,
        "raw_value_redacted": bool(raw_value),
        "raw_value_digits_only": bool(raw_value and raw_value.isdigit()),
        "redaction_reason": ENV_VALUE_REDACTION_REASON if raw_value else None,
        "default_seconds": DEFAULT_MAKE_TIMEOUT_SECONDS,
        "max_seconds": MAX_MAKE_TIMEOUT_SECONDS,
        "seconds": DEFAULT_MAKE_TIMEOUT_SECONDS,
        "source": "default" if not raw_value else "environment",
        "ok": True,
        "reason": None,
    }
    if not raw_value:
        return policy
    try:
        timeout = int(raw_value)
    except ValueError:
        notes.append(f"Ignoring invalid {MAKE_TIMEOUT_ENV}; using default make timeout.")
        policy["ok"] = False
        policy["reason"] = "make timeout environment value is not an integer"
        return policy
    if timeout <= 0:
        notes.append(f"Ignoring non-positive {MAKE_TIMEOUT_ENV}; using default make timeout.")
        policy["ok"] = False
        policy["reason"] = "make timeout environment value is not positive"
        return policy
    if timeout > MAX_MAKE_TIMEOUT_SECONDS:
        notes.append(
            f"Rejecting {MAKE_TIMEOUT_ENV}; maximum supported make timeout is {MAX_MAKE_TIMEOUT_SECONDS}s."
        )
        policy["ok"] = False
        policy["reason"] = "make timeout environment value exceeds maximum"
        return policy
    policy["seconds"] = timeout
    return policy


def redacted_environment_variable(name: str) -> dict[str, Any]:
    return {
        "name": name,
        "present": True,
        "value": REDACTED_ENV_VALUE,
        "redacted": True,
        "redaction_reason": ENV_VALUE_REDACTION_REASON,
    }


def blocked_variables_summary(blocked: list[dict[str, str]]) -> str:
    return "; ".join(f"{item['name']} ({item['reason']})" for item in blocked)


def collect_make_environment_guard(shud_dir: Path, skip_build: bool, errors: list[str]) -> dict[str, Any]:
    makefile = shud_dir / "Makefile"
    cc_assignment = parse_make_assignment_detail(makefile, "CC")
    sundials_assignment = parse_make_assignment_detail(makefile, "SUNDIALS_DIR")
    present = {
        name: redacted_environment_variable(name)
        for name in (*UNSUPPORTED_MAKE_ENV_VARS, *MAKE_ENV_OVERRIDE_VARS, *SHUD_TARGET_ENV_OVERRIDE_VARS)
        if os.environ.get(name)
    }
    blocked: list[dict[str, str]] = []
    for name in UNSUPPORTED_MAKE_ENV_VARS:
        if name in present:
            blocked.append(
                {
                    "name": name,
                    "reason": "make control variable could alter Makefile evaluation",
                }
            )
    if "CC" in present and (not cc_assignment or cc_assignment["operator"] != "?="):
        blocked.append(
            {
                "name": "CC",
                "reason": "environment CC is not selected by the recorded SHUD Makefile CC evidence",
            }
        )
    if "CXX" in present:
        blocked.append(
            {
                "name": "CXX",
                "reason": "environment CXX is not part of the recorded SHUD build identity",
            }
        )
    if (
        "SUNDIALS_DIR" in present
        and sundials_assignment
        and sundials_assignment["operator"] != "?="
    ):
        blocked.append(
            {
                "name": "SUNDIALS_DIR",
                "reason": "environment SUNDIALS_DIR would conflict with the SHUD Makefile-selected SUNDIALS_DIR",
            }
        )
    for name in SHUD_TARGET_ENV_OVERRIDE_VARS:
        if name in present:
            blocked.append(
                {
                    "name": name,
                    "reason": "environment variable is consumed by the SHUD Makefile shud target but is not part of the recorded build identity",
                }
            )

    guard = {
        "skipped_build": skip_build,
        "present_variables": present,
        "blocked_variables": blocked,
        "makefile_cc_operator": cc_assignment["operator"] if cc_assignment else None,
        "makefile_sundials_dir_operator": sundials_assignment["operator"] if sundials_assignment else None,
        "ok": not blocked,
    }
    if blocked and not skip_build:
        errors.append(
            "unsupported make environment overrides are set before SHUD build: "
            f"{blocked_variables_summary(blocked)}"
        )
    return guard


def run_make(shud_dir: Path, target: str, timeout_seconds: int) -> dict[str, Any]:
    return run_command(["make", target], cwd=shud_dir, timeout=timeout_seconds)


def git_path_bool(git_dir: Path, args: list[str]) -> tuple[bool | None, str | None]:
    result = run_git_command(git_dir, args)
    if result["exit_code"] == 0:
        return True, None
    if result["exit_code"] == 1:
        return False, None
    return None, command_failure_detail(result)


def git_path_tracked(git_dir: Path, path_name: str) -> tuple[bool | None, str | None]:
    pathspecs = [path_name]
    if (git_dir / path_name).is_dir():
        pathspecs.extend([f"{path_name}/", f"{path_name}/**"])
    result = run_git_command(git_dir, ["ls-files", "--", *pathspecs])
    if result["exit_code"] != 0:
        return None, command_failure_detail(result)
    return bool(str(result.get("stdout_tail") or "").strip()), None


def classify_shud_artifact_name(name: str) -> str | None:
    if name in SHUD_EXACT_ARTIFACT_NAMES:
        return "explicit_build_product"
    if any(fnmatch.fnmatch(name, pattern) for pattern in SHUD_CURRENT_BUILD_ARTIFACT_PATTERNS):
        return "current_build_artifact_pattern"
    if any(fnmatch.fnmatch(name, pattern) for pattern in SHUD_BROAD_RESIDUE_PATTERNS):
        return "broad_residue_pattern"
    return None


def inventory_shud_artifacts(
    shud_dir: Path,
    removable_current_build_names: set[str] | None = None,
) -> list[dict[str, Any]]:
    if not shud_dir.is_dir():
        return []
    removable_current_build_names = removable_current_build_names or set()
    artifacts: list[dict[str, Any]] = []
    for path in sorted(shud_dir.iterdir(), key=lambda candidate: candidate.name):
        classification = classify_shud_artifact_name(path.name)
        if not classification:
            continue
        tracked, tracked_error = git_path_tracked(shud_dir, path.name)
        ignored, ignored_error = git_path_bool(shud_dir, ["check-ignore", "-q", "--", path.name])
        removable = tracked is False and (
            classification == "explicit_build_product" or path.name in removable_current_build_names
        )
        block_reason = None
        if tracked is None:
            block_reason = "tracking state could not be proven"
        elif tracked:
            block_reason = "path is tracked by git"
        elif classification != "explicit_build_product" and path.name not in removable_current_build_names:
            block_reason = "artifact pattern match was not created by the current build flow"
        artifacts.append(
            {
                "path": str(path),
                "name": path.name,
                "exists": path.exists() or path.is_symlink(),
                "kind": "directory" if path.is_dir() and not path.is_symlink() else "file",
                "classification": classification,
                "tracked": tracked,
                "tracked_error": tracked_error,
                "git_ignored": ignored,
                "git_ignored_error": ignored_error,
                "created_by_current_build_flow": path.name in removable_current_build_names,
                "removable": removable,
                "block_reason": block_reason,
                "size_bytes": path.stat().st_size if path.is_file() else None,
            }
        )
    return artifacts


def remove_shud_artifacts(artifacts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    removals: list[dict[str, Any]] = []
    for artifact in artifacts:
        removal = {"path": artifact["path"], "name": artifact["name"], "removed": False, "error": None}
        if not artifact.get("removable"):
            removal["error"] = "artifact path is tracked or tracking state could not be proven"
            removals.append(removal)
            continue
        path = Path(artifact["path"])
        try:
            if path.is_dir() and not path.is_symlink():
                shutil.rmtree(path)
            else:
                path.unlink()
            removal["removed"] = True
        except FileNotFoundError:
            removal["removed"] = True
        except OSError as exc:
            removal["error"] = str(exc)
        removals.append(removal)
    return removals


def cleanup_shud_artifacts(
    shud_dir: Path,
    timeout_seconds: int,
    removable_current_build_names: set[str] | None = None,
) -> dict[str, Any]:
    removable_current_build_names = removable_current_build_names or set()
    before_inventory = inventory_shud_artifacts(shud_dir, removable_current_build_names)
    blocking_inventory = [artifact for artifact in before_inventory if not artifact["removable"]]
    if blocking_inventory:
        return {
            "make_clean": None,
            "make_clean_skipped": True,
            "skip_reason": "unsafe SHUD artifact candidates were present before make clean",
            "artifact_inventory_before_cleanup": before_inventory,
            "artifact_inventory_before_extra_cleanup": before_inventory,
            "extra_cleanup": [],
            "artifact_inventory_after_cleanup": before_inventory,
        }

    make_result = run_make(shud_dir, "clean", timeout_seconds)
    after_make_inventory = inventory_shud_artifacts(shud_dir, removable_current_build_names)
    if make_result["exit_code"] != 0:
        return {
            "make_clean": make_result,
            "make_clean_skipped": False,
            "skip_reason": None,
            "artifact_inventory_before_cleanup": before_inventory,
            "artifact_inventory_before_extra_cleanup": after_make_inventory,
            "extra_cleanup": [],
            "artifact_inventory_after_cleanup": after_make_inventory,
        }

    removals = remove_shud_artifacts(after_make_inventory)
    after_inventory = inventory_shud_artifacts(shud_dir, removable_current_build_names)
    return {
        "make_clean": make_result,
        "make_clean_skipped": False,
        "skip_reason": None,
        "artifact_inventory_before_cleanup": before_inventory,
        "artifact_inventory_before_extra_cleanup": after_make_inventory,
        "extra_cleanup": removals,
        "artifact_inventory_after_cleanup": after_inventory,
    }


def collect_shud(
    repo_root: Path,
    skip_build: bool,
    cleanup: bool,
    source_boundary_ok: bool,
    make_environment_guard: dict[str, Any] | None,
    tool_identity: dict[str, Any] | None,
    errors: list[str],
    notes: list[str],
    incomplete_reasons: list[str],
) -> dict[str, Any]:
    shud_dir = repo_root / "SHUD"
    timeout = make_timeout_policy(notes)
    timeout_seconds = int(timeout["seconds"])
    shud: dict[str, Any] = {
        "path": str(shud_dir),
        "commit": None,
        "commit_error": None,
        "build": {
            "skipped": skip_build,
            "pre_clean": None,
            "command": ["make", "shud"],
            "timeout_seconds": timeout_seconds,
            "timeout_policy": timeout,
            "exit_code": None,
            "result": None,
            "artifact": artifact_state(shud_dir / "shud"),
            "artifact_inventory_after_build": None,
            "cleanup_requested": cleanup,
            "cleanup": None,
            "artifact_after_cleanup": None,
            "artifact_inventory_after_cleanup": None,
            "artifact_inventory_final": None,
            "blocked_before_make": False,
            "block_reason": None,
            "make_environment_guard": make_environment_guard,
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

    if not source_boundary_ok:
        shud["build"]["blocked_before_make"] = True
        shud["build"]["block_reason"] = "source-boundary preflight did not pass"
        shud["build"]["artifact_inventory_final"] = inventory_shud_artifacts(shud_dir)
        return shud

    if not timeout["ok"] and not skip_build:
        errors.append(f"SHUD make timeout rejected: {timeout['reason']}")
        shud["build"]["blocked_before_make"] = True
        shud["build"]["block_reason"] = str(timeout["reason"])
        shud["build"]["artifact_inventory_final"] = inventory_shud_artifacts(shud_dir)
        return shud

    if not tool_identity_ok(tool_identity, ("git", "make")) and not skip_build:
        shud["build"]["blocked_before_make"] = True
        shud["build"]["block_reason"] = "tool identity preflight did not pass"
        shud["build"]["artifact_inventory_final"] = inventory_shud_artifacts(shud_dir)
        return shud

    if make_environment_guard and not make_environment_guard.get("ok", False) and not skip_build:
        shud["build"]["blocked_before_make"] = True
        shud["build"]["block_reason"] = "unsupported make environment overrides are set"
        shud["build"]["artifact_inventory_final"] = inventory_shud_artifacts(shud_dir)
        return shud

    if skip_build:
        reason = "SHUD build was skipped by --skip-build; evidence is environment-only and not a readiness pass."
        notes.append(reason)
        incomplete_reasons.append(reason)
        final_inventory = inventory_shud_artifacts(shud_dir)
        shud["build"]["artifact_inventory_final"] = final_inventory
        if final_inventory:
            errors.append("SHUD build artifacts are present while --skip-build collected env-only evidence")
        return shud

    pre_clean = cleanup_shud_artifacts(shud_dir, timeout_seconds)
    shud["build"]["pre_clean"] = pre_clean
    if pre_clean["make_clean_skipped"]:
        errors.append("SHUD pre-build cleanup refused unsafe build artifacts in SHUD checkout before make clean")
        shud["build"]["artifact"] = artifact_state(shud_dir / "shud")
        shud["build"]["artifact_inventory_final"] = pre_clean["artifact_inventory_after_cleanup"]
        return shud
    if pre_clean["make_clean"]["exit_code"] != 0:
        errors.append(f"SHUD pre-build make clean failed: {command_failure_detail(pre_clean['make_clean'])}")
        shud["build"]["artifact"] = artifact_state(shud_dir / "shud")
        shud["build"]["artifact_inventory_final"] = pre_clean["artifact_inventory_after_cleanup"]
        return shud
    if pre_clean["artifact_inventory_after_cleanup"]:
        errors.append("SHUD pre-build cleanup left build artifacts in SHUD checkout")
        shud["build"]["artifact"] = artifact_state(shud_dir / "shud")
        shud["build"]["artifact_inventory_final"] = pre_clean["artifact_inventory_after_cleanup"]
        return shud

    build_result = run_make(shud_dir, "shud", timeout_seconds)
    shud["build"]["result"] = build_result
    shud["build"]["exit_code"] = build_result["exit_code"]
    shud["build"]["artifact"] = artifact_state(shud_dir / "shud")
    shud["build"]["artifact_inventory_after_build"] = inventory_shud_artifacts(shud_dir)
    if build_result["exit_code"] != 0:
        errors.append(f"SHUD build command failed: {command_text(build_result)}: {command_failure_detail(build_result)}")
    elif not shud["build"]["artifact"]["exists"]:
        errors.append("SHUD build command exited 0 but SHUD/shud does not exist")
    elif not shud["build"]["artifact"]["executable"]:
        errors.append("SHUD build command exited 0 but SHUD/shud is not executable")

    if cleanup:
        removable_current_build_names = {
            artifact["name"]
            for artifact in (shud["build"]["artifact_inventory_after_build"] or [])
            if artifact["classification"] != "explicit_build_product" and artifact["tracked"] is False
        }
        cleanup_result = cleanup_shud_artifacts(shud_dir, timeout_seconds, removable_current_build_names)
        shud["build"]["cleanup"] = cleanup_result
        shud["build"]["artifact_after_cleanup"] = artifact_state(shud_dir / "shud")
        shud["build"]["artifact_inventory_after_cleanup"] = cleanup_result["artifact_inventory_after_cleanup"]
        if cleanup_result["make_clean_skipped"]:
            errors.append("SHUD cleanup refused unsafe build artifacts in SHUD checkout before make clean")
        elif cleanup_result["make_clean"]["exit_code"] != 0:
            errors.append(f"SHUD cleanup make clean failed: {command_failure_detail(cleanup_result['make_clean'])}")
        elif shud["build"]["artifact_after_cleanup"]["exists"]:
            errors.append("SHUD cleanup completed but SHUD/shud still exists")
        elif shud["build"]["artifact_inventory_after_cleanup"]:
            errors.append("SHUD cleanup completed but build artifacts remain in SHUD checkout")
    else:
        errors.append("SHUD cleanup was disabled; readiness requires post-build cleanup")

    final_inventory = inventory_shud_artifacts(shud_dir)
    shud["build"]["artifact_inventory_final"] = final_inventory
    if final_inventory:
        errors.append("SHUD build artifacts remain after helper completion")

    return shud


def append_status_errors(label: str, result: dict[str, Any], errors: list[str]) -> None:
    if result["exit_code"] != 0:
        errors.append(f"{label} git status failed: {command_failure_detail(result)}")
        return
    status = str(result.get("stdout_tail") or "").strip()
    if status:
        errors.append(f"{label} has uncommitted or visible changes: {status}")


def collect_source_boundary(repo_root: Path, errors: list[str], phase: str) -> dict[str, Any]:
    boundary_errors: list[str] = []
    status_args = ["status", "--short", "--untracked-files=all"]
    root_status = run_git_command(repo_root, [*status_args, "--", "SHUD", "rSHUD", "workspace"])
    shud_status = run_git_command(repo_root / "SHUD", status_args)
    rshud_status = run_git_command(repo_root / "rSHUD", status_args)
    ignored_build_sources = ignored_build_source_scan(repo_root / "SHUD")
    append_status_errors("workspace/SHUD/rSHUD source boundary", root_status, boundary_errors)
    append_status_errors("SHUD checkout", shud_status, boundary_errors)
    append_status_errors("rSHUD checkout", rshud_status, boundary_errors)
    boundary_errors.extend(ignored_build_sources["errors"])
    errors.extend(boundary_errors)
    return {
        "phase": phase,
        "ok": not boundary_errors,
        "errors": boundary_errors,
        "repo_status_shud_rshud_workspace": root_status,
        "shud_status": shud_status,
        "rshud_status": rshud_status,
        "ignored_build_sources": ignored_build_sources,
    }


def skipped_component(reason: str) -> dict[str, Any]:
    return {
        "ok": False,
        "skipped": True,
        "skip_reason": reason,
    }


def self_test_fixture_marker() -> dict[str, Any]:
    return {
        "active": SELF_TEST_FIXTURE_MODE,
        "ready_for_consumption": not SELF_TEST_FIXTURE_MODE,
        "reason": SELF_TEST_FIXTURE_REASON if SELF_TEST_FIXTURE_MODE else None,
        "tool_allowance": {
            "requires_cli_flag": "--self-test",
            "enable_env": SELF_TEST_TOOL_ALLOWANCE_ENABLE_ENV,
            "dir_env": SELF_TEST_TOOL_ALLOWANCE_DIR_ENV,
            "env_values_recorded": False,
        },
    }


def finalize_conclusion(payload: dict[str, Any], skip_build: bool) -> None:
    if skip_build:
        payload["conclusion"] = "incomplete"
    elif payload["errors"]:
        payload["conclusion"] = "block"
    elif payload["incomplete_reasons"] or payload.get("self_test_fixture", {}).get("active"):
        payload["conclusion"] = "incomplete"
    else:
        payload["conclusion"] = "pass"


def provisional_output_payload(payload: dict[str, Any], skip_build: bool) -> dict[str, Any]:
    provisional = copy.deepcopy(payload)
    provisional["provisional"] = {
        "status": "postflight_pending",
        "ready_for_consumption": False,
        "reason": PROVISIONAL_POSTFLIGHT_REASON,
    }
    if PROVISIONAL_POSTFLIGHT_REASON not in provisional["incomplete_reasons"]:
        provisional["incomplete_reasons"].append(PROVISIONAL_POSTFLIGHT_REASON)
    finalize_conclusion(provisional, skip_build)
    return provisional


def build_payload(repo_root: Path, output: Path, skip_build: bool, cleanup: bool) -> dict[str, Any]:
    notes: list[str] = []
    errors: list[str] = []
    incomplete_reasons: list[str] = []
    if SELF_TEST_FIXTURE_MODE:
        incomplete_reasons.append(SELF_TEST_FIXTURE_REASON)
    shud_dir = repo_root / "SHUD"
    payload: dict[str, Any] = {
        "readiness_check": "shud_rshud",
        "version": VERSION,
        "checked_at": utc_now(),
        "repo_root": str(repo_root),
        "output": {
            "path": str(output),
            "default_relative_path": str(DEFAULT_OUTPUT_RELATIVE),
            "git_guard": output_git_guard(repo_root, output),
        },
        "os": collect_os(),
        "self_test_fixture": self_test_fixture_marker(),
    }
    payload["tool_identity"] = collect_tool_identity(errors)
    preflight = collect_source_boundary(repo_root, errors, "preflight")
    payload["source_boundary"] = {
        "preflight": preflight,
        "postflight_after_output_write": None,
    }
    source_boundary_ok = preflight["ok"]
    if source_boundary_ok:
        make_environment_guard = collect_make_environment_guard(shud_dir, skip_build, errors)
        payload["make_environment_guard"] = make_environment_guard
        payload["compiler"] = collect_compiler(shud_dir, errors, notes)
        payload["sundials"] = collect_sundials(shud_dir, errors)
    else:
        reason = "source-boundary preflight did not pass; skipped SHUD Makefile-derived evidence"
        make_environment_guard = None
        payload["make_environment_guard"] = skipped_component(reason)
        payload["compiler"] = skipped_component(reason)
        payload["sundials"] = skipped_component(reason)
    payload["shud"] = collect_shud(
        repo_root,
        skip_build,
        cleanup,
        source_boundary_ok,
        make_environment_guard,
        payload.get("tool_identity"),
        errors,
        notes,
        incomplete_reasons,
    )
    payload["rshud"] = collect_rshud(repo_root, errors, include_description=source_boundary_ok)
    payload["notes"] = notes
    payload["errors"] = errors
    payload["incomplete_reasons"] = incomplete_reasons
    finalize_conclusion(payload, skip_build)
    return payload


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", default=None, help="Repository root to inspect. Defaults to this script's repo.")
    parser.add_argument(
        "--output",
        default=None,
        help=f"Evidence output path. Defaults to {DEFAULT_OUTPUT_RELATIVE}. Relative paths are under repo root.",
    )
    parser.add_argument(
        "--skip-build",
        action="store_true",
        help="Skip make clean/make shud and collect env/version evidence only. This produces incomplete evidence, not a readiness pass.",
    )
    parser.add_argument(
        "--cleanup",
        action="store_true",
        help="Accepted for compatibility. Cleanup is always performed after a non-skipped build.",
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help=(
            "Enable internal fixture-tool allowance for this self-test run. "
            "This mode always produces non-consumable readiness evidence."
        ),
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    global SELF_TEST_FIXTURE_MODE
    args = parse_args(argv)
    SELF_TEST_FIXTURE_MODE = bool(args.self_test)
    repo_root_input = Path(args.repo_root) if args.repo_root else default_repo_root()
    repo_root_lexical = Path(os.path.abspath(repo_root_input))
    repo_root = repo_root_input.resolve()
    output = output_path(repo_root_lexical, args.output)
    raw_output_is_absolute = bool(args.output and Path(args.output).is_absolute())

    def validate_output_write_scope() -> None:
        validate_output_scope(
            repo_root,
            output,
            repo_root_lexical,
            raw_output_is_absolute=raw_output_is_absolute,
        )

    try:
        validate_output_write_scope()
        validate_replacement_target(output)
    except (OutputSafetyError, OSError) as exc:
        print(f"readiness output path rejected: {exc}", file=sys.stderr)
        return 2

    cleanup = not args.skip_build
    payload = build_payload(repo_root, output, args.skip_build, cleanup)
    try:
        write_json_safely(
            output,
            provisional_output_payload(payload, args.skip_build),
            validate_before_replace=validate_output_write_scope,
        )
    except OutputSafetyError as exc:
        print(f"readiness output write rejected: {exc}", file=sys.stderr)
        return 2
    except OSError as exc:
        print(f"readiness output write failed: {exc}", file=sys.stderr)
        return 2

    postflight_errors: list[str] = []
    payload["source_boundary"]["postflight_after_output_write"] = collect_source_boundary(
        repo_root,
        postflight_errors,
        "postflight_after_output_write",
    )
    payload["errors"].extend(postflight_errors)
    finalize_conclusion(payload, args.skip_build)
    try:
        write_json_safely(output, payload, validate_before_replace=validate_output_write_scope)
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
