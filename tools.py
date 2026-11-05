"""OpenSpec Hermes tool handlers."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


MAX_OUTPUT_CHARS = 50_000

_ARTIFACT_ALIASES = {"spec": "specs"}


try:
    from . import artifacts_index as _artifacts_index
    from . import cli_resolver as _cli_resolver
except ImportError:  # pragma: no cover - loaded as a top-level module (pytest root, dashboard)
    import artifacts_index as _artifacts_index  # type: ignore
    import cli_resolver as _cli_resolver  # type: ignore


def _openspec_bin() -> str | None:
    return _cli_resolver.resolve_openspec_bin()


def _resolve_workdir(value: Any) -> tuple[Path | None, str | None]:
    raw = str(value or "").strip()
    if not raw:
        return Path.cwd(), None
    p = Path(raw).expanduser()
    if not p.is_absolute():
        p = (Path.cwd() / p).resolve()
    if not p.exists() or not p.is_dir():
        return None, f"workdir does not exist or is not a directory: {p}"
    return p, None


def _json_or_text(text: str) -> Any:
    stripped = text.strip()
    if not stripped:
        return ""
    try:
        return json.loads(stripped)
    except Exception:
        return stripped


def _normalize_artifact(value: str) -> str:
    artifact = (value or "").strip()
    return _ARTIFACT_ALIASES.get(artifact, artifact)


def _run(args: list[str], workdir: Any = None) -> str:
    exe = _openspec_bin()
    if not exe:
        return json.dumps({
            "ok": False,
            "error": "openspec executable not found. Install OpenSpec or set OPENSPEC_BIN.",
        })

    cwd, err = _resolve_workdir(workdir)
    if err:
        return json.dumps({"ok": False, "error": err})

    env = os.environ.copy()
    env.setdefault("OPENSPEC_TELEMETRY", "0")
    env.setdefault("NO_COLOR", "1")

    cmd = _cli_resolver.build_openspec_argv(exe, args)
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(cwd),
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=120,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return json.dumps({
            "ok": False,
            "command": cmd,
            "workdir": str(cwd),
            "error": "openspec command timed out after 120s",
        })
    except Exception as exc:
        return json.dumps({
            "ok": False,
            "command": cmd,
            "workdir": str(cwd),
            "error": str(exc),
        })

    stdout = proc.stdout[-MAX_OUTPUT_CHARS:]
    stderr = proc.stderr[-MAX_OUTPUT_CHARS:]
    return json.dumps({
        "ok": proc.returncode == 0,
        "exit_code": proc.returncode,
        "command": cmd,
        "workdir": str(cwd),
        "stdout": _json_or_text(stdout),
        "stderr": _json_or_text(stderr),
        "truncated": len(proc.stdout) > MAX_OUTPUT_CHARS or len(proc.stderr) > MAX_OUTPUT_CHARS,
    })


def _template_instruction_fallback(artifact: str, reason: str, workdir: Any = None, schema: str = "") -> str | None:
    """Return template-backed instructions when OpenSpec needs a change first."""
    if "No changes found" not in reason:
        return None
    artifact = _normalize_artifact(artifact)
    if not artifact:
        return None

    templates_args = ["templates", "--json"]
    if schema:
        templates_args.extend(["--schema", schema])
    templates_result = json.loads(_run(templates_args, workdir))
    if not templates_result.get("ok") or not isinstance(templates_result.get("stdout"), dict):
        return None

    entry = templates_result["stdout"].get(artifact)
    if not isinstance(entry, dict):
        return None
    path = Path(str(entry.get("path") or "")).expanduser()
    if not path.is_file():
        return None
    try:
        content = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None

    fallback = dict(templates_result)
    fallback["ok"] = True
    fallback["stdout"] = {
        "artifact": artifact,
        "fallback": "template",
        "reason": reason,
        "templatePath": str(path),
        "source": entry.get("source"),
        "content": content,
    }
    fallback["stderr"] = ""
    return json.dumps(fallback)


def _registry_module():
    """Import the plugin-local OpenSpec registry (package-relative, else top-level)."""
    try:
        from . import registry  # type: ignore
        return registry
    except ImportError:
        pass
    try:
        import registry  # type: ignore
        return registry
    except ImportError:
        return None


def _read_doc(path: Path) -> str:
    try:
        if path.is_file():
            return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        pass
    return ""


def _iter_change_dirs(root: Path):
    """Yield ``(change_dir, archived)`` for every change folder with a proposal."""
    changes_root = root / "openspec" / "changes"
    if changes_root.is_dir():
        for child in sorted(changes_root.iterdir()):
            if child.name == "archive":
                continue
            if child.is_dir() and (child / "proposal.md").is_file():
                yield child, False
        archive_root = changes_root / "archive"
        if archive_root.is_dir():
            for child in sorted(archive_root.iterdir()):
                if child.is_dir() and (child / "proposal.md").is_file():
                    yield child, True


def _iter_specs(root: Path):
    specs_root = root / "openspec" / "specs"
    if specs_root.is_dir():
        for child in sorted(specs_root.rglob("*.md")):
            if child.is_file():
                yield child.relative_to(specs_root).as_posix(), child


def _iter_ideas(root: Path):
    """Yield every ``.md`` idea file under ``openspec/ideas/`` (sorted)."""
    ideas_root = root / "openspec" / "ideas"
    if ideas_root.is_dir():
        for child in sorted(ideas_root.iterdir()):
            if child.is_file() and child.suffix.lower() == ".md":
                yield child


def _exploration_listing(records: list[dict]) -> list[dict]:
    return [
        {key: rec[key] for key in ("name", "filename", "scope", "token")} for rec in records
    ]


def _review_listing(records: list[dict]) -> list[dict]:
    return [
        {key: rec[key] for key in ("change", "name", "filename", "token", "verdict")}
        for rec in records
    ]


def _context_failure(resolved: dict, ref: str, name: str, repo_path: Path) -> dict:
    base = {"ok": False, "name": name, "path": str(repo_path), "error": resolved["error"]}
    if resolved["error"] == "ambiguous":
        base["candidates"] = resolved["candidates"]
        base["message"] = (
            f"Reference '{ref}' is ambiguous: it matches more than one artifact "
            "(change, spec, idea, exploration, review). Use a qualified ref from 'candidates'."
        )
    elif resolved["error"] == "invalid_ref":
        base["message"] = (
            f"Reference '{ref}' is not a valid artifact reference "
            "(token, kind:name, or a plain name without path separators)."
        )
    else:
        base["message"] = f"No change, spec, idea, exploration, or review matching '{ref}' under openspec/."
    return base


def openspec_context(args: dict, **kwargs) -> str:
    """Resolve a copyable identifier (``puzzletea`` or ``puzzletea/os_xxx``) into
    repo path + (optionally) the change's proposal/tasks/design/specs content."""
    registry = _registry_module()
    if registry is None:
        return json.dumps({
            "ok": False,
            "error": "OpenSpec registry unavailable (plugins.openspec.registry not importable).",
        })

    identifier = str(args.get("identifier") or "").strip()
    if not identifier:
        return json.dumps({"ok": False, "error": "identifier is required (e.g. 'puzzletea' or 'puzzletea/os_a1b2c3')"})

    source_ref, change_ref = registry.parse_identifier(identifier)
    # Resolve source by vanity name first, then fall back to a legacy source token.
    source = registry.get_source_by_name(source_ref) or registry.get_source(source_ref)
    if source is None:
        return json.dumps({"ok": False, "error": f"No registered OpenSpec source for '{source_ref}'."})

    name = registry.effective_name(source)
    repo_path = Path(source["path"]).expanduser()
    if not (repo_path / "openspec").is_dir():
        return json.dumps({
            "ok": False,
            "name": name,
            "path": str(repo_path),
            "error": f"openspec/ directory not found at {repo_path} (repo may have moved).",
        })

    result: dict[str, Any] = {
        "ok": True,
        "name": name,
        "path": str(repo_path),
        "workdir": str(repo_path),
        "hint": "Use this path as 'workdir' for other openspec_* tools, or run openspec commands from here.",
    }

    index = _artifacts_index.build_index(repo_path, registry.change_token)

    if change_ref:
        resolved = _artifacts_index.resolve_ref(index, change_ref)
        if not resolved["ok"]:
            return json.dumps(_context_failure(resolved, change_ref, name, repo_path))
        kind, record = resolved["kind"], resolved["record"]
        if kind == "idea":
            result["idea"] = {
                "name": record["name"],
                "filename": record["filename"],
                "token": record["token"],
                "content": _read_doc(Path(record["path"])),
            }
        elif kind == "spec":
            result["spec"] = {
                "path": record["rel"],
                "token": record["token"],
                "content": _read_doc(Path(record["path"])),
            }
        elif kind == "exploration":
            result["exploration"] = {
                key: record[key]
                for key in ("name", "filename", "scope", "token", "title", "date", "path")
            }
            result["exploration"]["content"] = _read_doc(Path(record["path"]))
        elif kind == "review":
            result["review"] = {
                key: record[key]
                for key in ("name", "filename", "change", "verdict", "round", "token", "path")
            }
            result["review"]["content"] = _read_doc(Path(record["path"]))
        else:
            change_dir = Path(record["path"])
            specs_root = change_dir / "specs"
            specs = []
            if specs_root.is_dir():
                for child in sorted(specs_root.rglob("*.md")):
                    specs.append({
                        "path": child.relative_to(specs_root).as_posix(),
                        "content": _read_doc(child),
                    })
            result["change"] = {
                "name": change_dir.name,
                "token": record["token"],
                "archived": record["archived"],
                "proposal": _read_doc(change_dir / "proposal.md"),
                "tasks": _read_doc(change_dir / "tasks.md"),
                "design": _read_doc(change_dir / "design.md"),
                "specs": specs,
            }
            result["explorations"] = _exploration_listing(
                [e for e in index["explorations"] if e["scope"] == f"change:{change_dir.name}"]
            )
            result["reviews"] = _review_listing(
                [r for r in index["reviews"] if r["change"] == change_dir.name]
            )
    else:
        change_dirs = [
            (Path(c["path"]), c["archived"]) for c in index["changes"] if not c["archived"]
        ]
        sequence = {}
        if hasattr(registry, "ensure_change_sequence"):
            sequence = registry.ensure_change_sequence(str(source.get("id") or source.get("token")), [change_dir.name for change_dir, _ in change_dirs])
        changes = [
            {
                "name": change_dir.name,
                "token": registry.change_token(change_dir.name),
                **({"sequence": sequence[change_dir.name]} if change_dir.name in sequence else {}),
            }
            for change_dir, archived in change_dirs
        ]
        result["changes"] = changes
        result["specs"] = [{"path": s_["rel"], "token": s_["token"]} for s_ in index["specs"]]
        result["ideas"] = [
            {"name": i["name"], "filename": i["filename"], "token": i["token"]} for i in index["ideas"]
        ]
        result["explorations"] = _exploration_listing(index["explorations"])
        result["reviews"] = _review_listing(index["reviews"])
        result["hint"] = (
            "Active changes are listed in 'changes'; current specs are listed in 'specs'; ideas are "
            "listed in 'ideas'; explorations and change reviews are listed in 'explorations' and "
            "'reviews'. Re-call with identifier "
            f"'{name}/<token>' (or a qualified ref such as 'exploration:<stem>@<change>' or "
            "'review:<stem>@<change>') to load one artifact, or use workdir with other "
            "openspec_* tools."
        )

    return json.dumps(result)


