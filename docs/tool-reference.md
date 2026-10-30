# Tool Reference

Two perspectives on the same 19 tools. Use whichever table matches what you
already know.

## Artifact → tool mapping

If you already know OpenSpec's artifact model (proposal, design, tasks, specs,
ideas, archive), this table maps each artifact operation to the Hermes tool
that performs it.

| You want to… | OpenSpec artifact | Hermes tool | Effect |
|---|---|---|---|
| Capture a raw idea | `openspec/ideas/<slug>.md` (new) | `openspec_idea_create` | Writes the idea file |
| Add a structured evaluation to an idea | `openspec/ideas/<slug>.md` (update) | `openspec_idea_enrich` | Appends problem, direction, feasibility, T-shirt size, risks, questions, next step |
| Turn an idea into a change | `openspec/changes/<change>/` (new) | `openspec_idea_promote` | Creates the change scaffold with proposal/tasks/spec traceability |
| Create a change without an idea | `openspec/changes/<change>/` (new) | `openspec_change_create` | Creates the change scaffold directly |
| Author the proposal | `openspec/changes/<change>/proposal.md` | `openspec_instructions` → write file | Returns the authoring guide; you write the file |
| Author the design doc | `openspec/changes/<change>/design.md` | `openspec_instructions` → write file | Returns the authoring guide; you write the file |
| Author specs | `openspec/changes/<change>/specs/<spec>/spec.md` | `openspec_instructions` → write file | Returns the authoring guide; you write the file |
| Author tasks | `openspec/changes/<change>/tasks.md` | `openspec_instructions` → write file | Returns the authoring guide; you write the file |
| Mark a change ready to implement | `tasks.md` + `specs/` placeholder | `openspec_change_promote` | Ensures checklist items and spec placeholder exist |
| Read a change or spec | Any artifact | `openspec_show` | Returns JSON: proposal, tasks, design, specs, deltas |
| Get the implementation guide | `openspec apply` instructions | `openspec_instructions` (artifact=`apply`) | Returns step-by-step apply instructions |
| Track task progress | `tasks.md` checkboxes | `openspec_task_set_status` | Toggles `- [ ]` ↔ `- [x]` |
| Check what artifacts exist | Change directory | `openspec_status` | Returns which artifacts are present/missing and readiness |
| Validate before archiving | All artifacts | `openspec_validate` | Returns validation errors |
| Archive a completed change | `openspec/changes/archive/` | `openspec_change_archive` | Moves the change dir to archive |
| Reopen an archived change | `openspec/changes/` (restore) | `openspec_change_unarchive` | Moves the change dir back to active |
| Compare a change spec against its baseline | Spec files (read-only) | `openspec_spec_diff` | Returns a structured semantic delta at the requirement/scenario level plus a unified line diff fallback. Filesystem-backed. |
| Create a spec from structured input | `openspec/specs/<spec>/spec.md` or `openspec/changes/<change>/specs/<spec>/spec.md` | `openspec_spec_create` | Writes formatted spec.md from title/purpose/requirements array. Overwrite with `force`. Filesystem-backed. |
| Read a spec as structured JSON | Spec files (read-only) | `openspec_spec_show` | Returns parsed title, purpose, requirements with scenarios and steps. Filesystem-backed. |
| List specs in a project | `openspec/specs/` or `openspec/changes/<change>/specs/` | `openspec_spec_list` | Returns array of spec names. Change-scoped or baseline. Filesystem-backed. |

---

## Tool → filesystem effect

If you know the Hermes tools but want the exact filesystem mutation, this is
the reference.

### Write tools

| Tool | Filesystem effect | Lifecycle transition |
|---|---|---|
| `openspec_idea_create` | Creates `openspec/ideas/<slug>.md` | → Idea |
| `openspec_idea_enrich` | Updates `openspec/ideas/<slug>.md` with structured report | Idea (stays) |
| `openspec_idea_promote` | Creates `openspec/changes/<change>/` (proposal, tasks, specs) | Idea → Draft |
| `openspec_change_create` | Creates `openspec/changes/<change>/` (proposal, tasks, specs) | → Draft |
| `openspec_change_promote` | Ensures `tasks.md` has checklist items + `specs/` has placeholder | Draft → Todo |
| `openspec_task_set_status` | Toggles checkboxes in `openspec/changes/<change>/tasks.md` | Todo → In progress → Done |
| `openspec_change_archive` | Moves `openspec/changes/<change>/` → `openspec/changes/archive/<change>/` | Done → Archived |
| `openspec_change_unarchive` | Moves archive dir back to active changes | Archived → Done |
| `openspec_spec_diff` | Returns structured semantic delta (requirement/scenario level) between change spec and baseline, or worktree spec and HEAD. Read-only. | (no transition — read tool) |
| `openspec_spec_create` | Writes formatted spec.md from structured input (title, purpose, requirements with scenarios). `change` scopes to delta specs; omit for baseline. | (creates spec file) |
| `openspec_spec_show` | Reads and parses a spec into structured JSON (title, purpose, requirements, scenarios, steps). Read-only. | (no transition — read tool) |
| `openspec_spec_list` | Lists spec names under `openspec/specs/` or `openspec/changes/<change>/specs/`. Read-only. | (no transition — read tool) |

