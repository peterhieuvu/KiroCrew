"""Ratchet: every whole-config agent-spec writer calls the governance sanitizer.

``allowedTools`` is kiro-cli's blanket auto-approve list and THE one grant path
that never reaches the PreToolUse gate, so a ref that lands on it skips the deny
floor, the sensitive-path check, the governance evaluation and the SEL record.
``autoApprove`` on an MCP server entry is the second route to the same bypass.
``platform.governance.sanitize_agent_config_governance`` closes both, and its
docstring states the contract this file enforces:

    Every whole-config writer MUST call this immediately before it persists, so
    no future writer can reopen the surface.

The predicate behind it is correct and refuses the floor-scoped builtins
unconditionally. The bug this guards against is a writer that never CALLS it.

That is not hypothetical. ``_install_research_agent`` derived its spec from
``build_agent_config()`` and wrote the result straight to disk, so the shipped
template's ``fs_read``/``code``/``glob``/``grep`` reached
``kirocrew-research.json``'s auto-approve list while the same four were filtered
out of ``kirocrew.json``. The sibling installers escaped the same fate only
because each author independently hardcoded a minimal list — the invariant was
held by per-writer vigilance rather than by the function that exists to guarantee
it.

So these are STRUCTURAL checks rather than behavioural ones. The behavioural tests
live next to each writer (``test_auto_research.py``, ``test_conductor_agent.py``,
``test_app_mcp_scoping.py``) and assert what a given spec ends up with; they pass
for a spec that is clean today and say nothing about the next writer. These assert
the shape a writer must have, so a NEW installer that reopens the surface fails
here even though no existing spec changed.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

from kiro_crew.agent_files import OWNED_KIRO_AGENT_FILES
from kiro_crew.platform.governance import BUILTIN_TOOL_SCOPES

AGENT_PY = Path(__file__).resolve().parents[1] / "src" / "kiro_crew" / "agent.py"

#: The shared sanitizer every whole-config writer must call before it persists.
SANITIZER = "sanitize_agent_config_governance"

#: Scopes whose builtins can never be auto-approved. Mirrored from
#: ``platform.governance._FLOOR_GATE_SCOPES`` rather than imported, deliberately:
#: this is the ratchet's own statement of the floor, so *widening* the production
#: set without revisiting these writers shows up here as a failure.
FLOOR_SCOPES = frozenset({"filesystem.read", "filesystem.write", "commands"})

#: Builtins that may never appear on an auto-approve list, derived from the real
#: scope map so a tool whose classification changes is picked up automatically.
FLOOR_BUILTINS = frozenset(
    name for name, scopes in BUILTIN_TOOL_SCOPES.items() if FLOOR_SCOPES.intersection(scopes)
)


def _functions() -> list[ast.FunctionDef]:
    tree = ast.parse(AGENT_PY.read_text(encoding="utf-8"))
    return [n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)]


def _calls(fn: ast.FunctionDef) -> set[str]:
    """Bare names of every function called anywhere inside ``fn``."""
    out: set[str] = set()
    for node in ast.walk(fn):
        if isinstance(node, ast.Call):
            target = node.func
            if isinstance(target, ast.Name):
                out.add(target.id)
            elif isinstance(target, ast.Attribute):
                out.add(target.attr)
    return out


def _whole_config_writers() -> list[ast.FunctionDef]:
    """Functions that assemble a spec from the template AND persist it.

    Both halves are load-bearing. ``build_agent_config`` alone has read-only
    callers that never publish a grant, and ``_atomic_json_write`` alone covers
    sidecars that are not agent specs. A function doing both is persisting a whole
    agent spec derived from the shipped template — precisely the shape the
    sanitizer's docstring addresses, and precisely the shape that inherits the
    template's auto-approve list.

    ``rebuild_agent_config`` is excluded: it is not a plain whole-config writer.
    It applies the ceiling incrementally as it merges each source and runs its own
    final list pass, and it is covered by ``test_app_mcp_scoping.py``'s
    ``TestBuiltinAutoApprovalsGoThroughTheFinalPass``. Asserted separately below so
    dropping that pass is still a failure.
    """
    return [
        fn
        for fn in _functions()
        if {"build_agent_config", "_atomic_json_write"} <= _calls(fn)
        and fn.name != "rebuild_agent_config"
    ]


class TestEveryWholeConfigWriterSanitizes:
    def test_there_is_at_least_one_writer_to_check(self):
        """Guard the guard: a refactor that renames the helpers must not silently pass.

        Every assertion below iterates ``_whole_config_writers()``. If that
        predicate stops matching — ``build_agent_config`` renamed, the write routed
        through a new helper — the loops go vacuous and this file reports green
        while checking nothing.
        """
        assert _whole_config_writers(), (
            "no whole-config writers matched: _whole_config_writers() no longer "
            "recognises the build+persist shape, so this file is vacuous"
        )

    def test_each_one_calls_the_sanitizer(self):
        """The assertion that would have caught the research-agent bug at its commit."""
        missing = [fn.name for fn in _whole_config_writers() if SANITIZER not in _calls(fn)]
        assert not missing, (
            f"{missing} persist an agent spec derived from build_agent_config() "
            f"without calling {SANITIZER}(). allowedTools and a server's "
            "autoApprove both skip the PreToolUse gate, so the template's "
            "floor-scoped builtins (code, fs_read, …) would be auto-approved for "
            "that agent."
        )

    def test_the_sanitizer_is_the_last_thing_before_the_write(self):
        """Ordering is part of the contract — "immediately before it persists".

        A call placed before a later mutation that re-adds a grant would pass the
        test above while shipping the bypass, so the line number is checked rather
        than mere presence.
        """
        for fn in _whole_config_writers():
            sanitize_lines = [
                node.lineno
                for node in ast.walk(fn)
                if isinstance(node, ast.Call)
                and isinstance(node.func, ast.Name)
                and node.func.id == SANITIZER
            ]
            write_lines = [
                node.lineno
                for node in ast.walk(fn)
                if isinstance(node, ast.Call)
                and isinstance(node.func, ast.Name)
                and node.func.id == "_atomic_json_write"
            ]
            assert sanitize_lines, fn.name
            assert min(sanitize_lines) < min(write_lines), (
                f"{fn.name} calls {SANITIZER}() after it writes the spec"
            )

    def test_the_primary_rebuild_still_applies_its_own_pass(self):
        """The primary spec's own final pass is part of the same contract.

        Excluded from the writer set above because it filters incrementally rather
        than sanitizing a finished object, but a refactor that dropped its final
        list pass would leave ``kirocrew.json`` — the agent behind user-facing
        chat — unfiltered.
        """
        rebuild = [fn for fn in _functions() if fn.name == "rebuild_agent_config"]
        assert len(rebuild) == 1
        calls = _calls(rebuild[0])
        assert "_may_auto_approve" in calls, "the final list pass must consult the ceiling"
        assert "log_api_access" in calls, "a withheld template grant must be audited"


class TestFloorBuiltinsAreNeverGrantedAsLiterals:
    def test_no_installer_hardcodes_a_floor_scoped_grant(self):
        """The literal lists must be clean too — the sanitizer is a backstop, not a licence.

        Several owned specs hold their auto-approve list as a literal. Passing one
        of these through the sanitizer would drop it silently on every host, which
        reads as a working grant in review and as a prompting agent at runtime.
        Catching it in the source is the honest failure.
        """
        offenders: list[tuple[str, str]] = []
        for fn in _functions():
            for assign in ast.walk(fn):
                if not isinstance(assign, ast.Assign) or not isinstance(assign.value, ast.List):
                    continue
                for target in assign.targets:
                    if not isinstance(target, ast.Subscript):
                        continue
                    key = target.slice
                    if not (isinstance(key, ast.Constant) and key.value == "allowedTools"):
                        continue
                    for elt in assign.value.elts:
                        if isinstance(elt, ast.Constant) and elt.value in FLOOR_BUILTINS:
                            offenders.append((fn.name, str(elt.value)))
        assert not offenders, (
            f"floor-scoped builtins granted as literals: {offenders}. These can "
            "never be auto-approved — may_skip_gate refuses them before it even "
            "consults the ceiling — so the grant is dead code that misleads review."
        )

    @pytest.mark.parametrize("tool", sorted(FLOOR_BUILTINS))
    def test_the_floor_set_is_what_we_think_it_is(self, tool: str):
        """Pin the membership this file reasons about.

        ``code`` is the one worth naming: it reads like a benign editor helper but
        governance maps it to ``filesystem.write`` because it writes files AND can
        shell out, which is precisely why it slipped through review in the research
        spec.
        """
        assert FLOOR_SCOPES.intersection(BUILTIN_TOOL_SCOPES[tool])

    def test_code_and_the_obvious_writers_are_in_the_floor_set(self):
        """Fail loudly if a reclassification quietly shrinks the set above."""
        for expected in ("code", "fs_read", "fs_write", "execute_bash", "glob", "grep"):
            assert expected in FLOOR_BUILTINS, expected


class TestOwnedSpecCoverage:
    def test_every_owned_spec_is_written_by_agent_py(self):
        """A new managed spec must arrive with a writer this ratchet can see.

        ``agent_files`` promises that adding a spec is "a one-line change in ONE
        place ... and every consumer picks it up". This is one of those consumers:
        it asserts each owned filename is actually produced by a constant in
        ``agent.py``, so a spec added to the tuple and written by some new path
        cannot skip the checks above unnoticed.
        """
        source = AGENT_PY.read_text(encoding="utf-8")
        constants = {
            "kirocrew.json": "AGENT_FILENAME",
            "kirocrew-lite.json": "LITE_AGENT_FILENAME",
            "kirocrew-conductor.json": "_CONDUCTOR_AGENT_FILENAME",
            "kirocrew-knowledge.json": "_KNOWLEDGE_AGENT_FILENAME",
            "kirocrew-research.json": "_RESEARCH_AGENT_FILENAME",
            "kirocrew-heartbeat.json": "_HEARTBEAT_AGENT_FILENAME",
        }
        uncovered = [f for f in OWNED_KIRO_AGENT_FILES if f not in constants]
        assert not uncovered, (
            f"{uncovered} were added to OWNED_KIRO_AGENT_FILES without being "
            f"registered here — confirm the writer calls {SANITIZER}(), then add "
            "it to this map."
        )
        for filename, const in constants.items():
            if filename in OWNED_KIRO_AGENT_FILES:
                assert const in source, f"{const} ({filename}) is not written by agent.py"
