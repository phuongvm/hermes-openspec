"""Subproject OpenSpec source-root and git-subdirectory resolution (Slice 3, Item 4)."""

import subprocess
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import registry
from dashboard import plugin_api


def _write(path: Path, text: str = "# T\n") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", *args],
        cwd=str(cwd), check=True, capture_output=True,
    )


@pytest.fixture()
def mono(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr(registry, "db_path", lambda: home / "openspec.db")
    monkeypatch.setattr(plugin_api, "_registry", registry)
    monkeypatch.setattr(plugin_api, "_migration_done", True)

    root = tmp_path / "monorepo"
    root.mkdir()
    _git(root, "init", "-q")
    _write(root / "openspec" / "changes" / "root-change" / "proposal.md", "# Root Change\n")
    _write(root / "openspec" / "specs" / "rootspec" / "spec.md", "# Root Spec\n")
    _write(root / "docker-compose" / "openspec" / "changes" / "compose-change" / "proposal.md", "# Compose Change\n")
    _write(root / "docker-compose" / "openspec" / "specs" / "compose" / "spec.md", "# Compose Spec v1\n")
    (root / "uninitialized-sub").mkdir()
    _git(root, "add", "-A")
    _git(root, "commit", "-q", "-m", "init")
    _write(root / "docker-compose" / "openspec" / "specs" / "compose" / "spec.md", "# Compose Spec v2\n")

    app = FastAPI()
    app.include_router(plugin_api.router)
    return {"root": root, "client": TestClient(app)}


def test_subproject_with_own_openspec_resolves_to_itself(mono):
    sub = mono["root"] / "docker-compose"
    assert plugin_api._repo_root(str(sub)) == (sub.resolve(), None)
    assert plugin_api._source_root(str(sub)) == (sub.resolve(), None)


def test_openspec_dir_path_resolves_to_parent(mono):
    sub = mono["root"] / "docker-compose"
    assert plugin_api._repo_root(str(sub / "openspec"))[0] == sub.resolve()


def test_uninitialized_subdir_does_not_alias_parent(mono):
    empty = mono["root"] / "uninitialized-sub"
    root, err = plugin_api._repo_root(str(empty))
    assert root == empty.resolve() and err is None
    assert plugin_api._source_root(str(empty))[0] is None


def test_git_root_still_resolves_to_itself(mono):
    assert plugin_api._repo_root(str(mono["root"]))[0] == mono["root"].resolve()


def test_sources_endpoint_isolates_subprojects(mono):
    client = mono["client"]
    parent = client.post("/sources", json={"path": str(mono["root"]), "name": "parent"}).json()["source"]
    child = client.post("/sources", json={"path": str(mono["root"] / "docker-compose"), "name": "compose"}).json()["source"]
    empty = client.post("/sources", json={"path": str(mono["root"] / "uninitialized-sub"), "name": "empty"}).json()["source"]
    by_id = {s["id"]: s for s in client.get("/sources").json()["sources"]}

    assert [c["name"] for c in by_id[parent["id"]]["openspec"]["changes"]] == ["root-change"]
    assert [c["name"] for c in by_id[child["id"]]["openspec"]["changes"]] == ["compose-change"]
    assert by_id[child["id"]]["repoRoot"] == str((mono["root"] / "docker-compose").resolve())
    assert by_id[empty["id"]]["valid"] is False
    assert by_id[empty["id"]]["repoRoot"] == str((mono["root"] / "uninitialized-sub").resolve())


def test_change_detail_resolves_for_subproject(mono):
    client = mono["client"]
    child = client.post("/sources", json={"path": str(mono["root"] / "docker-compose"), "name": "compose"}).json()["source"]
    ok = client.get(f"/sources/{child['id']}/changes/compose-change")
    assert ok.status_code == 200
    assert client.get(f"/sources/{child['id']}/changes/root-change").status_code == 404


def test_init_initializes_uninitialized_subdir(mono, monkeypatch):
    monkeypatch.setattr(plugin_api, "_find_openspec_bin", lambda: None)
    client = mono["client"]
    empty = client.post("/sources", json={"path": str(mono["root"] / "uninitialized-sub"), "name": "empty"}).json()["source"]
    resp = client.post(f"/sources/{empty['id']}/init")
    assert resp.status_code == 200, resp.text
    assert (mono["root"] / "uninitialized-sub" / "openspec").is_dir()
    assert not (mono["root"] / "openspec" / "uninitialized-sub").exists()


def test_git_context_prefix(mono):
    sub = mono["root"] / "docker-compose"
    git_root, rel = plugin_api._git_context(sub)
    assert git_root.resolve() == mono["root"].resolve()
    assert rel == "docker-compose/"
    assert plugin_api._git_context(mono["root"])[1] == ""


def test_git_helpers_use_subproject_prefix(mono):
    sub = mono["root"] / "docker-compose"
    assert plugin_api._list_ref_specs(sub, "HEAD") == ["compose/spec.md"]
    assert plugin_api._read_ref_spec(sub, "HEAD", "compose/spec.md") == "# Compose Spec v1\n"
    dates = plugin_api._spec_git_dates(sub)
    assert set(dates) == {"compose/spec.md"}
    # parent only sees its own tree
    assert plugin_api._list_ref_specs(mono["root"], "HEAD") == ["rootspec/spec.md"]


def test_spec_browser_dirty_diff_for_subproject(mono):
    sub = mono["root"] / "docker-compose"
    browser = plugin_api._spec_browser(sub, dirty=True)
    assert [f["path"] for f in browser["files"]] == ["compose/spec.md"]
    assert browser["files"][0]["status"] == "modified"


# ── Slice 3c: spec_parser metadata on spec browser + spec detail ───────────

RICH_SPEC = (
    "# Compose Specification\n\n## Purpose\nDefine how compose stacks start.\nSecond purpose line.\n\n"
    "## Requirements\n\n"
    "### Requirement: Start order\nThe stack SHALL start db before app.\n\n"
    "#### Scenario: Cold start\n- **WHEN** the stack boots\n- **THEN** db starts first\n\n"
    "#### Scenario: Warm start\n- **WHEN** db is already up\n- **THEN** app starts\n\n"
    "### Requirement: Health\nEach service MUST expose a health check.\n\n"
    "#### Scenario: Unhealthy\n- **WHEN** a check fails\n- **THEN** the stack reports failure\n- **AND** exits non-zero\n"
)


def _rich_mono(mono):
    sub = mono["root"] / "docker-compose"
    _write(sub / "openspec" / "specs" / "compose" / "spec.md", RICH_SPEC)
    _write(sub / "openspec" / "specs" / "bare.md", "no heading at all\n")
    return sub


def test_spec_browser_current_entries_carry_parser_metadata(mono):
    sub = _rich_mono(mono)
    files = {f["path"]: f for f in plugin_api._spec_browser(sub)["files"]}
    rich = files["compose/spec.md"]
    assert rich["domain"] == "compose"
    assert rich["title"] == "Compose"
    assert rich["purpose"] == "Define how compose stacks start.\nSecond purpose line."
    assert rich["requirementCount"] == 2
    assert rich["scenarioCount"] == 3
    bare = files["bare.md"]
    assert bare["domain"] == "bare"
    assert bare["title"] == "bare.md"
    assert bare["purpose"] == ""
    assert (bare["requirementCount"], bare["scenarioCount"]) == (0, 0)


def test_spec_browser_dirty_entries_carry_parser_metadata(mono):
    sub = _rich_mono(mono)
    dirty = {f["path"]: f for f in plugin_api._spec_browser(sub, dirty=True)["files"]}
    assert dirty["compose/spec.md"]["requirementCount"] == 2
    assert dirty["compose/spec.md"]["domain"] == "compose"
    assert dirty["compose/spec.md"]["status"] == "modified"


def test_spec_detail_carries_parser_metadata(mono):
    sub = _rich_mono(mono)
    detail = plugin_api._spec_detail(sub, "compose/spec.md")
    assert detail["domain"] == "compose"
    assert detail["title"] == "Compose"
    assert detail["purpose"].startswith("Define how compose stacks start.")
    assert (detail["requirementCount"], detail["scenarioCount"]) == (2, 3)
    assert detail["content"] == RICH_SPEC


def test_spec_detail_endpoint_exposes_metadata(mono):
    sub = _rich_mono(mono)
    client = mono["client"]
    child = client.post("/sources", json={"path": str(sub), "name": "compose"}).json()["source"]
    body = client.get(f"/sources/{child['id']}/specs", params={"path": "compose/spec.md"}).json()
    assert body["requirementCount"] == 2 and body["scenarioCount"] == 3
    listing = client.get(f"/sources/{child['id']}/spec-browser").json()["files"]
    assert {f["path"]: f["scenarioCount"] for f in listing}["compose/spec.md"] == 3
