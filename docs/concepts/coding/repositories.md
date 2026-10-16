# Repositories

A guild's repositories are the git repositories its
[coding agents](index.md) work in. Every coding agent of the guild
clones each one into its own [home](../agent-home.md), under
`repos/<name>`, and the [harness](harnesses.md) runs there. A guild
needs at least one before its coding agents can run.

A repository comes from one of two places. It is picked on a
[GitHub](../../tools-and-connectors/github.md) login, under **Tools**,
at the organisation, the guild, or the agent. That login gives the
agent a token to clone, push, and open pull requests. Or it is added
by URL on the guild's Settings: with a GitHub login, or anonymously,
which clones a public repository and gives no credential.

## Why it exists

The repositories belong to the guild, not to one agent, so every
coding agent of the guild works on the same code. Each still has its
own clone, so agents never edit each other's files. Work moves between
them as branches on the remote ([Teams](teams.md)).

## How it works

### Where the list comes from

The list a coding run clones is:

1. the repositories picked on the agent's effective GitHub login: the
   agent's own login, else its guild's, else its organisation's, the
   first that is connected;
2. plus the guild's other git URLs: anonymous ones, and ones added
   with a GitHub login that is not that effective login. A name already
   in the first list wins.

A narrower scope inherits the wider login's repositories until it
connects its own login and picks a different set
([GitHub](../../tools-and-connectors/github.md)).

### What a coding run does with them

At each generation of a coding agent, after the sandbox is up and the
workspace and harness checks pass:

1. **Tokens.** For each GitHub login the repositories use, the
   orchestrator mints a short-lived token limited to those repositories,
   with contents and pull requests write. It writes the tokens on the
   agent's machine, outside every home, and adds them to the run's
   redaction.
2. **Identity and clone.** The agent's git identity is written into
   its home, and each repository missing from `repos/` is cloned. A
   clone already there whose `origin` names another URL on the same
   host, as after a rename, is pointed at the current URL.
3. **Start checkpoint** of every working tree
   ([Reviewing changes](reviewing-changes.md)).

After that the agent fetches, branches, commits, and pushes itself.
The orchestrator never runs git in its own process: a repository's
hooks and configuration are the agent's.

The run's working directory starts in the repository when the guild
has exactly one, and in the home otherwise. Before each `shell`
command and each harness start and poll, a token close to expiry is
replaced.

### Git identity

Commits carry the agent's name as author. The author email is the
guild's **Commit author email** when it is set, otherwise
`<agent id>@agents.guilds.run`. Deploy services such as Vercel identify
the author from that address, so a guild that deploys previews sets it
to a verified email on the GitHub account that owns the project.

### Removing a repository

Removing a repository leaves the working trees already cloned in the
agents' homes. Deleting a guild deletes its repositories. Deleting a
GitHub connection deletes the repositories added through it.

## In the app

### The guild's Settings

The guild's **Settings** tab has two parts for coding:

- **Git**: **Commit author email**, the address coding agents put on
  commits. Its hint reads "A verified email on the GitHub account that
  owns the Vercel project (Hobby: the account owner). Empty uses each
  agent's platform address." It is saved with **Save**.
- **Repositories**: the extra git URLs each coding agent of the guild
  clones into `repos/<name>` in its home, at its next run, under the
  line "Other git repositories, added by URL." Each row
  shows the name, URL, and default branch, a tag, "anonymous",
  "GitHub · `<account>`", or "`<account>` disconnected", and a remove
  button. With none, "No extra repositories yet." Under them, an add
  form: **Name**, **URL**, and **Default branch** (optional). For a
  `github.com` URL a **GitHub login** select appears, offering each
  connected login and "None: clone anonymously", the first connected
  login unless the operator picks none. **Add repository** adds it at
  once, with a toast "`<name>` added".

Any operator who sees the guild may add and remove repositories. They
are not part of the Settings **Save**.

### The coding agent's Repositories

