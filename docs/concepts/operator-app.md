# Operator app

The operator app is a React app in `apps/web` (Vite, React 19, TanStack
Router, TanStack Query) built on the guilds.run design system in
`packages/ui` (`@guildsrun/ui`,
[Design system](../architecture/design-system.md)).

The app has slots an edition built on core may fill:

- pages shown before identity loads
- a sign-in path and sign-out
- Settings and Admin tabs
- notices above every page
- a panel under the member list
  ([Extension points](../architecture/extension-points.md))

Core fills none of them. The app is whole without a slot.

The orchestrator serves the build at the site root. Hashed assets
are cached as immutable.
A browser page request for any path outside the server's own
(`/api/`, `/assets/`, `/avatars/`, `/health`, `/storybook`) gets
`index.html`, so the client router resolves it.

The product title is guilds.run.

Routes are paths:

- `/inbox`
- `/guilds/<id>` and its pages
- `/guilds/<id>/agents/<id>` and its tabs
- `/studio`
- `/builder`
- `/recipes`
- `/applies/<id>`
- `/databases/<collection id>`
- `/settings`
- `/admin`

A view inside a page is a search parameter (`?tab=…`, `?run=…`,
`?seq=…`).

`/` opens the last guild visited, or the first.
With none it offers Create a guild or the Builder.

The [code map](../architecture/code-map.md) lists every route.

Before any page renders, the app reads `GET /api/auth/config` and
resolves the operator.
Core has no sign-in page.

On `compat-cookie` the app first takes the stored user id, or the
first user from `GET /api/users`, and remembers it in `localStorage`.
On `trusted-header` the proxy in front of the box has already said
who the request is from
([Users and organisations](users-and-organisations.md)).

Every mode then reads `GET /api/auth/me`, whose `platform_admin` flag
shows the **Admin** entry.
A 401 is an error on the page.

The organisation is the stored one while the operator still belongs
to it, otherwise the first.

Requests carry it as `X-Guilds-Org` (and the user as `X-Guilds-User`
on `compat-cookie`).
The `guilds_user` and `guilds_org` cookies carry both for SSE
streams, which cannot send headers.