### Read tools

| Tool | Returns | When to call |
|---|---|---|
| `openspec_context` | Repo path + change/spec content (resolves `os_*` identifiers) | First — gives you the `workdir` for all other tools |
| `openspec_list` | Changes or specs in a project | Before picking a change to work on |
| `openspec_show` | Full change or spec as JSON | To read proposal/tasks/design/specs/deltas |
| `openspec_status` | Artifact completion status (what exists, what's missing) | Before promoting or archiving |
| `openspec_instructions` | Authoring guide for an artifact (proposal, design, tasks, specs, apply) | Before authoring or implementing |
| `openspec_validate` | Validation errors for changes/specs | After editing, before archiving |
| `openspec_task_list` | Task ids, text, status, completion counts | Before marking tasks done |

> **Authoring note:** `openspec_instructions` returns the guide, not the
> artifact. After calling it, the caller writes the file (proposal.md,
> design.md, spec.md, tasks.md) using normal file tools. This is by design —
> the guide is reusable, the content is human/agent judgment.

## `openspec_context` references, explorations and reviews

`openspec_context` takes `<source>` or `<source>/<ref>`.

| Form | Example | Selects |
|---|---|---|
| Bare source | `demoapp` | Lists `changes`, `specs`, `ideas`, `explorations`, `reviews` with tokens (no file content) |
| Token | `demoapp/os_a1b2c3` | The single artifact with that token |
| Qualified | `demoapp/exploration:spike@demo` | One kind and scope |
| Unqualified | `demoapp/board-search` | The artifact, only when exactly one matches |

Grammar (`artifacts_index.parse_ref`):

```
ref        := token | qualified | literal
token      := "os_" 6*6HEXDIG
qualified  := "change:" NAME | "spec:" NAME | "idea:" STEM
            | "exploration:" STEM [ "@" CHANGE ]
            | "review:" STEM "@" CHANGE
literal    := NAME
NAME/STEM/CHANGE := 1*( ALPHA / DIGIT / "." / "_" / "-" )
```

- `exploration:<stem>` without `@` is workspace scope only; change-local explorations need `@<change>` or their token. `review:` always needs `@<change>`.
- Path separators, `..`, whitespace or an unknown qualifier return `ok: false, error: "invalid_ref"` and nothing is read.
- No match returns `error: "not_found"`. More than one match (a spec and an exploration with the same name, or one review stem in two changes) returns `error: "ambiguous"` with `candidates: [{kind, ref}]` (`ref` is the qualified form) and no content.

Result keys when a single artifact is resolved:

| Key | Fields |
|---|---|
| `exploration` | `name, filename, scope, token, title, date, path, content` |
| `review` | `name, filename, change, verdict, round, token, path, content` |
| `change` / `spec` / `idea` | unchanged; `change` also carries that change's `explorations` and `reviews` lists |

`scope` is `workspace` or `change:<change_name>`. `verdict` is `APPROVED`, `REJECTED` or `PENDING`; only a structured `Verdict:` line or a bolded marker counts, so prose such as "not approved yet" stays `PENDING`.

### Dashboard API additions

| Route | Returns |
|---|---|
| `GET /sources` | per source: `openspec.explorations`, `counts.explorations`; per change: `hasExplorations`, `hasReviews`, `reviewCount`, `latestVerdict`, `crewCards` |
| `GET /sources/{id}/changes/{change}` | adds `explorations`, `hasExplorations`, `reviews` (with `content`), `crewCards` |
| `GET /sources/{id}/explorations/{name}?scope=workspace\|change:<change>` | one exploration with `path` and `content`; HTTP 400 for a malformed name or scope, 404 when absent |
| `POST /sources/{id}/discover` | body `{"register": false}` (default) previews `candidates`; `{"register": true}` registers only new repositories (idempotent) |

`crewCards` entries are `{id, title, status, assignee, board, url}` with `url` of the form `/crew?card=<id>`. They are read from the Crew `kanban.db` files opened read-only and appear only when a card title or body names an artifact by `openspec/...` path or by token.

---

← [Back to overview](index.md) · [← Previous: Lifecycle](lifecycle.md) · [Next: Delegation →](delegation.md)
