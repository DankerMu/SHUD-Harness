#!/usr/bin/env python3
"""Collect SHUD build and rSHUD installed-package readiness evidence."""

from __future__ import annotations

import argparse
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
from typing import Any


VERSION = "v0.2.0"
DEFAULT_OUTPUT_RELATIVE = Path("workspace/readiness/shud_rshud_readiness.json")
MIN_RSHUD_VERSION = "2.5.0"
TEXT_TAIL_LIMIT = 12000
COMMAND_TAIL_READ_BYTES = TEXT_TAIL_LIMIT * 4
DEFAULT_MAKE_TIMEOUT_SECONDS = 300
MAKE_TIMEOUT_ENV = "SHUD_RSHUD_READINESS_MAKE_TIMEOUT_SECONDS"
SHUD_ARTIFACT_NAMES = {"shud", "shud_omp", "shud_debug", "shud.dSYM"}
SHUD_ARTIFACT_PATTERNS = ("*.o", "*.dSYM", "shud.*", "SHUD.*")


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


def run_command(args: list[str], cwd: Path | None = None, timeout: int | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {
        "command": args,
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
    }
    try:
        process = subprocess.Popen(
            args,
            cwd=str(cwd) if cwd else None,
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


def sundials_candidates(shud_dir: Path) -> list[dict[str, Any]]:
    env = os.environ
    makefile_assignment = parse_make_assignment_detail(shud_dir / "Makefile", "SUNDIALS_DIR")
    makefile_value = makefile_assignment["value"] if makefile_assignment else None
    makefile_operator = makefile_assignment["operator"] if makefile_assignment else None
    selected_raw: str | None = None
    selected_source: str | None = None
    env_value = env.get("SUNDIALS_DIR")
    if makefile_value and makefile_operator == "?=" and env_value:
        selected_raw = env_value
        selected_source = "environment SUNDIALS_DIR via Makefile ?="
    elif makefile_value:
        selected_raw = expand_make_path(makefile_value, env)
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
            expand_make_path(makefile_value, env) if makefile_value else None,
            f"SHUD Makefile SUNDIALS_DIR {makefile_operator}" if makefile_value else None,
            False,
        ),
        (env_value, "environment SUNDIALS_DIR", False),
        (str(Path.home() / "sundials"), "default ~/sundials fallback", False),
        ("/usr/local/sundials", "common local fallback", False),
        ("/usr/local/opt/sundials", "common local fallback", False),
        ("/opt/homebrew/opt/sundials", "Homebrew fallback", False),
    ]
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


def command_failure_detail(result: dict[str, Any]) -> str:
    detail = (result.get("stderr_tail") or result.get("stdout_tail") or result.get("error") or "").strip()
    return detail.splitlines()[-1] if detail else "no detail"


def make_timeout_seconds(notes: list[str]) -> int:
    raw_value = os.environ.get(MAKE_TIMEOUT_ENV)
    if not raw_value:
        return DEFAULT_MAKE_TIMEOUT_SECONDS
    try:
        timeout = int(raw_value)
    except ValueError:
        notes.append(f"Ignoring invalid {MAKE_TIMEOUT_ENV}={raw_value!r}; using default make timeout.")
        return DEFAULT_MAKE_TIMEOUT_SECONDS
    if timeout <= 0:
        notes.append(f"Ignoring non-positive {MAKE_TIMEOUT_ENV}={raw_value!r}; using default make timeout.")
        return DEFAULT_MAKE_TIMEOUT_SECONDS
    return timeout


def run_make(shud_dir: Path, target: str, timeout_seconds: int) -> dict[str, Any]:
    return run_command(["make", target], cwd=shud_dir, timeout=timeout_seconds)


def git_path_bool(git_dir: Path, args: list[str]) -> tuple[bool | None, str | None]:
    result = run_command(["git", "-C", str(git_dir), *args], timeout=20)
    if result["exit_code"] == 0:
        return True, None
    if result["exit_code"] == 1:
        return False, None
    return None, command_failure_detail(result)


def git_path_tracked(git_dir: Path, path_name: str) -> tuple[bool | None, str | None]:
    pathspecs = [path_name]
    if (git_dir / path_name).is_dir():
        pathspecs.extend([f"{path_name}/", f"{path_name}/**"])
    result = run_command(["git", "-C", str(git_dir), "ls-files", "--", *pathspecs], timeout=20)
    if result["exit_code"] != 0:
        return None, command_failure_detail(result)
    return bool(str(result.get("stdout_tail") or "").strip()), None


def is_shud_artifact_name(name: str) -> bool:
    return name in SHUD_ARTIFACT_NAMES or any(fnmatch.fnmatch(name, pattern) for pattern in SHUD_ARTIFACT_PATTERNS)


