# Screen map

Every screen of the operator app, where it opens, and the page that
explains it. The app's title is guilds.run. The orchestrator serves
it at the site root, and the same app works on a laptop or a phone.

How the app is built, how a page loads its user and organisation,
and every route with its search parameters are in
[Web app](web-app.md).

## Back button

A link in a page's content that leads to another tab or page, such as
a tool call's memory chip in an agent's chat or a link in guild
settings, leaves a round back arrow floating over the top left of the
page's body, just under the agent's or guild's tab row. It returns to
the exact place the link was followed from, the open run and call
included. Its tooltip names that place: its tab within the same agent
or guild ("Back to Chat"), its full name from elsewhere ("Back to
agent chat", "Back to guild settings").

Moving within the new place keeps the button. Going back, or moving
to another place by the tabs, the sidebar, or the browser, clears it.
Links in tab rows and headers are the app's own navigation and leave
no button.

## Markdown

Messages, notes, Tasks, and instructions render as GitHub Markdown
that keeps single line breaks. `![[…]]` embeds, `[[…]]` references,
and tagged handles show as chips. Code blocks show their language and a copy button.

## Screens

| Screen | Route | Explained in |
|---|---|---|
| Welcome dialog | over every page | [Model keys](../concepts/model-keys.md) |
| Home: opens the last guild visited, or the first; with none, **Create a guild** or **Use Builder** | `/` | [Guilds](../concepts/guilds.md), [Guild builder](../concepts/guild-builder.md) |
| Not-found page: **Nothing lives at this address**, with **Back to your guilds** | any unknown path | this page |
| Sidebar: **Inbox**, **Builder**, **Recipes**, **Tables** | every page | [Inbox and issues](../concepts/inbox.md), [Guild builder](../concepts/guild-builder.md), [Recipes](../concepts/recipes.md), [Collections](../concepts/collections.md) |
| Sidebar: guild rows, each with its unread message count | every page | [Guilds](../concepts/guilds.md), [Inbox and issues](../concepts/inbox.md) |
| Sidebar: agent rows and **Add agent** | every page | [Agents](../concepts/agents.md) |
| Collapsed rail (⌘B / Ctrl+B): the same entries, guild unread badges, and **Settings** | every page | [Guilds](../concepts/guilds.md) |
| Account menu: **Organisation** switch, **Theme**, **Desktop notifications** (when the browser supports them), **Settings**, **Admin**, **Sign out** | every page | [Organisations](../concepts/organisations.md), [Users](../concepts/users.md), [Inbox and issues](../concepts/inbox.md) |
| **Create guild** dialog | from the sidebar | [Guilds](../concepts/guilds.md) |
| **Create an agent**: choice of agent or coding agent | from **Add agent** or the guild's **New agent** | [Agents](../concepts/agents.md) |
| **Create an agent** (Identity, Model, Machine) | from **Add agent** | [Agents](../concepts/agents.md), [Machines](../concepts/machines.md), [Agent home](../concepts/agent-home.md) for **Disk** |
| **Create a coding agent** (Identity, Machine, Harness, Lead model, Repositories) | from **Add agent** | [Coding agents](../concepts/coding/index.md), [Harnesses](../concepts/coding/harnesses.md), [Repositories](../concepts/coding/repositories.md) |
| Guild header and **Guild options** menu: **Open in Studio**, **New agent**, **Save as recipe**, **Guild settings**, **Clear group chat** | `/guilds/<id>` | [Guilds](../concepts/guilds.md), [Group chat](../concepts/group-chat.md) |
| Guild message-budget button | `/guilds/<id>` | [Group chat](../concepts/group-chat.md) |
| Open recipe apply strip | `/guilds/<id>` | [Applying recipes](../concepts/applying-recipes.md) |
| Guild **Group chat** tab, with the queue of messages waiting for busy agents | `/guilds/<id>` | [Group chat](../concepts/group-chat.md) |
| Guild **Settings** tab | `/guilds/<id>/settings` | [Guilds](../concepts/guilds.md) |
| Guild Settings: **Operators** | `/guilds/<id>/settings` | [Operators](../concepts/operators.md) |
| Guild Settings: **Commit author email**, **Repositories** | `/guilds/<id>/settings` | [Repositories](../concepts/coding/repositories.md) |
| Guild **State › Files** | `/guilds/<id>/state/files` | [Notes](../concepts/notes.md) |
| Note **Access** button and the **Access to `<path>`** dialog | the header of an open note in the notes browser: Guild **State › Files**, Agent **State › Notes**, Studio | [Access](../concepts/access.md#the-access-panel), [Notes](../concepts/notes.md) |
| Guild **State › Tables** | `/guilds/<id>/state/tables` | [Collections](../concepts/collections.md#what-a-guild-or-an-agent-reaches) |
| Guild **State › Access** | `/guilds/<id>/state/access` | [Access](../concepts/access.md#what-a-guild-or-an-agent-reaches), [Notes](../concepts/notes.md), [Collections](../concepts/collections.md) |
| Guild **Routines** tab | `/guilds/<id>/routines` | [Routines](../concepts/routines.md) |
| Guild **Issues** tab | `/guilds/<id>/issues` | [Inbox and issues](../concepts/inbox.md) |
| Guild **Tools** tab | `/guilds/<id>/tools` | [Access](../concepts/access.md) |
| Guild **Secrets** tab | `/guilds/<id>/secrets` | [Secrets](../concepts/secrets.md) |
| Guild **Usage** tab | `/guilds/<id>/usage` | [Usage](../concepts/usage.md) |
| Agent inspector header and menu | `/guilds/<id>/agents/<id>` | [Agents](../concepts/agents.md) |
| Coding readiness warning | agent inspector | [Coding agents](../concepts/coding/index.md) |
| **Browser login needed** strip | agent inspector | [Browser](../concepts/browser.md) |
| Agent **Chat** tab: transcript, run flow, attachments, **Resume** | `/guilds/<id>/agents/<id>` (`?run=…`) | [Run transcript](../concepts/run-transcript.md), [Runs](../concepts/runs.md) |
| Chat History drawer | `/guilds/<id>/agents/<id>/history` (`?history=true`) | [Run transcript](../concepts/run-transcript.md) |
| Chat coding strip | agent **Chat** tab | [Coding agents](../concepts/coding/index.md) |
| Chat `code_task` row and **Changes** panel | agent **Chat** tab | [Code tasks](../concepts/coding/code-tasks.md), [Reviewing changes](../concepts/coding/reviewing-changes.md) |
| Chat secret request card | agent **Chat** tab | [Run transcript](../concepts/run-transcript.md), [Secrets](../concepts/secrets.md) |
| Agent **Prompt** tab | `/guilds/<id>/agents/<id>/prompt` | [Task](../concepts/task.md) |
| Agent **State › Memory** | `/guilds/<id>/agents/<id>/state/memory` | [Memory](../concepts/memory.md) |
| Agent **State › Notes** | `/guilds/<id>/agents/<id>/state/notes` | [Notes](../concepts/notes.md) |
| Agent **State › Tables** | `/guilds/<id>/agents/<id>/state/tables` | [Collections](../concepts/collections.md#what-a-guild-or-an-agent-reaches) |
| Agent **State › Access** | `/guilds/<id>/agents/<id>/state/access` | [Access](../concepts/access.md#what-a-guild-or-an-agent-reaches), [Notes](../concepts/notes.md), [Collections](../concepts/collections.md) |
| Agent **State › Scripts** | `/guilds/<id>/agents/<id>/state/scripts` | [Scripts](../concepts/scripts.md) |
| Agent **Routine** tab | `/guilds/<id>/agents/<id>/routine` | [Routines](../concepts/routines.md) |
| Agent **Browser** tab | `/guilds/<id>/agents/<id>/browser` | [Browser](../concepts/browser.md) |
| Agent **CLI** tab | `/guilds/<id>/agents/<id>/cli` | [Agent home](../concepts/agent-home.md) |
| Agent **Tools** tab | `/guilds/<id>/agents/<id>/tools` | [Access](../concepts/access.md) |
| Agent **Secrets** tab | `/guilds/<id>/agents/<id>/secrets` | [Secrets](../concepts/secrets.md) |
| Agent **Usage** tab | `/guilds/<id>/agents/<id>/usage` | [Usage](../concepts/usage.md), [Agent home](../concepts/agent-home.md) for disk |
| Agent **Settings**: **Identity**, **Model** / **Lead model** | `/guilds/<id>/agents/<id>/settings` (`?section=identity`, `model`) | [Agents](../concepts/agents.md) |
| Agent Settings: **Machine** | `?section=machine` | [Machines](../concepts/machines.md) |
| Agent Settings: **Harness** | `?section=harness` | [Harnesses](../concepts/coding/harnesses.md) |
| Agent Settings: **Repositories** | `?section=repositories` | [Repositories](../concepts/coding/repositories.md) |
| Access view (Tools and Secrets, at organisation, guild, and agent) | Settings, guild, and agent tabs | [Access](../concepts/access.md), [Secrets](../concepts/secrets.md) |
| **Inbox** | `/inbox` | [Inbox and issues](../concepts/inbox.md) |
| **Tables**: records, **Columns**, **Access** | `/tables`, `/tables/<collection id>` (`?tab=columns`, `access`) | [Collections](../concepts/collections.md), [Access](../concepts/access.md#the-access-panel) |
| Settings › **General** | `/settings` | [Organisations](../concepts/organisations.md) |
| Settings › **Members** | `/settings?tab=members` | [Organisations](../concepts/organisations.md) |
| Settings › **Machines** | `/settings?tab=machines` | [Machines](../concepts/machines.md) |
| Settings › **Model keys** | `/settings?tab=keys` | [Model keys](../concepts/model-keys.md) |
| Settings › **Secrets** | `/settings?tab=secrets` | [Secrets](../concepts/secrets.md) |
| Settings › **Tools** | `/settings?tab=tools` | [Access](../concepts/access.md) |
| Settings › **Usage** | `/settings?tab=usage` | [Usage](../concepts/usage.md) |
| Admin › **Connector catalog** | `/admin` | [Instance admin](../concepts/instance-admin.md), [Connector registry](../tools-and-connectors/connector-registry.md) |
| Admin › **Platform keys** | `/admin?tab=instance` | [Instance admin](../concepts/instance-admin.md), [Platform keys](../tools-and-connectors/platform-keys.md) |
| Admin › **Users** | `/admin?tab=users` | [Instance admin](../concepts/instance-admin.md), [Users](../concepts/users.md) |
| **Studio** landing and workspace: **Guild**, **Agents**, **State**, **Tools** | `/studio`, `/studio/<session id>` | [Prompt Studio](../concepts/prompt-studio.md) |
| Studio **Agents** › **Topology** | `/studio/<session id>?section=agents` | [Studio activity](../concepts/studio-activity.md) |
| Studio **State** › **References** | `/studio/<session id>?section=state&tab=references` | [Prompt Studio](../concepts/prompt-studio.md#state) |
| Studio coach proposal cards | `/studio/<session id>` | [Studio proposals](../concepts/studio-proposals.md) |
| **Builder** landing and workspace | `/builder`, `/builder/<session id>` | [Guild builder](../concepts/guild-builder.md) |
| **Recipes** library and recipe page | `/recipes`, `/recipes/<id>` | [Recipes](../concepts/recipes.md) |
| Apply preview and apply checklist | `/recipes/<id>/apply`, `/applies/<apply id>` | [Applying recipes](../concepts/applying-recipes.md) |
