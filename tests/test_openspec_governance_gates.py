from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

import pytest

import artifacts_index
import schemas
import tools
import __init__ as openspec_plugin


def _scaffold_change(
    tmp_path: Path,
    change: str = "demo-change",
    *,
    tasks_md: str = "- [x] 1.1 Complete task\n",
    created_at: str = "2026-11-03T05:30:00Z",
) -> Path:
    ox = tmp_path / "openspec"
    ch = ox / "changes" / change
    (ch / "specs" / "demo-cap").mkdir(parents=True, exist_ok=True)
    (ch / "reviews").mkdir(parents=True, exist_ok=True)
    (ch / ".openspec.yaml").write_text(
        f'schema: spec-driven\nx-createdAt: "{created_at}"\n',
        encoding="utf-8",
    )
    (ch / "proposal.md").write_text("# Proposal\n\n## Why\nTest why.\n", encoding="utf-8")
    (ch / "design.md").write_text("# Design\n\n## Context\nTest design.\n", encoding="utf-8")
    (ch / "tasks.md").write_text(tasks_md, encoding="utf-8")
    (ch / "specs" / "demo-cap" / "spec.md").write_text(
        "# Spec Delta: Demo Cap\n\n"
        "## Purpose\n\n"
        "Provide deterministic test coverage for OpenSpec governance gates and spec synchronization.\n\n"
        "## ADDED Requirements\n\n"
        "### Requirement: Deterministic Gate Check\n"
        "The system SHALL enforce deterministic gate checks.\n\n"
        "#### Scenario: Gate passes when valid\n"
        "- **WHEN** all conditions are satisfied\n"
        "- **THEN** the gate MUST allow transition\n",
        encoding="utf-8",
    )
    return ch


def test_review_ordering_v1_approved_to_v2_rejected_and_v10_precedence(tmp_path: Path):
    ch = _scaffold_change(tmp_path, "order-check")
    reviews = ch / "reviews"

    # Case 1: v1 APPROVED -> v2 REJECTED must resolve to REJECTED
    (reviews / "findings-proposal-v1.md").write_text("Verdict: APPROVED\n", encoding="utf-8")
    (reviews / "findings-proposal-v2.md").write_text("Verdict: REJECTED\n", encoding="utf-8")
    gate = artifacts_index.evaluate_change_gate(tmp_path, "order-check", "propose_approved")
    assert gate["allowed"] is False
    assert gate["proposal_verdict"] == "REJECTED"
    assert gate["latest_verdict"] == "REJECTED"

    # Case 2: v1 REJECTED -> v2 APPROVED must resolve to APPROVED for propose_approved
    (reviews / "findings-proposal-v2.md").write_text("Verdict: APPROVED\n", encoding="utf-8")
    gate2 = artifacts_index.evaluate_change_gate(tmp_path, "order-check", "propose_approved")
    assert gate2["allowed"] is True
    assert gate2["proposal_verdict"] == "APPROVED"
    assert gate2["latest_verdict"] == "APPROVED"

    # Case 3: Proposal-only APPROVED without verification review MUST fail verify_close and archive
    gate_vc = artifacts_index.evaluate_change_gate(tmp_path, "order-check", "verify_close")
    assert gate_vc["allowed"] is False
    assert "verification_review_missing" in gate_vc["missing"]

    # Case 4: v2 APPROVED -> v10 REJECTED (integer round ordering: 10 > 2, not lexical "10" < "2")
    (reviews / "findings-proposal-v10.md").write_text("Verdict: REJECTED\n", encoding="utf-8")
    gate_v10 = artifacts_index.evaluate_change_gate(tmp_path, "order-check", "propose_approved")
    assert gate_v10["allowed"] is False
    assert gate_v10["proposal_verdict"] == "REJECTED"

    # Case 5: Verification review PENDING / missing explicit verdict
    (reviews / "findings-proposal-v11.md").write_text("Verdict: APPROVED\n", encoding="utf-8")
    (reviews / "findings-verify-v1.md").write_text("# Review in progress without verdict line\n", encoding="utf-8")
    gate_pending = artifacts_index.evaluate_change_gate(tmp_path, "order-check", "verify_close")
    assert gate_pending["allowed"] is False
    assert gate_pending["verify_verdict"] == "PENDING"
    assert "verification_review_pending" in gate_pending["missing"]


