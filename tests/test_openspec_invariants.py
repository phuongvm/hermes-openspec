"""Fork invariants for phuongvm/hermes-openspec.

OPENSPEC-INV-1: `.openspec.yaml` metadata written by the plugin uses `x-*` extension keys,
because OpenSpec CLI >= 1.15.0 fails `validate --strict` on unknown non-extension keys.
OPENSPEC-INV-2: tests/conftest.py makes the plugin's own top-level modules win on import.
"""

import json
import os
import subprocess
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


def test_inv2_pytest_ignores_foreign_python_site_packages_on_pythonpath(tmp_path):
    """Foreign-ABI site-packages on PYTHONPATH (pyvenv.cfg, POSIX pythonX.Y, ABI tag) must be pruned."""
    foreign_minor = sys.version_info[1] + 9
    maj = sys.version_info[0]

    # 1. Windows venv layout (pyvenv.cfg)
    foreign_venv = tmp_path / "foreign_venv"
    win_sp = foreign_venv / "Lib" / "site-packages"
    win_sp.mkdir(parents=True)
    (foreign_venv / "pyvenv.cfg").write_text(
        f"home = {tmp_path}\nversion_info = {maj}.{foreign_minor}.0\n",
        encoding="utf-8",
    )

    # 2. POSIX lib/pythonX.Y/site-packages layout (no pyvenv.cfg)
    posix_sp = tmp_path / "posix_env" / "lib" / f"python{maj}.{foreign_minor}" / "site-packages"
    posix_sp.mkdir(parents=True)

    # 3. Bare site-packages identified by C-extension ABI tag (no pyvenv.cfg)
    abi_sp = tmp_path / "abi_only" / "site-packages"
    abi_sp.mkdir(parents=True)
    (abi_sp / f"_dummy.cp{maj}{foreign_minor}-win_amd64.pyd").write_bytes(b"")

    for sp in (win_sp, posix_sp, abi_sp):
        for pkg in ("pydantic", "pydantic_core", "fastapi"):
            pkg_dir = sp / pkg
            pkg_dir.mkdir()
            (pkg_dir / "__init__.py").write_text(
                "raise ImportError('foreign ABI site-packages must not be imported')\n",
                encoding="utf-8",
            )

    existing_pp = [
        p for p in (os.environ.get("PYTHONPATH") or "").split(os.pathsep) if p
    ]
    for entry in sys.path:
        if entry and (Path(entry) / "hermes_constants.py").is_file() and entry not in existing_pp:
            existing_pp.append(entry)

    env = os.environ.copy()
    env["PYTHONPATH"] = os.pathsep.join([str(win_sp), str(posix_sp), str(abi_sp), *existing_pp])
    proc = subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            str(PLUGIN_ROOT / "tests" / "test_subproject_sources.py"),
            "-k",
            "test_subproject_with_own_openspec_resolves_to_itself",
            "-q",
            "-p",
            "no:cacheprovider",
        ],
        cwd=str(tmp_path),
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert proc.returncode == 0, f"stdout={proc.stdout}\nstderr={proc.stderr}"