_SLUG_RE = re.compile(r"[^a-z0-9]+")
_VALID_CHANGE_RE = re.compile(r"^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$")
_ENRICHMENT_START = "<!-- OPENSPEC_IDEA_ENRICHMENT_START -->"
_ENRICHMENT_END = "<!-- OPENSPEC_IDEA_ENRICHMENT_END -->"
_VALID_FEASIBILITY = {"low", "medium", "high"}
_VALID_TSHIRT = {"xs", "s", "m", "l", "xl"}


def _error(message: str, **extra: Any) -> str:
    payload = {"ok": False, "error": message}
    payload.update(extra)
    return json.dumps(payload)


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _slugify(value: str, fallback: str = "idea") -> str:
    slug = _SLUG_RE.sub("-", value.strip().lower()).strip("-")
    return slug or fallback


def _resolve_project(args: dict) -> tuple[Path | None, str | None, dict[str, Any]]:
    """Resolve a tool call to a project root.

    Prefer explicit workdir. Also accept a registered OpenSpec identifier/source
    name so agents can call write tools with the same project handles used by
    ``openspec_context``.
    """
    workdir = args.get("workdir")
    if workdir:
        root, err = _resolve_workdir(workdir)
        return root, err, {}

    identifier = str(args.get("identifier") or args.get("project") or "").strip()
    if identifier:
        registry = _registry_module()
        if registry is None:
            return None, "OpenSpec registry unavailable (plugins.openspec.registry not importable).", {}
        source_ref, _artifact_ref = registry.parse_identifier(identifier)
        source = registry.get_source_by_name(source_ref) or registry.get_source(source_ref)
        if source is None:
            return None, f"No registered OpenSpec source for '{source_ref}'.", {}
        root = Path(source["path"]).expanduser()
        if not root.is_absolute():
            root = root.resolve()
        if not root.exists() or not root.is_dir():
            return None, f"registered source path does not exist or is not a directory: {root}", {}
        return root, None, {"source": source, "name": registry.effective_name(source)}

    root, err = _resolve_workdir(None)
    return root, err, {}


def _ensure_openspec_layout(root: Path) -> None:
    openspec_root = root / "openspec"
    (openspec_root / "changes" / "archive").mkdir(parents=True, exist_ok=True)
    (openspec_root / "specs").mkdir(parents=True, exist_ok=True)
    (openspec_root / "ideas").mkdir(parents=True, exist_ok=True)


def _unique_idea_path(ideas_root: Path, slug: str) -> tuple[str, Path]:
    candidate = ideas_root / f"{slug}.md"
    if not candidate.exists():
        return slug, candidate
    index = 2
    while True:
        suffixed = f"{slug}-{index}"
        candidate = ideas_root / f"{suffixed}.md"
        if not candidate.exists():
            return suffixed, candidate
        index += 1


def _coerce_string_list(value: Any) -> list[str]:
    if value is None or value == "":
        return []
    if isinstance(value, str):
        return [line.strip() for line in value.splitlines() if line.strip()]
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    return [str(value).strip()]


def _idea_path(root: Path, idea_ref: str) -> Path:
    slug = _slugify(idea_ref)
    return root / "openspec" / "ideas" / f"{slug}.md"


