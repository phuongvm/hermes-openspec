# Exploration: Code-Enforced OpenSpec Close-Out Gate (`code-enforced-openspec-closeout-gate`)

- **Date**: 2026-11-02
- **Author**: Coordinator (`default/20261102_092114_ecab47`)
- **Target Repositories**:
  1. `O:/workspaces/oss/hermes-openspec` (`os_8ec009` — OpenSpec plugin tools, artifact indexer & dashboard API)
  2. `O:/workspaces/oss/crew` (`os_54792d` — Crew intake preload hook & coordinator close-out injection)
- **Live Runtime Targets**:
  - `O:/workspaces/_config/agent4070/hermes/plugins/openspec` (plus profile copies under `profiles/*/plugins/openspec`)
  - `O:/workspaces/_config/agent4070/hermes/plugins/crew` (plus profile copies under `profiles/*/plugins/crew`)

---

## 1. Problem Statement & Empirical Root Causes

During the close-out of `crew-inputs-and-propose-continuity`, relying on prose instructions inside `skills/crew/SKILL.md` failed to prevent close-out errors for three code-level reasons:

1. **Root Cause 1 — `openspec_change_archive` (`oss/hermes-openspec/tools.py:1113-1141`) Has Zero Pre-Archive Guardrails**:
   - `openspec_change_archive` only checks `_derive_status(tasks_path) != "done"` before calling `shutil.move(str(change_dir), str(archive_dir))`.
   - It does **not** verify whether delta specs under `changes/<change>/specs/<capability>/spec.md` (`ADDED` / `MODIFIED` requirements) were merged into canonical `<root>/openspec/specs/<capability>/spec.md`.
   - It does **not** check whether the latest review in `changes/<change>/reviews/` has an `APPROVED` verdict (allowing a change whose latest review is `REJECTED` to be archived).
   - It does **not** package the Exploration Document referenced by `.openspec.yaml` (`x-exploration:`), `proposal.md`, or `openspec/workspace/explorations/*<change>*.md` into `changes/<change>/explorations/` before moving to `changes/archive/`, resulting in `hasExplorations: False` on archived changes.

2. **Root Cause 2 — `_CrewLinker.for_change` (`oss/hermes-openspec/dashboard/plugin_api.py:393`) and `_review_sort_key` (`oss/hermes-openspec/artifacts_index.py:208`) Break Archive Metadata**:
   - `_CrewLinker.for_change(name, token)` only checks `name in refs["changes"] or token in refs["tokens"]`. When a change is archived under a date-prefixed directory `YYYY-MM-DD-<slug>` (by the OpenSpec CLI), `name` is `YYYY-MM-DD-<slug>` while the Crew cards reference `<slug>`, causing `crewCards` to become empty (`[]`).
   - `_review_sort_key(path)` splits filenames purely by digit tokens (`re.split(r"(\d+)", path.name)`), sorting alphabetically by prefix (`findings-apply-v3.md` before `findings-proposal-v2.md` because `'a' < 'p'`). Consequently, a Round-3 `APPROVED` review named `findings-apply-v3.md` is overridden by an earlier Round-2 `REJECTED` review named `findings-proposal-v2.md` when computing `latestVerdict = reviews[-1]["verdict"]`.

3. **Root Cause 3 — `crew_intake_preload` (`oss/crew/__init__.py:1597-1616`) Returns `None` on Completed (`Done`) Watcher Reports After Context Compaction Prunes `crew` Skill**:
   - Long-running multi-card OpenSpec workflows trigger Hermes context compaction, which prunes `skills/crew/SKILL.md` (`[SKILL_PRUNED: content lost in compression]`).
   - When the final Apply card's `crew_card.py watch` process returns a `Done` report (`WATCH_REPORT_RX`), `crew_intake_preload` only handles `REJECTED` reports and returns `None` for `Done` reports. Without an injected close-out gate reminder naming the canonical repository/worktree `OPENSPEC_ROOT` and the 6-step close-out checklist, the Coordinator can drift or skip steps.

