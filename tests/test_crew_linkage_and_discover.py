"""Read-only Crew card linkage (3.1) and submodule/child source discovery (3.2)."""

import hashlib
import os
import sqlite3
import subprocess
from contextlib import closing
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


def _make_kanban(db_path: Path, cards):
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(str(db_path))) as conn:
        conn.execute(
            "CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT, assignee TEXT, "
            "status TEXT NOT NULL, priority INTEGER DEFAULT 0, created_at INTEGER DEFAULT 0)"
        )
        for card in cards:
            conn.execute(
                "INSERT INTO tasks (id, title, body, assignee, status) VALUES (?, ?, ?, ?, ?)",
                (card["id"], card.get("title", "t"), card.get("body", ""), card.get("assignee", "coder"),
                 card.get("status", "running")),
            )
        conn.commit()


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


@pytest.fixture()
def env(tmp_path, monkeypatch):
    home = tmp_path / "home with space"
    home.mkdir()
    monkeypatch.setattr(registry, "db_path", lambda: home / "openspec.db")
    monkeypatch.setattr(plugin_api, "_registry", registry)
    monkeypatch.setattr(plugin_api, "_migration_done", True)

    repo = tmp_path / "repo"
    ox = repo / "openspec"
    demo = ox / "changes" / "demo"
    _write(demo / "proposal.md", "# Demo\n")
    _write(demo / "explorations" / "spike.md", "# Local Spike\n")
    _write(ox / "workspace" / "explorations" / "2026-10-30-topic.md", "# Topic\n")
    _write(ox / "workspace" / "explorations" / "spike.md", "# Ws Spike\n")
    _write(ox / "changes" / "other" / "proposal.md", "# Other\n")
    _write(ox / "changes" / "archive" / "2026-01-01-old" / "proposal.md", "# Old\n")

    source = registry.add_source(str(repo), "demoapp")
    app = FastAPI()
    app.include_router(plugin_api.router)
    return {"home": home, "repo": repo, "sid": source["token"], "client": TestClient(app), "tmp": tmp_path}


def _scan(env):
    payload = env["client"].get("/sources").json()["sources"]
    return next(s for s in payload if s["id"] == env["sid"])["openspec"]


def _cards_for_change(env, name):
    changes = {c["name"]: c for c in _scan(env)["changes"]}
    return changes[name].get("crewCards", [])


def _cards_for_exploration(env, scope, name):
    items = {(e["scope"], e["name"]): e for e in _scan(env)["explorations"]}
    return items[(scope, name)].get("crewCards", [])


# ---------------------------------------------------------------------------
# 3.1 Crew linkage
# ---------------------------------------------------------------------------


def test_missing_databases_yield_empty_lists(env):
    assert plugin_api._scan_crew_cards(env["home"]) == []
    assert _cards_for_change(env, "demo") == []
    detail = env["client"].get(f"/sources/{env['sid']}/changes/demo").json()
    assert detail["crewCards"] == []


def test_forward_slash_path_reference_links_change(env):
    _make_kanban(env["home"] / "kanban.db", [
        {"id": "t_aaa111", "title": "Implement demo", "body": "see openspec/changes/demo/proposal.md", "assignee": "coder", "status": "running"},
    ])
    cards = _cards_for_change(env, "demo")
    assert cards == [{
        "id": "t_aaa111", "title": "Implement demo", "status": "running", "assignee": "coder",
        "board": "default", "url": "/crew?card=t_aaa111",
    }]
    assert _cards_for_change(env, "other") == []


def test_backslash_windows_path_reference_links_change(env):
    _make_kanban(env["home"] / "kanban.db", [
        {"id": "t_bbb222", "body": "Artifact: O:\\workspaces\\openspec\\changes\\demo\\tasks.md"},
    ])
    assert [c["id"] for c in _cards_for_change(env, "demo")] == ["t_bbb222"]


def test_token_reference_links_change(env):
    token = registry.change_token("demo")
    _make_kanban(env["home"] / "kanban.db", [{"id": "t_ccc333", "title": f"Work on {token}"}])
    assert [c["id"] for c in _cards_for_change(env, "demo")] == ["t_ccc333"]