def inventory_shud_artifacts(shud_dir: Path) -> list[dict[str, Any]]:
    if not shud_dir.is_dir():
        return []
    artifacts: list[dict[str, Any]] = []
    for path in sorted(shud_dir.iterdir(), key=lambda candidate: candidate.name):
        if not is_shud_artifact_name(path.name):
            continue
        tracked, tracked_error = git_path_tracked(shud_dir, path.name)
        ignored, ignored_error = git_path_bool(shud_dir, ["check-ignore", "-q", "--", path.name])
        removable = tracked is False
        artifacts.append(
            {
                "path": str(path),
                "name": path.name,
                "exists": path.exists() or path.is_symlink(),
                "kind": "directory" if path.is_dir() and not path.is_symlink() else "file",
                "tracked": tracked,
                "tracked_error": tracked_error,
                "git_ignored": ignored,
                "git_ignored_error": ignored_error,
                "removable": removable,
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


def cleanup_shud_artifacts(shud_dir: Path, timeout_seconds: int) -> dict[str, Any]:
    make_result = run_make(shud_dir, "clean", timeout_seconds)
    before_inventory = inventory_shud_artifacts(shud_dir)
    removals = remove_shud_artifacts(before_inventory)
    after_inventory = inventory_shud_artifacts(shud_dir)
    return {
        "make_clean": make_result,
        "artifact_inventory_before_extra_cleanup": before_inventory,
        "extra_cleanup": removals,
        "artifact_inventory_after_cleanup": after_inventory,
    }


def collect_shud(
    repo_root: Path,
    skip_build: bool,
    cleanup: bool,
    errors: list[str],
    notes: list[str],
    incomplete_reasons: list[str],
) -> dict[str, Any]:
    shud_dir = repo_root / "SHUD"
    timeout_seconds = make_timeout_seconds(notes)
    shud: dict[str, Any] = {
        "path": str(shud_dir),
        "commit": None,
        "commit_error": None,
        "build": {
            "skipped": skip_build,
            "pre_clean": None,
            "command": ["make", "shud"],
            "timeout_seconds": timeout_seconds,
            "exit_code": None,
            "result": None,
            "artifact": artifact_state(shud_dir / "shud"),
            "artifact_inventory_after_build": None,
            "cleanup_requested": cleanup,
            "cleanup": None,
            "artifact_after_cleanup": None,
            "artifact_inventory_after_cleanup": None,
            "artifact_inventory_final": None,
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
    if pre_clean["make_clean"]["exit_code"] != 0:
        errors.append(f"SHUD pre-build make clean failed: {command_failure_detail(pre_clean['make_clean'])}")
        shud["build"]["artifact"] = artifact_state(shud_dir / "shud")
        return shud
    if pre_clean["artifact_inventory_after_cleanup"]:
        errors.append("SHUD pre-build cleanup left build artifacts in SHUD checkout")
        shud["build"]["artifact"] = artifact_state(shud_dir / "shud")
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
        cleanup_result = cleanup_shud_artifacts(shud_dir, timeout_seconds)
        shud["build"]["cleanup"] = cleanup_result
        shud["build"]["artifact_after_cleanup"] = artifact_state(shud_dir / "shud")
        shud["build"]["artifact_inventory_after_cleanup"] = cleanup_result["artifact_inventory_after_cleanup"]
        if cleanup_result["make_clean"]["exit_code"] != 0:
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


def collect_source_boundary(repo_root: Path, errors: list[str]) -> dict[str, Any]:
    root_status = run_command(["git", "-C", str(repo_root), "status", "--short", "--", "SHUD", "rSHUD", "workspace"], timeout=20)
    shud_status = run_command(["git", "-C", str(repo_root / "SHUD"), "status", "--short"], timeout=20)
    rshud_status = run_command(["git", "-C", str(repo_root / "rSHUD"), "status", "--short"], timeout=20)
    append_status_errors("workspace/SHUD/rSHUD source boundary", root_status, errors)
    append_status_errors("SHUD checkout", shud_status, errors)
    append_status_errors("rSHUD checkout", rshud_status, errors)
    return {
        "repo_status_shud_rshud_workspace": root_status,
        "shud_status": shud_status,
        "rshud_status": rshud_status,
    }


def build_payload(repo_root: Path, output: Path, skip_build: bool, cleanup: bool) -> dict[str, Any]:
    notes: list[str] = []
    errors: list[str] = []
    incomplete_reasons: list[str] = []
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
    payload["shud"] = collect_shud(repo_root, skip_build, cleanup, errors, notes, incomplete_reasons)
    payload["rshud"] = collect_rshud(repo_root, errors)
    payload["source_boundary"] = collect_source_boundary(repo_root, errors)
    payload["notes"] = notes
    payload["errors"] = errors
    payload["incomplete_reasons"] = incomplete_reasons
    if skip_build or incomplete_reasons:
        payload["conclusion"] = "incomplete"
    elif errors:
        payload["conclusion"] = "block"
    else:
        payload["conclusion"] = "pass"
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

    cleanup = not args.skip_build
    payload = build_payload(repo_root, output, args.skip_build, cleanup)
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
