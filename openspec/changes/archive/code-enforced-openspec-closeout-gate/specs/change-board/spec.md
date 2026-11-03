# Delta Specification: OpenSpec Change Board (`code-enforced-openspec-closeout-gate`)

## MODIFIED Requirements

### Requirement: Board scan model
The dashboard API SHALL scan each initialized source's `openspec/` directory into board data without persisting change or spec records in the plugin database, ordering change review artifacts by round number first (`parse_round`) so `latestVerdict` reflects the highest review round and matching `crewCards` across both `<slug>` and `YYYY-MM-DD-<slug>` archived change directories.

#### Scenario: Active change scan
- **GIVEN** a directory exists under `openspec/changes/` with a `proposal.md`
- **WHEN** the source is scanned
- **THEN** the API includes it as a change with name, token, title, status, artifact presence flags, and task stats when available

#### Scenario: Archived change scan
- **GIVEN** a directory exists under `openspec/changes/archive/` with a `proposal.md`
- **WHEN** the source is scanned
- **THEN** the API includes it as an archived change and assigns it the archived status

#### Scenario: Date-prefixed archived change preserves Crew card linkage
- **GIVEN** a Crew card references `openspec/changes/<slug>/proposal.md` (or the token for `<slug>`) and the change was archived under `openspec/changes/archive/YYYY-MM-DD-<slug>`
- **WHEN** the source is scanned or change detail is requested for `YYYY-MM-DD-<slug>`
- **THEN** `crewCards` MUST include the Crew card referencing `<slug>`

#### Scenario: Review scan orders by round number across different filename prefixes
- **GIVEN** a change's `reviews/` directory contains `findings-proposal-v1.md` (`REJECTED`), `findings-proposal-v2.md` (`REJECTED`), and `findings-apply-v3.md` (`APPROVED`)
- **WHEN** `scan_reviews` and `_change_summary` evaluate the change
- **THEN** `findings-apply-v3.md` MUST sort last (round 3 after round 2) and `latestVerdict` MUST be `APPROVED`

#### Scenario: Idea scan
- **GIVEN** a markdown file exists under `openspec/ideas/`
- **WHEN** the source is scanned
- **THEN** the API includes it as an idea with name, token, title, and ideas status

#### Scenario: Current spec scan
- **GIVEN** a markdown file exists under `openspec/specs/`
- **WHEN** the source is scanned
- **THEN** the API includes it as a current spec with relative path, token, and title