The create dialog's **Repositories** step and the **Repositories**
section of a coding agent's Settings show the guild's repositories.
Changes there are the guild's, saved as they are made.

A line reads "Code tasks run in these repositories, shared by every
coding agent of `<guild>`." Then the guild's GitHub login:

- When the GitHub App is not set up on the box: "GitHub is not set up
  on this box.", then **Set up**, which opens the GitHub App under
  **Admin**, **Platform keys**, for a platform admin, or "Ask a
  platform admin to set it up." for anyone else, and **Learn more**,
  which opens [GitHub](../../tools-and-connectors/github.md) on
  docs.guilds.run in a new tab.
- While no login is connected: "Connect GitHub to pick repositories,
  private ones included." and **Connect GitHub**, which starts the
  guild's connect flow.
- With the guild's own login: "GitHub · `<account>`" over the login's
  repository picker, **From GitHub · `<account>`**.
- With the organisation's login: "GitHub · `<account>` (the
  organisation's login)", its repositories listed read-only, and
  **Connect GitHub**, which connects a login of the guild's own.

Then the guild's **Repositories**, as on the guild's Settings. While
the guild has none, picked or added, an ochre line says so: in the
create dialog, "No repository yet. You can create the agent and add
one later in the guild's Settings."; in Settings, "No repository yet,
so this agent's coding runs fail at start."

