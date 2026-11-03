# Technical Design: Code-Enforced OpenSpec Close-Out Gate (`code-enforced-openspec-closeout-gate`)

## 1. Deep Modules & Public Seams

### 1.1 Pre-Archive Gate & Exploration Packaging (`tools.py:1113-1142`)
- Add `_check_delta_specs_synced(root: Path, change_dir: Path) -> list[dict[str, Any]]`:
  - Parse `change_dir / "specs"` for `*/spec.md`.
  - Track active section header (`## ADDED Requirements`, `## MODIFIED Requirements`, `## REMOVED Requirements`).
  - Collect every `### Requirement: <Title>` line inside `ADDED` or `MODIFIED` sections (or when no `REMOVED` section is active).
  - Verify `<root>/openspec/specs/<rel_spec_path>` exists and contains each required `### Requirement: <Title>` line.
  - Return a list of `{spec, missing_requirements}` dicts for any unsynced spec.
- Add `_check_reviews_approved(change_dir: Path, change: str) -> str | None`:
  - Use `_artifacts_index.scan_reviews(change_dir, change, lambda s: s)` and if non-empty and `reviews[-1]["verdict"] == "REJECTED"`, return an error string.
- Add `_package_change_explorations(root: Path, change_dir: Path, change: str) -> list[str]`:
  - Check `.openspec.yaml` (`x-exploration:`), `proposal.md` (`openspec/workspace/explorations/<name>.md`), and `<root>/openspec/workspace/explorations/*<change>*.md`.
  - Copy any matching file from `<root>/openspec/workspace/explorations/` into `change_dir / "explorations"` if not already present.

### 1.2 Round-First Review Sorting & Date-Prefix Crew Linkage (`artifacts_index.py` & `dashboard/plugin_api.py`)
- In `artifacts_index.py`:
  - Define `_DATE_PREFIX_RE = re.compile(r"^\d{4}-\d{2}-\d{2}-")` and `strip_date_prefix(name: str) -> str`.
  - Update `_review_sort_key(path: Path)`: compute `rnd = parse_round(path.stem)`; return `(1 if rnd is not None else 0, rnd or 0, natural_parts)`.
  - Update `extract_openspec_refs`: when `name` is extracted from `openspec/changes/(?:archive/)?<name>`, add both `name` and `strip_date_prefix(name)` to `refs["changes"]`.
- In `dashboard/plugin_api.py`:
  - Update `_CrewLinker.for_change(self, name: str, token: str)`: compute `bare = _artifacts.strip_date_prefix(name)` and `bare_token = _change_token(bare) if bare != name else token`, matching `name in refs["changes"] or bare in refs["changes"] or token in refs["tokens"] or bare_token in refs["tokens"]`.

## 2. Public Testing Seams
- `tests/test_openspec_workflow_fixes.py`: unit & integration tests for `openspec_change_archive` pre-archive delta-spec sync gate, rejected-review gate, and auto-exploration packaging.
- `tests/test_explorations_and_reviews.py`: test `findings-apply-v3.md` (`APPROVED`) sorting after `findings-proposal-v2.md` (`REJECTED`).
- `tests/test_crew_linkage_and_discover.py`: test active-card path `openspec/changes/old/proposal.md` linking to archived `2026-01-01-old`.