def test_archived_change_path_links(env):
    _make_kanban(env["home"] / "kanban.db", [
        {"id": "t_ddd444", "body": "openspec/changes/archive/2026-01-01-old/proposal.md"},
    ])
    assert [c["id"] for c in _cards_for_change(env, "2026-01-01-old")] == ["t_ddd444"]


def test_exploration_links_only_by_full_relative_path(env):
    _make_kanban(env["home"] / "kanban.db", [
        {"id": "t_ws1", "body": "Inputs: openspec/workspace/explorations/2026-10-30-topic.md"},
        {"id": "t_loc1", "body": "Inputs: openspec/changes/demo/explorations/spike.md"},
    ])
    assert [c["id"] for c in _cards_for_exploration(env, "workspace", "2026-10-30-topic")] == ["t_ws1"]
    # same stem, different scope: only the exact scope links
    assert [c["id"] for c in _cards_for_exploration(env, "change:demo", "spike")] == ["t_loc1"]
    assert _cards_for_exploration(env, "workspace", "spike") == []


def test_exploration_links_by_token(env):
    token = registry.change_token("exploration:workspace:spike")
    _make_kanban(env["home"] / "kanban.db", [{"id": "t_tok1", "body": f"see {token}"}])
    assert [c["id"] for c in _cards_for_exploration(env, "workspace", "spike")] == ["t_tok1"]
    assert _cards_for_exploration(env, "change:demo", "spike") == []


@pytest.mark.parametrize("body", [
    "We should write up the spike and the 2026-10-30-topic notes.",
    "check 2026-10-30-topic.md and spike.md in the folder",
    "openspec/changes/demo-extra/proposal.md is a different change",
    "see openspec/changes/demo2 and openspec/changes/xdemo",
    "myopenspec/changes/demo/proposal.md",
])
def test_prose_and_partial_names_do_not_link(env, body):
    _make_kanban(env["home"] / "kanban.db", [{"id": "t_neg1", "title": "chatter", "body": body}])
    assert _cards_for_change(env, "demo") == []
    assert _cards_for_exploration(env, "workspace", "2026-10-30-topic") == []
    assert _cards_for_exploration(env, "workspace", "spike") == []
    assert _cards_for_exploration(env, "change:demo", "spike") == []


def test_archived_cards_are_excluded(env):
    _make_kanban(env["home"] / "kanban.db", [
        {"id": "t_live", "body": "openspec/changes/demo", "status": "done"},
        {"id": "t_gone", "body": "openspec/changes/demo", "status": "archived"},
    ])
    assert [c["id"] for c in _cards_for_change(env, "demo")] == ["t_live"]


def test_boards_are_scanned_and_labelled(env):
    _make_kanban(env["home"] / "kanban.db", [{"id": "t_root", "body": "openspec/changes/demo"}])
    _make_kanban(env["home"] / "kanban" / "boards" / "crew" / "kanban.db", [
        {"id": "t_crew", "body": "openspec/changes/demo/design.md", "assignee": "reviewer"},
    ])
    cards = {c["id"]: c for c in _cards_for_change(env, "demo")}
    assert set(cards) == {"t_root", "t_crew"}
    assert cards["t_root"]["board"] == "default" and cards["t_crew"]["board"] == "crew"
    assert cards["t_crew"]["assignee"] == "reviewer"


def test_card_with_path_and_token_appears_once(env):
    token = registry.change_token("demo")
    _make_kanban(env["home"] / "kanban.db", [
        {"id": "t_dup", "title": f"{token}", "body": "openspec/changes/demo/proposal.md and again openspec/changes/demo"},
    ])
    assert [c["id"] for c in _cards_for_change(env, "demo")] == ["t_dup"]


def test_detail_endpoints_include_crew_cards(env):
    _make_kanban(env["home"] / "kanban.db", [
        {"id": "t_det", "body": "openspec/changes/demo/explorations/spike.md"},
    ])
    sid = env["sid"]
    change = env["client"].get(f"/sources/{sid}/changes/demo").json()
    assert [c["id"] for c in change["crewCards"]] == ["t_det"]
    ex = env["client"].get(f"/sources/{sid}/explorations/spike", params={"scope": "change:demo"}).json()
    assert [c["id"] for c in ex["crewCards"]] == ["t_det"]
    ws = env["client"].get(f"/sources/{sid}/explorations/spike").json()
    assert ws["crewCards"] == []


