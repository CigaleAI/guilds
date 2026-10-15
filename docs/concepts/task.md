# Task

The Task is the operator's standing purpose for one agent. It says
what the agent is for and how it should work: its role, its rules,
what good output looks like. Every run of the agent carries the Task
in its [system prompt](system-prompt.md).

Only the operator writes the Task. The agent reads it and follows it,
but never changes it. What the agent learns on its own goes to its
[Memory](memory.md) and its [notes](notes.md). Keeping the two apart
makes both easy to read: the Task is what the operator asked, Memory
is what the agent chose to remember.

## When you use it

- You create an agent and describe its job.
- You change how the agent works: a new rule, a new output format, a
  different priority.
- You want a long rule set, or a shared one, in every run: you write
  it in a [note](notes.md) and embed the note in the Task.

The Task is standing guidance. It is not a question for the agent to
answer, and it is not a reason for the agent to post in
[group chat](group-chat.md).

## How it works

### Where it comes from

A new agent's Task starts from the focus given when it was created.
Without a focus, it starts from a short repository template that asks
the agent to assist the user and collaborate with the guild members.

The orchestrator reads the Task when a run is created and puts it in
the `<task>` section of the system prompt. Changing the Task does not
change runs that already exist.

Every save keeps the previous text as a version. The operator can
look at any earlier version and restore it.

### Embeds

An embed pulls a note into the Task when a run starts. It is written
`![[display-path]]`, where the display path names a note
([Artifacts](artifacts.md)).

```mermaid
flowchart LR
  T["Task<br/>![[…/style-guide.md]]"] -->|"run starts"| P["system prompt<br/>Task section with the note's text inlined"]
  N["note style-guide.md<br/>![[…/glossary.md]]"] -.->|"one more hop"| P
```

- The note's text replaces the embed, inside an element named after
  the note, so the agent sees where it came from.
- Embeds inside that note are inlined too, one more hop. Embeds
  deeper than that stay as text.
- An embed of a [collection](collections.md) becomes the collection's
  name. Its records are not inlined.
- The same note embedded twice is inlined once. Later embeds of it
  become its title.
- Embedding a note does not let the agent read it with `note_get`.
  The text is in its prompt, but its grants stay as they are.

A short `[[name]]` in prose is plain text. It is not an embed and is
never rewritten. A file name, or a line like "inlined from: …", is
not an embed either.

Prompt Studio and the [Guild builder](guild-builder.md) put durable
rules in notes the operator can inspect, and embed them in the Task
only with `![[display-path]]`.

### A broken embed stops the agent

An embed must resolve to a live note or collection. When one does
not, the agent cannot start a run until the embed is fixed or
removed. The app marks the broken link in three places (see below).

A note that a live Task embeds cannot be deleted. This keeps embeds
from breaking by accident.

## In the app

The agent's **Prompt** tab edits the Task.

- The editor has **Edit** and **Preview** modes. Save, or
  Cmd/Ctrl+S, writes the Task. **Discard** drops the edits.
- **Insert › Note** and **Insert › Table** open a picker and insert
  the chosen note or collection at the cursor as `![[display-path]]`.
  A collection chip shows the collection's name. Clicking an embed
  opens a preview of it.
- An embed that no longer resolves is marked. A banner,
  **Runs can't start: the Task links to something that no longer
  exists**, names each broken link.
- The **Version** picker lists the live version and every earlier one,
  with when it was replaced and by whom. An earlier version shows as
  **Text** or **Compare with live**. **Restore v*N*** makes it the
  live Task again, as a new version.
- When another save lands while you edit, your text is kept and a
  banner offers **Compare**, **Keep mine**, and **Use theirs**.
