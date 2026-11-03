"""Shared artifact index for the OpenSpec plugin (stdlib only).

Single owner of exploration/review scanning, token injection, verdict and round
parsing, reference parsing/resolution, traversal-safe reads and OpenSpec reference
extraction. ``dashboard/plugin_api.py`` and ``tools.py`` are thin adapters over it.

No ``fastapi``, ``pydantic``, Hermes or ``registry`` imports: the token authority is
injected as ``token_for: Callable[[str], str]`` (callers pass ``registry.change_token``).

Reference grammar::

    ref        := token | qualified | literal
    token      := "os_" 6*6HEXDIG
    qualified  := "change:" NAME | "spec:" NAME | "idea:" STEM
                | "exploration:" STEM [ "@" CHANGE ]
                | "review:" STEM "@" CHANGE
    literal    := NAME
    NAME/STEM/CHANGE := 1*( ALPHA / DIGIT / "." / "_" / "-" )
"""

from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Iterable

TokenFor = Callable[[str], str]

MAX_ARTIFACT_BYTES = 512 * 1024

_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")
_TOKEN_RE = re.compile(r"^os_[0-9a-fA-F]{6}$")
_KINDS = ("change", "spec", "idea", "exploration", "review")
_DATE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})")
_DATE_PREFIX_RE = re.compile(r"^\d{4}-\d{2}-\d{2}-(?P<bare>[A-Za-z0-9._-]+)$")
_ROUND_RE = re.compile(r"(?:^|[-_])(?:v|round[-_]?)(\d+)$", re.IGNORECASE)


def strip_date_prefix(name: Any) -> str:
    raw = str(name or "").strip()
    match = _DATE_PREFIX_RE.match(raw)
    return match.group("bare") if match else raw
_VERDICT_LINE_RE = re.compile(
    r"^\s*(?:[-*+]\s+)?(?:#{1,6}\s*)?\**\s*verdict[\s*]*:[\s*]*(?P<v>[A-Za-z]+)",
    re.IGNORECASE,
)
_HEADING_MARKER_RE = re.compile(r"^\s*#{1,6}\s.*\*\*(APPROVED|REJECTED)\*\*", re.IGNORECASE)


# ---------------------------------------------------------------------------
# reference grammar
# ---------------------------------------------------------------------------


def _valid_name(value: str) -> bool:
    return bool(value) and bool(_NAME_RE.match(value)) and ".." not in value and value != "."


_INVALID = {"ok": False, "error": "invalid_ref"}


def parse_ref(ref: Any) -> dict[str, Any]:
    """Parse a public reference. Returns ``ok: False, error: invalid_ref`` on any violation."""
    raw = str(ref or "").strip()
    if not raw:
        return dict(_INVALID)
    if ":" not in raw:
        if "@" in raw or not _valid_name(raw):
            return dict(_INVALID)
        if _TOKEN_RE.match(raw):
            return {"ok": True, "form": "token", "kind": None, "name": raw.lower(), "change": None}
        return {"ok": True, "form": "literal", "kind": None, "name": raw, "change": None}

    kind, _, rest = raw.partition(":")
    if kind not in _KINDS or not rest:
        return dict(_INVALID)
    name, at, change = rest.partition("@")
    if not _valid_name(name):
        return dict(_INVALID)
    if at:
        if kind not in ("exploration", "review") or not _valid_name(change):
            return dict(_INVALID)
    elif kind == "review":
        return dict(_INVALID)
    return {"ok": True, "form": "qualified", "kind": kind, "name": name, "change": change if at else None}


# ---------------------------------------------------------------------------
# verdict / round
# ---------------------------------------------------------------------------


def extract_review_verdict(text: Any) -> str:
    """Return ``APPROVED``, ``REJECTED`` or ``PENDING`` from structured verdict markers only."""
    found: set[str] = set()
    for line in str(text or "").splitlines():
        match = _VERDICT_LINE_RE.match(line)
        if match:
            word = match.group("v").upper()
            if word in ("APPROVED", "REJECTED", "PENDING"):
                found.add(word)
                continue
        marker = _HEADING_MARKER_RE.match(line)
        if marker:
            found.add(marker.group(1).upper())
    if "REJECTED" in found:
        return "REJECTED"
    if "APPROVED" in found:
        return "APPROVED"
    return "PENDING"


