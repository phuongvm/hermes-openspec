"""Tracer Bullet 1: cross-platform CLI resolver and bundled skill deduplication."""

import importlib.util
import os
import sys
from pathlib import Path

import pytest

import cli_resolver
import tools
from dashboard import plugin_api

PLUGIN_ROOT = Path(__file__).resolve().parent.parent


def _exe(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("@echo off\n", encoding="utf-8")
    path.chmod(0o755)
    return path


# ---------------------------------------------------------------------------
# resolver
# ---------------------------------------------------------------------------


def test_resolver_candidates_override_returns_first_existing(tmp_path):
    missing = tmp_path / "missing" / "openspec"
    good = _exe(tmp_path / "bin" / "openspec")
    later = _exe(tmp_path / "other" / "openspec")
    assert cli_resolver.resolve_openspec_bin([missing, good, later], env={}) == str(good)


def test_resolver_candidates_none_exist_returns_none(tmp_path):
    assert cli_resolver.resolve_openspec_bin([tmp_path / "nope"], env={}) is None


def test_resolver_env_openspec_bin_rung_wins(tmp_path):
    configured = _exe(tmp_path / "configured" / "openspec")
    on_path = _exe(tmp_path / "pathdir" / "openspec")
    env = {"OPENSPEC_BIN": f"  {configured}  ", "PATH": str(on_path.parent)}
    assert cli_resolver.resolve_openspec_bin(env=env, is_windows=False) == str(configured)


def test_resolver_path_lookup_rung(tmp_path):
    # shutil.which on Windows only matches PATHEXT names, so use the native shim name.
    on_path = _exe(tmp_path / "pathdir" / ("openspec.cmd" if os.name == "nt" else "openspec"))
    env = {"PATH": str(on_path.parent)}
    found = cli_resolver.resolve_openspec_bin(env=env, is_windows=False)
    assert found is not None and os.path.normcase(found) == os.path.normcase(str(on_path))


def test_resolver_stripped_path_windows_appdata_cmd_shim(tmp_path):
    shim = _exe(tmp_path / "AppData" / "npm" / "openspec.cmd")
    env = {"PATH": str(tmp_path / "empty"), "APPDATA": str(tmp_path / "AppData")}
    assert cli_resolver.resolve_openspec_bin(env=env, is_windows=True) == str(shim)


def test_resolver_windows_prefers_cmd_over_extensionless_sibling(tmp_path):
    bare = _exe(tmp_path / "AppData" / "npm" / "openspec")
    shim = _exe(tmp_path / "AppData" / "npm" / "openspec.cmd")
    env = {"PATH": "", "APPDATA": str(tmp_path / "AppData")}
    assert bare.exists()
    assert cli_resolver.resolve_openspec_bin(env=env, is_windows=True) == str(shim)


def test_resolver_nvm_symlink_rung(tmp_path):
    shim = _exe(tmp_path / "nvm" / "openspec.cmd")
    env = {"PATH": "", "NVM_SYMLINK": str(tmp_path / "nvm")}
    assert cli_resolver.resolve_openspec_bin(env=env, is_windows=True) == str(shim)


def test_resolver_default_ladder_lists_nvm4w_only_on_windows():
    win = cli_resolver.default_candidates(env={}, is_windows=True)
    posix = cli_resolver.default_candidates(env={}, is_windows=False)
    assert any(str(c).replace("\\", "/") == "C:/nvm4w/nodejs/openspec.cmd" for c in win)
    assert not any("nvm4w" in str(c) for c in posix)


def test_resolver_npm_global_home_rung(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    exe = _exe(tmp_path / ".npm-global" / "bin" / "openspec")
    assert cli_resolver.resolve_openspec_bin(env={"PATH": ""}, is_windows=False) == str(exe)


def test_resolver_build_argv_passes_args_through(tmp_path):
    shim = _exe(tmp_path / "openspec.cmd")
    assert cli_resolver.build_openspec_argv(str(shim), ["list", "--json"], is_windows=True) == [
        str(shim), "list", "--json",
    ]


def test_resolver_build_argv_swaps_extensionless_for_cmd_sibling_on_windows(tmp_path):
    bare = _exe(tmp_path / "openspec")
    shim = _exe(tmp_path / "openspec.cmd")
    assert cli_resolver.build_openspec_argv(str(bare), ["x"], is_windows=True) == [str(shim), "x"]
    assert cli_resolver.build_openspec_argv(str(bare), ["x"], is_windows=False) == [str(bare), "x"]


def test_resolver_tools_and_dashboard_use_shared_resolver(tmp_path, monkeypatch):
    exe = _exe(tmp_path / "bin" / "openspec")
    monkeypatch.setenv("OPENSPEC_BIN", str(exe))
    assert tools._openspec_bin() == str(exe)
    assert plugin_api._find_openspec_bin() == str(exe)
    monkeypatch.setenv("OPENSPEC_BIN", str(tmp_path / "gone"))
    monkeypatch.setenv("PATH", "")
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path / "nohome"))
    monkeypatch.delenv("APPDATA", raising=False)
    monkeypatch.delenv("NVM_SYMLINK", raising=False)
    if os.name != "nt":
        assert tools._openspec_bin() is None
        assert plugin_api._find_openspec_bin() is None


def test_resolver_module_is_dependency_free():
    src = (PLUGIN_ROOT / "cli_resolver.py").read_text(encoding="utf-8")
    for banned in ("fastapi", "pydantic", "hermes", "registry"):
        assert f"import {banned}" not in src and f"from {banned}" not in src


# ---------------------------------------------------------------------------
# bundled skill deduplication
# ---------------------------------------------------------------------------