def _relative(path: Path, root: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.as_posix()


def _markdown_list(items: list[str]) -> str:
    if not items:
        return "- None"
    return "\n".join(f"- {item}" for item in items)


_TASK_LINE_RE = re.compile(r"^(?P<prefix>\s*- \[)(?P<mark>[ xX])(?P<suffix>\]\s*(?:(?P<id>\d+(?:\.\d+)*)\s+)?(?P<text>.*?))\s*$")


def _change_path(root: Path, change: str, *, archived: bool = False) -> Path:
    base = root / "openspec" / "changes"
    if archived:
        base = base / "archive"
    return base / change


def _resolve_change_path(root: Path, change_ref: str) -> tuple[Path | None, bool]:
    change = _slugify(change_ref, fallback="")
    if not change:
        return None, False
    active = _change_path(root, change)
    if active.is_dir():
        return active, False
    bare = _artifacts_index.strip_date_prefix(change)
    if bare and bare != change:
        active_bare = _change_path(root, bare)
        if active_bare.is_dir():
            return active_bare, False
    archived = _change_path(root, change, archived=True)
    if archived.is_dir():
        return archived, True
    archive_root = root / "openspec" / "changes" / "archive"
    if archive_root.is_dir():
        for child in sorted(archive_root.iterdir()):
            if child.is_dir() and (
                child.name == change or _artifacts_index.strip_date_prefix(child.name) in {change, bare}
            ):
                return child, True
    return None, False


def _resolve_change_names(root: Path, registry, refs: list[str]) -> tuple[list[str], list[str]]:
    names: list[str] = []
    missing: list[str] = []
    by_name = {change_dir.name: change_dir.name for change_dir, _ in _iter_change_dirs(root)}
    by_token = {registry.change_token(name): name for name in by_name}
    for ref in refs:
        raw = str(ref or "").strip()
        if not raw:
            continue
        name = by_name.get(raw) or by_token.get(raw)
        if name:
            if name not in names:
                names.append(name)
        else:
            missing.append(raw)
    return names, missing


def _derive_status(tasks_path: Path, *, archived: bool = False) -> str:
    if archived:
        return "archived"
    if not tasks_path.is_file():
        return "draft"
    tasks = _parse_tasks(tasks_path)
    if not tasks:
        return "draft"
    done = sum(1 for task in tasks if task["status"] == "done")
    if done == 0:
        return "todo"
    if done == len(tasks):
        return "done"
    return "in_progress"


def _parse_tasks(tasks_path: Path) -> list[dict[str, Any]]:
    if not tasks_path.is_file():
        return []
    tasks: list[dict[str, Any]] = []
    seq = 0
    for line_no, line in enumerate(tasks_path.read_text(encoding="utf-8", errors="replace").splitlines(), start=1):
        match = _TASK_LINE_RE.match(line)
        if not match:
            continue
        seq += 1
        task_id = match.group("id") or str(seq)
        tasks.append({
            "id": task_id,
            "text": match.group("text").strip(),
            "status": "done" if match.group("mark").lower() == "x" else "todo",
            "line": line_no,
        })
    return tasks


def _task_counts(tasks: list[dict[str, Any]]) -> dict[str, int]:
    done = sum(1 for task in tasks if task["status"] == "done")
    total = len(tasks)
    return {"total": total, "done": done, "todo": total - done}


def _format_tasks(items: list[str]) -> str:
    lines = ["## 1. Tasks", ""]
    for index, text in enumerate(items, start=1):
        lines.append(f"- [ ] 1.{index} {text}")
    lines.append("")
    return "\n".join(lines)


def _default_tasks() -> list[str]:
    return ["Refine scope", "Implement behavior", "Validate OpenSpec artifacts and tests"]


def _write_placeholder_spec(change_dir: Path, change: str, title: str, source: str = "change") -> Path:
    spec_dir = change_dir / "specs" / change
    spec_dir.mkdir(parents=True, exist_ok=True)
    spec_path = spec_dir / "spec.md"
    if spec_path.exists():
        return spec_path
    spec = f"""# {title}

## ADDED Requirements

### Requirement: {title} scope
The system SHALL implement the approved behavior described by this {source} after this placeholder is refined into concrete requirements.

#### Scenario: Placeholder refinement
- **GIVEN** `{change}` has been created as an OpenSpec change
- **WHEN** implementation begins
- **THEN** this placeholder requirement is replaced or refined with concrete, testable behavior before the change is completed
"""
    spec_path.write_text(spec, encoding="utf-8")
    return spec_path


def _write_change_scaffold(
    root: Path,
    change: str,
    title: str,
    summary: str,
    *,
    source_section: str = "",
    tasks: list[str] | None = None,
    with_spec: bool = False,
    force: bool = False,
) -> tuple[dict[str, Any] | None, str | None]:
    _ensure_openspec_layout(root)
    change_dir = _change_path(root, change)
    if change_dir.exists() and not force:
        return None, f"change already exists: {change}"
    change_dir.mkdir(parents=True, exist_ok=True)
    created = _now_iso()
    source_block = f"\n## Source\n\n{source_section}\n" if source_section else ""
    proposal = f"""## Why

{summary}

## What Changes

- Create the `{change}` OpenSpec change scaffold for review and refinement.

{source_block}## Capabilities

### New Capabilities
- `{change}`: Initial capability placeholder. Refine before implementation.

### Modified Capabilities
- None yet.

## Impact

- TBD: Fill in affected code, APIs, dependencies, or systems before implementation.
"""
    (change_dir / "proposal.md").write_text(proposal, encoding="utf-8")
    task_items = tasks or []
    if task_items:
        (change_dir / "tasks.md").write_text(_format_tasks(task_items), encoding="utf-8")
    spec_path = None
    if with_spec:
        spec_path = _write_placeholder_spec(change_dir, change, title)
    (change_dir / ".openspec.yaml").write_text(
        # OpenSpec >= 1.15 warns (and fails --strict) on unknown keys; x- keys are tool extensions (OPENSPEC-INV-1).
        "schema: spec-driven\nx-createdAt: " + json.dumps(created) + "\n",
        encoding="utf-8",
    )
    paths = {
        "proposal": str(change_dir / "proposal.md"),
        "metadata": str(change_dir / ".openspec.yaml"),
    }
    if task_items:
        paths["tasks"] = str(change_dir / "tasks.md")
    if spec_path:
        paths["spec"] = str(spec_path)
    return {
        "ok": True,
        "change": change,
        "change_path": str(change_dir),
        "relative_change_path": _relative(change_dir, root),
        "workdir": str(root),
        "status": _derive_status(change_dir / "tasks.md"),
        "paths": paths,
    }, None


def openspec_idea_create(args: dict, **kwargs) -> str:
    root, err, context = _resolve_project(args)
    if err or root is None:
        return _error(err or "workdir could not be resolved")

    title = str(args.get("title") or "").strip()
    prompt = str(args.get("prompt") or "").strip()
    if not title:
        return _error("title is required")
    if not prompt:
        return _error("prompt is required")

    origin = str(args.get("origin") or args.get("source") or "unspecified").strip() or "unspecified"
    notes = str(args.get("notes") or "").strip()
    tags = _coerce_string_list(args.get("tags"))

    _ensure_openspec_layout(root)
    ideas_root = root / "openspec" / "ideas"
    slug, path = _unique_idea_path(ideas_root, _slugify(str(args.get("slug") or title)))
    created = _now_iso()
    tags_text = ", ".join(tags) if tags else "None"

    sections = [
        f"# {title}",
        "",
        "## Source",
        f"- Origin: {origin}",
        f"- Created: {created}",
        f"- Tags: {tags_text}",
    ]
    if context.get("name"):
        sections.append(f"- Project: {context['name']}")
    sections.extend([
        "",
        "## Prompt",
        prompt,
    ])
    if notes:
        sections.extend(["", "## Notes", notes])
    sections.append("")

    path.write_text("\n".join(sections), encoding="utf-8")
    return json.dumps({
        "ok": True,
        "slug": slug,
        "title": title,
        "path": str(path),
        "relative_path": _relative(path, root),
        "workdir": str(root),
        "metadata": {"origin": origin, "created": created, "tags": tags},
    })


def openspec_idea_enrich(args: dict, **kwargs) -> str:
    root, err, _context = _resolve_project(args)
    if err or root is None:
        return _error(err or "workdir could not be resolved")
    idea = str(args.get("idea") or args.get("slug") or "").strip()
    if not idea:
        return _error("idea is required")

    path = _idea_path(root, idea)
    if not path.is_file():
        return _error(f"idea not found: {idea}")

    feasibility = str(args.get("feasibility") or "").strip()
    tshirt_size = str(args.get("tshirt_size") or args.get("t_shirt_size") or "").strip()
    if feasibility and feasibility.lower() not in _VALID_FEASIBILITY:
        return _error("feasibility must be one of: Low, Medium, High")
    if tshirt_size and tshirt_size.lower() not in _VALID_TSHIRT:
        return _error("tshirt_size must be one of: XS, S, M, L, XL")

    problem = str(args.get("problem") or "TBD").strip() or "TBD"
    proposed_direction = str(args.get("proposed_direction") or args.get("proposedDirection") or "TBD").strip() or "TBD"
    key_questions = _coerce_string_list(args.get("key_questions"))
    risks = _coerce_string_list(args.get("risks"))
    size_justification = str(args.get("size_justification") or "TBD").strip() or "TBD"
    suggested_next_step = str(args.get("suggested_next_step") or "TBD").strip() or "TBD"
    generated = _now_iso()

    report = "\n".join([
        _ENRICHMENT_START,
        "## Enrichment Report",
        "",
        f"Generated: {generated}",
        "",
        "### Problem",
        problem,
        "",
        "### Proposed Direction",
        proposed_direction,
        "",
        "### Key Questions",
        _markdown_list(key_questions),
        "",
        "### Feasibility",
        f"Feasibility: {feasibility or 'TBD'}",
        "",
        "### T-Shirt Size",
        f"T-Shirt Size: {tshirt_size or 'TBD'}",
        "",
        "### Size Justification",
        size_justification,
        "",
        "### Risks",
        _markdown_list(risks),
        "",
        "### Suggested Next Step",
        suggested_next_step,
        _ENRICHMENT_END,
        "",
    ])

    content = path.read_text(encoding="utf-8", errors="replace")
    if _ENRICHMENT_START in content and _ENRICHMENT_END in content:
        before, rest = content.split(_ENRICHMENT_START, 1)
        _old, after = rest.split(_ENRICHMENT_END, 1)
        content = before.rstrip() + "\n\n" + report + after.lstrip("\n")
    else:
        content = content.rstrip() + "\n\n" + report
    path.write_text(content, encoding="utf-8")

    return json.dumps({
        "ok": True,
        "idea": _slugify(idea),
        "path": str(path),
        "relative_path": _relative(path, root),
        "workdir": str(root),
        "metadata": {"generated": generated, "feasibility": feasibility, "tshirt_size": tshirt_size},
    })


def openspec_idea_promote(args: dict, **kwargs) -> str:
    root, err, _context = _resolve_project(args)
    if err or root is None:
        return _error(err or "workdir could not be resolved")
    idea = str(args.get("idea") or args.get("slug") or "").strip()
    change = _slugify(str(args.get("change") or args.get("change_id") or ""), fallback="")
    if not idea:
        return _error("idea is required")
    if not change or not _VALID_CHANGE_RE.match(change):
        return _error("change must be a kebab-case id")

    idea_path = _idea_path(root, idea)
    if not idea_path.is_file():
        return _error(f"idea not found: {idea}")

    _ensure_openspec_layout(root)
    change_dir = root / "openspec" / "changes" / change
    if change_dir.exists() and not args.get("force"):
        return _error(f"change already exists: {change}", change=change, change_path=str(change_dir))
    change_dir.mkdir(parents=True, exist_ok=True)

    idea_content = idea_path.read_text(encoding="utf-8", errors="replace")
    title = idea_content.splitlines()[0].lstrip("# ").strip() if idea_content.strip() else idea
    summary = str(args.get("summary") or f"Promote idea: {title}").strip()
    rel_idea = _relative(idea_path, root)
    created = _now_iso()

    proposal = f"""## Why

{summary}

## What Changes

- Promote the reviewed idea `{idea_path.stem}` into an implementation-ready OpenSpec change.
- Preserve traceability to the source idea while proposal, specs, design, and tasks are refined.

## Source Idea

- Path: `{rel_idea}`
- Promoted: {created}

### Idea Content

```md
{idea_content.rstrip()}
```

## Capabilities

### New Capabilities
- `{change}`: Initial capability placeholder created from the promoted idea. Refine before implementation.

### Modified Capabilities
- None yet.

## Impact

- TBD: Fill in affected code, APIs, dependencies, or systems before implementation.
"""
    tasks = """## 1. Proposal Refinement

- [ ] 1.1 Review the source idea and clarify scope.
- [ ] 1.2 Identify affected capabilities and write spec deltas.
- [ ] 1.3 Add design notes if implementation trade-offs are non-trivial.

## 2. Implementation

- [ ] 2.1 Implement the approved behavior.
- [ ] 2.2 Add or update tests.
- [ ] 2.3 Validate OpenSpec artifacts and test suite.
"""
    spec_dir = change_dir / "specs" / change
    spec_dir.mkdir(parents=True, exist_ok=True)
    spec = f"""# {title}

## ADDED Requirements

### Requirement: Promoted idea scope
The system SHALL implement the approved behavior described by the promoted idea after this placeholder is refined into concrete requirements.

#### Scenario: Placeholder refinement
- **GIVEN** the idea `{idea_path.stem}` has been promoted into this change
- **WHEN** implementation begins
- **THEN** this placeholder requirement is replaced or refined with concrete, testable behavior before the change is completed
"""
    (change_dir / "proposal.md").write_text(proposal, encoding="utf-8")
    (change_dir / "tasks.md").write_text(tasks, encoding="utf-8")
    (spec_dir / "spec.md").write_text(spec, encoding="utf-8")
    metadata = {
        "schema": "spec-driven",
        "sourceIdea": rel_idea,
        "promotedAt": created,
    }
    # OpenSpec >= 1.15 warns (and fails --strict) on unknown keys; x- keys are tool extensions (OPENSPEC-INV-1).
    (change_dir / ".openspec.yaml").write_text("schema: spec-driven\nx-sourceIdea: " + json.dumps(rel_idea) + "\nx-promotedAt: " + json.dumps(created) + "\n", encoding="utf-8")

    return json.dumps({
        "ok": True,
        "idea": idea_path.stem,
        "change": change,
        "change_path": str(change_dir),
        "relative_change_path": _relative(change_dir, root),
        "workdir": str(root),
        "paths": {
            "proposal": str(change_dir / "proposal.md"),
            "tasks": str(change_dir / "tasks.md"),
            "spec": str(spec_dir / "spec.md"),
            "metadata": str(change_dir / ".openspec.yaml"),
        },
        "metadata": metadata,
    })


def openspec_change_create(args: dict, **kwargs) -> str:
    root, err, _context = _resolve_project(args)
    if err or root is None:
        return _error(err or "workdir could not be resolved")
    change = _slugify(str(args.get("change") or args.get("change_id") or ""), fallback="")
    title = str(args.get("title") or change.replace("-", " ").title()).strip()
    summary = str(args.get("summary") or f"Create change: {title}").strip()
    if not change or not _VALID_CHANGE_RE.match(change):
        return _error("change must be a kebab-case id")
    tasks = _coerce_string_list(args.get("tasks"))
    result, error = _write_change_scaffold(
        root,
        change,
        title,
        summary,
        tasks=tasks,
        with_spec=bool(args.get("with_spec")) or bool(tasks),
        force=bool(args.get("force")),
    )
    if error:
        return _error(error, change=change, change_path=str(_change_path(root, change)))
    return json.dumps(result)


def openspec_change_promote(args: dict, **kwargs) -> str:
    root, err, _context = _resolve_project(args)
    if err or root is None:
        return _error(err or "workdir could not be resolved")
    change = _slugify(str(args.get("change") or args.get("change_id") or ""), fallback="")
    if not change:
        return _error("change is required")
    change_dir, archived = _resolve_change_path(root, change)
    if change_dir is None or archived:
        return _error(f"active change not found: {change}")
    tasks_path = change_dir / "tasks.md"
    if not tasks_path.exists() or bool(args.get("replace_tasks")):
        task_items = _coerce_string_list(args.get("tasks")) or _default_tasks()
        tasks_path.write_text(_format_tasks(task_items), encoding="utf-8")
    title = change.replace("-", " ").title()
    proposal = _read_doc(change_dir / "proposal.md")
    for line in proposal.splitlines():
        if line.startswith("# "):
            title = line.lstrip("# ").strip() or title
            break
    spec_path = _write_placeholder_spec(change_dir, change, title)
    tasks = _parse_tasks(tasks_path)
    return json.dumps({
        "ok": True,
        "change": change,
        "change_path": str(change_dir),
        "relative_change_path": _relative(change_dir, root),
        "workdir": str(root),
        "status": _derive_status(tasks_path),
        "counts": _task_counts(tasks),
        "paths": {"tasks": str(tasks_path), "spec": str(spec_path)},
    })


def openspec_change_sequence_set(args: dict, **kwargs) -> str:
    """Set dashboard-local order/dependency metadata for active changes."""
    root, err, context = _resolve_project(args)
    if err or root is None:
        return _error(err or "workdir could not be resolved")
    registry = _registry_module()
    if registry is None or not hasattr(registry, "set_change_sequence"):
        return _error("OpenSpec registry sequence support unavailable")
    source = context.get("source") if isinstance(context, dict) else None
    if source is None:
        source = registry.get_source_by_path(str(root))
    if source is None:
        return _error("sequence metadata requires a registered OpenSpec source; pass identifier/project or register the repo in the dashboard", workdir=str(root))
    raw_changes = _coerce_string_list(args.get("changes"))
    changes, missing = _resolve_change_names(root, registry, raw_changes)
    if missing:
        return _error("some changes were not found", missing=missing, workdir=str(root))
    if not changes:
        return _error("changes is required")
    raw_deps = args.get("dependencies") or args.get("depends_on") or {}
    if raw_deps is None:
        raw_deps = {}
    if not isinstance(raw_deps, dict):
        return _error("dependencies must be an object mapping change names/tokens to arrays of prerequisite change names/tokens")
    dependencies: dict[str, list[str]] = {}
    dep_missing: list[str] = []
    for raw_key, raw_values in raw_deps.items():
        key_names, key_missing = _resolve_change_names(root, registry, [str(raw_key)])
        dep_names, missing_deps = _resolve_change_names(root, registry, _coerce_string_list(raw_values))
        if key_missing:
            dep_missing.extend(key_missing)
            continue
        if missing_deps:
            dep_missing.extend(missing_deps)
        if key_names:
            dependencies[key_names[0]] = dep_names
    if dep_missing:
        return _error("some dependency changes were not found", missing=dep_missing, workdir=str(root))
    source_id = str(source.get("id") or source.get("token"))
    group_id = str(args.get("group_id") or args.get("groupId") or "default").strip() or "default"
    sequence = registry.set_change_sequence(source_id, changes, group_id=group_id, dependencies=dependencies)
    return json.dumps({
        "ok": True,
        "source": registry.effective_name(source),
        "source_id": source_id,
        "workdir": str(root),
        "groupId": group_id,
        "changes": [{"name": name, "token": registry.change_token(name), "sequence": sequence.get(name, {})} for name in changes],
        "note": "Sequence/dependency metadata is stored in the Hermes OpenSpec plugin DB, not in OpenSpec files.",
    })


def openspec_task_list(args: dict, **kwargs) -> str:
    root, err, _context = _resolve_project(args)
    if err or root is None:
        return _error(err or "workdir could not be resolved")
    change = _slugify(str(args.get("change") or args.get("change_id") or ""), fallback="")
    if not change:
        return _error("change is required")
    change_dir, archived = _resolve_change_path(root, change)
    if change_dir is None:
        return _error(f"change not found: {change}")
    tasks_path = change_dir / "tasks.md"
    tasks = _parse_tasks(tasks_path)
    if not tasks:
        return _error(f"tasks not found for change: {change}", change=change, tasks=[])
    return json.dumps({
        "ok": True,
        "change": change,
        "archived": archived,
        "path": str(tasks_path),
        "relative_path": _relative(tasks_path, root),
        "tasks": tasks,
        "counts": _task_counts(tasks),
        "status": _derive_status(tasks_path, archived=archived),
    })


def openspec_task_set_status(args: dict, **kwargs) -> str:
    root, err, _context = _resolve_project(args)
    if err or root is None:
        return _error(err or "workdir could not be resolved")
    change = _slugify(str(args.get("change") or args.get("change_id") or ""), fallback="")
    status = str(args.get("status") or "").strip().lower()
    if status in {"open", "todo", "pending"}:
        mark = " "
        normalized = "todo"
    elif status in {"done", "complete", "completed"}:
        mark = "x"
        normalized = "done"
    else:
        return _error("status must be 'todo' or 'done'")
    task_ids = set(_coerce_string_list(args.get("tasks") or args.get("task_ids")))
    if not task_ids:
        return _error("tasks is required")
    change_dir, archived = _resolve_change_path(root, change)
    if change_dir is None or archived:
        return _error(f"active change not found: {change}")
    tasks_path = change_dir / "tasks.md"
    if not tasks_path.is_file():
        return _error(f"tasks not found for change: {change}")
    lines = tasks_path.read_text(encoding="utf-8", errors="replace").splitlines()
    # Build a lookup of parsed tasks so we can match by numeric ID or text substring.
    parsed = _parse_tasks(tasks_path)
    # Resolve each requested task_id to actual line numbers.
    # Accept: numeric IDs (exact match), or text substrings (case-insensitive).
    target_lines: set[int] = set()
    not_found: list[str] = []
    for requested in task_ids:
        # Try exact numeric ID match first
        id_matches = [t for t in parsed if t["id"] == requested]
        if id_matches:
            for t in id_matches:
                target_lines.add(t["line"])
            continue
        # Try text substring match (case-insensitive)
        needle = requested.lower()
        text_matches = [t for t in parsed if needle in t["text"].lower()]
        if text_matches:
            for t in text_matches:
                target_lines.add(t["line"])
            continue
        not_found.append(requested)
    if not_found:
        return _error("task ids not found: " + ", ".join(not_found), missing=not_found)
    # Rewrite matching lines
    updated_lines = []
    matched_ids: set[str] = set()
    for line_no, line in enumerate(lines, start=1):
        if line_no in target_lines:
            match = _TASK_LINE_RE.match(line)
            if match:
                matched_ids.add(match.group("id") or str(line_no))
                line = f"{match.group('prefix')}{mark}{match.group('suffix')}"
        updated_lines.append(line)
    tasks_path.write_text("\n".join(updated_lines) + "\n", encoding="utf-8")
    tasks = _parse_tasks(tasks_path)
    return json.dumps({
        "ok": True,
        "change": change,
        "updated": sorted(matched_ids),
        "set_status": normalized,
        "path": str(tasks_path),
        "relative_path": _relative(tasks_path, root),
        "tasks": tasks,
        "counts": _task_counts(tasks),
        "status": _derive_status(tasks_path),
    })


_REQ_HEADER_RE = re.compile(r"^###\s+Requirement:\s*(.+?)\s*$")
_SCENARIO_HEADER_RE = re.compile(r"^####\s+Scenario:\s*(.+?)\s*$")
_SCENARIO_TAG_RE = re.compile(r"\((?:MODIFIED|ADDED|REMOVED|RENAMED)\)", re.IGNORECASE)
_DELTA_SECTION_RE = re.compile(r"^##\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements\b", re.IGNORECASE)
_X_EXPLORATION_RE = re.compile(r"^\s*x-exploration\s*:\s*(.+?)\s*$", re.MULTILINE)
_X_CREATED_AT_RE = re.compile(r"^\s*x-createdAt\s*:\s*[\"']?(\d{4}-\d{2}-\d{2})", re.MULTILINE)
_RAW_ARCHIVE_BLOCK_MESSAGE = (
    "Raw openspec archive is forbidden; use openspec_change_archive after Commander approval."
)


def _extract_required_delta_headers(text: str) -> list[str]:
    headers: list[str] = []
    section = "ADDED"
    for line in text.splitlines():
        sec_match = _DELTA_SECTION_RE.match(line.strip())
        if sec_match:
            section = sec_match.group(1).upper()
            continue
        if section in ("REMOVED", "RENAMED"):
            continue
        req_match = _REQ_HEADER_RE.match(line.strip())
        if req_match:
            title = req_match.group(1).strip()
            if title and title not in headers:
                headers.append(title)
    return headers


def _parse_requirement_blocks(md_text: str, *, is_delta: bool = False) -> dict[str, Any]:
    """Parse markdown into title, purpose, and sectioned requirement blocks."""
    lines = md_text.splitlines()
    title = ""
    purpose_lines: list[str] = []
    mode = "header"
    current_section = "ADDED" if is_delta else "CANONICAL"
    blocks: list[dict[str, Any]] = []
    current_block: dict[str, Any] | None = None

    def _flush():
        nonlocal current_block
        if current_block is not None:
            raw_lines = list(current_block["lines"])
            while raw_lines and raw_lines[-1].strip() in ("", "---"):
                raw_lines.pop()
            current_block["lines"] = raw_lines
            blocks.append(current_block)
            current_block = None

    for line in lines:
        stripped = line.strip()
        if stripped.startswith("# ") and not stripped.startswith("## "):
            if not title:
                title = stripped[2:].strip()
            continue
        if stripped.lower().startswith("## purpose"):
            _flush()
            mode = "purpose"
            continue
        sec_m = _DELTA_SECTION_RE.match(stripped)
        if sec_m:
            _flush()
            current_section = sec_m.group(1).upper()
            mode = "reqs"
            continue
        if stripped.lower().startswith("## requirements"):
            _flush()
            current_section = "CANONICAL"
            mode = "reqs"
            continue
        req_m = _REQ_HEADER_RE.match(stripped)
        if req_m:
            _flush()
            mode = "reqs"
            current_block = {
                "name": req_m.group(1).strip(),
                "section": current_section,
                "lines": [f"### Requirement: {req_m.group(1).strip()}"],
                "scenarios": [],
                "has_scenario_tags": False,
            }
            continue
        if mode == "purpose":
            purpose_lines.append(line)
        elif current_block is not None:
            scn_m = _SCENARIO_HEADER_RE.match(stripped)
            if scn_m:
                scn_name = scn_m.group(1).strip()
                current_block["scenarios"].append(scn_name)
                if _SCENARIO_TAG_RE.search(scn_name):
                    current_block["has_scenario_tags"] = True
            current_block["lines"].append(line)

    _flush()
    while purpose_lines and not purpose_lines[0].strip():
        purpose_lines.pop(0)
    while purpose_lines and not purpose_lines[-1].strip():
        purpose_lines.pop()
    return {
        "title": title,
        "purpose": "\n".join(purpose_lines),
        "blocks": blocks,
    }


def openspec_sync_specs(args: dict, **kwargs) -> str:
    """Deterministically merge delta specs from changes/<change>/specs/ into openspec/specs/."""
    root, err, _context = _resolve_project(args)
    if err or root is None:
        return _error(err or "workdir could not be resolved")
    change = _slugify(str(args.get("change") or args.get("change_id") or ""), fallback="")
    if not change:
        return _error("change is required")
    dry_run = bool(args.get("dry_run"))
    change_dir, archived = _resolve_change_path(root, change)
    if change_dir is None or archived:
        return _error(f"active change not found: {change}")
    specs_dir = change_dir / "specs"
    if not specs_dir.is_dir():
        return json.dumps({
            "ok": True,
            "change": change,
            "dry_run": dry_run,
            "synced_specs": [],
            "workdir": str(root),
        })

    delta_files = [p for p in sorted(specs_dir.rglob("*.md")) if p.is_file()]
    merge_plan: list[tuple[str, Path, str, dict[str, int]]] = []

    for delta_file in delta_files:
        delta_text = delta_file.read_text(encoding="utf-8", errors="replace")
        if "#### Scenario: Placeholder refinement" in delta_text:
            continue
        rel = delta_file.relative_to(specs_dir).as_posix()
        canonical_file = root / "openspec" / "specs" / rel
        delta_parsed = _parse_requirement_blocks(delta_text, is_delta=True)
        if not delta_parsed["blocks"]:
            continue

        if canonical_file.is_file():
            canon_text = canonical_file.read_text(encoding="utf-8", errors="replace")
            canon_parsed = _parse_requirement_blocks(canon_text, is_delta=False)
        else:
            canon_parsed = {"title": "", "purpose": "", "blocks": []}

        canon_by_name: dict[str, dict[str, Any]] = {
            b["name"]: b for b in canon_parsed["blocks"]
        }
        ordered_names: list[str] = [b["name"] for b in canon_parsed["blocks"]]

        # Pre-Merge Safety Gate: check MODIFIED scenario counts
        for dblock in delta_parsed["blocks"]:
            if dblock["section"] != "MODIFIED":
                continue
            existing = canon_by_name.get(dblock["name"])
            if existing is None:
                continue
            n_canon = len(existing["scenarios"])
            n_delta = len(dblock["scenarios"])
            if n_delta < n_canon and not dblock["has_scenario_tags"]:
                return _error(
                    f"⛔ UNSAFE MERGE BLOCKED: {rel} requirement '{dblock['name']}' has {n_canon} scenarios, "
                    f"but delta has {n_delta} without tags. Fix: Add (MODIFIED) tag to scenario headers.",
                    change=change,
                    spec=rel,
                    requirement=dblock["name"],
                    canonical_scenarios=n_canon,
                    delta_scenarios=n_delta,
                )

        counts = {"added": 0, "modified": 0, "removed": 0}
        for dblock in delta_parsed["blocks"]:
            sec = dblock["section"]
            rname = dblock["name"]
            cleaned_lines = [
                _SCENARIO_TAG_RE.sub("", ln).rstrip() if _SCENARIO_HEADER_RE.match(ln.strip()) else ln
                for ln in dblock["lines"]
            ]
            if sec == "REMOVED":
                if rname in canon_by_name:
                    del canon_by_name[rname]
                    ordered_names = [n for n in ordered_names if n != rname]
                    counts["removed"] += 1
            elif sec in ("ADDED", "MODIFIED"):
                new_entry = {
                    "name": rname,
                    "section": "CANONICAL",
                    "lines": cleaned_lines,
                    "scenarios": list(dblock["scenarios"]),
                    "has_scenario_tags": False,
                }
                if rname in canon_by_name:
                    canon_by_name[rname] = new_entry
                    if sec == "MODIFIED":
                        counts["modified"] += 1
                    else:
                        counts["added"] += 1
                else:
                    canon_by_name[rname] = new_entry
                    ordered_names.append(rname)
                    if sec == "MODIFIED":
                        counts["modified"] += 1
                    else:
                        counts["added"] += 1

        raw_title = canon_parsed["title"] or delta_parsed["title"] or Path(rel).parent.name.replace("-", " ").title()
        if raw_title.lower().startswith("spec delta:"):
            raw_title = raw_title.split(":", 1)[1].strip()
        if not raw_title.lower().endswith("specification"):
            header_title = f"# {raw_title} Specification"
        else:
            header_title = f"# {raw_title}"

        purpose_text = canon_parsed["purpose"] or delta_parsed["purpose"]
        out_parts = [header_title, ""]
        if purpose_text:
            out_parts.extend(["## Purpose", "", purpose_text, ""])
        out_parts.extend(["## Requirements", ""])
        for idx, rname in enumerate(ordered_names):
            blk = canon_by_name[rname]
            out_parts.extend(blk["lines"])
            out_parts.append("")
        rendered = "\n".join(out_parts).rstrip() + "\n"
        merge_plan.append((rel, canonical_file, rendered, counts))

    synced_specs: list[dict[str, Any]] = []
    for rel, canonical_file, rendered, counts in merge_plan:
        if not dry_run:
            canonical_file.parent.mkdir(parents=True, exist_ok=True)
            canonical_file.write_text(rendered, encoding="utf-8")
        synced_specs.append({
            "spec": rel,
            "path": _relative(canonical_file, root),
            "counts": counts,
        })

    return json.dumps({
        "ok": True,
        "change": change,
        "dry_run": dry_run,
        "synced_specs": synced_specs,
        "workdir": str(root),
    })


def _check_delta_specs_synced(root: Path, change_dir: Path) -> list[dict[str, Any]]:
    specs_dir = change_dir / "specs"
    if not specs_dir.is_dir():
        return []
    unsynced: list[dict[str, Any]] = []
    for delta_file in sorted(specs_dir.rglob("*.md")):
        if not delta_file.is_file():
            continue
        delta_text = delta_file.read_text(encoding="utf-8", errors="replace")
        if "#### Scenario: Placeholder refinement" in delta_text:
            continue
        required = _extract_required_delta_headers(delta_text)
        removed: list[str] = []
        sec = "ADDED"
        for line in delta_text.splitlines():
            sm = _DELTA_SECTION_RE.match(line.strip())
            if sm:
                sec = sm.group(1).upper()
                continue
            if sec == "REMOVED":
                rm = _REQ_HEADER_RE.match(line.strip())
                if rm and rm.group(1).strip() not in removed:
                    removed.append(rm.group(1).strip())
        if not required and not removed:
            continue
        rel = delta_file.relative_to(specs_dir).as_posix()
        canonical_file = root / "openspec" / "specs" / rel
        if not canonical_file.is_file():
            if required:
                unsynced.append({"spec": rel, "missing_requirements": required})
            continue
        canonical_titles = {
            m.group(1).strip()
            for line in canonical_file.read_text(encoding="utf-8", errors="replace").splitlines()
            if (m := _REQ_HEADER_RE.match(line.strip()))
        }
        missing = [req for req in required if req not in canonical_titles]
        still_present = [req for req in removed if req in canonical_titles]
        if missing or still_present:
            entry: dict[str, Any] = {"spec": rel, "missing_requirements": missing}
            if still_present:
                entry["unremoved_requirements"] = still_present
            unsynced.append(entry)
    return unsynced


def _package_change_explorations(root: Path, change_dir: Path, change: str) -> list[str]:
    ws_exp_dir = root / "openspec" / "workspace" / "explorations"
    candidates: list[str] = []
    meta_path = change_dir / ".openspec.yaml"
    if meta_path.is_file():
        meta_text = meta_path.read_text(encoding="utf-8", errors="replace")
        for m in _X_EXPLORATION_RE.finditer(meta_text):
            raw = m.group(1).strip().strip("\"'").replace("\\", "/")
            fname = Path(raw).name
            if fname.endswith(".md") and fname not in candidates:
                candidates.append(fname)
    proposal_path = change_dir / "proposal.md"
    if proposal_path.is_file():
        refs = _artifacts_index.extract_openspec_refs(proposal_path.read_text(encoding="utf-8", errors="replace"))
        for scope, fname in sorted(refs.get("explorations", set())):
            if scope == "workspace" and fname not in candidates:
                candidates.append(fname)
    if ws_exp_dir.is_dir():
        bare = _artifacts_index.strip_date_prefix(change)
        for p in sorted(ws_exp_dir.iterdir()):
            if p.is_file() and p.suffix.lower() == ".md":
                if (change in p.stem or (bare and bare in p.stem)) and p.name not in candidates:
                    candidates.append(p.name)
    packaged: list[str] = []
    target_dir = change_dir / "explorations"
    if ws_exp_dir.is_dir():
        for fname in candidates:
            src = ws_exp_dir / fname
            dst = target_dir / fname
            if src.is_file() and not dst.is_file():
                target_dir.mkdir(parents=True, exist_ok=True)
                shutil.copy2(str(src), str(dst))
                packaged.append(fname)
    return packaged


def _resolve_archive_folder_name(change_dir: Path, change: str) -> str:
    if _artifacts_index._DATE_PREFIX_RE.match(change):
        return change
    meta_path = change_dir / ".openspec.yaml"
    if meta_path.is_file():
        m = _X_CREATED_AT_RE.search(meta_path.read_text(encoding="utf-8", errors="replace"))
        if m:
            return f"{m.group(1)}-{change}"
    for exp_file in _artifacts_index._md_files(change_dir / "explorations"):
        dm = _artifacts_index._DATE_RE.match(exp_file.stem)
        if dm:
            return f"{dm.group(1)}-{change}"
    today = datetime.now(timezone.utc).date().isoformat()
    return f"{today}-{change}"


def _archive_linked_kanban_cards(root: Path, change: str) -> list[str]:
    import sqlite3

    bare = _artifacts_index.strip_date_prefix(change)
    target_names = {change, bare} - {""}
    registry = _registry_module()
    target_tokens: set[str] = set()
    if registry is not None and hasattr(registry, "change_token"):
        for nm in target_names:
            try:
                target_tokens.add(str(registry.change_token(nm)).lower())
            except Exception:
                pass

    db_paths: list[Path] = []
    for candidate_home in [
        Path(os.environ["HERMES_HOME"]) if os.environ.get("HERMES_HOME") else None,
        root,
    ]:
        if candidate_home is None or not candidate_home.is_dir():
            continue
        if (candidate_home / "kanban.db").is_file():
            db_paths.append(candidate_home / "kanban.db")
        boards_dir = candidate_home / "kanban" / "boards"
        if boards_dir.is_dir():
            for board in sorted(boards_dir.iterdir()):
                if board.is_dir() and (board / "kanban.db").is_file():
                    db_paths.append(board / "kanban.db")

    archived_ids: list[str] = []
    seen_dbs: set[str] = set()
    for db_path in db_paths:
        resolved = str(db_path.resolve())
        if resolved in seen_dbs:
            continue
        seen_dbs.add(resolved)
        try:
            conn = sqlite3.connect(str(db_path), timeout=5.0)
            with conn:
                rows = conn.execute(
                    "SELECT id, title, status, body FROM tasks WHERE status = 'done'"
                ).fetchall()
                to_archive: list[str] = []
                for row_id, title, _status, body in rows:
                    refs = _artifacts_index.extract_openspec_refs(f"{title or ''}\n{body or ''}")
                    if (refs["changes"] & target_names) or (
                        target_tokens and ({t.lower() for t in refs["tokens"]} & target_tokens)
                    ):
                        to_archive.append(str(row_id))
                for card_id in to_archive:
                    conn.execute("UPDATE tasks SET status = 'archived' WHERE id = ?", (card_id,))
                    if card_id not in archived_ids:
                        archived_ids.append(card_id)
            conn.close()
        except Exception:
            continue
    return archived_ids


def openspec_change_archive(args: dict, **kwargs) -> str:
    root, err, _context = _resolve_project(args)
    if err or root is None:
        return _error(err or "workdir could not be resolved")
    if args.get("force"):
        return _error(
            "force bypass is forbidden on openspec_change_archive; task, review, exploration, and spec-sync gates are non-bypassable."
        )
    change = _slugify(str(args.get("change") or args.get("change_id") or ""), fallback="")
    if not change:
        return _error("change is required")
    change_dir = _change_path(root, change)
    if not change_dir.is_dir():
        return _error(f"active change not found: {change}")
    tasks_path = change_dir / "tasks.md"
    status = _derive_status(tasks_path)
    if status != "done":
        return _error(f"change is not complete: {change}", status=status)

    unsynced = _check_delta_specs_synced(root, change_dir)
    if unsynced:
        return _error(
            f"delta specs not synced to canonical specs for change: {change}. Run openspec_sync_specs first.",
            change=change,
            unsynced_specs=unsynced,
        )

    packaged = _package_change_explorations(root, change_dir, change)
    # If no exploration file exists yet in change_dir/explorations and no workspace exploration
    # was pending for this change, synthesize a minimal packaged exploration receipt so legacy
    # changes without workspace explorations remain archivable once reviews + specs + tasks pass.
    ws_exp_dir = root / "openspec" / "workspace" / "explorations"
    has_unawaited_ws_exp = False
    if ws_exp_dir.is_dir():
        bare = _artifacts_index.strip_date_prefix(change)
        has_unawaited_ws_exp = any(
            p.is_file() and p.suffix.lower() == ".md" and (change in p.stem or (bare and bare in p.stem))
            for p in ws_exp_dir.iterdir()
        )
    if not _artifacts_index._md_files(change_dir / "explorations") and not has_unawaited_ws_exp:
        meta_path = change_dir / ".openspec.yaml"
        has_x_exp = bool(
            meta_path.is_file()
            and _X_EXPLORATION_RE.search(meta_path.read_text(encoding="utf-8", errors="replace"))
        )
        if not has_x_exp:
            exp_dir = change_dir / "explorations"
            exp_dir.mkdir(parents=True, exist_ok=True)
            auto_exp = exp_dir / f"{change}-exploration.md"
            proposal_txt = _read_doc(change_dir / "proposal.md") or f"# {change}\n"
            auto_exp.write_text(proposal_txt, encoding="utf-8")
            packaged.append(auto_exp.name)

    gate_res = _artifacts_index.evaluate_change_gate(root, change, "archive")
    if not gate_res["allowed"] or gate_res["latest_verdict"] != "APPROVED":
        return _error(
            f"cannot archive change '{change}': archive gate failed "
            f"(latest_verdict={gate_res['latest_verdict']}, missing={gate_res['missing']})",
            change=change,
            gate=gate_res,
        )

    archive_folder_name = _resolve_archive_folder_name(change_dir, change)
    archive_dir = _change_path(root, archive_folder_name, archived=True)
    archive_dir.parent.mkdir(parents=True, exist_ok=True)
    if archive_dir.exists():
        return _error(f"archived change already exists: {archive_folder_name}", change=change)

    shutil.move(str(change_dir), str(archive_dir))
    archived_cards = _archive_linked_kanban_cards(root, change)
    date_prefix = archive_folder_name[:10]
    post_archive_obligations = {
        "post_archive_sync_required": True,
        "audit_report_path": f"openspec/workspace/audits/{date_prefix}/{change}-audit.md",
        "archived_kanban_cards": archived_cards,
        "architecture_doc_check": "docs/architecture.md",
    }
    return json.dumps({
        "ok": True,
        "change": change,
        "archive_name": archive_folder_name,
        "status": "archived",
        "archived_path": str(archive_dir),
        "relative_archived_path": _relative(archive_dir, root),
        "packaged_explorations": packaged,
        "archived_kanban_cards": archived_cards,
        "post_archive_obligations": post_archive_obligations,
        "workdir": str(root),
    })


def openspec_change_unarchive(args: dict, **kwargs) -> str:
    root, err, _context = _resolve_project(args)
    if err or root is None:
        return _error(err or "workdir could not be resolved")
    change = _slugify(str(args.get("change") or args.get("change_id") or ""), fallback="")
    if not change:
        return _error("change is required")
    bare = _artifacts_index.strip_date_prefix(change)
    archive_dir = _change_path(root, change, archived=True)
    if not archive_dir.is_dir():
        archive_root = root / "openspec" / "changes" / "archive"
        if archive_root.is_dir():
            for child in sorted(archive_root.iterdir()):
                if child.is_dir() and (
                    child.name == change or _artifacts_index.strip_date_prefix(child.name) in {change, bare}
                ):
                    archive_dir = child
                    break
    active_dir = _change_path(root, bare or change)
    if not archive_dir.is_dir():
        return _error(f"archived change not found: {change}")
    if active_dir.exists() and not args.get("force"):
        return _error(f"active change already exists: {bare or change}")
    if active_dir.exists():
        shutil.rmtree(active_dir)
    shutil.move(str(archive_dir), str(active_dir))
    status = _derive_status(active_dir / "tasks.md")
    return json.dumps({
        "ok": True,
        "change": change,
        "status": status,
        "change_path": str(active_dir),
        "relative_change_path": _relative(active_dir, root),
        "workdir": str(root),
    })


def openspec_list(args: dict, **kwargs) -> str:
    cmd = ["list", "--json"]
    kind = str(args.get("kind") or "changes").strip().lower()
    if kind == "specs":
        cmd.append("--specs")
    else:
        cmd.append("--changes")
    sort = str(args.get("sort") or "").strip().lower()
    if sort in {"recent", "name"}:
        cmd.extend(["--sort", sort])
    return _run(cmd, args.get("workdir"))


def openspec_show(args: dict, **kwargs) -> str:
    name = str(args.get("name") or "").strip()
    if not name:
        return json.dumps({"ok": False, "error": "name is required"})
    cmd = ["show", name, "--json", "--no-interactive"]
    item_type = str(args.get("type") or "").strip().lower()
    if item_type in {"change", "spec"}:
        cmd.extend(["--type", item_type])
    if args.get("deltas_only"):
        cmd.append("--deltas-only")
    if args.get("requirements_only"):
        cmd.append("--requirements")
    if args.get("no_scenarios"):
        cmd.append("--no-scenarios")
    requirement = str(args.get("requirement") or "").strip()
    if requirement:
        cmd.extend(["--requirement", requirement])
    return _run(cmd, args.get("workdir"))


def openspec_validate(args: dict, **kwargs) -> str:
    cmd = ["validate", "--json", "--no-interactive"]
    if args.get("strict", True):
        cmd.append("--strict")
    scope = str(args.get("scope") or "").strip().lower()
    target = str(args.get("target") or "").strip()
    if scope == "all" or (not target and not scope):
        cmd.append("--all")
    elif scope == "changes":
        cmd.append("--changes")
    elif scope == "specs":
        cmd.append("--specs")
    elif target:
        cmd.append(target)
    else:
        return json.dumps({"ok": False, "error": "target is required when scope='target'"})
    item_type = str(args.get("type") or "").strip().lower()
    if item_type in {"change", "spec"}:
        cmd.extend(["--type", item_type])
    return _run(cmd, args.get("workdir"))


def openspec_status(args: dict, **kwargs) -> str:
    change = str(args.get("change") or "").strip()
    if not change:
        return json.dumps({"ok": False, "error": "change is required"})
    cmd = ["status", "--change", change, "--json"]
    schema = str(args.get("schema") or "").strip()
    if schema:
        cmd.extend(["--schema", schema])
    return _run(cmd, args.get("workdir"))


def openspec_instructions(args: dict, **kwargs) -> str:
    cmd = ["instructions", "--json"]
    artifact = _normalize_artifact(str(args.get("artifact") or ""))
    if artifact:
        cmd.append(artifact)
    change = str(args.get("change") or "").strip()
    if change:
        cmd.extend(["--change", change])
    schema = str(args.get("schema") or "").strip()
    if schema:
        cmd.extend(["--schema", schema])

    result = _run(cmd, args.get("workdir"))
    parsed = json.loads(result)
    if parsed.get("ok"):
        return result
    reason = "\n".join(str(parsed.get(key) or "") for key in ("stderr", "stdout", "error"))
    fallback = _template_instruction_fallback(artifact, reason, args.get("workdir"), schema)
    return fallback or result


def openspec_spec_diff(args: dict, **kwargs) -> str:
    """Compare a change's delta spec against its baseline, or a worktree spec
    against its HEAD version, and return the structured semantic delta plus a
    unified line diff fallback.

    Filesystem-backed — does not require the OpenSpec CLI binary.
    """
    root, err, _context = _resolve_project(args)
    if err or root is None:
        return _error(err or "workdir could not be resolved")

    spec = str(args.get("spec") or "").strip()
    if not spec:
        return _error("spec is required (e.g. 'agent-tools')")

    # Prevent path traversal
    if spec.startswith("/") or ".." in Path(spec).parts:
        return _error("spec must be a relative path without parent references")

    change = str(args.get("change") or "").strip()

    try:
        from . import spec_parser  # type: ignore
    except ImportError:
        import spec_parser  # type: ignore

    if change:
        # Diff change spec vs baseline
        change_spec_path = root / "openspec" / "changes" / change / "specs" / f"{spec}" / "spec.md"
        # Also handle nested paths like "agent-tools/spec.md"
        if not change_spec_path.is_file():
            change_spec_path = root / "openspec" / "changes" / change / "specs" / f"{spec}.md"
        if not change_spec_path.is_file():
            return _error(
                f"change spec not found: openspec/changes/{change}/specs/{spec}/spec.md",
                change=change,
                spec=spec,
            )

        after_md = _read_doc(change_spec_path)
        baseline_path = root / "openspec" / "specs" / spec / "spec.md"
        if not baseline_path.is_file():
            baseline_path = root / "openspec" / "specs" / f"{spec}.md"

        before_md = _read_doc(baseline_path) if baseline_path.is_file() else None
        baseline_exists = before_md is not None
    else:
        # Diff worktree spec vs HEAD
        worktree_path = root / "openspec" / "specs" / spec / "spec.md"
        if not worktree_path.is_file():
            worktree_path = root / "openspec" / "specs" / f"{spec}.md"
        if not worktree_path.is_file():
            return _error(
                f"spec not found: openspec/specs/{spec}/spec.md",
                spec=spec,
            )

        after_md = _read_doc(worktree_path)
        before_md = _git_show_spec(root, spec)
        if before_md is None:
            return _error(
                "git is required for worktree-vs-HEAD comparison and the spec "
                "has no git history (it may be untracked). Pass 'change' to "
                "diff against a change's delta spec instead.",
                spec=spec,
            )
        baseline_exists = True

    diff = spec_parser.semantic_spec_diff(before_md, after_md)
    line_diff = spec_parser.unified_diff(before_md, after_md, spec)

    return json.dumps({
        "ok": True,
        "spec": spec,
        "change": change or None,
        "status": diff["status"],
        "baseline_exists": baseline_exists,
        "requirements": diff["requirements"],
        "line_diff": line_diff,
        "workdir": str(root),
    })


def _git_show_spec(root: Path, spec_path: str) -> str | None:
    """Return the HEAD version of a spec via git, or None if unavailable."""
    try:
        proc = subprocess.run(
            ["git", "-C", str(root), "show", f"HEAD:openspec/specs/{spec_path}/spec.md"],
            capture_output=True,
            text=True,
            timeout=8,
            check=False,
        )
    except Exception:
        return None
    if proc.returncode != 0:
        # Try flat path
        try:
            proc = subprocess.run(
                ["git", "-C", str(root), "show", f"HEAD:openspec/specs/{spec_path}.md"],
                capture_output=True,
                text=True,
                timeout=8,
                check=False,
            )
        except Exception:
            return None
        if proc.returncode != 0:
            return None
    return proc.stdout


def _spec_target_path(root: Path, spec: str, change: str) -> Path:
    """Resolve the spec.md path for a given spec name and optional change scope."""
    if change:
        base = root / "openspec" / "changes" / change / "specs"
    else:
        base = root / "openspec" / "specs"
    return base / spec / "spec.md"


def _spec_dir_from_path(spec_path: Path) -> str:
    """Extract the spec directory name from a spec.md path."""
    return spec_path.parent.name


def _list_specs_in_dir(specs_root: Path) -> list[str]:
    """List spec names (directory names containing spec.md) under a specs root."""
    if not specs_root.is_dir():
        return []
    names: list[str] = []
    for child in sorted(specs_root.iterdir()):
        if child.is_dir() and (child / "spec.md").is_file():
            names.append(child.name)
        elif child.is_file() and child.suffix == ".md" and child.name != "spec.md":
            # Flat .md files at the root level
            names.append(child.stem)
    return names


def openspec_spec_create(args: dict, **kwargs) -> str:
    """Create a spec from structured input and write a formatted spec.md.

    Filesystem-backed — does not require the OpenSpec CLI binary.
    """
    root, err, _context = _resolve_project(args)
    if err or root is None:
        return _error(err or "workdir could not be resolved")

    spec = str(args.get("spec") or "").strip()
    if not spec:
        return _error("spec is required (e.g. 'agent-tools')")

    # Validate slug: kebab-case, no path traversal
    if not _VALID_CHANGE_RE.match(spec) or ".." in Path(spec).parts or spec.startswith("/"):
        return _error(f"spec must be kebab-case (letters, numbers, hyphens): {spec}")

    title = str(args.get("title") or "").strip()
    if not title:
        return _error("title is required")

    purpose = str(args.get("purpose") or "").strip()
    if not purpose:
        return _error("purpose is required")

    requirements = args.get("requirements")
    if not isinstance(requirements, list) or not requirements:
        return _error("requirements must be a non-empty array")

    change = str(args.get("change") or "").strip()
    if change and not _VALID_CHANGE_RE.match(change):
        return _error(f"change must be kebab-case: {change}")

    force = bool(args.get("force"))

    spec_path = _spec_target_path(root, spec, change)

    if spec_path.exists() and not force:
        rel = _relative(spec_path, root)
        return _error(
            f"spec already exists at {rel}. Pass force=true to overwrite.",
            spec=spec,
            change=change or None,
            path=rel,
        )

    try:
        from . import spec_parser  # type: ignore
    except ImportError:
        import spec_parser  # type: ignore

    md = spec_parser.spec_to_markdown(title, purpose, requirements)

    spec_path.parent.mkdir(parents=True, exist_ok=True)
    spec_path.write_text(md, encoding="utf-8")

    return json.dumps({
        "ok": True,
        "spec": spec,
        "change": change or None,
        "path": _relative(spec_path, root),
        "absolute_path": str(spec_path),
        "workdir": str(root),
    })


def openspec_spec_show(args: dict, **kwargs) -> str:
    """Read a spec as structured JSON using parse_spec.

    Filesystem-backed — does not require the OpenSpec CLI binary.
    """
    root, err, _context = _resolve_project(args)
    if err or root is None:
        return _error(err or "workdir could not be resolved")

    spec = str(args.get("spec") or "").strip()
    if not spec:
        return _error("spec is required (e.g. 'agent-tools')")

    if spec.startswith("/") or ".." in Path(spec).parts:
        return _error("spec must be a relative path without parent references")

    change = str(args.get("change") or "").strip()

    spec_path = _spec_target_path(root, spec, change)
    if not spec_path.is_file():
        # Try flat .md path
        if change:
            flat = root / "openspec" / "changes" / change / "specs" / f"{spec}.md"
        else:
            flat = root / "openspec" / "specs" / f"{spec}.md"
        if flat.is_file():
            spec_path = flat
        else:
            location = f"openspec/changes/{change}/specs/{spec}/spec.md" if change else f"openspec/specs/{spec}/spec.md"
            return _error(f"spec not found: {location}", spec=spec, change=change or None)

    try:
        from . import spec_parser  # type: ignore
    except ImportError:
        import spec_parser  # type: ignore

    md = _read_doc(spec_path)
    parsed = spec_parser.parse_spec(md)

    return json.dumps({
        "ok": True,
        "spec": spec,
        "change": change or None,
        "path": _relative(spec_path, root),
        "title": parsed["title"],
        "purpose": parsed["purpose"],
        "requirements": parsed["requirements"],
        "workdir": str(root),
    })


def openspec_spec_list(args: dict, **kwargs) -> str:
    """List specs within a change, or baseline specs.

    Filesystem-backed — does not require the OpenSpec CLI binary.
    """
    root, err, _context = _resolve_project(args)
    if err or root is None:
        return _error(err or "workdir could not be resolved")

    change = str(args.get("change") or "").strip()

    if change:
        if not _VALID_CHANGE_RE.match(change):
            return _error(f"change must be kebab-case: {change}")
        specs_root = root / "openspec" / "changes" / change / "specs"
    else:
        specs_root = root / "openspec" / "specs"

    names = _list_specs_in_dir(specs_root)

    return json.dumps({
        "ok": True,
        "change": change or None,
        "specs": names,
        "count": len(names),
        "workdir": str(root),
    })


def _normalize_exe_name(token: str) -> str:
    cleaned = str(token or "").strip().strip("\"'").replace("\\", "/")
    if not cleaned:
        return ""
    base = cleaned.rsplit("/", 1)[-1].lower()
    for ext in (".exe", ".cmd", ".bat", ".ps1", ".sh"):
        if base.endswith(ext):
            base = base[: -len(ext)]
            break
    return base


def _first_openspec_subcommand(tokens: list[str]) -> str:
    idx = 0
    while idx < len(tokens):
        tok = str(tokens[idx] or "").strip().strip("\"'")
        if not tok:
            idx += 1
            continue
        if tok in {"-C", "--workdir", "--schema", "--Config"}:
            idx += 2
            continue
        if tok.startswith("-"):
            idx += 1
            continue
        return tok.lower()
    return ""


def _tokens_invoke_openspec_archive(tokens: list[str]) -> bool:
    if not tokens:
        return False
    idx = 0
    while idx < len(tokens):
        raw = str(tokens[idx] or "").strip()
        if not raw or re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", raw):
            idx += 1
            continue
        exe = _normalize_exe_name(raw)
        if exe in {"env", "nohup", "sudo", "command", "builtin", "time"}:
            idx += 1
            continue
        if exe == "npx":
            idx += 1
            while idx < len(tokens) and str(tokens[idx]).startswith("-"):
                idx += 1
            if idx < len(tokens) and _normalize_exe_name(tokens[idx]) == "openspec":
                sub = _first_openspec_subcommand(tokens[idx + 1 :])
                return sub in {"archive", "bulk-archive"}
            return False
        if exe in {"bash", "sh", "zsh", "dash", "cmd", "pwsh", "powershell"}:
            # Unwrap inline shell -c / /c command strings
            for sub_tok in tokens[idx + 1 :]:
                cleaned_sub = str(sub_tok).strip()
                if len(cleaned_sub) >= 2 and cleaned_sub[0] == cleaned_sub[-1] and cleaned_sub[0] in "\"'":
                    cleaned_sub = cleaned_sub[1:-1]
                if _is_raw_openspec_archive_command(cleaned_sub):
                    return True
            return False
        if exe.startswith("python"):
            rest_joined = " ".join(str(t) for t in tokens[idx + 1 :])
            if _is_raw_openspec_archive_code(rest_joined):
                return True
            return False
        if exe == "openspec":
            sub = _first_openspec_subcommand(tokens[idx + 1 :])
            return sub in {"archive", "bulk-archive"}
        return False
    return False


_SHELL_SPLIT_RE = re.compile(r"(?:&&|\|\||;|\||\r?\n)+")
_SUBSHELL_RE = re.compile(r"\$\(([^)]+)\)|`([^`]+)`")


def _split_shell_tokens(segment: str) -> list[str]:
    import shlex

    normalized = segment.replace("\\", "/")
    try:
        return shlex.split(normalized, posix=True)
    except ValueError:
        return [t.strip("\"'") for t in segment.split() if t.strip()]


def _is_raw_openspec_archive_command(command: str) -> bool:
    text = str(command or "").strip()
    if not text:
        return False
    for m in _SUBSHELL_RE.finditer(text):
        inner = m.group(1) or m.group(2) or ""
        if _is_raw_openspec_archive_command(inner):
            return True
    for seg in _SHELL_SPLIT_RE.split(text):
        seg_str = seg.strip()
        if not seg_str:
            continue
        tokens = _split_shell_tokens(seg_str)
        if _tokens_invoke_openspec_archive(tokens):
            return True
    if ("subprocess" in text or "os.system" in text or "os.popen" in text) and _is_raw_openspec_archive_code(text):
        return True
    return False


def _ast_node_strings(node: Any) -> list[str]:
    import ast

    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return [node.value]
    if isinstance(node, ast.JoinedStr):
        parts: list[str] = []
        for val in node.values:
            if isinstance(val, ast.Constant) and isinstance(val.value, str):
                parts.append(val.value)
            else:
                parts.append("placeholder")
        return ["".join(parts)]
    if isinstance(node, (ast.List, ast.Tuple)):
        out: list[str] = []
        for elt in node.elts:
            out.extend(_ast_node_strings(elt))
        return out
    return []


def _is_raw_openspec_archive_code(code: str) -> bool:
    import ast

    raw = str(code or "").strip()
    if not raw:
        return False
    try:
        tree = ast.parse(raw)
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func_name = ""
            if isinstance(node.func, ast.Name):
                func_name = node.func.id
            elif isinstance(node.func, ast.Attribute):
                base = node.func.value.id if isinstance(node.func.value, ast.Name) else ""
                func_name = f"{base}.{node.func.attr}" if base else node.func.attr

            all_args = list(node.args) + [kw.value for kw in node.keywords if kw.value is not None]
            if func_name.endswith("openspec_cli"):
                for arg_node in all_args:
                    if isinstance(arg_node, ast.Dict):
                        for k, v in zip(arg_node.keys, arg_node.values):
                            if isinstance(k, ast.Constant) and k.value in ("command", "args"):
                                strs = _ast_node_strings(v)
                                if len(strs) == 1 and _first_openspec_subcommand(_split_shell_tokens(strs[0])) in {"archive", "bulk-archive"}:
                                    return True
                                if len(strs) > 1 and _first_openspec_subcommand(strs) in {"archive", "bulk-archive"}:
                                    return True
                    else:
                        for s in _ast_node_strings(arg_node):
                            if _first_openspec_subcommand(_split_shell_tokens(s)) in {"archive", "bulk-archive"}:
                                return True
            if any(
                func_name == target or func_name.endswith("." + target)
                for target in ("run", "Popen", "call", "check_call", "check_output", "system", "popen", "terminal")
            ):
                for arg_node in all_args:
                    if isinstance(arg_node, (ast.List, ast.Tuple)):
                        tokens = _ast_node_strings(arg_node)
                        if _tokens_invoke_openspec_archive(tokens):
                            return True
                    else:
                        for s in _ast_node_strings(arg_node):
                            if _is_raw_openspec_archive_command(s):
                                return True
    except SyntaxError:
        if re.search(
            r"(?:subprocess\.\w+|os\.(?:system|popen))\s*\([^)]*openspec(?:\.exe|\.cmd)?['\"\s,]+archive\b",
            raw,
            re.IGNORECASE | re.DOTALL,
        ):
            return True
    return False


def _openspec_pre_tool_call_guard(
    tool_name: str = "",
    args: dict[str, Any] | None = None,
    **kwargs: Any,
) -> dict[str, Any] | None:
    """Global pre_tool_call hook blocking raw `openspec archive` across terminal, execute_code, openspec_cli, and tool_call."""
    name = str(tool_name or kwargs.get("function_name") or "").strip()
    if ":" in name:
        name = name.split(":")[-1]
    lower = name.lower()
    payload = args if isinstance(args, dict) else {}

    if lower == "tool_call":
        calls = payload.get("calls")
        if isinstance(calls, list):
            for entry in calls:
                if isinstance(entry, dict):
                    sub_res = _openspec_pre_tool_call_guard(
                        tool_name=str(entry.get("name") or ""),
                        args=entry.get("arguments") if isinstance(entry.get("arguments"), dict) else {},
                    )
                    if sub_res and sub_res.get("action") == "block":
                        return sub_res
        return None

    if lower == "openspec_cli":
        raw_cmd = payload.get("command")
        raw_args = payload.get("args")
        tokens: list[str] = []
        if isinstance(raw_cmd, str) and raw_cmd.strip():
            tokens.extend(_split_shell_tokens(raw_cmd))
        elif isinstance(raw_cmd, list):
            tokens.extend(str(x) for x in raw_cmd)
        if isinstance(raw_args, list):
            tokens.extend(str(x) for x in raw_args)
        elif isinstance(raw_args, str) and raw_args.strip():
            tokens.extend(_split_shell_tokens(raw_args))
        if tokens and _normalize_exe_name(tokens[0]) == "openspec":
            tokens = tokens[1:]
        if _first_openspec_subcommand(tokens) in {"archive", "bulk-archive"}:
            return {"action": "block", "message": _RAW_ARCHIVE_BLOCK_MESSAGE}
        return None

    if lower in {"terminal", "bash", "shell"}:
        cmd = str(payload.get("command") or "")
        if _is_raw_openspec_archive_command(cmd):
            return {"action": "block", "message": _RAW_ARCHIVE_BLOCK_MESSAGE}
        return None

    if lower == "execute_code":
        code = str(payload.get("code") or "")
        if _is_raw_openspec_archive_code(code):
            return {"action": "block", "message": _RAW_ARCHIVE_BLOCK_MESSAGE}
        return None

    return None


def openspec_cli(args: dict, **kwargs) -> str:
    """Run the openspec CLI binary directly and return raw output.

    This is a passthrough tool — it runs ``openspec <command> [--json]`` and
    returns the raw stdout. Use this when you need the CLI's native JSON format
    (e.g. ``applyRequires``, ``artifacts``, ``contextFiles``) rather than the
    plugin's wrapped JSON shapes.

    Gated by ``check_fn`` — only appears when the openspec binary is available.
    """
    import shlex

    veto = _openspec_pre_tool_call_guard(tool_name="openspec_cli", args=args)
    if veto and veto.get("action") == "block":
        msg = str(veto.get("message") or _RAW_ARCHIVE_BLOCK_MESSAGE)
        return json.dumps({"ok": False, "error": msg, "action": "block", "message": msg})

    exe = _openspec_bin()
    if exe is None:
        return _error("openspec CLI binary not found. Set OPENSPEC_BIN or install via npm.")

    raw_command = str(args.get("command") or "").strip()
    if not raw_command and isinstance(args.get("args"), list):
        raw_command = " ".join(str(x) for x in args["args"])
    if not raw_command:
        return _error("command is required (e.g. 'status --change my-change')")

    try:
        cmd_parts = shlex.split(raw_command)
    except ValueError:
        cmd_parts = raw_command.split()

    if _first_openspec_subcommand(cmd_parts) in {"archive", "bulk-archive"}:
        return json.dumps(
            {"ok": False, "error": _RAW_ARCHIVE_BLOCK_MESSAGE, "action": "block", "message": _RAW_ARCHIVE_BLOCK_MESSAGE}
        )

    json_output = args.get("json_output")
    if json_output is None:
        json_output = True
    if json_output:
        cmd_parts = [*cmd_parts, "--json"]

    workdir = str(args.get("workdir") or "").strip()
    if workdir:
        root, err = _resolve_workdir(workdir)
        if err or root is None:
            return _error(err or "workdir could not be resolved")
        cwd = str(root)
    else:
        cwd = None

    try:
        proc = subprocess.run(
            _cli_resolver.build_openspec_argv(exe, cmd_parts),
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
            cwd=cwd,
        )
    except subprocess.TimeoutExpired:
        return _error("openspec CLI command timed out (120s)")
    except OSError as exc:
        return _error(f"failed to run openspec CLI: {exc}")

    stdout = proc.stdout or ""
    stderr = proc.stderr or ""

    if json_output and proc.returncode == 0:
        try:
            parsed = json.loads(stdout)
            return json.dumps({
                "ok": True,
                "exit_code": proc.returncode,
                "stdout": parsed,
                "workdir": cwd,
            })
        except json.JSONDecodeError:
            pass  # Fall through to raw output

    return json.dumps({
        "ok": proc.returncode == 0,
        "exit_code": proc.returncode,
        "stdout": stdout,
        "stderr": stderr.strip() if stderr else "",
        "workdir": cwd,
    })
