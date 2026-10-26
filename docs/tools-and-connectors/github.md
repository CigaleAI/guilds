# GitHub

Connecting GitHub gives agents tools for the issues, pull requests,
branches, files, and CI runs of the repositories you pick, and lets
coding agents clone and push to them. It runs through one GitHub App
per box. You set it up in three steps:

1. A platform admin creates the App, once per box.
2. An operator connects their GitHub account under **Tools**.
3. The operator picks the repositories agents may use.

## Before you start

- You are a platform admin on the box, for step 1.
- The box's public address is set. The App sends GitHub logins back
  to `<PUBLIC_BASE_URL>/api/mcp/oauth/callback`. When
  `PUBLIC_BASE_URL` is empty, that is the address you reach the box
  at, such as `http://localhost:8080`. To reach the box from
  elsewhere, set the address first
  ([Remote access](../operations/remote-access.md)).

## Step 1: Create the App

1. Open **Admin**, **Platform keys**, and expand **GitHub App**.
2. Click **Create the GitHub App**.
3. Fill in the dialog, or leave it empty:
   - **App name**: shown on GitHub, where it must be unique. 34
     characters at most. The default is `Guilds (<host>)`.
   - **Organisation**: the GitHub organisation that owns the App.
     Empty creates it on your own account.
4. Click **Continue on GitHub**, and confirm the App on GitHub.

GitHub sends you back to **Platform keys**, and **GitHub App** reads
**On**. If it shows **Couldn't create the GitHub App** instead,
nothing was stored: start again.

The App asks for read and write access to Contents and Pull requests,
and read access to Metadata. It is private and receives no webhooks.

## Step 2: Connect GitHub

1. Open **Tools** at the organisation, the guild, or the agent.
2. On the **GitHub** card, click **Connect**.
3. On GitHub, authorize the App.
4. If the App is not installed on your account yet, GitHub asks next
   which account to install it on and which repositories it may
   reach.

GitHub sends you back with the card connected and showing the
account. The App is installed once per GitHub account: a later
Connect, from another guild or agent, reuses that installation. When
you reach several installations, a page asks which account to use.

When the GitHub organisation needs an admin to approve the install,
click **Connect** again once they have.

## Step 3: Pick the repositories

On the **GitHub** card, pick each repository from **From GitHub ·
`<account>`**. The list holds the repositories the installation
reaches. To see another one, give the App access to it on GitHub.

A guild or agent without its own login uses its organisation's
repositories, and an agent its guild's. Connecting a login at the
narrower scope lets it pick a different set.

The guild's coding agents clone these repositories at their next
run ([Repositories](../concepts/coding/repositories.md),
[Add a coding agent](../getting-started/add-a-coding-agent.md)).

## Registering the App by hand

Instead of step 1, you can register the App yourself on GitHub
(**Settings**, **Developer settings**, **GitHub Apps**):

1. Create an App with:
   - Callback URL: `<PUBLIC_BASE_URL>/api/mcp/oauth/callback`
   - **Request user authorization (OAuth) during installation**
     checked. Without it, GitHub never sends you back to the box
     after an install, and Connect never completes.
   - **Redirect on update** checked
   - Webhook inactive
   - Repository permissions: Contents, Pull requests, and Issues
     read and write; Actions, Checks, Commit statuses, and Metadata
     read
   - **Only on this account** for where it can be installed
2. Generate a client secret and a private key.
3. On **Platform keys**, **GitHub App**, enter:
   - **App ID**
   - **App slug**: the last segment of `https://github.com/apps/<slug>`
   - **Private key (PEM)**: the file's content as is
   - **Client ID**
   - **Client secret**
4. Click **Save**.

## Troubleshooting

**The GitHub window stays on GitHub after you validate.** The App
does not request user authorization during installation. On GitHub,
open the App's settings, check **Request user authorization (OAuth)
during installation**, and save. Then uninstall the App from your
account and click **Connect** again.