@pytest.fixture()
def plugin_pkg():
    spec = importlib.util.spec_from_file_location(
        "openspec_plugin_under_test",
        PLUGIN_ROOT / "__init__.py",
        submodule_search_locations=[str(PLUGIN_ROOT)],
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    yield mod
    sys.modules.pop(spec.name, None)


class FakeCtx:
    def __init__(self):
        self.tools = []
        self.skills = []

    def register_tool(self, **kwargs):
        self.tools.append(kwargs["name"])

    def register_skill(self, name, path):
        self.skills.append(name)


def _skill(root: Path, name: str, category: str | None = None) -> Path:
    d = root / category / name if category else root / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(f"---\nname: {name}\n---\n", encoding="utf-8")
    return d


def _bundled_names():
    return sorted(p.parent.name for p in (PLUGIN_ROOT / "skills").glob("*/SKILL.md"))


def _home(tmp_path, external=None, mode=None):
    home = tmp_path / "home"
    home.mkdir(exist_ok=True)
    lines = []
    if external is not None:
        lines += ["skills:", "  external_dirs:", f"    - {Path(external).as_posix()}"]
    if mode is not None:
        lines += [
            "plugins:", "  entries:", "    openspec:", "      settings:",
            f"        register_bundled_skills: {mode}",
        ]
    (home / "config.yaml").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return home


def test_skills_auto_skips_external_dir_duplicate_and_registers_rest(tmp_path, plugin_pkg, monkeypatch):
    monkeypatch.delenv("OPENSPEC_REGISTER_BUNDLED_SKILLS", raising=False)
    ext = tmp_path / "ext"
    _skill(ext, "openspec-explore", category="openspec")
    home = _home(tmp_path, external=ext)
    ctx = FakeCtx()
    plugin_pkg.register_bundled_skills(ctx, hermes_home=home)
    expected = [n for n in _bundled_names() if n != "openspec-explore"]
    assert "openspec-explore" not in ctx.skills
    assert sorted(ctx.skills) == expected and len(expected) > 0


def test_skills_auto_skips_hermes_home_skills_duplicate(tmp_path, plugin_pkg, monkeypatch):
    monkeypatch.delenv("OPENSPEC_REGISTER_BUNDLED_SKILLS", raising=False)
    home = _home(tmp_path)
    _skill(home / "skills", "openspec-propose")
    ctx = FakeCtx()
    plugin_pkg.register_bundled_skills(ctx, hermes_home=home)
    assert "openspec-propose" not in ctx.skills
    assert "openspec-explore" in ctx.skills


def test_skills_true_registers_all_even_with_duplicates(tmp_path, plugin_pkg, monkeypatch):
    monkeypatch.delenv("OPENSPEC_REGISTER_BUNDLED_SKILLS", raising=False)
    ext = tmp_path / "ext"
    _skill(ext, "openspec-explore", category="openspec")
    home = _home(tmp_path, external=ext, mode="true")
    _skill(home / "skills", "openspec-propose")
    ctx = FakeCtx()
    plugin_pkg.register_bundled_skills(ctx, hermes_home=home)
    assert sorted(ctx.skills) == _bundled_names()


@pytest.mark.parametrize("config_mode", ["auto", "false"])
def test_skills_env_true_overrides_config(tmp_path, plugin_pkg, monkeypatch, config_mode):
    ext = tmp_path / "ext"
    _skill(ext, "openspec-explore", category="openspec")
    home = _home(tmp_path, external=ext, mode=config_mode)
    monkeypatch.setenv("OPENSPEC_REGISTER_BUNDLED_SKILLS", "TRUE")
    ctx = FakeCtx()
    plugin_pkg.register_bundled_skills(ctx, hermes_home=home)
    assert sorted(ctx.skills) == _bundled_names()


def test_skills_false_registers_none_but_tools_stay(tmp_path, plugin_pkg, monkeypatch):
    monkeypatch.delenv("OPENSPEC_REGISTER_BUNDLED_SKILLS", raising=False)
    home = _home(tmp_path, mode="false")
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(plugin_pkg, "_hermes_home", lambda: home)
    ctx = FakeCtx()
    plugin_pkg.register(ctx)
    assert ctx.skills == []
    assert "openspec_context" in ctx.tools and "openspec_cli" in ctx.tools


def test_skills_env_false_beats_config_true(tmp_path, plugin_pkg, monkeypatch):
    home = _home(tmp_path, mode="true")
    monkeypatch.setenv("OPENSPEC_REGISTER_BUNDLED_SKILLS", "0")
    ctx = FakeCtx()
    plugin_pkg.register_bundled_skills(ctx, hermes_home=home)
    assert ctx.skills == []


def test_should_register_bundled_skill_modes(tmp_path, plugin_pkg):
    home = tmp_path / "h"
    _skill(home / "skills", "openspec-explore")
    assert plugin_pkg.should_register_bundled_skill("openspec-explore", mode="auto", hermes_home=home) is False
    assert plugin_pkg.should_register_bundled_skill("openspec-explore", mode="true", hermes_home=home) is True
    assert plugin_pkg.should_register_bundled_skill("openspec-explore", mode="false", hermes_home=home) is False
    assert plugin_pkg.should_register_bundled_skill("openspec-propose", mode="auto", hermes_home=home) is True


def test_should_register_accepts_config_mapping_external_dirs(tmp_path, plugin_pkg):
    ext = tmp_path / "ext"
    _skill(ext, "openspec-explore", category="openspec")
    cfg = {"skills": {"external_dirs": [str(ext)]}}
    assert plugin_pkg.should_register_bundled_skill(
        "openspec-explore", mode="auto", hermes_home=tmp_path / "h", config=cfg
    ) is False
