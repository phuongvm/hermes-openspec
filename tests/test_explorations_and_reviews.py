"""Explorations and change reviews across the dashboard API and ``openspec_context``."""

import json
from pathlib import Path

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import registry
import tools
from dashboard import plugin_api


def _write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(registry, "db_path", lambda: tmp_path / "openspec.db")
    monkeypatch.setattr(tools, "_registry_module", lambda: registry)
    monkeypatch.setattr(plugin_api, "_registry", registry)
    monkeypatch.setattr(plugin_api, "_migration_done", True)

    repo = tmp_path / "repo"
    ox = repo / "openspec"
    _write(ox / "workspace" / "explorations" / "2026-10-30-topic.md", "# Topic\nworkspace body\n")
    _write(ox / "workspace" / "explorations" / "spike.md", "# Workspace Spike\n")
    demo = ox / "changes" / "demo"
    _write(demo / "proposal.md", "# Demo\n")
    _write(demo / "tasks.md", "- [ ] 1.1 x\n")
    _write(demo / "explorations" / "spike.md", "# Local Spike\nlocal body\n")
    _write(demo / "explorations" / "only-local.md", "# Only Local\n")
    _write(demo / "reviews" / "findings-proposal-v1.md", "- **Verdict**: **REJECTED**\n")
    _write(demo / "reviews" / "findings-proposal-v2.md", "- **Verdict**: **APPROVED**\n\nbody v2\n")
    quiet = ox / "changes" / "quiet"
    _write(quiet / "proposal.md", "# Quiet\n")
    _write(ox / "changes" / "archive" / "2026-01-01-old" / "proposal.md", "# Old\n")
    _write(ox / "changes" / "archive" / "2026-01-01-old" / "explorations" / "legacy.md", "# Legacy\n")
    _write(ox / "specs" / "agent-tools" / "spec.md", "# Agent Tools\n")
    _write(ox / "ideas" / "board-search.md", "# Idea\n")

    source = registry.add_source(str(repo), "demoapp")
    app = FastAPI()
    app.include_router(plugin_api.router)
    return {"repo": repo, "source": source, "sid": source["token"], "client": TestClient(app)}


def _sources(env):
    payload = env["client"].get("/sources").json()
    return next(s for s in payload["sources"] if s["id"] == env["sid"])


def _ctx(identifier):
    return json.loads(tools.openspec_context({"identifier": identifier}))


# ---------------------------------------------------------------------------
# /sources
# ---------------------------------------------------------------------------


def test_sources_lists_workspace_and_change_local_explorations(env):
    scan = _sources(env)["openspec"]
    items = scan["explorations"]
    by = {(i["scope"], i["name"]): i for i in items}
    assert set(by) == {
        ("workspace", "2026-10-30-topic"),
        ("workspace", "spike"),
        ("change:demo", "spike"),
        ("change:demo", "only-local"),
        ("change:2026-01-01-old", "legacy"),
    }
    topic = by[("workspace", "2026-10-30-topic")]
    assert topic["filename"] == "2026-10-30-topic.md"
    assert topic["title"] == "Topic" and topic["date"] == "2026-10-30"
    assert topic["token"] == registry.change_token("exploration:workspace:2026-10-30-topic")
    assert scan["counts"]["explorations"] == 5


def test_sources_change_summaries_report_exploration_and_review_flags(env):
    changes = {c["name"]: c for c in _sources(env)["openspec"]["changes"]}
    demo, quiet = changes["demo"], changes["quiet"]
    assert demo["hasExplorations"] is True and demo["hasReviews"] is True
    assert demo["reviewCount"] == 2 and demo["latestVerdict"] == "APPROVED"
    assert quiet["hasExplorations"] is False and quiet["hasReviews"] is False
    assert quiet["reviewCount"] == 0 and quiet["latestVerdict"] is None
    assert changes["2026-01-01-old"]["hasExplorations"] is True


# ---------------------------------------------------------------------------
# /changes/{name}
# ---------------------------------------------------------------------------


