"""OpenSpec plugin — registers CLI-backed spec workflow tools and bundled skills."""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, Mapping

try:
    from . import schemas
    from . import tools
except ImportError:  # pragma: no cover - pytest may import the repo root as a top-level module
    import schemas  # type: ignore
    import tools  # type: ignore

logger = logging.getLogger(__name__)
_PLUGIN_DIR = Path(__file__).parent

_TOOLS = (
    ("openspec_list", schemas.OPENSPEC_LIST, tools.openspec_list, "📋"),
    ("openspec_show", schemas.OPENSPEC_SHOW, tools.openspec_show, "📖"),
    ("openspec_validate", schemas.OPENSPEC_VALIDATE, tools.openspec_validate, "✅"),
    ("openspec_status", schemas.OPENSPEC_STATUS, tools.openspec_status, "📊"),
    ("openspec_instructions", schemas.OPENSPEC_INSTRUCTIONS, tools.openspec_instructions, "🧭"),
)

_WRITE_TOOLS = (
    ("openspec_idea_create", schemas.OPENSPEC_IDEA_CREATE, tools.openspec_idea_create, "💡"),
    ("openspec_idea_enrich", schemas.OPENSPEC_IDEA_ENRICH, tools.openspec_idea_enrich, "🔎"),
    ("openspec_idea_promote", schemas.OPENSPEC_IDEA_PROMOTE, tools.openspec_idea_promote, "🚀"),
    ("openspec_task_list", schemas.OPENSPEC_TASK_LIST, tools.openspec_task_list, "☑️"),
    ("openspec_change_sequence_set", schemas.OPENSPEC_CHANGE_SEQUENCE_SET, tools.openspec_change_sequence_set, "🔢"),
    ("openspec_task_set_status", schemas.OPENSPEC_TASK_SET_STATUS, tools.openspec_task_set_status, "✅"),
    ("openspec_change_create", schemas.OPENSPEC_CHANGE_CREATE, tools.openspec_change_create, "📝"),
    ("openspec_change_promote", schemas.OPENSPEC_CHANGE_PROMOTE, tools.openspec_change_promote, "➡️"),
    ("openspec_sync_specs", schemas.OPENSPEC_SYNC_SPECS, tools.openspec_sync_specs, "🔄"),
    ("openspec_change_archive", schemas.OPENSPEC_CHANGE_ARCHIVE, tools.openspec_change_archive, "📦"),
    ("openspec_change_unarchive", schemas.OPENSPEC_CHANGE_UNARCHIVE, tools.openspec_change_unarchive, "♻️"),
    ("openspec_spec_diff", schemas.OPENSPEC_SPEC_DIFF, tools.openspec_spec_diff, "🔍"),
    ("openspec_spec_create", schemas.OPENSPEC_SPEC_CREATE, tools.openspec_spec_create, "✏️"),
    ("openspec_spec_show", schemas.OPENSPEC_SPEC_SHOW, tools.openspec_spec_show, "📄"),
    ("openspec_spec_list", schemas.OPENSPEC_SPEC_LIST, tools.openspec_spec_list, "📋"),
)


_TRUE_WORDS = {"true", "1", "yes", "on"}
_FALSE_WORDS = {"false", "0", "no", "off"}


def _hermes_home() -> Path:
    try:
        from hermes_constants import get_hermes_home

        return Path(get_hermes_home())
    except Exception:
        return Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")


def _scalar(text: str) -> str:
    text = text.strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "\"'":
        return text[1:-1]
    return text


def _mini_yaml(text: str) -> dict:
    """Stdlib subset parser (nested maps and scalar lists) used when PyYAML is absent."""
    root: dict = {}
    # stack entries: (indent, container, parent_container, key_in_parent)
    stack: list[tuple[int, Any, Any, str | None]] = [(-1, root, None, None)]
    for raw in text.splitlines():
        body = raw.split(" #", 1)[0].rstrip()
        if not body.strip() or body.lstrip().startswith("#"):
            continue
        indent = len(body) - len(body.lstrip())
        line = body.strip()
        while len(stack) > 1 and indent <= stack[-1][0] and not (
            line.startswith("- ") and indent == stack[-1][0] and isinstance(stack[-1][1], list)
        ):
            stack.pop()
        _, container, parent, key_in_parent = stack[-1]
        if line.startswith("- "):
            if isinstance(container, dict) and not container and parent is not None:
                container = []
                parent[key_in_parent] = container
                stack[-1] = (stack[-1][0], container, parent, key_in_parent)
            if isinstance(container, list):
                container.append(_scalar(line[2:]))
            continue
        key, sep, value = line.partition(":")
        if not sep or not isinstance(container, dict):
            continue
        key = key.strip()
        if value.strip():
            container[key] = _scalar(value)
        else:
            container[key] = {}
            stack.append((indent, container[key], container, key))
    return root


