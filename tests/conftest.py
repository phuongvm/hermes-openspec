"""Make the plugin's own top-level modules (tools, registry, dashboard, ...) win on import.

`python -m pytest` run from the plugin root puts the root on sys.path, but a bare `pytest`
run from anywhere else does not. In a Hermes environment, `import tools` then resolves to
Hermes's own `tools` package instead of this plugin's tools.py.
"""

import sys
from pathlib import Path

_PLUGIN_ROOT = Path(__file__).resolve().parent.parent

if str(_PLUGIN_ROOT) in sys.path:
    sys.path.remove(str(_PLUGIN_ROOT))
sys.path.insert(0, str(_PLUGIN_ROOT))

for _name in ("tools", "registry", "schemas", "spec_parser", "dashboard"):
    _mod = sys.modules.get(_name)
    _file = getattr(_mod, "__file__", None) if _mod is not None else None
    if _mod is not None and (not _file or _PLUGIN_ROOT not in Path(_file).resolve().parents):
        del sys.modules[_name]