def test_evaluate_change_gate_verify_close_and_archive_requirements(tmp_path: Path):
    ch = _scaffold_change(tmp_path, "gate-check", tasks_md="- [x] 1.1 Done\n- [ ] 1.2 Todo\n")
    (ch / "reviews" / "findings-proposal-v1.md").write_text("Verdict: APPROVED\n", encoding="utf-8")
    (ch / "reviews" / "findings-verify-v1.md").write_text("Verdict: APPROVED\n", encoding="utf-8")

    # Incomplete tasks block verify_close
    g1 = artifacts_index.evaluate_change_gate(tmp_path, "gate-check", "verify_close")
    assert g1["allowed"] is False
    assert "tasks_incomplete" in g1["missing"]

    # Complete tasks -> verify_close passes, but archive still blocks on packaged_explorations + unsynced_specs
    (ch / "tasks.md").write_text("- [x] 1.1 Done\n- [x] 1.2 Done\n", encoding="utf-8")
    g2 = artifacts_index.evaluate_change_gate(tmp_path, "gate-check", "verify_close")
    assert g2["allowed"] is True
    assert g2["latest_verdict"] == "APPROVED"

    g_arch = artifacts_index.evaluate_change_gate(tmp_path, "gate-check", "archive")
    assert g_arch["allowed"] is False
    assert "packaged_explorations" in g_arch["missing"]
    assert "unsynced_specs" in g_arch["missing"]


def test_archive_no_force_bypass_allowed(tmp_path: Path):
    assert "force" not in schemas.OPENSPEC_CHANGE_ARCHIVE["parameters"]["properties"]
    ch = _scaffold_change(tmp_path, "no-force", tasks_md="- [ ] 1.1 Not done\n")
    res = json.loads(tools.openspec_change_archive({"workdir": str(tmp_path), "change": "no-force", "force": True}))
    assert res["ok"] is False
    assert "force" in res["error"].lower()
    assert ch.is_dir()


