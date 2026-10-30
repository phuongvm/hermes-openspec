"""Make the plugin's own top-level modules (tools, registry, dashboard, ...) win on import.

`python -m pytest` run from the plugin root puts the root on sys.path, but a bare `pytest`
run from anywhere else does not. In a Hermes environment, `import tools` then resolves to
Hermes's own `tools` package instead of this plugin's tools.py.

When a multi-Python runner injects foreign-version `site-packages` directories into
`PYTHONPATH`, prune them before test collection so compiled extensions resolve from
the active interpreter while keeping source checkouts (such as `hermes-agent`) intact.
"""

import os
import re
import sys
from pathlib import Path

_PLUGIN_ROOT = Path(__file__).resolve().parent.parent
_PYVENV_VER_RX = re.compile(r"^\s*(?:version|version_info)\s*=\s*(\d+)\.(\d+)", re.MULTILINE)
_POSIX_SP_VER_RX = re.compile(r"[/\\]python(\d+)\.(\d+)[/\\](?:site|dist)-packages(?:[/\\]+)?$", re.IGNORECASE)
_EXT_TAG_VER_RX = re.compile(r"\.(?:cp|cpython-)(\d)(\d{1,2})(?:m|t)?[-.]", re.IGNORECASE)
_ACTIVE_PY_VER = sys.version_info[:2]


def _site_packages_py_version(entry: str) -> tuple[int, int] | None:
    if not entry:
        return None
    m = _POSIX_SP_VER_RX.search(entry)
    if m:
        return (int(m.group(1)), int(m.group(2)))
    try:
        p = Path(entry).resolve()
    except OSError:
        return None
    if p.name.lower() not in ("site-packages", "dist-packages"):
        return None
    for parent in (p.parent, p.parent.parent, p.parent.parent.parent):
        cfg = parent / "pyvenv.cfg"
        if cfg.is_file():
            try:
                cm = _PYVENV_VER_RX.search(cfg.read_text(encoding="utf-8", errors="replace"))
            except OSError:
                return None
            if cm:
                return (int(cm.group(1)), int(cm.group(2)))
    try:
        for child in os.scandir(p):
            em = _EXT_TAG_VER_RX.search(child.name)
            if em:
                return (int(em.group(1)), int(em.group(2)))
    except OSError:
        pass
    return None


sys.path[:] = [
    entry
    for entry in sys.path
    if _site_packages_py_version(entry) in (None, _ACTIVE_PY_VER)
]

if str(_PLUGIN_ROOT) in sys.path:
    sys.path.remove(str(_PLUGIN_ROOT))
sys.path.insert(0, str(_PLUGIN_ROOT))

for _name in ("tools", "registry", "schemas", "spec_parser", "dashboard", "cli_resolver", "artifacts_index"):
    _mod = sys.modules.get(_name)
    _file = getattr(_mod, "__file__", None) if _mod is not None else None
    if _mod is not None and (not _file or _PLUGIN_ROOT not in Path(_file).resolve().parents):
        del sys.modules[_name]