- A provenance strip says who changed the Task last
  ([Artifacts](artifacts.md#every-change-is-recorded)).
- Leaving with unsaved edits asks first.

A broken embed is also marked on the agent's row in the sidebar and
in the agent inspector's header (**Broken file link in the Task**).

Prompt Studio drafts Task changes for the operator to review and
publish ([Prompt Studio](prompt-studio.md)).

The run's Chat tab shows the composed system message, with the Task
as it was at run creation ([Runs](runs.md)).

## Rules and limits

| Rule | Value or behaviour |
|---|---|
| Who writes the Task | operators only; agents never |
| Size | 256 KB |
| Earlier versions kept | 50 |
| Saving the same text | nothing changes, no version is added |
| Embed depth | the Task's embeds and one more hop |
| Embedded text per run | 64 KB in total |
| A broken embed | the agent cannot start a run |
| Deleting a note a live Task embeds | refused |
| Deleting `task.md` | refused |

## Reference

### Storage

The live Task is on the agent row: `agents.task`, with `task_version`,
`task_hash`, and `task_updated_at`. It is not an artifact. Its display
path, `org/<org_id>/agents/<agent_id>/task.md`, is virtual.

Each save that changes the text archives the previous text to
`task_revisions` (`version`, `content_text`, `replaced_at`,
`replaced_by_type`, `replaced_by_id`, `replaced_by_name`), keeping the
newest 50. An empty previous text is not archived. Each save appends
a `file_changes` row ([Artifacts](artifacts.md#file-provenance)).

A new agent's Task is its focus, or the template
`apps/orchestrator/src/prompts/task.md`.

The run's system row metadata records `task_source`: the Task's
`version`, `hash`, and `display_path`, `has_embeds`, and `embeds`,
each embedded note's `display_path`, `version`, `content_hash`, and
`kind`.

### Embed expansion

`apps/orchestrator/src/artifacts/embeds.ts` expands embeds at run
creation:

- The load is as the operator, so the agent's note grants do not
  limit it. Depth is 2. The budget is 64 KB of embedded note text in
  total.
- Each note body is wrapped in an element named after its file name
  without `.md`, reduced to letters, digits, `_`, and `-`, with
  `path` and `level` attributes:

  ```text
  <style-guide path="org/o_…/guilds/guild_…/style-guide.md" level="guild">
  …note text…
  </style-guide>
  ```

- A name that would clash with a prompt section (`guidelines`,
  `task`, `state`, `memory`) or cannot open an element is prefixed
  `note-`. An empty name becomes `note`.
- A collection path becomes the collection name.
- A path already inlined becomes the note's title (or its key
  without `.md`).

A run is refused with 422 when an embed fails:

| Case | Error |
|---|---|
| not a display path, missing, or deleted | `embed failed: <path> (<reason>)` |
| a path that is not a note or collection | `embed failed: <path> (not a note)` |
| more than 64 KB of embedded text | `embed budget exceeded` |

Deleting a note that a live Task embeds is 409
`note is embedded in task (<agent ids>)`.

Recipes write embeds in a recipe-local form, `![[guild/…]]`,
`![[org/…]]`, or `![[agent/<role>/…]]`, which apply rewrites into
display paths ([Recipe format](recipe-format.md),
[Applying recipes](applying-recipes.md)). A live Task that still
holds a `recipe:` link or a missing file shows as broken.

### HTTP

```text
GET  /api/agents/:agent_id/files/task.md      { path, display_path, content, version, revisions }
PUT  /api/agents/:agent_id/files/task.md      { content, expected_version? }
GET  /api/guilds/:guild_id/embed-status       { agents: [{ id, broken_embeds }] }
GET  /api/org/embeddable-notes                the notes the Insert picker offers
```

- `revisions` lists the earlier versions newest first:
  `{ version, content, replaced_at, replaced_by_name }`.
- A `PUT` whose `expected_version` is not the live version is 409
  `version conflict`. A non-integer `expected_version` is 422.
- A write that does not come from an operator is 422
  `task is not writable`. More than 256 KB is 422
  `write exceeds 256 KB`.
- `DELETE` on `task.md` is 422 `cannot delete this file`.
- `broken_embeds` lists each embed of the agent's Task that does not
  resolve: not a display path, a `recipe:` link that was not
  rewritten, missing, or not a note.
