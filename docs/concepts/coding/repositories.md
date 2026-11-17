# Repositories

A guild's repositories are the git repositories its subscription
agents can work in ([Code work](index.md)). Each subscription agent
picks the ones it works on, in its config's `repositories`, and the
ones of them it only reads, in `read_only_repositories`. Each turn
clones the ones it picks into the agent's own
[home](../agent-home.md), and the [harness](harnesses.md) runs there.
A subscription agent on Cursor or Antigravity needs at least one
before it can run; one on Claude Code or Codex that picks none works
in its home. An agent on a key picks none.

A repository comes from one of two places. It is picked on a
[GitHub](../../tools-and-connectors/github.md) login, under **Tools**,
at the organisation, the guild, or the agent. That login gives the
agent a token to clone and push. Or it is added by an HTTPS URL on
the guild's Settings, on any git host, with one credential: a GitHub
login, an access token kept as a [secret](../secrets.md), or none,
which clones a public repository.

The repository's credential decides its git provider: GitHub for a
GitHub login, the access-token provider for an access token, none
without a credential. The provider gives the agent a token for that
repository at each turn. git
only clones, fetches and pushes; a pull or merge request is opened
with the host's connector tools, such as the GitHub connector's
([Pull requests](#pull-requests)).

## Why it exists

The repositories belong to the guild, so its subscription agents can
work on the same code, and each agent picks the ones its work needs. An
agent that reviews the site does not clone the shop, and its runs get
no token for it. Each agent has its own clone, so agents never edit
each other's files. Work moves between them as branches on the remote
([Several agents in one guild](index.md#several-agents-in-one-guild)).

## How it works

### Where the list comes from

The repositories an agent can use are:

1. the repositories picked on the agent's effective GitHub login: the
   agent's own login, else its guild's, else its organisation's, the
   first that is connected;
2. plus the guild's other repositories, added anonymously, with any
   GitHub login, or with an access token. A name already in the first
   list wins.

A narrower scope inherits the wider login's repositories until it
connects its own login and picks a different set
([GitHub](../../tools-and-connectors/github.md)).

A turn clones the ones the agent's config picks, in the config's
order. A create or a settings change may pick only
repositories the agent can use. A repository the agent already picks
stays picked when it can no longer use it, as after its login
disconnects; its runs then fail at start, naming it, until it comes
back or is unpicked.

### What a subscription agent's turn does with them

A subscription agent's turn works in the repositories its agent picks,
in its harness's CLI. At each generation the run checks the agent's
picks first: one it can no longer use fails the run with
`coding.repositories_gone`, naming it. An agent that picks none skips
the rest, and its turn starts in its home; on Cursor or Antigravity,
which need a repository, the run fails instead with
`coding.repositories_missing`. Then, once the harness
check passes, for each repository it picks:

1. **Tokens.** Each repository with a git provider gets its token
   from that provider. For each GitHub login the repositories use, the
   orchestrator mints a short-lived token limited to those of them the
   agent pushes to, with contents write alone, which pushes a branch
   and opens no pull request, and one limited to those it only reads,
   with contents read alone. For a repository with an access token, it
   reads the value of the secret the repository names. It writes the
   tokens on the agent's machine, outside every home, and adds them to
   the run's redaction ([Tokens](#tokens)).
2. **Identity, clone, and fetch.** The agent's git identity is written
   into its home, each repository missing from `repos/` is cloned, and
   each one there is fetched. A clone already there whose `origin`
   names another URL on the same host, as after a rename, is pointed
   at the current URL first. Each clone of a repository the agent only
   reads gets a push URL that refuses every push
   ([Read-only repositories](#read-only-repositories)). The
   orchestrator never runs git in its own process: a repository's
   hooks and configuration are the agent's.
3. **Turn start checkpoint** of each one's working tree, under the
   turn's call id ([Reviewing changes](reviewing-changes.md#checkpoints)).

The CLI starts in the repository's working tree when the agent picks
one, and in its home when it picks several. It branches, commits, and
pushes with its own tools: git's credential helper answers the push
with the turn's token. The CLI's environment never holds `GH_TOKEN`
or `GITHUB_TOKEN`, nor any repository token. Tokens that near their
expiry are replaced before each poll of the turn.

When the turn ends, however it ends, the run takes the turn's end
checkpoint, records what the turn changed in each repository it
changed ([Reviewing changes](reviewing-changes.md#refs)), and empties
the agent's tokens file, so the credential helper answers no
repository between turns.

The system prompt of a subscription agent that picks repositories says
which ones it has and where, where its turn starts, how it branches,
commits and pushes, and how its pull request is opened
([System prompt](../system-prompt.md#capability-parts-of-the-guidelines)).

### Read-only repositories

An agent reads some of its repositories without pushing to them: a
reviewer reads the code it reviews, a writer of specs reads the code
it specifies. `read_only_repositories` lists them, each one of the
agent's `repositories`. Such a repository is cloned and fetched like
the others, and the agent is given no means to push to it:

- on GitHub, its token holds contents read alone, so GitHub refuses a
  push with it;
- on every host, its clone's push URL names
  `https://push-disabled.invalid/this-repository-is-read-only`, so a
  push to `origin` fails and names that URL. An access token kept as a
  secret is the host's to narrow, not the orchestrator's: the agent's
  clone gets the same token whether it reads the repository only or
  pushes to it, and the push URL alone stops the push
  ([SEC-73](../../architecture/security-register.md#sec-73--a-repository-an-agent-only-reads-on-a-host-other-than-github-is-read-only-by-its-clones-push-url-alone)).

State marks each such repository `read_only`, and the system prompt
tells the agent that git refuses to push it. A repository picked
writable again gets its push URL back at the next generation.

### Pull requests

A pull request is opened with the connector tool of the repository's
host, under that connector's own login and bindings, never with a
repository token. For a GitHub repository it is the GitHub connector's
`create_pull_request`, which a subscription agent reaches through the
orchestrator's MCP server like any of its Guilds tools
([Tools in a run](../../tools-and-connectors/tools-in-a-run.md#a-subscription-agents-run)).
Like every writing tool it starts Off. A subscription agent whose run
offers it reads its name, as its harness calls it, in its system
prompt. One whose run offers none, or whose repositories are on a host
without a connector, reads that the pushed branch ends its part.

### Git identity

Commits carry the agent's name as author. The author email is the
guild's **Commit author email** when it is set, otherwise
`<agent id>@agents.guilds.run`. Deploy services such as Vercel identify
the author from that address, so a guild that deploys previews sets it
to a verified email on the GitHub account that owns the project.

### Access tokens

An access token serves a repository on any HTTPS git host: GitLab,
Bitbucket, Gitea, Azure DevOps, or GitHub itself. The token is kept
as a secret of the organisation, and the repository names that
secret and the username git sends with the token. The username is
the one the host asks for with that kind of token:

| Host | Token | Username |
| --- | --- | --- |
| GitLab | A personal, project, or group access token with `read_repository` and `write_repository` | `oauth2` |
| Bitbucket Cloud | A repository, project, or workspace access token with repository write | `x-token-auth` |
| Gitea, Forgejo | An access token with repository write | The account's username |
| Azure DevOps | A personal access token with Code read and write | Any name that is not empty |

The orchestrator reads the secret's value when a subscription agent's
generation starts. A changed value reaches the next generation. The value is not
added to the agents' environment unless the secret is also granted to
them. The token never expires on the box's side and is never
refreshed; the host's own expiry, when the token has one, still
applies.

Only a member who manages the secret may add a repository with it:
an organisation owner or admin, or a member for a secret granted only
in guilds they see ([Secrets](../secrets.md)). The token reaches every
subscription agent of the guild that picks the repository through git, so
the rule is the one that guards changing the secret.

### Removing a repository

Removing a repository from the guild, or taking it out of a GitHub
login's pick, unpicks it from each agent that picks it and can no
longer use it, in the same transaction, and takes it out of that
agent's read-only repositories. An agent that still reaches
it, through another login or another of the guild's rows, keeps it.
Removing a repository leaves the working trees already cloned in the
agents' homes. Deleting a guild deletes its repositories. Deleting a
GitHub connection deletes the repositories added through it, and
deleting a secret deletes the repositories whose access token it
holds.

## In the app

### The guild's Settings

The guild's **Settings** tab has two parts for code work:

- **Git**: **Commit author email**, the address its agents put on
  commits. Its hint reads "A verified email on the GitHub account that
  owns the Vercel project (Hobby: the account owner). Empty uses each
  agent's platform address." It is saved with **Save**.
- **Repositories**: the extra git URLs the guild's subscription agents
  can pick. Each agent that picks one clones it into `repos/<name>` in
  its home, at its next turn. They sit under the line "Other git
  repositories, added by URL." Each row
  shows the name, URL, and default branch, a tag, "anonymous",
  "GitHub · `<account>`", "`<account>` disconnected", or
  "Token · `<secret>`", and a remove button. With none, "No extra
  repositories yet." Under them, an add form: **Name**, **URL**
  (placeholder `https://git.example.com/owner/shop.git`), and
  **Default branch** (optional), then **Credential**. It offers each
  connected GitHub login, for a `github.com` URL only, **Access
  token**, and "None: clone anonymously". A `github.com` URL starts on
  the first connected login, any other URL on none. **Access token**
  adds **Secret**, a select of the organisation's secrets the operator
  manages, and **Username** (placeholder `oauth2`). With no such
  secret, its hint reads "Add the token under Secrets first: only a
  secret you manage can be used." **Add repository** waits for both,
  then adds the repository at once, with a toast "`<name>` added".

Any operator who sees the guild may add and remove repositories. They
are not part of the Settings **Save**.

### The agent's Repositories

The **Repositories** section of a subscription agent's Settings picks
the repositories the agent works on, then shows the guild's
repositories it picks from.

A line reads "This agent works in the repositories it picks. The
repositories of `<guild>` below are shared by its agents; each picks
the ones it works on." Under **This agent works on**, a checkbox
per repository the agent can use, ticked when the agent picks it. A
repository the agent picks and can no longer use follows, ticked and
tagged "no longer in the guild", so it can be unticked. A repository
ticked joins the end of the agent's picks. With none to pick, "The
guild has no repository yet. Add one below." The ticks are part of
the agent's config: Settings saves them with **Save**. The boxes list
what this agent can use, which its own GitHub login may change.

While the agent picks no repository it can use, an ochre line says so:
"No repository picked, so this agent's turns run in its home.", or on
Cursor or Antigravity "No repository picked.
`<Harness>` keeps its own system prompt, so it runs a subscription
agent only with a repository."

Then the guild's GitHub login, whose changes are the guild's, saved as
they are made:

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

Then the guild's **Repositories**, as on the guild's Settings, also
saved as they are made. A repository added there joins the boxes
above, unticked.

## Rules and limits

| Rule | Value or behaviour |
| --- | --- |
| Name | `^[a-z][a-z0-9_-]{0,62}$`, unique in the guild; also the folder under `repos/` |
| An agent's picks | Only on a subscription agent; each a repository it can use, once; a pick it can no longer use stays until it is unpicked; at least one on a subscription agent on Cursor or Antigravity |
| URL | `https` on any host, without credentials, query, or fragment; SSH is refused |
| Credential | One at most: a GitHub login, or an access token's secret and username |
| With a GitHub login | `https://github.com/<owner>/<repository>`, reachable by that login's installation |
| With an access token | Any HTTPS URL; a secret of the guild's organisation that the member manages; a username of one line without spaces, at most 256 characters |
| Default branch | The one given; without one, GitHub's for a login-backed repository, else `main` |
| Anonymous repository | Cloned without credentials: only a public one clones |
| Access token | Read at each generation start; never refreshed |
| Who may change them | Any operator who sees the guild |
| Clone timeout | 600 seconds per repository |
| Token refresh | Replaced within 10 minutes of expiry |
| GitHub token permissions | Contents write alone; contents read alone for a repository the agent only reads |
| Read-only repositories | Some of the agent's picks, each once; cloned and fetched, with a push URL that refuses every push |
| Fetch | Each generation fetches every clone whose `origin` is the repository's URL; a failed fetch leaves the clone as it was and is logged |
| Tokens between turns | A subscription agent's tokens file is emptied when its turn ends |
| Commit author email | Empty, or one email address of at most 254 characters, not on a `.invalid` domain |
| Removing | Unpicks it from each agent that can no longer use it; leaves existing clones in place |

## Reference

### Storage

`agents.config.repositories` holds the names a subscription agent
picks, in order; it is empty on an agent on a key.
`agents.config.read_only_repositories` holds those of them it only
reads ([Agents](../agents.md#reference)).

`guild_repositories`:

| Column | Meaning |
| --- | --- |
| `id` | The repository's id |
| `guild_id` | The guild; deleting the guild deletes the row |
| `name` | Matches `^[a-z][a-z0-9_-]{0,62}$`, unique per guild |
| `url` | The git URL |
| `default_branch` | The branch recorded for it |
| `provider` | How its token is minted: `github` through its GitHub login, `access_token` from the secret that holds its access token, or null to clone it without credentials |
| `connection_id` | The GitHub connection of a `github` repository, else null; deleting the connection deletes the row |
| `secret_id` | The secret that holds an `access_token` repository's token, else null; deleting the secret deletes the row |
| `username` | The username git sends with an `access_token` repository's token, else null |
| `remote_id` | The host's id for the repository, which a rename of it or its owner keeps; GitHub's id for a repository with a GitHub login |
| `created_at`, `updated_at` | Timestamps |

A check holds each row to its provider's fields: `connection_id` for
`github`; `secret_id` and `username` for `access_token`; none of them
without a provider.

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

`GET` returns `{ repositories, github_connections, usable }`.
`repositories` are this guild's git URLs. `github_connections` are the
GitHub logins the caller can see in the organisation: `id`,
`owner_scope`, `owner_id`, `account_hint`, `status`. `usable` names
the repositories a new agent of the guild can use: those picked
on the guild's GitHub login, else the organisation's, while connected,
and the guild's other repositories
([Where the list comes from](#where-the-list-comes-from)).

A repository payload carries `id`, `guild_id`, `name`, `url`,
`default_branch`, `provider` (`github`, `access_token`, or null),
`connection_id`, `connection` (`id`, `status`, `account_hint`, or
null), `secret_id`, `username`, `secret` (`id`, `name`, or null),
`created_at`, and `updated_at`.

`POST` takes `{ name, url, default_branch?, connection_id?, secret_id?, username? }`
and returns 201 with the repository.

- `name` and `url` are strings, `default_branch`, `connection_id`,
  `secret_id` and `username` a string or null; another type is 422
  naming the field. An empty string is the same as null.
- A bad name, URL, or branch is 422. `default_branch` must be a valid
  branch name.
- A `connection_id` with a `secret_id` or a `username` is 422 "a
  repository takes one credential: a GitHub login or an access token".
- A name the guild already has is 409.
- With a `connection_id`: the URL must be
  `https://github.com/<owner>/<repository>` (422). The connection must
  exist (404), be a GitHub connection (422), and be the organisation's
  login or a guild-owned login the caller can see in the same
  organisation (422 "the GitHub connection is not visible from this
  guild"). It must be connected (422), and its installation must reach
  the repository (422 "the GitHub connection does not reach
  `<owner>`/`<repository>`").
  `default_branch` then defaults to the one GitHub reports, and GitHub's
  id is recorded. When the connection is this guild's own login, the
  repository is also added to the login's selection. GitHub refusing
  the installation marks the connection disconnected (422); another
  GitHub error is 502.
- With a `secret_id`: a `username` is required, of one line without
  spaces or control characters and at most 256 characters, and the
  other way round (422 "an access token takes secret_id and a username
  of one line without spaces, of at most 256 characters"). The secret
  must be one of the guild's organisation (404 "secret not found") that
  the caller manages (403 "only a member who manages this secret can
  give it to a guild's repositories"). The provider is `access_token`,
  and `default_branch` defaults to `main`.
- Without either, `default_branch` defaults to `main`, and the
  repository is cloned anonymously.

`DELETE` returns 204, or 404 for an unknown repository. A repository
added with this guild's own login also leaves the login's selection.
In the same transaction, each agent of the guild that picks the name
and can no longer use it unpicks it.

`PUT /api/guilds/:id` accepts `git_author_email`. Omitted leaves the
stored value. An empty string or null clears it. Otherwise it is
trimmed and must be a single email address: no whitespace, one `@`,
and a domain with a dot that neither starts nor ends with one (422
`git_author_email must be a single email address`), not on `invalid`
or a `.invalid` domain (422 `git_author_email must not use a .invalid
domain`), and at most 254 characters.

### Tokens

The repository's `provider` mints its token. A repository without one
gets no token.

- `github`: for each GitHub connection the repositories use, the
  orchestrator mints an installation access token limited by their
  GitHub ids to those the agent pushes to, with contents write alone,
  and one limited to those it only reads, with contents read alone. A
  repository stored without an id gets the one GitHub lists
  under its path. GitHub's answer names every repository as it is now:
  a repository whose name or owner changed gets its current URL, on
  the guild repository and in the login's selection. The token lives
  one hour.
- `access_token`: the value of the secret `secret_id` names, read when
  the generation starts, sent with the repository's `username`. It has
  no expiry and is never refreshed, and carries what the host granted
  it, whether the agent only reads the repository or not. The
  secret is not added to the agent's environment; an agent gets it
  there only when the secret is also granted to it
  ([Secrets](../secrets.md)).

The tokens are written through the sandbox file API to
`/run/guilds/<agent id>/git-tokens.json`, outside every home, as
`{ repositories: { <name>: { token, expires_at, host, path, username, provider } } }`.
`host` and `path` are where git may use the token: `github.com` and
the repository's `<owner>/<repository>` for GitHub; for an access
token, the URL's host, with its port when it is not 443, and the URL's
path. `username` is `x-access-token` for GitHub. `expires_at` is null
for an access token. Each token joins the generation's redaction set
as `GIT_TOKEN_<n>`.

git reads its repository's token through the credential helper,
`/usr/local/bin/guilds-git-credential`. The image sets it for every
HTTPS host (`credential.https://`) with `credential.useHttpPath`, so
git asks with the host and the repository's path, and each repository
gets its own token. The helper answers with the entry's `username` and
token only when the host and the path match the entry's; the path
matches without a trailing `.git` and in any case. It answers nothing
for an entry whose username or token holds a line break. The image
also sets the helper through `GIT_CONFIG_*` environment variables,
which git reads after every configuration file: an empty helper first
drops any helper set before it for an HTTPS host, such as the one
`gh auth setup-git` writes into the agent's home, then the guild
helper follows. The agent's own git configuration cannot replace it,
for any HTTPS host.

A harness gets no repository token in its environment
([Harness environment](harnesses.md#harness-environment)).

Before each poll of a subscription agent's turn, a token within 10 minutes of
expiry is replaced and rewritten. When a subscription agent's turn
ends, the tokens file is rewritten as `{ repositories: {} }`.

The generation-start error `repository.token` covers:

- a disconnected connection: "the GitHub connection for `<account>` is
  disconnected";
- GitHub refusing the installation: "GitHub refused the installation
  for `<account>`; the connection is now disconnected";
- an installation that does not reach a repository: "the GitHub App
  installed for `<account>` does not reach `<name>` (`<owner>`/`<repository>`):
  give the App access to it on GitHub, or pick it again on the GitHub
  integration";
- an access token's secret that is gone: "`<name>`: the secret that
  holds its access token is gone";
- one that cannot be decrypted: "`<name>`: the secret `<secret>` that
  holds its access token cannot be read";
- one whose value holds a line break: "`<name>`: the secret `<secret>`
  holds a line break, which git cannot send as a token".

### An agent's picks

`config.repositories` is a list of repository names, each once
([Agents](../agents.md#reference)). A create or a reconfigure is 422:

- with a list on an agent on a key: "repositories are only for
  subscription agents";
- with a value that is not a list: "repositories must be a list of
  repository names"; with an item that is not a repository name:
  "repositories: `<item>` is not a repository name"; with a name twice:
  "repositories: `<name>` is listed twice";
- with a name the agent cannot use that its stored config does not
  already pick: "repositories: the agent cannot use `<names>`: add it to
  the guild's Repositories first".

`config.read_only_repositories` is a list of names of
`config.repositories`, each once; left out, it is empty. A create or a
reconfigure is 422 with a value that is not a list
("read_only_repositories must be a list of repository names"), an
item that is not a repository name, a name twice, or a name
`repositories` does not list: "read_only_repositories: `<names>` must
also be in repositories".

The generation of a subscription agent that picks repositories, or
whose harness needs one, fails at start, before the machine wakes:

- with `coding.repositories_gone` while the agent picks a repository
  it can no longer use: "this agent picks `<names>`, which it can no
  longer use: add it back in the guild's Repositories, or unpick it in
  the agent's Settings under Repositories, then send again";
- with `coding.repositories_missing` while it picks none, on Cursor or
  Antigravity: "this agent has no repository: pick one in its Settings under
  Repositories, then send again".

`GET /api/agents/:id/harness` lists `repositories`, the names a
subscription agent's turn clones (those the agent picks and can use, in its order), and
`usable_repositories`, the names it can use
([Harnesses](harnesses.md#reference)).

### Identity and clone

`guilds-code git_setup` writes `user.name` (the agent's name) and
`user.email` into the `.gitconfig` in the agent's home, then runs
`git clone` for each repository the agent picks that is missing from
`repos/`, and `git fetch --prune origin` in each clone there whose
`origin` is the repository's URL, waiting up to 600 seconds for each.
It sets `remote.origin.pushurl` to
`https://push-disabled.invalid/this-repository-is-read-only` in each
clone of a repository the agent only reads, and unsets it in every
other. A fetch that fails leaves the clone as it was; the generation
goes on, and the orchestrator logs `repository.fetch` with git's
error. A failed clone is removed, and the generation
fails with `repository.clone`, "clone failed: `<name>`: `<error>`". When
git wanted credentials, the error says which case it is:

- the repository had a token git left unused: "git did not use the
  token issued for it";
- a `github.com` repository without a login: "it has no GitHub login,
  so it was cloned without credentials: pick a private repository on
  the GitHub integration instead";
- another host: "it was cloned without credentials, which only a public
  repository allows".

### State

The State of a subscription agent that picks repositories carries `repositories`, the ones it picks and can use,
in its config's order: `[{ name, path, default_branch, read_only }]`,
where `path` is `/home/<agent id>/repos/<name>` and `read_only` is true
for one it only reads. Live git state is not
in State.

### Code

`apps/orchestrator/src/coding/repositories.ts` (validation, the
repositories an agent can use and the ones it picks),
`apps/orchestrator/src/coding/agent-repositories.ts` (loading them for
an agent, and the run errors of its picks),
`apps/orchestrator/src/coding/git.ts` (the git provider, the agent's
tokens, identity, clone errors, and the connector
tool that opens a pull request),
`apps/orchestrator/src/coding/github-provider.ts` (GitHub's tokens),
`apps/orchestrator/src/coding/access-token-provider.ts` (an access
token's), `apps/orchestrator/src/github/tokens.ts` (minting a login's
installation token),
`apps/orchestrator/src/secrets/service.ts` (`requireManagedSecret`,
who may give a secret to a guild's repositories),
`apps/orchestrator/src/coding/guild-repositories.ts` (a guild's
repositories and the GitHub logins they use, and
`retireInstallationGone`, which retires a login whose installation
GitHub refused, while its repositories are listed and while a run's
tokens are minted),
`apps/orchestrator/src/generation/coding.ts` (a subscription turn's
tokens, clones, and checkpoints),
`apps/orchestrator/src/mcp/connections.ts` (the GitHub login an
operator sees),
`apps/orchestrator/src/guilds/validation.ts` (the commit author
email), `apps/orchestrator/src/http/coding-routes.ts` (routes), and in
the app `apps/web/src/features/agent/GuildRepositories.tsx` (the
guild's repositories and the add form),
`apps/web/src/features/agent/repositories.ts` (the login a URL is
added with, and the agent's repository checklist),
`apps/web/src/features/agent/CodingRepositories.tsx` (the agent's
Repositories),
`apps/web/src/features/access/GithubRepositories.tsx` (a login's
repository picker), and
`apps/web/src/features/guild/pages/GuildSettings.tsx` (the **Git**
group).
