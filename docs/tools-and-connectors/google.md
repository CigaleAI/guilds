# Gmail and Drive

Gmail and Drive share one Google Cloud OAuth client on the box: the
**Google connectors** integration under **Admin**, **Platform keys**.
A platform admin registers a Web application on Google Cloud,
enables the APIs, and pastes its Client ID and Client secret there.
Until both are set, Tools marks both connectors **Not set up** and
disables Connect ([Integrations](catalog.md#integrations)).

The redirect URI is `<PUBLIC_BASE_URL>/api/mcp/oauth/callback`, or
the address the box is reached at when `PUBLIC_BASE_URL` is empty.
The operator's browser follows that redirect, so the provider needs
no path to the box
([Remote access](../getting-started/remote-access.md)). Register
that URI on the Cloud client.

Connect follows the same callback and refresh path as Notion
([Connectors](connectors.md#browser-oauth)). The client is the
Google Cloud Web application the integration holds, read at each
Connect. Missing credentials are a Connect error.

## Gmail

The Cloud project enables `gmail.googleapis.com`. Authorize requests
`gmail.readonly` and `gmail.compose` with `access_type=offline`
against Google's user OAuth endpoints.

Gmail writes `search_threads`, `get_thread`, `get_message`,
`list_labels`, `list_drafts`, `create_draft`, and `send_message`
after a successful `/users/me/profile` ping. `send_message` starts
Off.

Calls hit `https://gmail.googleapis.com/gmail/v1` with the stored
Google access token.

## Drive

The Cloud project enables `drive.googleapis.com` and
`drivemcp.googleapis.com`. Authorize requests `drive` with
`access_type=offline`.

After Google login, the login waits for its `folder_id` setting
([Login settings](connectors.md#login-settings)). Its `lookup` takes
a pasted folder link or id, or searches folders by name across My
Drive, folders shared with the account, and shared drives. Its
`validate` requires one folder that is not My Drive, and the
connection's `account_hint` is that folder's name. Each Drive tool
call is limited to that folder and its descendants.

Search and recent-file lists use the Drive API with Shared drive
flags, then keep only files in that folder. These also use that
API:

- read
- download
- metadata
- permissions
- copy
- create

`create_file` takes `file_path` under `/home/agent`. The
orchestrator reads the file.

`download_file_content` writes that path and returns it. It does not
return file bytes. Both follow the
[workspace file rules](../concepts/secrets-and-access.md#agent-workspace-files).

Small UTF-8 text may use `textContent`. Create and copy stay off
until the operator enables them. Official Drive MCP has no delete.

The Google token can see the rest of the Drive. `drive` is a
restricted OAuth scope.
