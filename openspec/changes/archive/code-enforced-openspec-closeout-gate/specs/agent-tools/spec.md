# Delta Specification: Agent OpenSpec Tools (`code-enforced-openspec-closeout-gate`)

## ADDED Requirements

### Requirement: Code-enforced pre-archive gate and exploration packaging
The `openspec_change_archive` tool SHALL verify delta-spec synchronization and review approval before archiving a completed change (unless `force=True`), and SHALL automatically package referenced workspace exploration documents into the change's `explorations/` directory before moving the change to `openspec/changes/archive/`.

#### Scenario: Archive refuses unsynced delta specification requirements
- **GIVEN** an active change has all tasks marked `[x]` in `tasks.md` and defines `ADDED` or `MODIFIED` `### Requirement:` headers under `openspec/changes/<change>/specs/<capability>/spec.md`
- **WHEN** `openspec_change_archive` is called without `force=True` and any such `### Requirement:` header is absent from `<root>/openspec/specs/<capability>/spec.md`
- **THEN** the tool MUST refuse to archive, return `ok: false` with `unsynced_specs` listing the missing capability/requirements, and leave the change in `openspec/changes/<change>`

#### Scenario: Archive refuses change whose latest review verdict is REJECTED
- **GIVEN** an active change has all tasks marked `[x]` and `openspec/changes/<change>/reviews/` has a latest review whose verdict is `REJECTED`
- **WHEN** `openspec_change_archive` is called without `force=True`
- **THEN** the tool MUST refuse to archive and return `ok: false` stating that the latest review verdict is `REJECTED`

#### Scenario: Archive automatically packages referenced workspace exploration document
- **GIVEN** an active change references an exploration document in `.openspec.yaml` (`x-exploration:`) or `proposal.md` that exists under `openspec/workspace/explorations/` but is not yet present in `openspec/changes/<change>/explorations/`
- **WHEN** `openspec_change_archive` succeeds
- **THEN** the tool MUST copy that exploration document into `openspec/changes/archive/<change>/explorations/` so the archived change reports `hasExplorations: true`
