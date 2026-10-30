"""Cross-platform ``openspec`` CLI binary resolution (stdlib only).

One ordered candidate ladder shared by ``tools.py`` and ``dashboard/plugin_api.py``:

1. ``OPENSPEC_BIN``
2. ``PATH`` lookup (``shutil.which`` against the supplied environment)
3. ``%APPDATA%/npm/openspec.cmd`` and ``%APPDATA%/npm/openspec``
4. ``%NVM_SYMLINK%/openspec.cmd`` and ``%NVM_SYMLINK%/openspec``
5. ``C:/nvm4w/nodejs/openspec.cmd`` and ``C:/nvm4w/nodejs/openspec`` (Windows only)
6. ``~/.npm-global/bin/openspec``

``resolve_openspec_bin(candidates=...)`` is the test seam: an explicit candidate
list replaces the default ladder.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Mapping, Sequence

_NVM4W_DIR = "C:/nvm4w/nodejs"


def _is_windows(is_windows: bool | None) -> bool:
    return (os.name == "nt") if is_windows is None else bool(is_windows)


def default_candidates(
    *,
    env: Mapping[str, str] | None = None,
    is_windows: bool | None = None,
) -> list[str | Path]:
    """Return the default ordered candidate ladder for the given environment."""
    env = os.environ if env is None else env
    windows = _is_windows(is_windows)
    ladder: list[str | Path] = []

    configured = str(env.get("OPENSPEC_BIN", "") or "").strip()
    if configured:
        ladder.append(configured)

    found = shutil.which("openspec", path=env.get("PATH", ""))
    if found:
        ladder.append(found)

    for var in ("APPDATA", "NVM_SYMLINK"):
        base = str(env.get(var, "") or "").strip()
        if not base:
            continue
        root = Path(base) / "npm" if var == "APPDATA" else Path(base)
        ladder.append(root / "openspec.cmd")
        ladder.append(root / "openspec")

    if windows:
        ladder.append(Path(_NVM4W_DIR) / "openspec.cmd")
        ladder.append(Path(_NVM4W_DIR) / "openspec")

    ladder.append(Path.home() / ".npm-global" / "bin" / "openspec")
    return ladder


def _usable(candidate: str | Path) -> bool:
    try:
        return bool(str(candidate)) and Path(candidate).is_file() and os.access(candidate, os.X_OK)
    except OSError:
        return False


def _prefer_cmd_shim(candidate: str, windows: bool) -> str:
    """On Windows an extensionless npm shim is a sh script; use its ``.cmd`` sibling."""
    if windows and not Path(candidate).suffix:
        sibling = Path(candidate + ".cmd")
        if _usable(sibling):
            return str(sibling)
    return candidate


def resolve_openspec_bin(
    candidates: Sequence[str | Path] | None = None,
    *,
    env: Mapping[str, str] | None = None,
    is_windows: bool | None = None,
) -> str | None:
    """Return the first usable ``openspec`` executable path, or ``None``."""
    windows = _is_windows(is_windows)
    ladder = default_candidates(env=env, is_windows=windows) if candidates is None else candidates
    for candidate in ladder:
        if _usable(candidate):
            return _prefer_cmd_shim(str(candidate), windows)
    return None


def build_openspec_argv(
    exe: str,
    args: Sequence[str],
    *,
    is_windows: bool | None = None,
) -> list[str]:
    """Build the subprocess argv for ``exe`` (single place for ``.cmd``/``.bat`` handling)."""
    return [_prefer_cmd_shim(str(exe), _is_windows(is_windows)), *[str(a) for a in args]]
