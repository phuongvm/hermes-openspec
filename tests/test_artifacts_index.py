"""artifacts_index: dependency-free scanning, reference grammar and resolution."""

import hashlib
import subprocess
import sys
from pathlib import Path

import pytest

import artifacts_index as ai

PLUGIN_ROOT = Path(__file__).resolve().parent.parent


def token_for(value: str) -> str:
    return "os_" + hashlib.sha256(value.encode("utf-8")).hexdigest()[:6]


def _write(path: Path, text: str = "# T\n") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def _repo(tmp_path: Path) -> Path:
    root = tmp_path / "repo"
    (root / "openspec" / "changes").mkdir(parents=True)
    return root


def _change(root: Path, name: str, archived: bool = False) -> Path:
    base = root / "openspec" / "changes" / ("archive" if archived else "")
    d = base / name
    _write(d / "proposal.md", f"# {name}\n")
    return d


# ---------------------------------------------------------------------------
# module isolation
# ---------------------------------------------------------------------------


def test_import_without_fastapi_or_hermes():
    code = (
        "import sys\n"
        "for n in ('fastapi','pydantic','hermes_constants','hermes_cli','registry'):\n"
        "    sys.modules[n] = None\n"
        f"sys.path.insert(0, {str(PLUGIN_ROOT)!r})\n"
        "import artifacts_index as ai\n"
        "print(ai.parse_ref('os_abcdef')['form'])\n"
    )
    out = subprocess.run([sys.executable, "-B", "-c", code], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip() == "token"


# ---------------------------------------------------------------------------
# grammar
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "ref,form,kind,name,change",
    [
        ("os_a1b2c3", "token", None, "os_a1b2c3", None),
        ("my-change", "literal", None, "my-change", None),
        ("change:demo", "qualified", "change", "demo", None),
        ("spec:agent-tools", "qualified", "spec", "agent-tools", None),
        ("idea:board-search", "qualified", "idea", "board-search", None),
        ("exploration:2026-10-30-topic", "qualified", "exploration", "2026-10-30-topic", None),
        ("exploration:spike@demo", "qualified", "exploration", "spike", "demo"),
        ("review:findings-v2@demo", "qualified", "review", "findings-v2", "demo"),
    ],
)
def test_parse_ref_accepts_grammar(ref, form, kind, name, change):
    parsed = ai.parse_ref(ref)
    assert parsed["ok"] is True
    assert (parsed["form"], parsed["kind"], parsed["name"], parsed["change"]) == (form, kind, name, change)


@pytest.mark.parametrize(
    "ref",
    [
        "",
        "..",
        "a/b",
        "a\\b",
        "../x",
        "x..y",
        "has space",
        "bogus:thing",
        "review:no-change",
        "change:demo@other",
        "exploration:@demo",
        "exploration:a@",
        "review:a@b@c",
        "os_zzzzzz:x",
        "change:",
    ],
)
def test_parse_ref_rejects_invalid(ref):
    assert ai.parse_ref(ref) == {"ok": False, "error": "invalid_ref"}


# ---------------------------------------------------------------------------
# verdict / round
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "text,expected",
    [
        ("# Review\n\n- **Verdict**: **APPROVED**\n", "APPROVED"),
        ("# Review\n\nVerdict: rejected\n", "REJECTED"),
        ("## Verdict: APPROVED\n", "APPROVED"),
        ("**Verdict:** REJECTED with required corrections\n", "REJECTED"),
        ("# Findings **APPROVED**\n", "APPROVED"),
        ("Verdict: PENDING\n", "PENDING"),
        ("this is not approved yet\n", "PENDING"),
        ("Verdict: not approved\n", "PENDING"),
        ("The reviewer approved the plan and rejected nothing.\n", "PENDING"),
        ("- **Verdict**: **APPROVED**\n- **Verdict**: **REJECTED**\n", "REJECTED"),
        ("", "PENDING"),
    ],
)
def test_extract_review_verdict(text, expected):
    assert ai.extract_review_verdict(text) == expected


@pytest.mark.parametrize(
    "stem,expected",
    [
        ("findings-proposal-v2", 2),
        ("findings-proposal-v10", 10),
        ("review-round-3", 3),
        ("Review_V4", 4),
        ("findings-reviewer-phase3", None),
        ("v", None),
        ("plain", None),
    ],
)
def test_parse_round(stem, expected):
    assert ai.parse_round(stem) == expected


# ---------------------------------------------------------------------------
# scanning
# ---------------------------------------------------------------------------