def parse_round(stem: Any) -> int | None:
    match = _ROUND_RE.search(str(stem or ""))
    return int(match.group(1)) if match else None


# ---------------------------------------------------------------------------
# reading
# ---------------------------------------------------------------------------


def _read_text(path: Path) -> str:
    try:
        if not path.is_file():
            return ""
        data = path.read_bytes()[:MAX_ARTIFACT_BYTES]
        return data.decode("utf-8", errors="replace")
    except OSError:
        return ""


def read_artifact(path: Path | str, allowed_dir: Path | str) -> str | None:
    """Read ``path`` only when it is a direct child file of ``allowed_dir`` (after resolving)."""
    try:
        target = Path(allowed_dir).resolve()
        resolved = Path(path).resolve()
        if resolved.parent != target or not resolved.is_file():
            return None
        return _read_text(resolved)
    except (OSError, RuntimeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# scanning
# ---------------------------------------------------------------------------


def _title(text: str, fallback: str) -> str:
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("# "):
            return stripped[2:].strip() or fallback
    return fallback


def _exploration_record(path: Path, scope: str, token_for: TokenFor) -> dict[str, Any]:
    stem = path.stem
    match = _DATE_RE.match(stem)
    if match:
        date = match.group(1)
    else:
        try:
            date = datetime.fromtimestamp(path.stat().st_mtime).date().isoformat()
        except OSError:
            date = ""
    return {
        "name": stem,
        "filename": path.name,
        "scope": scope,
        "token": token_for(f"exploration:{scope}:{stem}"),
        "title": _title(_read_text(path), stem),
        "date": date,
        "path": str(path.resolve()),
    }


def _md_files(directory: Path) -> list[Path]:
    try:
        if not directory.is_dir():
            return []
        return sorted(
            (p for p in directory.iterdir() if p.is_file() and p.suffix.lower() == ".md"),
            key=lambda p: p.name.lower(),
        )
    except OSError:
        return []


def scan_change_explorations(change_dir: Path | str, token_for: TokenFor) -> list[dict[str, Any]]:
    """Explorations local to one change (``scope: change:<name>``)."""
    change_dir = Path(change_dir)
    scope = f"change:{change_dir.name}"
    return [_exploration_record(p, scope, token_for) for p in _md_files(change_dir / "explorations")]


def scan_explorations(
    repo_root: Path | str,
    change_dirs: Iterable[Path | str],
    token_for: TokenFor,
) -> list[dict[str, Any]]:
    """Workspace explorations first, then each change's local explorations."""
    root = Path(repo_root)
    records = [
        _exploration_record(p, "workspace", token_for)
        for p in _md_files(root / "openspec" / "workspace" / "explorations")
    ]
    for change_dir in change_dirs:
        records.extend(scan_change_explorations(change_dir, token_for))
    return records


def _review_sort_key(path: Path) -> tuple[Any, ...]:
    rnd = parse_round(path.stem)
    natural = tuple(int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", path.name))
    return (1 if rnd is not None else 0, rnd or 0, natural)


def scan_reviews(change_dir: Path | str, change_name: str, token_for: TokenFor) -> list[dict[str, Any]]:
    """``<change_dir>/reviews/*.md`` in natural filename order (v2 before v10)."""
    reviews = []
    files = sorted(_md_files(Path(change_dir) / "reviews"), key=_review_sort_key)
    for path in files:
        stem = path.stem
        reviews.append({
            "name": stem,
            "filename": path.name,
            "change": change_name,
            "token": token_for(f"review:{change_name}:{stem}"),
            "verdict": extract_review_verdict(_read_text(path)),
            "round": parse_round(stem),
            "path": str(path.resolve()),
        })
    return reviews


def iter_change_dirs(repo_root: Path | str) -> list[tuple[Path, bool]]:
    """``(change_dir, archived)`` for every change folder with a ``proposal.md``."""
    changes_root = Path(repo_root) / "openspec" / "changes"
    found: list[tuple[Path, bool]] = []
    try:
        if changes_root.is_dir():
            for child in sorted(changes_root.iterdir()):
                if child.name != "archive" and child.is_dir() and (child / "proposal.md").is_file():
                    found.append((child, False))
            archive_root = changes_root / "archive"
            if archive_root.is_dir():
                for child in sorted(archive_root.iterdir()):
                    if child.is_dir() and (child / "proposal.md").is_file():
                        found.append((child, True))
    except OSError:
        pass
    return found


def build_index(repo_root: Path | str, token_for: TokenFor) -> dict[str, Any]:
    """Scan every artifact kind under ``<repo_root>/openspec`` into one resolvable index."""
    root = Path(repo_root)
    change_pairs = iter_change_dirs(root)
    changes = [
        {"name": d.name, "archived": archived, "token": token_for(d.name), "path": str(d.resolve())}
        for d, archived in change_pairs
    ]
    specs = []
    specs_root = root / "openspec" / "specs"
    try:
        if specs_root.is_dir():
            for child in sorted(specs_root.rglob("*.md")):
                if child.is_file():
                    rel = child.relative_to(specs_root).as_posix()
                    specs.append({
                        "name": rel, "rel": rel, "token": token_for(f"spec:{rel}"),
                        "path": str(child.resolve()),
                    })
    except OSError:
        pass
    ideas = [
        {"name": p.stem, "filename": p.name, "token": token_for(p.stem), "path": str(p.resolve())}
        for p in _md_files(root / "openspec" / "ideas")
    ]
    reviews: list[dict[str, Any]] = []
    for d, _archived in change_pairs:
        reviews.extend(scan_reviews(d, d.name, token_for))
    return {
        "root": str(root),
        "changes": changes,
        "specs": specs,
        "ideas": ideas,
        "explorations": scan_explorations(root, [d for d, _a in change_pairs], token_for),
        "reviews": reviews,
    }


def parse_scope(scope: Any) -> str | None:
    """Validate an exploration scope: ``workspace`` or ``change:<NAME>``. ``None`` if malformed."""
    raw = str(scope if scope is not None else "workspace")
    if raw == "workspace":
        return raw
    kind, sep, change = raw.partition(":")
    if sep and kind == "change" and _valid_name(change):
        return raw
    return None


def load_exploration(
    repo_root: Path | str,
    name: Any,
    scope: Any,
    token_for: TokenFor,
) -> dict[str, Any] | None:
    """Return one exploration record plus ``content``; ``None`` if absent.

    Raises ``ValueError`` for a malformed ``name`` or ``scope`` (callers map it to HTTP 400).
    """
    stem = str(name or "")
    clean_scope = parse_scope(scope)
    if not _valid_name(stem) or clean_scope is None:
        raise ValueError("invalid exploration name or scope")
    root = Path(repo_root)
    if clean_scope == "workspace":
        directory = root / "openspec" / "workspace" / "explorations"
    else:
        wanted = clean_scope.partition(":")[2]
        match = next((d for d, _a in iter_change_dirs(root) if d.name == wanted), None)
        if match is None:
            return None
        directory = match / "explorations"
    path = directory / f"{stem}.md"
    content = read_artifact(path, directory)
    if content is None:
        return None
    return {**_exploration_record(path, clean_scope, token_for), "content": content}


# ---------------------------------------------------------------------------
# resolution
# ---------------------------------------------------------------------------


def _spec_names(rel: str) -> set[str]:
    names = {rel}
    if rel.endswith("/spec.md"):
        names.add(rel[: -len("/spec.md")])
    if rel.endswith(".md"):
        names.add(rel[: -len(".md")])
    return {n for n in names if "/" not in n}


def _qualified(kind: str, record: dict[str, Any]) -> str:
    if kind == "exploration":
        scope = record["scope"]
        return f"exploration:{record['name']}" if scope == "workspace" else (
            f"exploration:{record['name']}@{scope.partition(':')[2]}"
        )
    if kind == "review":
        return f"review:{record['name']}@{record['change']}"
    if kind == "spec":
        short = sorted(n for n in _spec_names(record["rel"]) if n != record["rel"] or "/" not in n)
        return f"spec:{short[0]}" if short else record["token"]
    return f"{kind}:{record['name']}"


def _candidates(index: dict[str, Any], kinds: Iterable[str], match: Callable[[str, dict[str, Any]], bool]):
    out = []
    for kind in kinds:
        for record in index.get(f"{kind}s" if kind != "idea" else "ideas", []):
            if match(kind, record):
                out.append((kind, record))
    return out


def resolve_ref(index: dict[str, Any], ref: Any) -> dict[str, Any]:
    """Resolve ``ref`` to exactly one artifact, or ``not_found`` / ``ambiguous`` / ``invalid_ref``."""
    parsed = parse_ref(ref)
    if not parsed["ok"]:
        return dict(_INVALID)
    form, kind, name, change = parsed["form"], parsed["kind"], parsed["name"], parsed["change"]

    def name_matches(k: str, record: dict[str, Any]) -> bool:
        if k == "spec":
            return name in _spec_names(record["rel"])
        return record["name"] == name

    def matcher(k: str, record: dict[str, Any]) -> bool:
        if form == "token":
            return record["token"].lower() == name
        if not name_matches(k, record):
            return False
        if k == "exploration":
            wanted = "workspace" if form == "qualified" and change is None else (
                f"change:{change}" if change else None
            )
            return wanted is None or record["scope"] == wanted
        if k == "review":
            return change is None or record["change"] == change
        return True

    kinds = [kind] if form == "qualified" else list(_KINDS)
    hits = _candidates(index, kinds, matcher)
    if not hits:
        return {"ok": False, "error": "not_found"}
    if len(hits) > 1:
        return {
            "ok": False,
            "error": "ambiguous",
            "candidates": [{"kind": k, "ref": _qualified(k, r)} for k, r in hits],
        }
    k, record = hits[0]
    return {"ok": True, "kind": k, "record": record}


# ---------------------------------------------------------------------------
# OpenSpec reference extraction (Crew card linkage)
# ---------------------------------------------------------------------------

_CHANGE_PATH_RE = re.compile(
    r"(?<![A-Za-z0-9._-])openspec/changes/(?:archive/)?(?P<name>[A-Za-z0-9._-]+)"
    r"(?:/(?P<sub>explorations|reviews)/(?P<file>[A-Za-z0-9._-]+?\.md)(?![A-Za-z0-9_-]|\.[A-Za-z0-9_-]))?"
)
_WORKSPACE_EXPLORATION_RE = re.compile(
    r"(?<![A-Za-z0-9._-])openspec/workspace/explorations/"
    r"(?P<file>[A-Za-z0-9._-]+?\.md)(?![A-Za-z0-9_-]|\.[A-Za-z0-9_-])"
)
_TOKEN_IN_TEXT_RE = re.compile(r"(?<![A-Za-z0-9_])os_[0-9a-f]{6}(?![A-Za-z0-9_])")


def extract_openspec_refs(text: Any) -> dict[str, set]:
    """Find path/token references to OpenSpec artifacts in free text (backslashes normalized)."""
    normalized = str(text or "").replace("\\", "/")
    refs: dict[str, set] = {"changes": set(), "explorations": set(), "reviews": set(), "tokens": set()}
    for match in _CHANGE_PATH_RE.finditer(normalized):
        name = match.group("name").rstrip(".")
        if not name or name == "archive":
            continue
        refs["changes"].add(name)
        bare = strip_date_prefix(name)
        if bare and bare != name:
            refs["changes"].add(bare)
        sub, filename = match.group("sub"), match.group("file")
        if sub == "explorations" and filename:
            refs["explorations"].add((f"change:{name}", filename))
        elif sub == "reviews" and filename:
            refs["reviews"].add((name, filename))
    for match in _WORKSPACE_EXPLORATION_RE.finditer(normalized):
        refs["explorations"].add(("workspace", match.group("file")))
    refs["tokens"].update(_TOKEN_IN_TEXT_RE.findall(normalized))
    return refs
