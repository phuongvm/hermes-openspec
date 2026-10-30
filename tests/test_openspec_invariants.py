"""Fork invariants for phuongvm/hermes-openspec.

OPENSPEC-INV-1: `.openspec.yaml` metadata written by the plugin uses `x-*` extension keys,
because OpenSpec CLI >= 1.15.0 fails `validate --strict` on unknown non-extension keys.
OPENSPEC-INV-2: tests/conftest.py makes the plugin's own top-level modules win on import.
"""

import json
import sys
from pathlib import Path

import tools

PLUGIN_ROOT = Path(__file__).resolve().parent.parent


def _meta(change_dir):
    text = (Path(change_dir) / ".openspec.yaml").read_text(encoding="utf-8")
    return dict(line.split(": ", 1) for line in text.splitlines() if ": " in line)


def test_inv1_change_create_writes_x_created_at(tmp_path):
    out = json.loads(tools.openspec_change_create({
        "workdir": str(tmp_path),
        "change": "inv1-created",
        "title": "Inv1 Created",
    }))
    assert out["ok"] is True
    meta = _meta(Path(out["paths"]["metadata"]).parent)
    assert meta["schema"] == "spec-driven"
    assert "x-createdAt" in meta
    assert "createdAt" not in meta


def test_inv1_idea_promote_writes_x_source_and_promoted_keys(tmp_path):
    idea = json.loads(tools.openspec_idea_create({
        "workdir": str(tmp_path),
        "title": "Inv1 Idea",
        "prompt": "Promotion metadata must use extension keys.",
    }))
    out = json.loads(tools.openspec_idea_promote({
        "workdir": str(tmp_path),
        "idea": idea["slug"],
        "change": "inv1-promoted",
    }))
    assert out["ok"] is True
    meta = _meta(out["change_path"])
    assert meta["schema"] == "spec-driven"
    assert "x-sourceIdea" in meta and "x-promotedAt" in meta
    assert "sourceIdea" not in meta and "promotedAt" not in meta


def test_inv2_plugin_modules_resolve_inside_plugin_root():
    for name in ("tools", "registry", "schemas", "spec_parser"):
        mod = __import__(name)
        assert PLUGIN_ROOT in Path(mod.__file__).resolve().parents, (name, mod.__file__)
    assert Path(sys.path[0]).resolve() == PLUGIN_ROOT