def test_sync_specs_pre_merge_safety_and_idempotent_merge(tmp_path: Path):
    ch = _scaffold_change(tmp_path, "sync-test")
    canon_dir = tmp_path / "openspec" / "specs" / "demo-cap"
    canon_dir.mkdir(parents=True, exist_ok=True)
    canon_file = canon_dir / "spec.md"
    canon_file.write_text(
        "# Demo Cap Specification\n\n"
        "## Purpose\n\n"
        "Existing canonical specification for demo capability.\n\n"
        "## Requirements\n\n"
        "### Requirement: Existing Cap\n"
        "The system SHALL support existing behavior.\n\n"
        "#### Scenario: First scenario\n"
        "- **WHEN** first condition holds\n"
        "- **THEN** first outcome occurs\n\n"
        "#### Scenario: Second scenario\n"
        "- **WHEN** second condition holds\n"
        "- **THEN** second outcome occurs\n\n"
        "### Requirement: Obsolete Cap\n"
        "The system SHALL remove obsolete cap.\n\n"
        "#### Scenario: Obsolete\n"
        "- **WHEN** old\n"
        "- **THEN** old\n",
        encoding="utf-8",
    )

    # Unsafe MODIFIED delta: 1 scenario vs 2 canonical scenarios without scenario tags -> MUST abort
    delta_file = ch / "specs" / "demo-cap" / "spec.md"
    delta_file.write_text(
        "# Spec Delta: Demo Cap\n\n"
        "## MODIFIED Requirements\n\n"
        "### Requirement: Existing Cap\n"
        "The system SHALL support updated behavior.\n\n"
        "#### Scenario: First scenario\n"
        "- **WHEN** first condition holds\n"
        "- **THEN** updated first outcome occurs\n",
        encoding="utf-8",
    )
    unsafe_res = json.loads(tools.openspec_sync_specs({"workdir": str(tmp_path), "change": "sync-test"}))
    assert unsafe_res["ok"] is False
    assert "UNSAFE MERGE BLOCKED" in unsafe_res["error"]
    assert "updated first outcome" not in canon_file.read_text(encoding="utf-8")

    # Safe MODIFIED delta (with (MODIFIED) tag) + ADDED + REMOVED -> merges cleanly & idempotently
    delta_file.write_text(
        "# Spec Delta: Demo Cap\n\n"
        "## MODIFIED Requirements\n\n"
        "### Requirement: Existing Cap\n"
        "The system SHALL support updated behavior.\n\n"
        "#### Scenario: First scenario (MODIFIED)\n"
        "- **WHEN** first condition holds\n"
        "- **THEN** updated first outcome occurs\n\n"
        "## ADDED Requirements\n\n"
        "### Requirement: Brand New Cap\n"
        "The system SHALL provide brand new capability.\n\n"
        "#### Scenario: Brand new\n"
        "- **WHEN** invoked\n"
        "- **THEN** it succeeds\n\n"
        "## REMOVED Requirements\n\n"
        "### Requirement: Obsolete Cap\n",
        encoding="utf-8",
    )
    sync_res = json.loads(tools.openspec_sync_specs({"workdir": str(tmp_path), "change": "sync-test"}))
    assert sync_res["ok"] is True
    merged_md = canon_file.read_text(encoding="utf-8")
    assert "## Requirements" in merged_md
    assert "### Requirement: Existing Cap" in merged_md
    assert "### Requirement: Brand New Cap" in merged_md
    assert "### Requirement: Obsolete Cap" not in merged_md
    assert "(MODIFIED)" not in merged_md

    # Second run is idempotent
    sync_res2 = json.loads(tools.openspec_sync_specs({"workdir": str(tmp_path), "change": "sync-test"}))
    assert sync_res2["ok"] is True
    assert canon_file.read_text(encoding="utf-8") == merged_md


def test_raw_archive_interception_matrix():
    import os

    hermes_root = os.environ.get("HERMES_AGENT_ROOT", "").strip()
    added_path = bool(hermes_root and hermes_root not in sys.path)
    if added_path:
        sys.path.append(hermes_root)
    try:
        from hermes_cli import plugins as host_plugins

        pm = host_plugins.PluginManager()
        pm._discovered = True

        class _DummyCtx:
            def register_tool(self, **kwargs):
                pass

            def register_skill(self, *args, **kwargs):
                pass

            def register_hook(self, event_name: str, callback):
                pm._hooks.setdefault(event_name, []).append(callback)

        openspec_plugin.register(_DummyCtx())
        old_mgr = host_plugins._plugin_manager
        host_plugins._plugin_manager = pm
        try:
            expected_msg = "Raw openspec archive is forbidden; use openspec_change_archive after Commander approval."
            blocked_vectors = [
                ("terminal", {"command": "openspec archive my-change -y"}),
                ("terminal", {"command": '"C:/nvm4w/nodejs/openspec.EXE" archive my-change --skip-specs -y'}),
                ("terminal", {"command": "cd /tmp && openspec archive my-change --yes"}),
                ("terminal", {"command": "echo ok; npx openspec archive my-change"}),
                ("execute_code", {"code": "import subprocess\nsubprocess.run(['openspec', 'archive', 'my-change', '-y'])"}),
                ("execute_code", {"code": "import os\nos.system('openspec archive my-change -y')"}),
                ("openspec_cli", {"command": "archive my-change -y"}),
                (
                    "tool_call",
                    {
                        "calls": [
                            {
                                "name": "openspec_cli",
                                "arguments": {"command": "archive my-change --yes"},
                            }
                        ]
                    },
                ),
            ]
            for tool_name, tool_args in blocked_vectors:
                action, message = host_plugins.get_pre_tool_call_directive(
                    tool_name, tool_args, task_id="t_test", session_id="s_test"
                )
                assert action == "block", f"Expected block for {tool_name}: {tool_args}"
                assert message == expected_msg

            # Direct openspec_cli handler call also fails closed
            cli_direct = json.loads(tools.openspec_cli({"command": "archive my-change -y"}))
            assert cli_direct["ok"] is False
            assert cli_direct["action"] == "block"
            assert cli_direct["message"] == expected_msg

            # Benign controls must be allowed
            benign_vectors = [
                ("terminal", {"command": "openspec validate my-change --strict --type change"}),
                ("terminal", {"command": "openspec status --change my-change --json"}),
                ("terminal", {"command": "openspec list --json"}),
                ("execute_code", {"code": "import subprocess\nsubprocess.run(['openspec', 'validate', 'my-change'])"}),
                ("openspec_cli", {"command": "status --change my-change"}),
            ]
            for tool_name, tool_args in benign_vectors:
                action, _message = host_plugins.get_pre_tool_call_directive(
                    tool_name, tool_args, task_id="t_test", session_id="s_test"
                )
                assert action is None, f"Unexpected block for benign {tool_name}: {tool_args}"
        finally:
            host_plugins._plugin_manager = old_mgr
    finally:
        if added_path and hermes_root in sys.path:
            sys.path.remove(hermes_root)