def test_scan_explorations_workspace_and_change_local(tmp_path):
    root = _repo(tmp_path)
    _write(root / "openspec" / "workspace" / "explorations" / "2026-10-30-topic.md", "# Topic Title\nbody\n")
    _write(root / "openspec" / "workspace" / "explorations" / "no-heading.md", "plain\n")
    _write(root / "openspec" / "workspace" / "explorations" / "notes.txt", "ignored")
    d = _change(root, "demo")
    _write(d / "explorations" / "spike.md", "# Spike\n")
    arch = _change(root, "old", archived=True)
    _write(arch / "explorations" / "legacy.md", "# Legacy\n")

    items = ai.scan_explorations(root, [d, arch], token_for)
    by = {(i["scope"], i["name"]): i for i in items}
    assert set(by) == {
        ("workspace", "2026-10-30-topic"),
        ("workspace", "no-heading"),
        ("change:demo", "spike"),
        ("change:old", "legacy"),
    }
    topic = by[("workspace", "2026-10-30-topic")]
    assert topic["filename"] == "2026-10-30-topic.md"
    assert topic["title"] == "Topic Title"
    assert topic["date"] == "2026-10-30"
    assert topic["token"] == token_for("exploration:workspace:2026-10-30-topic")
    assert Path(topic["path"]).is_file()
    assert by[("workspace", "no-heading")]["title"] == "no-heading"
    assert len(by[("workspace", "no-heading")]["date"]) == 10  # mtime ISO date fallback
    assert by[("change:demo", "spike")]["token"] == token_for("exploration:change:demo:spike")


def test_scan_explorations_missing_dirs_is_empty(tmp_path):
    assert ai.scan_explorations(_repo(tmp_path), [], token_for) == []


def test_scan_reviews_sorted_with_verdict_round_and_token(tmp_path):
    root = _repo(tmp_path)
    d = _change(root, "demo")
    _write(d / "reviews" / "findings-proposal-v10.md", "Verdict: APPROVED\n")
    _write(d / "reviews" / "findings-proposal-v2.md", "- **Verdict**: **REJECTED**\n")
    _write(d / "reviews" / "findings-proposal-v1.md", "not approved yet\n")
    items = ai.scan_reviews(d, "demo", token_for)
    assert [i["name"] for i in items] == [
        "findings-proposal-v1", "findings-proposal-v2", "findings-proposal-v10",
    ]
    assert [i["verdict"] for i in items] == ["PENDING", "REJECTED", "APPROVED"]
    assert [i["round"] for i in items] == [1, 2, 10]
    assert items[0]["change"] == "demo"
    assert items[0]["filename"] == "findings-proposal-v1.md"
    assert items[0]["token"] == token_for("review:demo:findings-proposal-v1")


def test_read_artifact_is_traversal_safe(tmp_path):
    allowed = tmp_path / "ex"
    _write(allowed / "ok.md", "hello")
    _write(tmp_path / "secret.md", "secret")
    assert ai.read_artifact(allowed / "ok.md", allowed) == "hello"
    assert ai.read_artifact(allowed / ".." / "secret.md", allowed) is None
    assert ai.read_artifact(allowed / "missing.md", allowed) is None
    sub = allowed / "sub"
    _write(sub / "nested.md", "nested")
    assert ai.read_artifact(sub / "nested.md", allowed) is None  # parent must equal allowed dir


# ---------------------------------------------------------------------------
# resolution
# ---------------------------------------------------------------------------


def _full_index(tmp_path):
    root = _repo(tmp_path)
    d = _change(root, "demo")
    _write(d / "explorations" / "spike.md", "# Spike\n")
    _write(d / "reviews" / "findings-v1.md", "Verdict: APPROVED\n")
    other = _change(root, "other")
    _write(other / "reviews" / "findings-v1.md", "Verdict: REJECTED\n")
    _write(root / "openspec" / "workspace" / "explorations" / "spike.md", "# Ws Spike\n")
    _write(root / "openspec" / "workspace" / "explorations" / "unique-topic.md", "# U\n")
    _write(root / "openspec" / "specs" / "agent-tools" / "spec.md", "# Spec\n")
    _write(root / "openspec" / "ideas" / "board-search.md", "# Idea\n")
    return root, ai.build_index(root, token_for)


def test_resolve_token_and_qualified_literals(tmp_path):
    _root, index = _full_index(tmp_path)
    ex_token = token_for("exploration:change:demo:spike")
    hit = ai.resolve_ref(index, ex_token)
    assert hit["ok"] and hit["kind"] == "exploration" and hit["record"]["scope"] == "change:demo"

    ws = ai.resolve_ref(index, "exploration:spike")
    assert ws["ok"] and ws["record"]["scope"] == "workspace"
    local = ai.resolve_ref(index, "exploration:spike@demo")
    assert local["ok"] and local["record"]["scope"] == "change:demo"

    rev = ai.resolve_ref(index, "review:findings-v1@other")
    assert rev["ok"] and rev["kind"] == "review" and rev["record"]["verdict"] == "REJECTED"
    assert ai.resolve_ref(index, token_for("review:demo:findings-v1"))["record"]["change"] == "demo"

    assert ai.resolve_ref(index, "change:demo")["kind"] == "change"
    assert ai.resolve_ref(index, "spec:agent-tools")["kind"] == "spec"
    assert ai.resolve_ref(index, "idea:board-search")["kind"] == "idea"


def test_resolve_unqualified_unique(tmp_path):
    _root, index = _full_index(tmp_path)
    hit = ai.resolve_ref(index, "unique-topic")
    assert hit["ok"] and hit["kind"] == "exploration"
    assert ai.resolve_ref(index, "board-search")["kind"] == "idea"
    assert ai.resolve_ref(index, "agent-tools")["kind"] == "spec"
    assert ai.resolve_ref(index, "demo")["kind"] == "change"


