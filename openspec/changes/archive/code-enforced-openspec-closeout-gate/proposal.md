# Proposal: Code-Enforced OpenSpec Close-Out Gate (`code-enforced-openspec-closeout-gate`)

## Why

Relying solely on prose instructions in `SKILL.md` allowed changes to be archived without syncing delta specs into canonical `openspec/specs/`, dropped Exploration Documents from archived changes (`hasExplorations: False`), broke `crewCards` linkage when changes were archived under date-prefixed directory names (`YYYY-MM-DD-<slug>`), and let earlier `v1`/`v2` `REJECTED` review files override a later `v3` `APPROVED` review file when sorting alphabetically (`findings-apply-v3.md` vs `findings-proposal-v2.md`).

## Source Exploration Document

- `openspec/workspace/explorations/2026-11-02-code-enforced-openspec-closeout-gate-exploration.md`

## What Changes

1. **Code-Enforced Pre-Archive Gate & Auto-Exploration Packaging in `openspec_change_archive` (`tools.py`)**:
   - Refuse `openspec_change_archive` (unless `force=True`) when any `### Requirement:` under `## ADDED Requirements` or `## MODIFIED Requirements` in `changes/<change>/specs/<cap>/spec.md` is missing from canonical `<root>/openspec/specs/<cap>/spec.md`.
   - Refuse `openspec_change_archive` (unless `force=True`) when `changes/<change>/reviews/` contains review artifacts whose latest verdict is `REJECTED`.
   - Automatically copy any referenced workspace Exploration Document (from `.openspec.yaml` `x-exploration:`, `proposal.md`, or `openspec/workspace/explorations/*<change>*.md`) into `changes/<change>/explorations/` before moving `change_dir` to `changes/archive/` so `hasExplorations: True` is guaranteed.
2. **Date-Prefix-Aware `_CrewLinker.for_change` & Round-First `_review_sort_key` (`artifacts_index.py` & `dashboard/plugin_api.py`)**:
   - Update `_review_sort_key(path)` in `artifacts_index.py` to sort by `(round_num is not None, round_num or 0, natural_parts)` using `parse_round(path.stem)` so `v3` / `round-3` always sorts after `v1` and `v2` regardless of prefix (`findings-apply-v3` vs `findings-proposal-v2`).
   - Add `strip_date_prefix(name)` (`^\d{4}-\d{2}-\d{2}-`) in `artifacts_index.py` and update `extract_openspec_refs` and `_CrewLinker.for_change` (`dashboard/plugin_api.py`) so archived changes named `YYYY-MM-DD-<slug>` retain all `crewCards` referencing `<slug>` or its token.

## Impact

- `tools.py`, `artifacts_index.py`, `dashboard/plugin_api.py`
- `tests/test_openspec_workflow_fixes.py`, `tests/test_explorations_and_reviews.py`, `tests/test_crew_linkage_and_discover.py`