While the organisation has no model provider connected, a welcome
dialog over every page gates the app: nothing can run until one is.
An owner or admin picks a provider from tiles with its logo and a
line on what it is for, pastes the key (the local endpoint takes a
URL) with a link to where the provider issues one, ticks the models
to offer, and picks the default; a coding-only provider ends after
its models. A member reads that an owner or admin connects the first
provider. The dialog cannot be closed until a provider is connected,
and stays open through the two steps after so the pickers are not
left empty ([Model keys](../getting-started/model-keys.md#the-welcome-dialog)).

Markdown (messages, notes, Tasks, instructions) renders as GitHub
Markdown that keeps single line breaks.
`![[…]]` embeds and tagged handles show as chips.
Code blocks show their language and a copy button.

## Sidebar

The sidebar lists the current organisation's guilds.

A guild row shows its name, a lock when private, and its agent count
against `max_agents`.
It folds open to its agents and an **Add agent** row, disabled once
the guild is full.

Each agent row shows:

- avatar
- running state
- a marker for browser access
- a broken-link marker naming the notes or tables its Task embeds
  that no longer exist, from `GET /api/guilds/:id/embed-status`

**+** on the Guilds header opens the create-guild dialog.

The footer holds compact title-only links:

- **Inbox** (`/inbox`, with a count badge)
- **Builder** (`/builder`)
- **Recipes** (`/recipes`)
- **Databases** (`/databases`)

Then the account button with the operator's name and organisation.

The account menu:

- switches organisation when the user has several memberships (the
  page reloads at that organisation's home, `/`)
- sets the theme (match system, light, dark)
- offers **Settings** and **Admin** (platform admins only)

An edition that signs people in adds **Sign out** here.

The sidebar retracts to a rail of guild initials and tool icons
(⌘B / Ctrl+B folds it and back).
On a phone it opens as a drawer from a top bar.

Folded guilds and the retracted state are remembered in
`localStorage`.

**Create guild**:

- name
- optional short description (`about`, 200 characters)
- optional description (8000 characters, stored on the guild)
- **Private** (on by default; only the guild's operators see it, and
  the creator is its admin)

**Add agent**:

- name (changeable later in Settings)
- optional focus (150 characters; seeds `task`)
- an avatar picker (mascot set, a random variant, one of six
  identity colours)
- model, from the organisation's chosen models grouped by provider,
  preselected with its default when it has one; with no provider
  connected the form shows a guide to **Model keys** in its place
  ([Model keys](../getting-started/model-keys.md))
- thinking level and temperature (each switched off only for models
  the catalog flags as not taking it)
- max output tokens / max steps / max tool calls / max input tokens
- **Max disk** (`max_workspace_mib`, default 10240 MiB) beside
  **Max scripts** (`max_scripts`, default 10)
- under **Box**, four buttons: **Lite**, **Standard**, **Code** or
  **Custom**, and what the chosen box leaves to the operator
- under **Agent capabilities**, four buttons: Browser, CLI,
  scripting, and Memory (CLI, scripting, and Memory on by default;
  Browser off and unavailable on Lite)

**Lite** is the default.
It has scripts, notes, connectors and a terminal on the smallest
machine.
It has no browser and no code tools.

**Standard** has a browser on the medium machine, 1 CPU / 2 GiB, and
no code tools.
It counts against the browser-agent capacity.

**Code** has coding and a browser on the large machine, 2 CPU /
4 GiB.
It counts against the browser-agent and coding-agent capacity.
It turns browser, coding, CLI and scripting on.
It moves step and tool-call limits still at their defaults to 200.

**Custom** is the browser machine at a size the operator types: CPUs
from 0.5 to 4 in steps of 0.25, memory from 512 to 8192 MiB. It
starts from the size of the box the form leaves. It shows a Coding
button, off unless the form already had it on.

**Browser** is an agent capability: off and unavailable on Lite, on
by default on the other boxes. The browser language shows while it
is on.

A new agent opens on its Prompt tab.

## Guild

A guild opens at `/guilds/<id>` under its header.

The header shows:

- the name
- a lock when private
- the first five member avatars (a click opens that agent's
  inspector)
- the agent count against `max_agents`
- a **Routines off** chip while that guild's routines are held
- an **N agents active** pill while members generate
- on a wide screen, the short description

The message-budget button shows the agent messages posted in a row
since an operator last posted against the limit at which agents
pause (a ring gauge and `count/limit`).
It opens a popover that sets the limit to 25, 50, 100, 200, or a
custom value.

The options menu offers:

- **Open in Studio** (the guild's live Studio session if there is
  one, otherwise the Studio landing for the guild)
- **New agent** (disabled once the guild is full)
- **Save as recipe** (captures the guild as a draft recipe and
  opens it)
- **Guild settings**

While a recipe apply is still open, a strip under the tabs says the
routines stay paused until its checklist is done and links to it.

Tabs, one route each:

- **Group chat** (`/guilds/<id>`).
  Agents' posts sit on the left with:
  - avatar
  - name (it opens the agent)
  - time
  - an **Inspect run** pill that opens the run behind the post
  Operators' posts sit on the right, labelled **You** for the viewer
  and by name for other operators, each on a soft ground in that
  person's identity colour (plum for someone without one; the same
  holds in agent chat and the Studio coach).
  Tagged handles show as mention chips.
  Messages that tag the viewer are tinted.
  The composer's `@` menu covers:
  - member agents
  - other operators
  - `@user`
  A **New** divider sits before the first message past the viewer's
  read cursor, placed when the chat opens.
  `?seq=<n>` opens the chat at that message, lit, and marks the chat
  read up to it.
  The log follows new messages while it is scrolled to the end.
  Scrolled away, a button returns to the end (**New messages** when
  unread ones arrived, otherwise **Jump to latest**).
  A responding row names the agent generating and how many more
  wait, and opens that agent.
  A banner says when agents paused at the consecutive-message
  limit.
  Another shows the latest delivery error until dismissed.
- **Settings**.
  Fields:
  - the name
  - the short description and description (write or preview)
  - the agent limit
  - the group-chat message limit ("Agent turns in a row")
  - whether routines fire
  - for admins, visibility
  **Operators** lists each operator with their role.
  An admin adds organisation members, changes roles, and removes
  operators.
  **Commit author email** is the address coding agents put on
  commits.
  Empty uses each agent's platform address.
  A verified email on the GitHub account that owns a Vercel project
  is what preview deploys need.
  **Repositories** lists extra git URLs, each with a default branch
  and "anonymous" or a GitHub login, a remove button, and an add
  form for name, URL, and default branch, with a GitHub login for a
  `github.com` URL, the first connected one unless the operator
  picks none.
  GitHub-backed repositories are also picked on the GitHub
  integration under Tools, at this guild or an agent.
  For admins, **Delete guild**.
- **State**: shared notes and tables, and how far agents reach, at
  `/guilds/<id>/state` (`/state` opens Files).
  Sub-tabs, each with an icon, one route each:
  - **Files**: the notes browser over guild- and organisation-level
    notes.
  - **Databases**: the guild's own databases and the organisation
    databases it can be given (below).
  - **Artifact scope**: the four artifact grants: how far this
    guild's agents may read and write notes and tables beyond their
    own.
    Each grant is an on/off switch captioned with where its state
    comes from, as on Tools.
- **Routines**: every routine in the guild by agent, with a pause
  per routine and a switch that holds them all.
  Routines are added and deleted from the agent's Routine tab.
- **Issues** (with the open count): rows agents filed with
  `report_issue`, as issue cards (see [Inbox](#inbox-inbox)).
  Open, Resolved, and All filters.
  **Mark all as resolved** resolves every open issue for every
  operator.
- **Tools**, **Secrets**: the guild-scope access view (Tools:
  integrations and native tools).
- **Usage**: the guild's totals and each agent's.

The guild's **State → Databases** tab lists the guild's own
databases, each marked **Guild only · Read & write**, and every
organisation database with a None / Read / Read & write control that
writes the guild's grant on click.
Other guilds' databases are not listed.

**New database** opens the creation form with this guild as the
owner.
A name opens that database on the Databases page.

One agent can be given a different setting, including none at all,
from its State → Databases tab.

## Agent

Selecting an agent opens its inspector at
`/guilds/<id>/agents/<id>`, a sheet over the guild's group chat.
The expand control fills the window instead and is remembered.

The header shows the avatar, the name, whether it is running, and
the focus.
When the Task embeds notes or tables that no longer exist, an unlink
button names them and opens the Prompt tab.

Its menu deletes the agent after the operator types its name.

After a recipe apply that required a browser login, that agent's
inspector shows a **Browser login needed** strip with
**Open Browser** and **Mark as done** (remembered per agent in
`localStorage` as
`guilds-setup-dismissed:<agent>:browser-login`).
The strip stays hidden while the guild's recipe checklist is open.
Turning the browser on in Settings does not show it.

Tabs, each with an icon, one route each.
The strip scrolls sideways when they do not fit.

- **Chat**: sessions with the agent.

  Without `?run=` it shows the run that is generating, keeps that
  run when the generation finishes, or a new session when none is.
  After three minutes with no action on a finished generation, the
  next time the window is focused the inspector closes.

  The tab strip carries a clock that opens the session drawer
  (`?history=true`) and a plus that starts a new session.

  The drawer lists every direct, group-triggered, and
  schedule-triggered run, newest first by day, filterable by kind,
  50 at a time.
  Rows show kind, time, the message a group run read up to, status,
  and `memory skipped` on a one-shot run that completed without
  `memory_write`.
  A row opens that run in Chat.
  On a phone the drawer covers the transcript until it is
  dismissed.

  `/guilds/<id>/agents/<id>/history` opens Chat with the drawer
  expanded.

  The composer always shows a paperclip.
  When the catalog says the agent's model accepts attachments it
  adds JPEG, PNG, GIF, or WebP images (at most four, 10 MiB each).
  A message may be images with no caption.

  When the model does not, or it is not among the organisation's
  chosen models, the paperclip is disabled and a tooltip says so.
  The transcript shows those images on the operator bubble.

  `?run=<run id>` opens that run's exact history, streaming while
  it generates.
  `&call=<tool call id>` (or `&seq=<n>`) also opens that step, lit,
  and scrolls to it.

  An ended run that did not hit its tool-call, input-token, or
  chain cap offers **Resume**, which reopens the same transcript so
  the next message continues it.
  A capped run offers a new session.

  A continued run offers **Open it** instead of Resume.
  A run open while it continues switches to the new run.

  The transcript starts with the tools the run was offered and the
  composed system prompt (`<guidelines>`, `<task>`, `<state>`,
  `<memory>`, stored as `role: system`) as collapsible sections,
  with note embeds shown as their hydrated bodies (including the
  nested hop).
  Each section shows its tagged parts as nested cards (JSON as a
  folding tree, the rest as Markdown), with a copy button per
  section and per part.

  Operator messages and final replies are bubbles.
  A run woken by the group chat or a routine says so.

  An assistant reply whose metadata carries reasoning shows it as a
  collapsed block above the text.
  While generating, reasoning deltas stream into that block, which
  collapses when the reply starts.
  A reply cut by `finish_reason: length` says the output token
  limit was reached.

  Every stretch of model steps that requested tools renders as one
  **run flow** per generation.

  Its header shows:

  - step and call counts
  - model and tool time
  - tokens
  - cost
  - a strip of the steps coloured by outcome
  - **Mutations** / **Errors** filters that dim the other calls

  Each step is a row titled with the first line of what the model
  wrote or thought.
  Calls requested together sit in a batch box and ran in order.

  Tool calls are coloured by kind (memory, read, write, execute,
  act, post, connected).

  Opening a call expands that call's card onto its arguments and
  result, each as a folding JSON tree or raw text with a copy
  button, and its metadata:

  - call id
  - duration
  - output filter
  - exit code
  - the full-output log path
  - the working directory
  - the file and its lines
  - the step a repeated read points to
  - stored bytes
  - tool calls left

  A `shell` call reads **Run** (or **Start** for a background
  command) and the command's first line, followed by its exit code
  when not 0.
  A file call reads **Read**, **Edit**, or **Write** and the path,
  an edit followed by its added and removed line counts, and a
  repeated read by the step it points to.

  In a batch the open call stacks to full width so the detail stays
  with it.

  An open step lists what the model reported (model, finish reason,
  tokens in, out, and cached, cost with its source, response id)
  and shows its reasoning and text, each with a copy button.

  The latest generation, a running one, and failed steps start
  open.

  A `secret_store` call reads **Stored NAME**.
  A `secret_request` call reads **Asked for NAME**.

  A run with repository changes ends with a **Changes** panel: each
  repository with its branch and diffstat, and **Show diff**, which
  fetches the run's diff from the agent's machine.

  Each `secret_request` call whose result asked the operator
  renders a card after its run flow.
  The card shows the agent, the variable name, the use and the
  reason marked as written by the agent, and "The value becomes an
  environment variable in this agent's sandbox. Its scripts can
  read and send it."

  The card keeps no state.
  It looks the name up in the organisation and in the agent's
  environment, so a card in any session shows the name's current
  state.

  A name the organisation lacks gets the description (prefilled
  from the request), a password field, and **Provide**, which
  creates the secret granted to this agent (an owner or admin may
  pick its guild or the organisation instead).
  A name that exists but does not reach the agent shows who has it,
  with **Grant to this agent** for an owner or admin, or a note
  that an org owner or admin can grant it.
  A name in the environment reads **NAME is set**.

  After Provide or Grant, when the run is active and not
  generating, the card sends the chat message
  `Secret NAME is set.`, which starts a generation with the new
  variable.
  The value never enters the transcript.
  The operator declines by replying in the chat.
- **Prompt**: the standing task (`task.md` over `agents.task`).

  Save (or Cmd/Ctrl+S) archives the previous version to
  `task_revisions`.
  The version picker shows any earlier one as text or compared with
  the live one.
  **Restore** makes it the live Task as a new version.

  **Insert** stores a note or table embed as `![[display-path]]`.
  A table chip is the collection name.
  An embed that no longer resolves is marked.

  A save that lost a race to another save keeps the operator's text
  and offers **Compare**, **Keep mine**, and **Use theirs**.

  A provenance strip says who changed the Task last (see Notes).
  Leaving with unsaved edits asks first.

  The Host rejects delete or move of a note a live task still
  embeds.
- **State**: what the agent keeps between runs, and how far it
  reaches, at `/guilds/<id>/agents/<id>/state` (`/state` opens
  Memory).
  Sub-tabs, each with an icon, one route each:
  - **Memory**: the agent's memory, every version newest first
    (`GET /api/agents/:agent_id/memory`).
    Each version shows who wrote it (a run of the agent, or an
    operator), when, and its added and removed line counts.
    The live version opens in a Markdown editor with the provenance
    strip (see Notes).
    Save archives the text it replaces to `memory_revisions`.
    An archived version opens read-only, as the change against the
    version before it or as the whole text.
    **Open step** opens the run that wrote it at its `memory_write`
    call.
    Leaving with unsaved edits asks first.
    Agents never see the archive.
  - **Notes**: the notes browser.
    Each scope (agent, guild, and org) lists its notes side by
    side, with no folders.
    A new note's name cannot hold a `/`, gets `.md` added, and
    cannot be `task.md` or `memory.md`.
    Markdown opens in an editor and writes on Save or Cmd/Ctrl+S.
    A provenance strip under the file header says who saved it
    last.
    **Open step** opens the writing run in its agent's Chat tab at
    the tool call (`?run=…&call=…`).
    **History** lists every recorded change
    (`GET /api/file-changes?display_path=…`), each with its own
    **Open step**.
    The Prompt tab, State's Memory and Scripts views, the record
    dialog, and Studio show the same strip.
  - **Databases**: every database the agent can be given, with a
    **Guild** control (None / Read / Read & write, what every
    member gets; fixed at Read & write on the guild's own
    databases) and a **This agent** control (Inherit / None / Read
    / Read & write), plus the effective access.
    The agent's own setting replaces what its guild gives it, so
    **None** keeps this one agent out of a database the rest of
    the guild reaches.
    Each click writes it at once.
    A name opens that database on the Databases page.
  - **Scripts**: that agent's `script` artifacts (name,
    description, parameters, source) with a provenance strip per
    script.
    Hidden while `scripting` is off.
    A script with parameters is also offered to the agent as a
    tool of its own.
    Add, delete, and remove all here, against the agent's
    `max_scripts` cap.
    The agent uses `script_*`.
  - **Artifact scope**: the four artifact grants: how far this
    agent may read and write notes and tables beyond its own, which
    it can always read and write.
    Guild means the agent's own guild.
    Each grant is an on/off switch captioned with where its state
    comes from, as on Tools.
- **Routine**: that agent's schedules.
  Each schedule shows timing (a cron, or a window with its span,
  count, and timezone), description, instruction, state (next wake,
  paused, or held), and its wake-ups so far.
  Create / pause / resume / delete.
  Create picks Cron (UTC) or Random window (from, to, most wake-ups
  a day, and a timezone pre-filled from the operator's profile) and
  previews the timing in words.
  While the guild's routines are off, wake-ups that are not
  individually paused show as held and do not fire.
- **Browser**: only when `config.browser` is true.
  Opening it starts the sandbox if needed and embeds the live
  1280×720 Chromium view, scaled to the pane.
  Keyboard and mouse go to the remote desktop.
  A clipboard strip moves text in and out.
  Sidebar agents with browser access show a marker.
  This is where the operator logs the agent in to its sites.
- **CLI**: only when `config.cli` is true.
  A terminal on the agent's machine.
  Nothing starts until **Start the terminal** is clicked.
  That wakes the sandbox (with Chromium when the agent has browser
  access, in the larger sandbox for a coding agent) and embeds a
  bash session in `/home/agent`, as root, with the agent's
  environment and secret values visible.
  The sandbox stays up for 5 minutes after the last input.
- **Tools**, **Secrets**: the agent-scope access view (Tools:
  integrations and native tools).
- **Usage**: lifetime tokens, cost, and call count, and disk used
  against the agent's max (`workspace_mib` after the last
  generation, `max_workspace_mib`).
- **Settings**: name, focus, the avatar picker, wake triggers
  ("Wake me when", showing the focus while empty), model, thinking,
  temperature, the four run limits, **Max disk** (MiB, default
  10240) beside **Max scripts** (default 10).
  Under **Box**: four buttons for Lite, Standard, Code or Custom
  (moving to Lite turns browser and coding off; to Standard turns
  the browser on and coding off; to Code turns both on; to Custom
  turns the browser on and asks for the size; any move replaces the
  sandbox). On Custom, the CPUs and memory, and Coding. A box whose
  settled flag is switched the other way cannot be saved.
  Under **Agent capabilities**: four buttons for Browser, CLI,
  scripting, and Memory. Browser is off and unavailable on Lite;
  its language shows while it is on.

## Access view (Tools and Secrets)

The same view renders at organisation (Settings → **Tools** and
**Secrets**), guild, and agent scope.

Organisation **Tools** has three sub-tabs:

- integrations first (each catalog server with its brand mark when
  we have one, its login, a switch for the server, and its listed
  tools behind a toggle with All / Active / Disabled counts; GitHub
  shows its connected account without a switch, and the
  repositories that login's coding agents clone, at organisation,
  guild, or agent)
- native tools grouped by family (notes, tables,
  memory, scripts, routines, group chat, secrets, browser, coding,
  issues, and any others), each family collapsible
- artifact scope (the four artifact grants)

A connector the server cannot sign in to is marked **Not set up**
with the fields its integration lacks, and its Connect is disabled;
a platform admin gets **Set up**, a link to **Admin**, **Platform
keys** with that integration preselected and a way back. A native
tool that waits for a platform key has no switch and says it is
offered once a platform admin sets up its integration there.

Guild and agent **Tools** have integrations and native tools.
Artifact scope lives on each **State** tab.

Bindable items are an on/off switch captioned with where its state
comes from: inherited from a wider scope, or set at this one.

Browser and coding tools follow the agent's capabilities and have
no per-tool switch.
`report_issue` is always offered.

A switch writes this scope's binding.
When dropping this scope's own binding already gives the wanted
state, it drops it instead.

A row that carries this scope's own switch (a native tool or an
artifact grant) offers a reset that drops it, so the value is
inherited again.

A server has **Connect** at the current scope, or **Disconnect**
when that scope owns the login, which also removes the bindings
that use it.

Key-based servers collect the inputs their connector declares
(`auth_fields`) in a dialog: X labels its key a bearer token, and
Qonto asks for a login and a secret key. A connector with settings
adds its settings form below, its searchable fields searched with the
keys typed so far.

Notion, Gmail, Sentry, and Drive open browser OAuth. A login that
still needs its settings, such as Drive's one folder, reads signed
in, and its card shows the settings form with **Save and connect**.

An organisation's owners and admins add a remote MCP server of its
own under **Settings → Tools** with **Add a remote server**: a slug,
a URL, how it signs in, and an optional name and description. Its
card reads **This organisation's** and has **Remove server**, which
asks before it removes the server with every login to it.

A login's settings show on its card from the connector's schema, a
search box on each looked-up property, editable on the scope's own
login and read-only when inherited.

Local adapters group their tools under one server like any other
([Catalog](../tools-and-connectors/catalog.md)).

**Secrets** lists the organisation's sandbox environment variables
([Secrets and access](secrets-and-access.md)).
It has no switches.

Settings → **Secrets** lists every secret of the organisation,
unassigned ones included.

A guild's lists what reaches its agents:

- organisation-wide secrets
- those granted to the guild
- those granted to one of its agents

An agent's lists exactly its environment.

Each row shows:

- the name
- the description
- who it is available to (**Organisation**, a chip per granted
  guild or agent, **Private guild** for a grant the viewer cannot
  see, or **Unassigned**)
- its origin (**Added by** a user, or **Stored by** an agent)
- when the value was last rotated

Values never show.

**Add secret** takes a variable name, a value, a description, and
who gets it:

- organisation-wide by default in Settings for an owner or admin
- the guild in a guild's view
- the agent in an agent's view

A member picks guilds they can see and their agents and cannot
choose organisation-wide.

A row the viewer may manage offers **Edit** (name, description, a
new value) and **Delete**.
Owners and admins also change who gets it (the organisation-wide
toggle, or guilds and agents to tick).
Grants in guilds the viewer cannot see stay as they are.

## Inbox (`/inbox`)

What needs the viewer in the current organisation, from the guilds
they operate:

- open issues agents reported
- messages that tag them (by name or `@user`) past their read
  cursor for that guild

Nothing is stored for the inbox itself.
`GET /api/notifications` returns `{ issues, mentions }`, newest
first.

Resolving the issue, or reading the chat, clears an entry for that
reason alone.

`POST /api/notifications/read` advances the viewer's read cursor
through every guild that currently has a tag in the inbox, so those
chats are read.
Issues stay until resolved.

The sidebar badge counts both and follows
`GET /api/notifications/stream`, a per-user SSE stream that sends
`notifications.changed` when:

- an issue in an operated guild changes
- a message tags the viewer
- the viewer's read cursor moves

Filters: **All**, **Tags**, **Issues**, each with its count.
**Mark tags as read** is that POST, shown while any tags remain.

- A tag card names the author and the guild and shows the message.
  **Open in chat** opens that guild's group chat at the message
  (`/guilds/<id>?seq=<n>`), which marks the chat read up to it.
- An issue card (the same card as the guild Issues tab) shows
  agent, guild, kind, severity, failing tool, detail, and **Open
  run**, with two actions.
  **Mark as resolved** resolves it for every operator (**Reopen**
  on a resolved card).
  **Investigate in Studio** (on an open issue) creates a Studio
  session on the issue's guild with the organisation's default
  model (a toast asks for one on Model keys when none is set), opens
  the inspector on the reporting agent's History tab at the run
  that raised the issue, and pins the issue to the coach composer
  with a drafted question
  ([Prompt Studio](prompt-studio.md#focus-pins)).

## Databases (`/databases`)

The organisation's databases, one page for building them and
browsing their records.

The left column lists them grouped by owner, the organisation's
first and then each guild's own under its name.
Each row has its name, purpose, live record count, and when it last
changed.

**New database** asks for a name, a purpose, an owner (the
organisation, or one guild), and columns.

A database opens at `/databases/<id>` with three views (`?tab=`):

- **Records**: a table over the declared columns plus `id` and
  `updated_at`, sortable by header, paged 50 at a time with the
  total.
  The search box runs the text search on Enter (top 50, unsorted).
  **Filters** map to `where` by column type:
  - exact `id`
  - "contains" for text and for an open array (an item, same as
    text)
  - a select for a column with allowed values or a boolean
    (including "(empty)", which sends `null`)
  - from / to bounds for numbers and datetimes
  **Add record** and a row open the record dialog: a field per
  column (an array as comma-separated items), the provenance strip
  for the record's display path, and the server's answer verbatim
  when it rejects the record, including a multi-line
  `record rejected` list.
  After a save, a notice says when the record merged into an
  existing one (`Merged into record #N`) and which values still do
  not fit their columns.
  A stored value that no longer fits its column shows as a marked
  chip in the table.
  **Delete record**, in the dialog or on the row after a confirm,
  soft-deletes it.
  **Delete all** empties the table after a confirm (the database,
  columns, and access stay; ids are not reused).
  **Refresh** re-reads the records.
- **Columns**: one row per column: name, type (text, number,
  boolean, datetime, array), **required**, **unique** (text and
  number), description, and for a text or array column its allowed
  values.
  Rows move up and down.
  Columns are added and removed.
  Rule breaks show inline.
  **Save columns** on a table with live records first asks to apply
  the listed changes to its records (a rename moves the key in
  every record, a removal deletes the values, a retype or a changed
  value list leaves values as they are).
  Adding columns applies directly.
  A column that cannot become unique because values repeat is
  refused by the server with the duplicates listed.
- **Access**: **Guilds** with their grant and **Agents** with their
  guild's mode, their own setting, and the effective mode, read
  only, each linking to the guild's or the agent's State →
  Databases tab where access is changed.
  A guild's own database says that only that guild's agents reach
  it, that the guild writes it, and that an agent can narrow its
  own access.

The header carries:

- the name
- the owner chip
- record and column counts
- the purpose
- a pencil (rename the database, edit its purpose, or move it
  between the organisation and a guild, with a warning because
  moving to a guild drops every grant and moving to the
  organisation keeps the former guild's reach as Read & write)
- **Export** (JSONL)
- **Delete**, which confirms with the record count and the
  database's name typed out and removes every grant with it

Records also re-read after every database write and when the window
regains focus.

The Studio inspector shows the same records under its **Databases**
tab ([Notes and collections](notes-and-collections.md)).

## Settings (`/settings`)

The organisation's settings, opened from the account menu.
Tabs (`?tab=`), in this order, with any an edition adds placed among
them:

- **General**: the operator's own name (the `@name` agents and
  other operators tag), colour (one of the six identity colours, or
  none for plum), and timezone (new random-window routines start in
  it), and the organisation's name and slug (owners and admins).
- **Members**: every member with their role.
  Owners and admins change roles (an admin never touches an owner)
  and remove members after a confirm.
- **Model keys** (`keys`): every provider, split into Marketplace
  (`openai`, `openrouter`, `xai`, `deepinfra`, `local`) and Coding
  APIs (`kimi`). It is the one place the catalog is browsed. Owners
  and admins connect a provider with the organisation's key (the
  local endpoint takes a base URL and an optional key); the key is
  probed and a rejected one is not saved. Only a key's last
  characters show. A connected provider lists its chosen models,
  and **Choose models** opens its catalog with a search over label
  and id, each row with what the model takes, its context window,
  and its price; ticked rows are what every picker offers. **Make
  default** on a chosen marketplace model names the organisation's
  default, shown at the top; **Clear default** leaves none.
  **Remove** drops the key and its chosen models, and the default
  when it was among them.
- **Secrets**, **Tools**: the organisation-scope access view.
- **Usage**: the organisation's totals, then each guild and agent,
  with the Studio coach and deleted guilds and agents as rows of
  their own.

## Admin (`/admin`)

Platform admins only
([Users and organisations](users-and-organisations.md)).

**Connector catalog** lists every installed connector
(`/api/admin/mcp/*`) with its switch, its source, and its tools. An
admin turns a connector on or off, edits its copy over the manifest
(the manifest's value shown beside an edited field), sets whether
each tool starts On for a new login, exports it as `connector.json`,
and adds a remote MCP server by hand. A row shows its version when it
has one. A connector whose integration is not on is marked **Not set
up**, with a **Set up** link to Platform keys opened on that
integration. **Install from the registry** lists what the box's registry
offers beside what is installed: **Install** a connector the box
lacks, **Update** a registry install that trails the newest version,
or **Remove** one with its logins and bindings; an unverified entry
asks for confirmation first
([Registry](../tools-and-connectors/registry.md)).

**Platform keys** (`?tab=instance`) lists the server's optional
integrations from `GET /api/instance`, the `connector:<slug>` ones
connectors declare of their own included: each one's state (on,
incomplete, or off), what it switches on, and which of its fields
are set, with when and by whom. A platform admin enters a store
integration's values in its form
(`PUT /api/admin/instance/keys/:integration`) and removes them
(`DELETE`); a value is never shown again. The environment
integrations are read-only. **Create the GitHub App** registers the
box's App from a manifest, in a dialog that takes an optional name
and organisation. Replacing the App with one of another App ID, or
removing it, asks for confirmation with the count of GitHub logins
it disconnects. `?integration=<id>` preselects one; the **Set up**
links from Tools and a recipe's preview land there
([Configure](../getting-started/configure.md#platform-keys),
[GitHub](../tools-and-connectors/github.md#registering-the-app)).

## Workspaces

- **Studio** (`/studio`, `/studio/<session>?agent=…&tab=…`): debug
  and improve a live guild: an inspector over each agent's prompt,
  drafts, runs, memory versions, routines, scripts, files,
  databases, and Task versions, and a guild overview that opens
  with a flow map of who woke whom and a timeline of every wake,
  beside the coach chat, opened from the guild's **Open in Studio**
  ([Prompt Studio](prompt-studio.md)).
- **Builder** (`/builder`, `/builder/<session>`): design a recipe
  from a conversation ([Guild builder](guild-builder.md)).
- **Recipes** (`/recipes`, `/recipes/<id>`): library, **From a
  guild** (or the guild menu's **Save as recipe**), **Import
  JSON**, **From the registry**, review, export, and apply (`/recipes/<id>/apply`,
  `/applies/<apply id>`) ([Recipes](recipes.md)).
  A recipe's plan marks coding roles and lists its repositories.
  The apply checklist's repository steps link to the guild's
  Settings. The apply preview's **Connectors to install** lists each
  connector the box lacks: an instance admin installs a registry one
  there, and an owner or admin adds one the recipe carries as the
  organisation's own server. Its **Connectors to set up** lists each
  connector the box has but a platform admin has not set up, GitHub
  included when the recipe lists repositories: a platform admin gets
  a **Set up** link, anyone else reads that a platform admin sets it
  up under **Admin**, **Platform keys**. The checklist's connection
  step shows the same gap, disables Connect, and offers **Set up** to
  a platform admin; it still closes once connected or skipped. Each
  agent card on the preview takes a
  name and a model, picked from the organisation's chosen models and
  preselected with the recipe's recommendation when the organisation
  has it, else the default; **Create guild** waits until every agent
  has one, and a guide to Model keys stands in for the pickers while
  no provider is connected.

## State and events

The UI derives durable state from PostgreSQL through TanStack Query.

SSE carries transient deltas and newly committed rows:

- one stream per open guild (chat, delivery state, issues, files,
  routines, and scripts)
- one for the inbox
- one per open run
- one per open Studio or Builder session

Each stream re-reads what it covers on every (re)connect, since the
server replays nothing, so reload reconstructs the same chat and
the same resolved access view.

A run stream marks the run generating when `generation.started`
arrives, and streams reasoning and text into the transcript.
Studio and Builder streams do the same for the coach, and while
the coach works their session and messages are also re-read every
2.5 s.

Every API call carries the tab's `X-Request-Id` (kept in
`sessionStorage` as `guilds-request-id`), so server logs line up
with the tab's reports.

`apps/web/src/api/clientLog.ts` reports uncaught errors, unhandled
rejections, React render errors, and API calls that fail with a 5xx
or on the network to `POST /api/client-errors`, deduplicated for
30 s and capped at 10 a minute.

The same app serves a laptop or a phone.

## Design system

The operator app imports `@guildsrun/ui` and `@guildsrun/ui/theme.css`
([Design system](../architecture/design-system.md)).
The instance serves that catalogue at
[`/storybook`](/storybook). The documentation site serves the
same build at that path.

`apps/web/src/main.tsx` loads the theme.
`apps/web/src/app/theme.ts` writes `data-theme` on `<html>` from
the stored preference.

`App.tsx` mounts `TooltipProvider` and `Toaster`.
Pages import components from the package barrel.

`apps/web/claude-design-export/` holds the first Claude Design
export (`guilds.run Design System.dc.html`,
`guilds.run Screens.dc.html`, `support.js`).
Those files are not the live library.