def _load_config(hermes_home: Path) -> dict:
    path = Path(hermes_home) / "config.yaml"
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return {}
    try:
        import yaml  # type: ignore

        data = yaml.safe_load(text)
        return data if isinstance(data, dict) else {}
    except ImportError:
        pass
    except Exception:
        return {}
    try:
        return _mini_yaml(text)
    except Exception:
        return {}


def _register_bundled_skills_mode(config: Mapping[str, Any]) -> str:
    raw: Any = os.environ.get("OPENSPEC_REGISTER_BUNDLED_SKILLS", "").strip()
    if not raw:
        raw = config
        for key in ("plugins", "entries", "openspec", "settings", "register_bundled_skills"):
            raw = raw.get(key) if isinstance(raw, Mapping) else None
    word = str(raw).strip().lower() if raw is not None else ""
    if word in _TRUE_WORDS:
        return "true"
    if word in _FALSE_WORDS:
        return "false"
    return "auto"


def _skill_roots(hermes_home: Path, config: Mapping[str, Any]) -> list[Path]:
    roots = [Path(hermes_home) / "skills"]
    skills_cfg = config.get("skills") if isinstance(config, Mapping) else None
    external = skills_cfg.get("external_dirs") if isinstance(skills_cfg, Mapping) else None
    if isinstance(external, str):
        external = [external]
    for entry in external or []:
        try:
            roots.append(Path(str(entry)).expanduser().resolve())
        except (OSError, RuntimeError):
            continue
    return roots


def should_register_bundled_skill(
    skill_name: str,
    *,
    mode: str = "auto",
    hermes_home: Path | None = None,
    config: Mapping[str, Any] | None = None,
) -> bool:
    """Decide whether the bundled ``skill_name`` is registered as ``plugin:openspec:<name>``."""
    mode = str(mode or "auto").strip().lower()
    if mode == "true":
        return True
    if mode == "false":
        return False
    home = Path(hermes_home) if hermes_home is not None else _hermes_home()
    cfg = config if config is not None else _load_config(home)
    for root in _skill_roots(home, cfg):
        try:
            if (root / skill_name / "SKILL.md").is_file():
                return False
            if any(hit.is_file() for hit in root.glob(f"*/{skill_name}/SKILL.md")):
                return False
        except OSError:
            continue
    return True


def register_bundled_skills(ctx, *, hermes_home: Path | None = None) -> None:
    """Register bundled upstream workflow skills according to ``register_bundled_skills``."""
    home = Path(hermes_home) if hermes_home is not None else _hermes_home()
    config = _load_config(home)
    mode = _register_bundled_skills_mode(config)
    if mode == "false":
        return
    skills_dir = _PLUGIN_DIR / "skills"
    for child in sorted(skills_dir.iterdir()) if skills_dir.is_dir() else []:
        skill_md = child / "SKILL.md"
        if not (child.is_dir() and skill_md.exists()):
            continue
        if not should_register_bundled_skill(child.name, mode=mode, hermes_home=home, config=config):
            continue
        try:
            ctx.register_skill(child.name, skill_md)
        except Exception:
            logger.warning("Failed to register skill %s", child.name, exc_info=True)


def _check_openspec_available() -> bool:
    return tools._openspec_bin() is not None


def register(ctx) -> None:
    # openspec_context only reads the registry DB + files on disk, so it is
    # available even when the openspec CLI binary is not installed. It is the
    # entry point for resolving copyable 'os_' identifiers.
    ctx.register_tool(
        name="openspec_context",
        toolset="openspec",
        schema=schemas.OPENSPEC_CONTEXT,
        handler=tools.openspec_context,
        emoji="🔖",
    )
    for name, schema, handler, emoji in _TOOLS:
        ctx.register_tool(
            name=name,
            toolset="openspec",
            schema=schema,
            handler=handler,
            check_fn=_check_openspec_available,
            emoji=emoji,
        )
    for name, schema, handler, emoji in _WRITE_TOOLS:
        ctx.register_tool(
            name=name,
            toolset="openspec",
            schema=schema,
            handler=handler,
            emoji=emoji,
        )
    # CLI passthrough tool — gated on openspec binary availability
    ctx.register_tool(
        name="openspec_cli",
        toolset="openspec",
        schema=schemas.OPENSPEC_CLI,
        handler=tools.openspec_cli,
        check_fn=_check_openspec_available,
        emoji="🖥️",
    )
    if callable(getattr(ctx, "register_hook", None)):
        ctx.register_hook("pre_tool_call", tools._openspec_pre_tool_call_guard)
    register_bundled_skills(ctx)
