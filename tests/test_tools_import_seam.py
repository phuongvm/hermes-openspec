"""tools.py must use normal imports (no path-based loader) for sibling modules."""
from __future__ import annotations

import importlib
import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def test_tools_has_no_path_based_loader():
    text = (ROOT / "tools.py").read_text(encoding="utf-8")
    assert "spec_from_file_location" not in text
    assert "_load_sibling" not in text


def test_dashboard_plugin_api_retains_path_loader():
    text = (ROOT / "dashboard" / "plugin_api.py").read_text(encoding="utf-8")
    assert "spec_from_file_location" in text


def test_top_level_import_shares_module_identity():
    import tools

    assert tools._cli_resolver is importlib.import_module("cli_resolver")
    assert tools._artifacts_index is importlib.import_module("artifacts_index")
    assert sys.modules["cli_resolver"] is tools._cli_resolver
    assert tools._registry_module() is importlib.import_module("registry")


def test_package_import_shares_module_identity():
    pkg_name = "openspec_pkg_seam_probe"
    spec = importlib.util.spec_from_file_location(
        pkg_name, ROOT / "__init__.py", submodule_search_locations=[str(ROOT)]
    )
    pkg = importlib.util.module_from_spec(spec)
    sys.modules[pkg_name] = pkg
    try:
        spec.loader.exec_module(pkg)
        tools_mod = importlib.import_module(f"{pkg_name}.tools")
        assert tools_mod._cli_resolver is importlib.import_module(f"{pkg_name}.cli_resolver")
        assert tools_mod._artifacts_index is importlib.import_module(f"{pkg_name}.artifacts_index")
        assert tools_mod._registry_module() is importlib.import_module(f"{pkg_name}.registry")
    finally:
        for name in [n for n in sys.modules if n == pkg_name or n.startswith(pkg_name + ".")]:
            del sys.modules[name]
