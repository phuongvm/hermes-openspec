# Tasks: Code-Enforced OpenSpec Close-Out Gate (`code-enforced-openspec-closeout-gate`)

## Slice 1 — Round-First Review Ordering & Date-Prefixed Archive Crew Linkage (`oss/hermes-openspec`)

- [x] 1.1 In `O:/workspaces/.worktrees/wt-code-enforced-openspec-closeout-gate`, update `artifacts_index.py` (`_review_sort_key`, `strip_date_prefix`, `extract_openspec_refs`) and `dashboard/plugin_api.py` (`_CrewLinker.for_change`) so review files sort by `parse_round(stem)` first and date-prefixed archived changes (`YYYY-MM-DD-<slug>`) link to Crew cards referencing `<slug>` or its token; add regression tests in `tests/test_explorations_and_reviews.py` and `tests/test_crew_linkage_and_discover.py`.
  - **Proof**: `"O:/workspaces/oss/hermes-agent/.venv/Scripts/python.exe" -m pytest "O:/workspaces/.worktrees/wt-code-enforced-openspec-closeout-gate/tests/test_explorations_and_reviews.py" "O:/workspaces/.worktrees/wt-code-enforced-openspec-closeout-gate/tests/test_crew_linkage_and_discover.py" -v`

## Slice 2 — Code-Enforced Pre-Archive Gate & Auto-Exploration Packaging in `openspec_change_archive` (`oss/hermes-openspec`)

- [x] 2.1 [Blocked by: 1.1] In `O:/workspaces/.worktrees/wt-code-enforced-openspec-closeout-gate`, update `tools.py` (`openspec_change_archive`) to enforce `_check_delta_specs_synced`, `_check_reviews_approved`, and `_package_change_explorations` before moving a change to `openspec/changes/archive/` (unless `force=True`), and add tests in `tests/test_openspec_workflow_fixes.py`.
  - **Proof**: `"O:/workspaces/oss/hermes-agent/.venv/Scripts/python.exe" -m pytest "O:/workspaces/.worktrees/wt-code-enforced-openspec-closeout-gate/tests/test_openspec_workflow_fixes.py" -v`