def test_change_detail_exposes_local_explorations_and_reviews(env):
    detail = env["client"].get(f"/sources/{env['sid']}/changes/demo").json()
    assert {(e["scope"], e["name"]) for e in detail["explorations"]} == {
        ("change:demo", "spike"), ("change:demo", "only-local"),
    }
    assert detail["hasExplorations"] is True
    reviews = detail["reviews"]
    assert [r["name"] for r in reviews] == ["findings-proposal-v1", "findings-proposal-v2"]
    assert [r["verdict"] for r in reviews] == ["REJECTED", "APPROVED"]
    assert [r["round"] for r in reviews] == [1, 2]
    assert "body v2" in reviews[1]["content"]
    assert reviews[1]["token"] == registry.change_token("review:demo:findings-proposal-v2")
    assert reviews[1]["filename"] == "findings-proposal-v2.md"


def test_change_detail_without_artifacts_has_empty_lists(env):
    detail = env["client"].get(f"/sources/{env['sid']}/changes/quiet").json()
    assert detail["explorations"] == [] and detail["reviews"] == []
    assert detail["hasExplorations"] is False


# ---------------------------------------------------------------------------
# /explorations/{name}
# ---------------------------------------------------------------------------


def test_exploration_detail_defaults_to_workspace_scope(env):
    body = env["client"].get(f"/sources/{env['sid']}/explorations/spike").json()
    assert body["scope"] == "workspace" and body["title"] == "Workspace Spike"
    assert Path(body["path"]).is_absolute() and "Workspace Spike" in body["content"]


def test_exploration_detail_change_scope(env):
    r = env["client"].get(f"/sources/{env['sid']}/explorations/spike", params={"scope": "change:demo"})
    body = r.json()
    assert r.status_code == 200
    assert body["scope"] == "change:demo" and "local body" in body["content"]
    assert body["token"] == registry.change_token("exploration:change:demo:spike")


def test_exploration_detail_name_without_scope_does_not_cross_scopes(env):
    r = env["client"].get(f"/sources/{env['sid']}/explorations/only-local")
    assert r.status_code == 404


@pytest.mark.parametrize(
    "name,scope",
    [
        ("x..y", "workspace"),
        ("a b", "workspace"),
        ("spike", "bogus"),
        ("spike", "change:"),
        ("spike", "change:../x"),
        ("spike", "change:a/b"),
        ("spike", "workspace/extra"),
    ],
)
def test_exploration_detail_rejects_malformed_input(env, name, scope):
    r = env["client"].get(f"/sources/{env['sid']}/explorations/{name}", params={"scope": scope})
    assert r.status_code == 400


def test_exploration_detail_direct_call_rejects_traversal(env):
    for bad in ("..", ".", "../secret", "a/b", "a\\b"):
        with pytest.raises(HTTPException) as exc:
            plugin_api.exploration_detail(env["sid"], bad, "workspace")
        assert exc.value.status_code == 400


def test_exploration_detail_unknown_is_404(env):
    sid = env["sid"]
    assert env["client"].get(f"/sources/{sid}/explorations/nope").status_code == 404
    assert env["client"].get(
        f"/sources/{sid}/explorations/spike", params={"scope": "change:missing"}
    ).status_code == 404


# ---------------------------------------------------------------------------
# openspec_context
# ---------------------------------------------------------------------------


def test_context_bare_source_lists_explorations_and_reviews_without_content(env):
    result = _ctx("demoapp")
    assert result["ok"] is True
    assert {(e["scope"], e["name"]) for e in result["explorations"]} >= {
        ("workspace", "spike"), ("change:demo", "spike"),
    }
    assert all(set(e) == {"name", "filename", "scope", "token"} for e in result["explorations"])
    reviews = {(r["change"], r["name"]): r for r in result["reviews"]}
    assert reviews[("demo", "findings-proposal-v2")]["verdict"] == "APPROVED"
    assert all(set(r) == {"change", "name", "filename", "token", "verdict"} for r in result["reviews"])


def test_context_change_detail_returns_local_artifact_tokens(env):
    result = _ctx("demoapp/demo")
    assert result["ok"] is True and result["change"]["name"] == "demo"
    assert {e["name"] for e in result["explorations"]} == {"spike", "only-local"}
    assert [r["name"] for r in result["reviews"]] == ["findings-proposal-v1", "findings-proposal-v2"]
    api = env["client"].get(f"/sources/{env['sid']}/changes/demo").json()
    assert {e["token"] for e in result["explorations"]} == {e["token"] for e in api["explorations"]}
    assert {r["token"] for r in result["reviews"]} == {r["token"] for r in api["reviews"]}