def test_databases_are_opened_read_only_and_left_byte_identical(env, monkeypatch):
    root_db = env["home"] / "kanban.db"
    board_db = env["home"] / "kanban" / "boards" / "crew" / "kanban.db"
    _make_kanban(root_db, [{"id": "t_ro1", "body": "openspec/changes/demo"}])
    _make_kanban(board_db, [{"id": "t_ro2", "body": "openspec/changes/other"}])
    before = {p: _sha(p) for p in (root_db, board_db)}

    real_connect = sqlite3.connect
    uris = []

    def spy(target, *args, **kwargs):
        uris.append((str(target), kwargs.get("uri")))
        return real_connect(target, *args, **kwargs)

    monkeypatch.setattr(plugin_api.sqlite3, "connect", spy)
    env["client"].get("/sources")
    env["client"].get(f"/sources/{env['sid']}/changes/demo")

    kanban = [(u, flag) for u, flag in uris if "kanban.db" in u]
    assert len(kanban) >= 2, uris  # root + board database were both opened
    assert all(u.startswith("file:") and "mode=ro" in u and flag is True for u, flag in kanban), kanban
    assert before == {p: _sha(p) for p in (root_db, board_db)}


def test_broken_database_degrades_to_empty(env):
    (env["home"] / "kanban.db").write_bytes(b"this is not a sqlite database")
    board = env["home"] / "kanban" / "boards" / "empty" / "kanban.db"
    board.parent.mkdir(parents=True)
    with closing(sqlite3.connect(str(board))) as conn:
        conn.execute("CREATE TABLE unrelated (x)")
        conn.commit()
    assert plugin_api._scan_crew_cards(env["home"]) == []
    assert env["client"].get("/sources").status_code == 200
    assert _cards_for_change(env, "demo") == []


def test_sources_scan_reads_databases_once_per_request(env, monkeypatch):
    _make_kanban(env["home"] / "kanban.db", [{"id": "t_one", "body": "openspec/changes/demo"}])
    # register a second source so a per-source reload would double the opens
    repo2 = env["tmp"] / "repo2"
    _write(repo2 / "openspec" / "changes" / "x" / "proposal.md")
    registry.add_source(str(repo2), "second")
    calls = []
    real = plugin_api._scan_crew_cards
    monkeypatch.setattr(plugin_api, "_scan_crew_cards", lambda home=None: calls.append(1) or real(home))
    env["client"].get("/sources")
    assert len(calls) == 1


# ---------------------------------------------------------------------------
# 3.2 discover
# ---------------------------------------------------------------------------


@pytest.fixture()
def tree(tmp_path, monkeypatch):
    home = tmp_path / "hermes"
    home.mkdir()
    monkeypatch.setattr(registry, "db_path", lambda: home / "openspec.db")
    monkeypatch.setattr(plugin_api, "_registry", registry)
    monkeypatch.setattr(plugin_api, "_migration_done", True)

    root = tmp_path / "workspace"
    _write(root / "openspec" / "changes" / ".gitkeep", "")
    (root / ".git").mkdir()
    # eligible
    _write(root / "ai_agents" / "tool-a" / "openspec" / "specs" / ".gitkeep", "")
    _write(root / "libs" / "tool-b" / "openspec" / "specs" / ".gitkeep", "")
    _write(root / "tool-c" / "openspec" / "specs" / ".gitkeep", "")
    _write(root / "oss" / "tool-d" / "openspec" / "specs" / ".gitkeep", "")
    # .gitmodules path at depth 3
    _write(root / "third_party" / "nested" / "lib" / "openspec" / "specs" / ".gitkeep", "")
    _write(root / ".gitmodules", '[submodule "lib"]\n\tpath = third_party/nested/lib\n\turl = x\n'
                                 '[submodule "missing"]\n\tpath = does/not/exist\n\turl = y\n')
    # out of bounds
    _write(root / "ai_agents" / "tool-a" / "vendor" / "deep" / "openspec" / "specs" / ".gitkeep", "")
    _write(root / ".worktrees" / "wt-x" / "openspec" / "specs" / ".gitkeep", "")
    _write(root / ".hiddenrepo" / "openspec" / "specs" / ".gitkeep", "")
    # git repo at depth 1 whose children must not be scanned
    (root / "gitrepo" / ".git").mkdir(parents=True)
    _write(root / "gitrepo" / "inner" / "openspec" / "specs" / ".gitkeep", "")
    # plain dir without openspec
    (root / "empty-dir").mkdir()

    source = registry.add_source(str(root), "workspace")
    app = FastAPI()
    app.include_router(plugin_api.router)
    return {"root": root, "sid": source["token"], "client": TestClient(app)}