**A GitHub tool answers 403.** The App or its installation lacks a
permission the tool needs. On GitHub, add the permissions listed in
[Registering the App by hand](#registering-the-app-by-hand) to the
App's settings. GitHub then asks each installation's owner to accept
them, under the account's **Installed GitHub Apps**. A tool that
needs a permission the App does not ask for, such as triggering a
workflow (Actions write), answers 403 until the App's settings add
it.

**GitHub sends you to a page that is not the box.** The App's
callback URL is not the box's address. Set `PUBLIC_BASE_URL`, and
make `<PUBLIC_BASE_URL>/api/mcp/oauth/callback` the App's first
callback URL ([Remote access](../operations/remote-access.md)).

## Replacing the App

An App with another App ID, or removing the App, disconnects every
GitHub login installed with the old one. The form asks first, with
the count. A new private key or client secret for the same App
disconnects nothing.

## Reference

### Setup state

The **GitHub App** integration stores `app_id`, `slug`,
`private_key`, `client_id`, and `client_secret`. Until all five are
set, Tools marks the connector **Not set up** with the missing fields
and disables Connect. A Connect sent anyway is a 422 with
`setup_state: unsupported` ([Platform keys](platform-keys.md)).
A replacing write without `confirm_replace` is a 409 with
`replaces_app: true` and `connections`. The private key accepts one
line with `\n` escapes too.

### Manifest flow

`POST /api/admin/instance/keys/github-app/manifest` with
`{ name?, owner?, return_to? }` answers `{ action, manifest, state }`
and sets the `guilds_github_manifest` cookie (HttpOnly, SameSite=Lax,
20 minutes, path = the callback). The browser posts the manifest to
`action`.

The manifest carries the settings above: `public: false`,
`request_oauth_on_install: true`, `setup_on_update: true`, and the
permissions `contents: write`, `pull_requests: write`,
`issues: write`, `actions: read`, `checks: read`, `statuses: read`,
and `metadata: read`. It sets no setup URL. Its `url` is the box's
address. Its callback URLs are
`<PUBLIC_BASE_URL>/api/mcp/oauth/callback` and, when the admin
reached the box at another address, that address's callback too. A box on the public internet also names an
inactive webhook at `<address>/api/github/webhook`. A loopback or
private address omits it: GitHub refuses a hook URL it cannot reach.

GitHub redirects to
`GET /api/admin/instance/keys/github-app/manifest/callback?code&state`.
The callback checks that the cookie's state matches a flow this
process started, trades the code once at
`POST https://api.github.com/app-manifests/{code}/conversions`, and
stores the fields for the admin who started the flow. It redirects to
`return_to` (a path on this app only) or to
`/admin?tab=instance&integration=github-app`. A failure redirects
there with `setup_error=state|conversion|store` and stores nothing
([Security register](../architecture/security-register.md), SEC-22).

### Connect flow

Connect follows the pending-login path of the browser logins
([OAuth](connectors.md#oauth)). GitHub connects at the organisation, a
guild, or an agent; any other scope is a 422.

1. Connect creates a pending connection with its `oauth_state` and
   answers with user authorization at `/login/oauth/authorize`, with
   the callback URL and the state. The cookie `guilds_github_oauth`
   (HttpOnly, SameSite=Lax, 20 minutes, path
   `/api/mcp/oauth/callback`) keeps the state in case GitHub omits it
   after a later hop. Connect always starts with user authorization,
   never on the install page.
2. The orchestrator trades the `code` for a user token and keeps an
   installation only when that user reaches it: the callback's
   `installation_id` when present, else the App's only installation
   on the token. Several open a picker
   ([Installation picker](#installation-picker)). None redirects to
   `https://github.com/apps/<slug>/installations/new?state=…`, whose
   own authorization hop returns a new `code` with the
   `installation_id`, traded without `redirect_uri`. A setup redirect
   (`setup_action` `install` or `update`) with `installation_id` and
   no `code` starts user authorization with the same `state`. An id in the URL alone proves nothing. The user
   token is discarded. A refused callback deletes a new pending
   connection.
3. The connection stores the installation id, takes the account's
   login as `account_hint`, becomes `connected`, and writes its
   enabled binding.

An install awaiting an organisation admin returns
`setup_action=request`. The box then shows **Approval Required**,
deletes a new pending login, and asks to connect again once the admin
approves.

### Installation picker

When the user reaches several installations, the callback redirects
to the picker page. Its `state` is the pending login's.

| Route | Does |
| --- | --- |
| `GET /api/mcp/oauth/github-installation?state=` | The picker page |
| `GET /api/mcp/oauth/github-installations?state=` | `{ installations: [{ id, account }], install_url }`: the App's installations the user reaches, and the install page to add another |
| `POST /api/mcp/oauth/github-installation` | `{ state, installation_id }`: connects the login to that installation. Answers `{ ok, account }` |

An expired or finished sign-in is a 404. An installation the user
does not reach is a 400.

### Tools

A login's tools come from GitHub's hosted MCP server,
`https://api.githubcopilot.com/mcp/`, with the `repos`, `issues`,
`pull_requests`, and `actions` toolsets (`X-MCP-Toolsets`).
`create_repository` and `fork_repository` are left out
(`policy.exclude`): an installation token limited to picked
repositories cannot use them. Tools that write start Off
([What starts Off](connectors.md#what-starts-off)). A login with no
repositories picked lists no tools.

Tools lists a login's tools like any connector's. The connector's
On/Off switch turns its tools on or off for that scope. Coding runs
reach the guild's repositories either way, and also use `git` and
`gh` in the sandbox.

The connector's State hook puts `github_repositories` in every run of
an agent that has GitHub on: the login's picked repositories as
`{ owner, repo, default_branch }`, the `owner` and `repo` the tools
take. A login with none picked adds no key.

### Repositories

`GET /api/mcp/connections/:id/github/repositories` lists what the
installation reaches: `name`, `full_name`, `owner`, `private`,
`default_branch`, `url`.

`PUT /api/mcp/connections/:id/github/selected` stores
`{ repositories: [{ name, url, default_branch }] }` in the login's
settings as `repositories`. Each must be one the installation
reaches, and is stored with GitHub's id for it (`github_id`), which a
rename of the repository or its owner keeps. A guild-owned login
mirrors its selection into `guild_repositories`.

### Tokens

The App's private key and the installation id never leave the
orchestrator. At each generation start of a coding agent, it signs an
App token (RS256, 9 minutes) and mints, per connection, an
installation token limited to the guild's repositories, valid one
hour ([Repositories](../concepts/coding/repositories.md#tokens)).

`guilds-git-credential` is the credential helper for
`https://github.com` with `useHttpPath`. It reads
`/run/guilds/<agent id>/git-tokens.json` for the agent
`GUILDS_AGENT_HOME` names. It is set in the image's system git
configuration and again through `GIT_CONFIG_COUNT`, which git reads
after every configuration file, so a helper the agent configures,
such as the one `gh auth setup-git` writes, cannot replace it.

A login's tool session sends an installation token for every
repository the login picked, holding every permission the
installation grants. The token stays in the orchestrator. The pool
mints a new one when the current one is within 10 minutes of expiry
or the endpoint answers 401, and drops the session when the login's
selection changes. A call on a login with no repositories picked
fails with a 422.

When GitHub refuses a token because the installation was removed or
suspended (404 or 403), the connection becomes `disconnected`, and
the coding generation or tool call that needed it fails. Deleting the
connection deletes the guild repositories added through it.