def test_archive_end_to_end_date_prefix_exploration_and_kanban_cards(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    ch = _scaffold_change(tmp_path, "e2e-change", created_at="2026-11-03T05:30:00Z")
    ws_exp = tmp_path / "openspec" / "workspace" / "explorations" / "2026-11-03-e2e-change-exploration.md"
    ws_exp.parent.mkdir(parents=True, exist_ok=True)
    ws_exp.write_text("# Exploration for E2E Change\n", encoding="utf-8")

    (ch / "reviews" / "findings-proposal-v1.md").write_text("Verdict: APPROVED\n", encoding="utf-8")
    (ch / "reviews" / "findings-verify-v1.md").write_text("Verdict: APPROVED\n", encoding="utf-8")

    # Sync specs first
    sync_res = json.loads(tools.openspec_sync_specs({"workdir": str(tmp_path), "change": "e2e-change"}))
    assert sync_res["ok"] is True

    # Create a Crew kanban.db with 2 linked done cards and 1 unrelated done card
    board_dir = tmp_path / "kanban" / "boards" / "crew"
    board_dir.mkdir(parents=True, exist_ok=True)
    kdb_path = board_dir / "kanban.db"
    conn = sqlite3.connect(str(kdb_path))
    with conn:
        conn.execute("CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, status TEXT, assignee TEXT, body TEXT)")
        conn.execute(
            "INSERT INTO tasks VALUES ('t_aaa111', 'Apply e2e-change', 'done', 'coder', 'Inputs: openspec/changes/e2e-change/tasks.md')"
        )
        conn.execute(
            "INSERT INTO tasks VALUES ('t_bbb222', 'Verify e2e-change', 'done', 'reviewer', 'Inputs: openspec/changes/e2e-change/reviews/findings-verify-v1.md')"
        )
        conn.execute(
            "INSERT INTO tasks VALUES ('t_ccc333', 'Other card', 'done', 'coder', 'Inputs: openspec/changes/other-change/tasks.md')"
        )
    conn.close()

    arch_res = json.loads(tools.openspec_change_archive({"workdir": str(tmp_path), "change": "e2e-change"}))
    assert arch_res["ok"] is True
    assert arch_res["archive_name"] == "2026-11-03-e2e-change"
    arch_dir = Path(arch_res["archived_path"])
    assert arch_dir.is_dir()
    assert (arch_dir / "explorations" / "2026-11-03-e2e-change-exploration.md").is_file()
    assert set(arch_res["archived_kanban_cards"]) == {"t_aaa111", "t_bbb222"}
    assert arch_res["post_archive_obligations"]["post_archive_sync_required"] is True

    conn = sqlite3.connect(str(kdb_path))
    rows = dict(conn.execute("SELECT id, status FROM tasks").fetchall())
    conn.close()
    assert rows == {
        "t_aaa111": "archived",
        "t_bbb222": "archived",
        "t_ccc333": "done",
    }
