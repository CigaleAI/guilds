# GitHub

`github` is backed by one GitHub App per box. The **GitHub App**
integration holds it, under **Admin**, **Platform keys**, in five
fields:

- App ID (`app_id`)
- App slug (`slug`)
- Private key (PEM) (`private_key`)
- Client ID (`client_id`)
- Client secret (`client_secret`)

Until all five are set, Tools marks the connector **Not set up**
with the missing fields and disables Connect; a Connect sent anyway
is a 422 with `setup_state: unsupported`
([Integrations](catalog.md#integrations)).

The App:

- asks for the repository permissions Contents and Pull requests
  (read and write) and Metadata (read)
- requests user authorization (OAuth) during installation and
  redirects on update, with `<PUBLIC_BASE_URL>/api/mcp/oauth/callback`
  as its callback URL, or the address the box is reached at when
  `PUBLIC_BASE_URL` is empty
- is private and subscribes to no webhook

## Registering the App

A platform admin registers it one of two ways.

**Create the GitHub App**, on Platform keys, registers it from a
manifest. The dialog takes an optional App name (GitHub caps it at
34 characters; the default is `Guilds (<host>)`) and an optional
organisation login (without one, the App belongs to the admin's own
account). The browser posts the manifest to GitHub, the admin
confirms it there, and GitHub returns them to the box with the five
fields stored and the integration on. The manifest carries the
settings above, `url` = the box's address, the manifest callback as
`redirect_url`, and as callback URLs
`<PUBLIC_BASE_URL>/api/mcp/oauth/callback` plus, when the admin
reached the box at another address (`http://localhost:8080` with
`PUBLIC_BASE_URL` empty), that address's `/api/mcp/oauth/callback`
too. When that address is on the public internet, the manifest also
names an inactive webhook at `<address>/api/github/webhook`. A
loopback or private address omits the hook: GitHub refuses a hook
URL it cannot reach.

The flow: `POST /api/admin/instance/keys/github-app/manifest` with
`{ name?, owner?, return_to? }` answers `{ action, manifest, state }`
and sets a state cookie (`guilds_github_manifest`, HttpOnly,
SameSite=Lax, 20 minutes, path = the callback). GitHub redirects to
`GET /api/admin/instance/keys/github-app/manifest/callback?code&state`,
which checks that the cookie's state matches a flow this process
started, trades the code once at
`POST https://api.github.com/app-manifests/{code}/conversions` (no
token), stores the fields for the admin who started the flow, and
redirects to `return_to` (a path on this app only) or to
`/admin?tab=instance&integration=github-app`. A failure redirects
there with `setup_error=state|conversion|store` and stores nothing
([Security register](../architecture/security-register.md), SEC-22).

**Paste.** Register the App on GitHub by hand (Settings, Developer
settings, GitHub Apps) with the settings above and the callback URL,
generate a client secret and a private key, and enter the App ID,
the slug (the last segment of `https://github.com/apps/<slug>`), the
PEM (as is, in the text area; one line with `\n` escapes is also
accepted), the client ID, and the client secret in the form.

**Replacing it.** Entering an App with another App ID, or removing
the integration, disconnects every GitHub login installed with the
old App, since their installations belong to it. The form asks for
confirmation with the count; the API answers 409 with
`replaces_app: true` and `connections` until `confirm_replace` is
sent. A new private key or client secret on the same App ID
disconnects nothing.

Connect is offered at organisation, guild, and agent scope. It
follows the pending-connection path of the browser logins. The App
is installed once per GitHub account. Later Connects reuse that
install.

Each login then chooses its own repositories on the GitHub card
(Tools), stored in the login's settings. A narrower scope
inherits the wider login's repositories until it connects its own
login and picks a different set.

1. Connect creates a pending connection with its `oauth_state`. When
   the organisation has no connected GitHub login the operator can
   see, it answers with `authorization_url`
   `https://github.com/apps/<slug>/installations/new?state=…`, where
   the operator chooses the account and the repositories the App may
   reach. When a login already exists, Connect sends the operator to
   user authorization at `/login/oauth/authorize` instead, so a
   second guild can attach the existing installation without
   installing the App again. A short-lived cookie stores that state
   so the callback can find the login if GitHub omits it after the
   authorize hop.
2. After install, GitHub either sends `code` (and sometimes
   `installation_id` and `state`) or a setup redirect with
   `installation_id` and `state` and no `code`. A setup redirect
   starts user authorization at `/login/oauth/authorize` with the
   same `state` and the callback URL. The orchestrator exchanges
   `code` for a user token and keeps an installation only when that
   user can reach it: the callback's id when present, otherwise this
   App's only installation on the token. Several installations open
   a picker (`/api/mcp/oauth/github-installation`) so the operator
   chooses the account, or installs the App on another. An id in
   the URL alone proves nothing. The user token is discarded. A
   refused callback deletes a new pending connection.
3. The connection stores the installation id, takes the account's
   login as `account_hint`, becomes `connected`, and writes its
   enabled binding.

An installation that needs an organisation admin's approval returns
`setup_action=request`. Connect again after they approve, and
GitHub's update redirect completes it.

The connection lists no model tools. Agents use `git` and `gh` in
the sandbox. The Tools view shows it without an On/Off switch.

`GET /api/mcp/connections/:id/github/repositories` lists the
repositories the installation reaches:

- `name`
- `full_name`
- `owner`
- `private`
- `default_branch`
- `url`

`PUT /api/mcp/connections/:id/github/selected` stores
`{ repositories: [{ name, url, default_branch }] }` in that login's
settings, as `repositories`.
Each must be one the installation reaches. Each is stored with
GitHub's id for it (`github_id`). A rename of the repository or its
owner keeps that id.

The access payload carries the selection in the login's `settings`. A guild-owned login also mirrors the selection
into `guild_repositories`. `GET /api/guilds/:id/repositories` still
lists that guild's extra git URLs and the GitHub logins the
operator can see.

**Tokens.** The App's private key and the installation id never
leave the orchestrator. At each generation start of a coding agent
the orchestrator signs an App token (RS256, 9 minutes) and
requests, for each connection the guild's repositories use, an
installation access token limited to those repositories by their
GitHub ids, with contents and pull requests write. GitHub makes it
valid for one hour.

A repository stored without an id gets the one GitHub lists under
its name in the installation. GitHub's answer names every
repository as it is now: a repository whose name or owner GitHub
changed gets its current URL, on the guild repository and in the
login's selection. When GitHub refuses the token because the
installation no longer reaches a repository, the error names it.

The tokens go to `/run/guilds/git-tokens.json` through the sandbox
file API. `guilds-git-credential` is the credential helper for
`https://github.com` with `useHttpPath`, set in the image's system
git configuration and again through the environment
(`GIT_CONFIG_COUNT`), which git reads after every configuration
file. A helper the agent configures in its home, such as the one
`gh auth setup-git` writes, cannot replace it.

git gets the token of the repository it is talking to. `shell`
exports the token of the repository that holds the working
directory as `GH_TOKEN` for `gh`. Before a `shell` call, a token
within 10 minutes of expiry is replaced.

Every token joins the run's redaction set. What a coding run does
with the repositories is in [Runs](../concepts/runs.md#repositories).

**Removal.** When GitHub refuses a token because the installation
was removed or suspended (404 or 403), the connection becomes
`disconnected`, and the coding generation that needed it fails at
start. Deleting the connection deletes the guild repositories
added through it.