def _names(result):
    return sorted(c["name"] for c in result["candidates"])


EXPECTED = ["lib", "tool-a", "tool-b", "tool-c", "tool-d"]


def test_discover_preview_without_body_returns_candidates_and_writes_nothing(tree):
    before = registry.list_sources()
    r = tree["client"].post(f"/sources/{tree['sid']}/discover")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True and body["registered"] == []
    assert _names(body) == EXPECTED
    assert all(set(c) >= {"path", "name", "alreadyRegistered"} for c in body["candidates"])
    assert all(c["alreadyRegistered"] is False for c in body["candidates"])
    assert registry.list_sources() == before


def test_discover_register_false_explicit_is_identical(tree):
    before = registry.list_sources()
    body = tree["client"].post(f"/sources/{tree['sid']}/discover", json={"register": False}).json()
    assert body["registered"] == [] and _names(body) == EXPECTED
    assert registry.list_sources() == before


def test_discover_bounds_exclude_deep_hidden_and_git_children(tree):
    names = _names(tree["client"].post(f"/sources/{tree['sid']}/discover").json())
    for banned in ("deep", "wt-x", ".hiddenrepo", "inner", "gitrepo", "empty-dir", "exist"):
        assert banned not in names


def test_discover_candidate_paths_stay_inside_root(tree):
    body = tree["client"].post(f"/sources/{tree['sid']}/discover").json()
    root = tree["root"].resolve()
    for c in body["candidates"]:
        assert root in Path(c["path"]).resolve().parents


def test_discover_register_true_adds_only_new_and_is_idempotent(tree):
    existing = registry.add_source(str(tree["root"] / "tool-c"), "tool-c")
    n_before = len(registry.list_sources())

    first = tree["client"].post(f"/sources/{tree['sid']}/discover", json={"register": True}).json()
    assert first["ok"] is True
    flagged = {c["name"]: c["alreadyRegistered"] for c in first["candidates"]}
    assert flagged["tool-c"] is True and flagged["tool-a"] is False
    assert sorted(r["name"] for r in first["registered"]) == ["lib", "tool-a", "tool-b", "tool-d"]
    assert len(registry.list_sources()) == n_before + 4
    assert registry.get_source(existing["token"])["token"] == existing["token"]

    second = tree["client"].post(f"/sources/{tree['sid']}/discover", json={"register": True}).json()
    assert second["registered"] == []
    assert all(c["alreadyRegistered"] for c in second["candidates"])
    assert len(registry.list_sources()) == n_before + 4


def test_discover_unknown_source_is_404(tree):
    assert tree["client"].post("/sources/os_nope00/discover").status_code == 404


def _link_dir(link: Path, target: Path) -> bool:
    """Create a directory link (symlink, or a junction on Windows hosts without symlink rights)."""
    try:
        link.symlink_to(target, target_is_directory=True)
        return True
    except (OSError, NotImplementedError):
        pass
    if os.name == "nt":
        done = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)],
                              capture_output=True, text=True)
        return done.returncode == 0 and link.exists()
    return False


def test_discover_link_escaping_root_is_skipped(tree, tmp_path):
    outside = tmp_path / "outside" / "evil"
    _write(outside / "openspec" / "specs" / ".gitkeep", "")
    link = tree["root"] / "linked"
    if not _link_dir(link, outside):
        pytest.skip("neither symlinks nor junctions can be created on this host")
    assert (link / "openspec").is_dir()  # the link really resolves to the outside repo
    names = _names(tree["client"].post(f"/sources/{tree['sid']}/discover").json())
    assert "linked" not in names and "evil" not in names
    assert names == EXPECTED
