# Gmail and Drive

Connecting Gmail lets agents read mail, download attachments, and
write drafts. Connecting Drive lets agents search, read, and create
files in one folder. Both sign in through one Google Cloud OAuth client
per box. You set them up in three steps:

1. A platform admin creates the Google Cloud client, once per box.
2. A platform admin enters its Client ID and Client secret under
   **Platform keys**.
3. An operator connects Gmail or Drive under **Tools**.

## Before you start

- You are a platform admin on the box, for steps 1 and 2.
- You know the box's callback URL:
  `<PUBLIC_BASE_URL>/api/mcp/oauth/callback`. When `PUBLIC_BASE_URL`
  is empty, it is the address you reach the box at. The operator's
  browser follows that redirect, so Google needs no path to the box
  ([Remote access](../operations/remote-access.md)).

## Step 1: Create the Google Cloud client

In the Google Cloud console:

1. Create a project, or pick one.
2. Enable the APIs the connectors call:
   - Gmail: `gmail.googleapis.com`
   - Drive: `drive.googleapis.com` and `drivemcp.googleapis.com`
3. Configure the OAuth consent screen. Add the scopes
   `https://www.googleapis.com/auth/gmail.readonly`,
   `https://www.googleapis.com/auth/gmail.compose`, and
   `https://www.googleapis.com/auth/drive`.
4. Create an OAuth client ID of type **Web application**.
5. Add the box's callback URL as an authorized redirect URI.
6. Copy the Client ID and the Client secret.

## Step 2: Enter the client

1. Open **Admin**, **Platform keys**, and expand **Google
   connectors**.
2. Paste the **Client ID** and the **Client secret**.
3. Click **Save**.

**Google connectors** reads **On**. Until both values are set,
**Tools** marks Gmail and Drive **Not set up** and disables
**Connect** ([Platform keys](platform-keys.md)).

## Step 3: Connect

1. Open **Tools** at the organisation, the guild, or the agent.
2. On the **Gmail** or **Google Drive** card, click **Connect**.
3. Sign in to Google and allow access.

The Gmail card reads connected. For Drive, the sign-in page says to
finish setup in guilds.run. The Drive card then shows a **Folder**
field: search for the folder by name, or paste a folder link, then
save. The card reads connected, showing the folder's name.

## Gmail

Gmail calls `https://gmail.googleapis.com/gmail/v1` with the login's
Google access token. It writes eight tools after a successful
`/users/me/profile` check:

| Tool | Does |
| --- | --- |
| `search_threads` | Searches threads |
| `get_thread` | Reads one thread, listing each message's attachments with their part ids |
| `get_message` | Reads one message, listing its attachments with their part ids |
| `download_attachment` | Writes one attachment to an optional `file_path` in the agent's home and returns the path, not the bytes. Up to 25 MB, during an agent run |
| `list_labels` | Lists labels |
| `list_drafts` | Lists drafts |
| `create_draft` | Writes a draft |
| `send_message` | Sends a message. Starts Off |

## Drive

Drive wraps the Drive MCP endpoint,
`https://drivemcp.googleapis.com/mcp/v1`. The Google token can see the
whole Drive, and `drive` is a restricted OAuth scope. The adapter
limits every call to one folder.

The login waits for its `folder_id` setting
([Login settings](connectors.md#login-settings)):

- Its `lookup` takes a pasted folder link or id. Otherwise it searches
  folders by name across My Drive, folders shared with the account,
  and shared drives.
- Its `validate` requires one folder that is not My Drive. The login's
  `account_hint` is that folder's name.

Each Drive tool is limited to that folder and its descendants:

| Tool | Does |
| --- | --- |
| `search_files` | Searches the folder, through the Drive API with shared-drive flags |
| `list_recent_files` | Recent files in the folder, the same way |
| `read_file_content` | Reads a file's text |
| `download_file_content` | Writes a file to an optional `file_path` in the agent's home and returns the path, not the bytes |
| `get_file_metadata` | A file's metadata |
| `get_file_permissions` | A file's permissions |
| `copy_file` | Copies a file. Starts Off |
| `create_file` | Creates a file or a folder. Starts Off |

`create_file` takes `file_path` in the agent's home,
`/home/<agent id>`. The orchestrator reads and encodes the file. Small
UTF-8 text may use `textContent` instead. To create a folder, set
`title` and `contentMimeType` `application/vnd.google-apps.folder`.
`create_file` and `download_file_content` follow the
[home file rules](../concepts/agent-home.md#agent-home-files).

The Drive MCP server has no delete tool.

## Reference

- Both connectors use `configured` OAuth with the `google-connectors`
  provider. Connect reads the client at each sign-in. Missing
  credentials are a 422 with `setup_state: unsupported`.
- Authorize requests the connector's scopes with `access_type=offline`,
  `prompt=consent`, and PKCE, against
  `https://accounts.google.com/o/oauth2/v2/auth`. Tokens come from
  `https://oauth2.googleapis.com/token`.
- The callback and refresh follow [OAuth](connectors.md#oauth).