The coding strip counts the repositories, "`<n>` repos" with their
names on hover, or reads "No repos" in bold
([Coding agents](index.md#coding-strip)).

## Rules and limits

| Rule | Value or behaviour |
| --- | --- |
| Name | `^[a-z][a-z0-9_-]{0,62}$`, unique in the guild; also the folder under `repos/` |
| URL | `https`, without credentials, query, or fragment |
| With a GitHub login | `https://github.com/<owner>/<repository>`, reachable by that login's installation |
| Default branch | GitHub's for a login-backed repository, else `main` |
| Anonymous repository | Cloned without credentials: only a public one clones |
| Who may change them | Any operator who sees the guild |
| Clone timeout | 600 seconds per repository |
| Token refresh | Replaced within 10 minutes of expiry |
| Commit author email | Empty, or one email address of at most 254 characters, not on a `.invalid` domain |
| Removing | Leaves existing clones in place |

## Reference

### Storage

`guild_repositories`:

| Column | Meaning |
| --- | --- |
| `id` | The repository's id |
| `guild_id` | The guild; deleting the guild deletes the row |
| `name` | Matches `^[a-z][a-z0-9_-]{0,62}$`, unique per guild |
| `url` | The git URL |
| `default_branch` | The branch recorded for it |
| `connection_id` | The GitHub connection it was added with, or null; deleting the connection deletes the row |
| `github_id` | GitHub's id for the repository, which a rename of it or its owner keeps |
| `created_at`, `updated_at` | Timestamps |

A guild-owned GitHub login mirrors its picked repositories into
`guild_repositories` ([GitHub](../../tools-and-connectors/github.md)).

`guilds.git_author_email` holds the commit author email, empty by
default.

### HTTP

```text
GET    /api/guilds/:id/repositories
POST   /api/guilds/:id/repositories
DELETE /api/guilds/:id/repositories/:repository_id
```

`GET` returns `{ repositories, github_connections }`. `repositories`
are this guild's git URLs. `github_connections` are the GitHub logins
the caller can see in the organisation: `id`, `owner_scope`,
`owner_id`, `account_hint`, `status`.

A repository payload carries `id`, `guild_id`, `name`, `url`,
`default_branch`, `connection_id`, `connection` (`id`, `status`,
`account_hint`, or null), `created_at`, and `updated_at`.

`POST` takes `{ name, url, default_branch?, connection_id? }` and
returns 201 with the repository.

- A bad name, URL, or branch is 422. `default_branch` must be a valid
  branch name.
- A name the guild already has is 409.
- With a `connection_id`: the connection must exist (404), be a GitHub
  connection (422), and be the organisation's login or a guild-owned
  login the caller can see in the same organisation (422 "the GitHub
  connection is not visible from this guild"). The URL must be
  `https://github.com/<owner>/<repository>`. The connection must be
  connected (422), and its installation must reach the repository
  (422 "the GitHub connection does not reach `<owner>`/`<repository>`").
  `default_branch` then defaults to the one GitHub reports, and GitHub's
  id is recorded. When the connection is this guild's own login, the
  repository is also added to the login's selection. GitHub refusing
  the installation marks the connection disconnected (422); another
  GitHub error is 502.
- Without a connection, `default_branch` defaults to `main`, and the
  repository is cloned anonymously.

`DELETE` returns 204, or 404 for an unknown repository. A repository
added with this guild's own login also leaves the login's selection.

`PUT /api/guilds/:id` accepts `git_author_email`. Omitted leaves the
stored value. An empty string or null clears it. Otherwise it is
trimmed and must be a single email address: no whitespace, one `@`,
and a domain with a dot that neither starts nor ends with one (422
`git_author_email must be a single email address`), not on `invalid`
or a `.invalid` domain (422 `git_author_email must not use a .invalid
domain`), and at most 254 characters.

### Tokens

For each GitHub connection the repositories use, the orchestrator
mints an installation access token limited to those repositories by
their GitHub ids, with contents and pull requests write. A repository
stored without an id gets the one GitHub lists under its path. GitHub's
answer names every repository as it is now: a repository whose name or
owner changed gets its current URL, on the guild repository and in the
login's selection.

The tokens are written through the sandbox file API to
`/run/guilds/<agent id>/git-tokens.json`, outside every home, as
`{ repositories: { <name>: { token, expires_at, host, path } } }`. Each
joins the generation's redaction set. git reads its repository's token
through the credential helper; `shell` exports the token of the
repository that holds the working directory as `GH_TOKEN` for `gh`
([GitHub](../../tools-and-connectors/github.md)). A harness's
environment has neither `GH_TOKEN` nor `GITHUB_TOKEN`.

Before each `shell` command and each `code_task` start and poll, a
token within 10 minutes of expiry is replaced and rewritten.

The generation-start error `repository.token` covers:

- a disconnected connection: "the GitHub connection for `<account>` is
  disconnected";
- GitHub refusing the installation: "GitHub refused the installation
  for `<account>`; the connection is now disconnected";
- an installation that no longer reaches a repository: "the GitHub App
  installed for `<account>` does not reach `<name>` (`<owner>`/`<repository>`):
  give the App access to it on GitHub, or pick it again on the GitHub
  integration".

### Identity and clone

`guilds-code git_setup` writes `user.name` (the agent's name) and
`user.email` into the `.gitconfig` in the agent's home, then runs
`git clone` for each repository missing from `repos/`, waiting up to
600 seconds for each. A failed clone is removed, and the generation
fails with `repository.clone`, "clone failed: `<name>`: `<error>`". When
git wanted credentials, the error says which case it is:

- the repository had a token git left unused: "git did not use the
  GitHub token issued for it";
- a `github.com` repository without a login: "it has no GitHub login,
  so it was cloned without credentials: pick a private repository on
  the GitHub integration instead";
- another host: "it was cloned without credentials, which only a public
  repository allows".

### State

A coding agent's State carries `repositories`:
`[{ name, path, default_branch }]`, where `path` is
`/home/<agent id>/repos/<name>`. Live git state is not in State.

### Code

`apps/orchestrator/src/coding/repositories.ts` (validation, the clone
list), `apps/orchestrator/src/coding/git.ts` (tokens, identity, clone
errors), `apps/orchestrator/src/http/coding-routes.ts` (routes),
`apps/web/src/features/guild/pages/GuildRepositories.tsx`, and
`apps/web/src/features/agent/CodingRepositories.tsx`.
