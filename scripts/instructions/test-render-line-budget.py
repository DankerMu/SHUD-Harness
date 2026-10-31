#!/usr/bin/env python3
"""Exercise the instruction budget through real renders in temporary roots.

Usage: python3 scripts/instructions/test-render-line-budget.py
No checker imports or third-party packages are required.
"""
from __future__ import annotations

import shlex
import subprocess
import tempfile
import unittest
from pathlib import Path

RENDERER = Path(__file__).resolve().with_name("render.sh")


class RenderLineBudgetTests(unittest.TestCase):
    def run_renderer(self, root: Path, *, check: bool = False) -> subprocess.CompletedProcess[str]:
        command = ["sh", str(RENDERER), "--root", str(root)]
        if check:
            command.append("--check")
        try:
            return subprocess.run(
                command, cwd=root, capture_output=True, text=True, check=False, timeout=30,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            self.fail(f"EXECUTION ERROR (not a budget result): {shlex.join(command)}: {error}")

    @staticmethod
    def command_evidence(result: subprocess.CompletedProcess[str]) -> str:
        return (
            f"command: {shlex.join(result.args)}\n"
            f"exit: {result.returncode}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )

    def require_render(self, root: Path) -> None:
        result = self.run_renderer(root)
        self.assertEqual(
            result.returncode, 0,
            "FIXTURE RENDER ERROR (not a budget result):\n" + self.command_evidence(result),
        )

    def assert_budget(
        self, *, limit: int, agents_lines: int, claude_lines: int, accepted: bool,
        final_newline: bool = True,
    ) -> None:
        with tempfile.TemporaryDirectory(prefix="instruction-line-budget-") as directory:
            root = Path(directory)
            sources = root / "instructions" / "agents"
            sources.mkdir(parents=True)
            (root / "constraints.yaml").write_text(
                f"thresholds:\n  agents_md_max_lines: {limit}\n", encoding="utf-8",
            )
            for name in ("shared.md", "codex.md", "claude.md"):
                (sources / name).write_bytes(b"")

            # Discover framing overhead through the public render seam, not a copied header.
            self.require_render(root)
            for fragment, output, target in (
                ("codex.md", "AGENTS.md", agents_lines),
                ("claude.md", "CLAUDE.md", claude_lines),
            ):
                framing = (root / output).read_bytes()
                self.assertTrue(framing.endswith(b"\n"), "FIXTURE ERROR: framing must end in LF")
                overhead = framing.count(b"\n")
                self.assertGreaterEqual(target, overhead, "FIXTURE ERROR: target below framing")
                fragment_bytes = b"Fixture instruction.\n" * (target - overhead)
                if fragment == "codex.md" and not final_newline:
                    self.assertTrue(fragment_bytes, "FIXTURE ERROR: need an unterminated source line")
                    fragment_bytes = fragment_bytes[:-1]
                (sources / fragment).write_bytes(fragment_bytes)

            # Only render.sh writes the projections. The check sees exactly those bytes.
            self.require_render(root)
            projections = {}
            for output, expected_lines in (("AGENTS.md", agents_lines), ("CLAUDE.md", claude_lines)):
                content = (root / output).read_bytes()
                terminated = final_newline if output == "AGENTS.md" else True
                self.assertEqual(
                    content.endswith(b"\n"), terminated, f"FIXTURE ERROR: {output} line ending",
                )
                self.assertEqual(
                    content.count(b"\n"), expected_lines - (not terminated),
                    f"FIXTURE ERROR: {output} does not have the requested physical line count",
                )
                projections[output] = content

            result = self.run_renderer(root, check=True)
            evidence = self.command_evidence(result)
            for output, content in projections.items():
                self.assertEqual(
                    (root / output).read_bytes(), content,
                    f"CHECK MUTATED PROJECTION: {output}\n{evidence}",
                )
            if accepted:
                self.assertEqual(
                    result.returncode, 0,
                    f"UNEXPECTED REJECTION: matching AGENTS.md={agents_lines}, "
                    f"CLAUDE.md={claude_lines}, configured limit={limit}\n{evidence}",
                )
            else:
                self.assertNotEqual(
                    result.returncode, 0,
                    f"SEMANTIC BUDGET FAILURE: --check accepted byte-matching "
                    f"AGENTS.md with {agents_lines} lines above configured limit {limit}\n{evidence}",
                )
                # A missing executable/config or unrelated cmp failure is not budget enforcement.
                self.assertEqual(result.returncode, 1, "NON-BUDGET REJECTION:\n" + evidence)
                diagnostic = result.stdout + result.stderr
                for detail in ("AGENTS.md", str(agents_lines), str(limit)):
                    self.assertIn(detail, diagnostic, "UNCLASSIFIED REJECTION:\n" + evidence)

    def test_320_lines_at_configured_limit_are_accepted(self) -> None:
        self.assert_budget(limit=320, agents_lines=320, claude_lines=320, accepted=True)

    def test_321_matching_lines_above_configured_limit_are_rejected(self) -> None:
        self.assert_budget(limit=320, agents_lines=321, claude_lines=320, accepted=False)

    def test_claude_only_excess_is_accepted(self) -> None:
        self.assert_budget(limit=320, agents_lines=320, claude_lines=321, accepted=True)

    def test_configured_limit_is_not_hardcoded(self) -> None:
        for lines, accepted in ((40, True), (41, False)):
            with self.subTest(agents_lines=lines, configured_limit=40):
                self.assert_budget(limit=40, agents_lines=lines, claude_lines=321, accepted=accepted)

    def test_final_unterminated_line_counts_toward_budget(self) -> None:
        for lines, accepted in ((320, True), (321, False)):
            with self.subTest(agents_lines=lines):
                self.assert_budget(
                    limit=320, agents_lines=lines, claude_lines=320,
                    accepted=accepted, final_newline=False,
                )

    def empty_fixture(self) -> Path:
        directory = tempfile.TemporaryDirectory(prefix="instruction-budget-config-")
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        sources = root / "instructions" / "agents"
        sources.mkdir(parents=True)
        for name in ("shared.md", "codex.md", "claude.md"):
            (sources / name).write_bytes(b"")
        (root / "constraints.yaml").write_text(
            "thresholds:\n  agents_md_max_lines: 320\n", encoding="utf-8",
        )
        return root

    def test_invalid_configuration_is_rejected_without_fallback(self) -> None:
        configs = {
            "missing file": None,
            "empty file": "",
            "missing threshold": "thresholds:\n  max_file_lines: 1000\n",
            "wrong section": "other:\n  agents_md_max_lines: 320\n",
            "duplicate threshold": "thresholds:\n  agents_md_max_lines: 320\n  agents_md_max_lines: 400\n",
            "duplicate section": "thresholds:\n  agents_md_max_lines: 320\nthresholds:\n  agents_md_max_lines: 400\n",
        }
        for value in ("", "0", "-1", "1.5", "true", "320oops", '"320"', "[]", "320#comment"):
            configs[f"malformed {value!r}"] = f"thresholds:\n  agents_md_max_lines: {value}\n"
        for name, config in configs.items():
            with self.subTest(config=name):
                root = self.empty_fixture()
                path = root / "constraints.yaml"
                if config is None:
                    path.unlink()
                else:
                    path.write_text(config, encoding="utf-8")
                self.require_render(root)
                result = self.run_renderer(root, check=True)
                evidence = self.command_evidence(result)
                self.assertEqual(result.returncode, 1, evidence)
                self.assertIn("invalid budget configuration", result.stderr, evidence)
                self.assertIn("constraints.yaml", result.stderr, evidence)
                self.assertNotIn("out of date", result.stderr, evidence)

    def test_commented_config_uses_only_thresholds_budget(self) -> None:
        root = self.empty_fixture()
        (root / "constraints.yaml").write_text(
            "other:\n  agents_md_max_lines: 1\n"
            "thresholds: # owned block\n  max_file_lines: 1000\n"
            "  agents_md_max_lines: 320 # AGENTS only\n"
            "next:\n  agents_md_max_lines: 1\n", encoding="utf-8",
        )
        self.require_render(root)
        result = self.run_renderer(root, check=True)
        self.assertEqual(result.returncode, 0, self.command_evidence(result))

    def test_both_projections_still_reject_byte_drift(self) -> None:
        for output in ("AGENTS.md", "CLAUDE.md"):
            with self.subTest(projection=output):
                root = self.empty_fixture()
                self.require_render(root)
                clean = self.run_renderer(root, check=True)
                self.assertEqual(clean.returncode, 0, self.command_evidence(clean))
                path = root / output
                path.write_bytes(path.read_bytes() + b"Hand-edited fixture.\n")
                result = self.run_renderer(root, check=True)
                evidence = self.command_evidence(result)
                self.assertEqual(result.returncode, 1, evidence)
                self.assertIn(f"{output} is out of date", result.stderr, evidence)


if __name__ == "__main__":
    unittest.main(verbosity=2)