---

## 2. Solution & Public Testing Seams

### Seam 1: Code-Enforced Pre-Archive Gate & Auto-Exploration Packaging in `openspec_change_archive` (`oss/hermes-openspec/tools.py`)
- Before archiving `change_dir` (unless `force=True`):
  1. **Delta Spec Sync Verification (`_check_delta_specs_synced(root, change_dir)`)**:
     - Scan `change_dir / "specs"` for `*/spec.md`.
     - Parse `### Requirement: <Title>` headers under `## ADDED Requirements` and `## MODIFIED Requirements` (ignoring `## REMOVED Requirements`).
     - Verify the corresponding canonical spec `<root>/openspec/specs/<capability>/spec.md` exists and contains each required `### Requirement: <Title>`.
     - If any requirement is missing from `<root>/openspec/specs/`, refuse archive with `ok: False`, `error: "delta specs not synced to canonical specs: ..."`, and `unsynced_specs: [...]`.
  2. **Review Verdict Gate (`_check_reviews_approved(change_dir, change)`)**:
     - If `change_dir / "reviews"` contains `.md` files and the latest review verdict is `"REJECTED"`, refuse archive (unless `force=True`) with `ok: False`, `error: "cannot archive change with REJECTED latest review verdict"`.
  3. **Automatic Exploration Packaging (`_package_change_explorations(root, change_dir, change)`)**:
     - Inspect `.openspec.yaml` (`x-exploration:`) and `proposal.md` (`openspec/workspace/explorations/<file>.md`) to locate any workspace exploration document for this change.
     - If found in `<root>/openspec/workspace/explorations/` and not yet present in `change_dir / "explorations"`, copy it into `change_dir / "explorations" / <filename>` prior to moving `change_dir` to `archive_dir`.

### Seam 2: Date-Prefix-Aware `_CrewLinker.for_change` & Round-First `_review_sort_key` (`oss/hermes-openspec/artifacts_index.py` & `dashboard/plugin_api.py`)
- In `artifacts_index.py`:
  - Update `_review_sort_key(path: Path)` to sort primarily by `(round_num is not None, round_num or 0, natural_parts)` where `round_num = parse_round(path.stem)`, so `v3` / `round-3` always sorts after `v1` and `v2` regardless of whether the stem prefix is `findings-proposal-`, `findings-apply-`, or `findings-reviewer-`.
  - Add helper `strip_date_prefix(name: str) -> str` (`re.sub(r"^\d{4}-\d{2}-\d{2}-", "", name)`) and in `extract_openspec_refs`, record both `name` and `strip_date_prefix(name)` in `refs["changes"]`.
- In `dashboard/plugin_api.py`:
  - Update `_CrewLinker.for_change(name, token)` to check `name`, `strip_date_prefix(name)`, `token`, and `_change_token(strip_date_prefix(name))` so both `<slug>` and `YYYY-MM-DD-<slug>` archived changes retain all linked `crewCards`.

### Seam 3: Close-Out Gate Context Injection on Completed OpenSpec Watcher Reports (`oss/crew/__init__.py`)
- In `crew_intake_preload` (`oss/crew/__init__.py:1597-1616`), when `WATCH_REPORT_RX` matches a non-`REJECTED` report that indicates completion (`Done`) and references `openspec/changes/<change-id>` (in `user_message` or in the card's `kanban.db` body), return a concise `[CREW OPENSPEC CLOSE-OUT GATE]` context reminder instructing the Coordinator to run the mandatory 6-point close-out sequence (`openspec-verify-change` -> `openspec-sync-specs` -> `openspec_change_archive` -> Post-Archive Audit -> worktree commit, push & `git pull --ff-only`) on the canonical repository's `OPENSPEC_ROOT` even if `[SKILL_PRUNED]` occurred earlier in the session.

---

## 3. Out of Scope
- Autonomous restart of Hermes Gateway or Dashboard services.