def test_context_resolves_exploration_by_token_and_qualified_forms(env):
    token = registry.change_token("exploration:change:demo:only-local")
    for ref in (token, "exploration:only-local@demo", "only-local"):
        result = _ctx(f"demoapp/{ref}")
        assert result["ok"] is True, (ref, result)
        ex = result["exploration"]
        assert ex["scope"] == "change:demo" and ex["name"] == "only-local"
        assert {"name", "filename", "scope", "token", "title", "date", "path", "content"} <= set(ex)
        assert Path(ex["path"]).is_absolute() and "Only Local" in ex["content"]


def test_context_exploration_without_at_selects_workspace_only(env):
    ex = _ctx("demoapp/exploration:spike")["exploration"]
    assert ex["scope"] == "workspace"
    assert _ctx("demoapp/exploration:only-local")["ok"] is False


def test_context_resolves_review_by_token_and_qualified_form(env):
    token = registry.change_token("review:demo:findings-proposal-v2")
    for ref in (token, "review:findings-proposal-v2@demo", "findings-proposal-v2"):
        result = _ctx(f"demoapp/{ref}")
        assert result["ok"] is True, (ref, result)
        review = result["review"]
        assert review["verdict"] == "APPROVED" and review["round"] == 2 and review["change"] == "demo"
        assert {"name", "filename", "change", "verdict", "round", "token", "path", "content"} <= set(review)
        assert "body v2" in review["content"]


def test_context_unqualified_unique_literal_across_kinds(env):
    assert _ctx("demoapp/board-search")["idea"]["name"] == "board-search"
    assert _ctx("demoapp/agent-tools")["spec"]["path"] == "agent-tools/spec.md"
    assert _ctx("demoapp/2026-10-30-topic")["exploration"]["scope"] == "workspace"


def test_context_ambiguous_literal_fails_closed_with_candidates(env):
    result = _ctx("demoapp/spike")
    assert result["ok"] is False and result["error"] == "ambiguous"
    assert sorted(c["ref"] for c in result["candidates"]) == [
        "exploration:spike", "exploration:spike@demo",
    ]
    assert all(set(c) == {"kind", "ref"} for c in result["candidates"])
    assert "exploration" not in result and "content" not in json.dumps(result)


def test_context_cross_kind_ambiguity_between_spec_and_exploration(env):
    _write(env["repo"] / "openspec" / "workspace" / "explorations" / "agent-tools.md", "# X\n")
    result = _ctx("demoapp/agent-tools")
    assert result["ok"] is False and result["error"] == "ambiguous"
    assert {c["kind"] for c in result["candidates"]} == {"spec", "exploration"}


@pytest.mark.parametrize("ref", ["a%2Fb", "x..y", "bogus:thing", "review:findings-proposal-v2", "exploration:a@"])
def test_context_invalid_ref_reads_nothing(env, ref):
    result = _ctx(f"demoapp/{ref}")
    assert result["ok"] is False and result["error"] == "invalid_ref"


def test_context_dotdot_path_is_invalid_ref(env):
    result = _ctx("demoapp/../secret")
    assert result["ok"] is False and result["error"] == "invalid_ref"


def test_context_unknown_ref_is_not_found(env):
    result = _ctx("demoapp/does-not-exist")
    assert result["ok"] is False and result["error"] == "not_found"


def test_api_and_tool_share_artifact_identity(env):
    scan = _sources(env)["openspec"]
    ctx = _ctx("demoapp")
    api_ex = {(e["scope"], e["name"]): e["token"] for e in scan["explorations"]}
    tool_ex = {(e["scope"], e["name"]): e["token"] for e in ctx["explorations"]}
    assert api_ex == tool_ex
    api_rev = {(r["name"]): r["verdict"] for r in env["client"].get(
        f"/sources/{env['sid']}/changes/demo").json()["reviews"]}
    tool_rev = {r["name"]: r["verdict"] for r in ctx["reviews"] if r["change"] == "demo"}
    assert api_rev == tool_rev


def test_adapters_contain_no_local_scanner_or_verdict_parser():
    root = Path(plugin_api.__file__).resolve().parent.parent
    for rel in ("tools.py", "dashboard/plugin_api.py"):
        src = (root / rel).read_text(encoding="utf-8")
        assert "def extract_review_verdict" not in src and "def scan_explorations" not in src
        assert "def scan_reviews" not in src and "def _extract_verdict" not in src
        assert "artifacts_index" in src