def test_resolve_cross_scope_and_cross_kind_collision_is_ambiguous(tmp_path):
    root, index = _full_index(tmp_path)
    scope_clash = ai.resolve_ref(index, "spike")
    assert scope_clash["ok"] is False and scope_clash["error"] == "ambiguous"
    assert sorted(c["ref"] for c in scope_clash["candidates"]) == ["exploration:spike", "exploration:spike@demo"]
    assert "record" not in scope_clash

    review_clash = ai.resolve_ref(index, "findings-v1")
    assert review_clash["error"] == "ambiguous"
    assert sorted(c["ref"] for c in review_clash["candidates"]) == [
        "review:findings-v1@demo", "review:findings-v1@other",
    ]

    _write(root / "openspec" / "ideas" / "demo.md", "# Idea named like a change\n")
    kind_clash = ai.resolve_ref(ai.build_index(root, token_for), "demo")
    assert kind_clash["error"] == "ambiguous"
    assert {(c["kind"], c["ref"]) for c in kind_clash["candidates"]} == {
        ("change", "change:demo"), ("idea", "idea:demo"),
    }
    token_clash = ai.resolve_ref(ai.build_index(root, token_for), token_for("demo"))
    assert token_clash["error"] == "ambiguous"


def test_resolve_not_found_and_invalid(tmp_path):
    _root, index = _full_index(tmp_path)
    assert ai.resolve_ref(index, "nothing-here") == {"ok": False, "error": "not_found"}
    assert ai.resolve_ref(index, "os_000000") == {"ok": False, "error": "not_found"}
    assert ai.resolve_ref(index, "../etc/passwd") == {"ok": False, "error": "invalid_ref"}
    assert ai.resolve_ref(index, "bogus:x") == {"ok": False, "error": "invalid_ref"}


# ---------------------------------------------------------------------------
# extract_openspec_refs
# ---------------------------------------------------------------------------


def test_extract_refs_paths_backslashes_and_tokens():
    text = (
        "See openspec/changes/demo/proposal.md and O:\\workspaces\\openspec\\changes\\other\\design.md.\n"
        "Exploration openspec/workspace/explorations/2026-10-30-topic.md plus "
        "openspec/changes/demo/explorations/spike.md and openspec/changes/demo/reviews/findings-v1.md.\n"
        "Token os_a1b2c3 and archived openspec/changes/archive/old-one/proposal.md"
    )
    refs = ai.extract_openspec_refs(text)
    assert refs["changes"] == {"demo", "other", "old-one"}
    assert refs["explorations"] == {("workspace", "2026-10-30-topic.md"), ("change:demo", "spike.md")}
    assert refs["reviews"] == {("demo", "findings-v1.md")}
    assert refs["tokens"] == {"os_a1b2c3"}


def test_extract_refs_segment_boundary_and_prose():
    refs = ai.extract_openspec_refs("openspec/changes/demo-extra is not demo; the spike and 2026-10-30-topic stems")
    assert refs["changes"] == {"demo-extra"}
    assert refs["explorations"] == set() and refs["reviews"] == set() and refs["tokens"] == set()


def test_extract_refs_trailing_punctuation_and_bare_dir():
    refs = ai.extract_openspec_refs("Implements openspec/changes/demo. Also (openspec/changes/demo2/).")
    assert refs["changes"] == {"demo", "demo2"}


def test_extract_refs_empty():
    assert ai.extract_openspec_refs("")["changes"] == set()
    assert ai.extract_openspec_refs(None)["tokens"] == set()


# ---------------------------------------------------------------------------
# scope + exploration detail
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("scope,expected", [
    ("workspace", "workspace"), ("change:demo", "change:demo"), (None, "workspace"),
    ("change:", None), ("change:a/b", None), ("change:..", None), ("bogus", None),
    ("workspace/x", None), ("", None),
])
def test_parse_scope(scope, expected):
    assert ai.parse_scope(scope) == expected


def test_load_exploration_by_scope_and_errors(tmp_path):
    root = _repo(tmp_path)
    _write(root / "openspec" / "workspace" / "explorations" / "ws.md", "# WS\nbody")
    d = _change(root, "demo")
    _write(d / "explorations" / "loc.md", "# Loc\nlocal")
    ws = ai.load_exploration(root, "ws", "workspace", token_for)
    assert ws["content"].startswith("# WS") and ws["scope"] == "workspace"
    loc = ai.load_exploration(root, "loc", "change:demo", token_for)
    assert loc["scope"] == "change:demo" and loc["token"] == token_for("exploration:change:demo:loc")
    assert ai.load_exploration(root, "loc", "workspace", token_for) is None
    assert ai.load_exploration(root, "ws", "change:missing", token_for) is None
    for bad_name, bad_scope in (("..", "workspace"), ("a/b", "workspace"), ("ws", "nope")):
        with pytest.raises(ValueError):
            ai.load_exploration(root, bad_name, bad_scope, token_for)
