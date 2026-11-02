import type { Static, TObject } from "@sinclair/typebox";
import {
  createDraft,
  downloadAttachment,
  getMessage,
  getThread,
  GmailError,
  listDrafts,
  listLabels,
  ping,
  searchThreads,
  sendMessage,
  type GmailOptions,
} from "./client.js";
import {
  AttachmentDownload,
  DraftPage,
  MessageLookup,
  NoParameters,
  OutgoingMessage,
  ThreadLookup,
  ThreadSearch,
} from "./parameters.js";
import { adapterTool, toolsAdapter } from "../tools.js";
import { requiredCredential, translated, type AdapterTool, type ConnectorContext, type Credentials } from "../types.js";

/** What a Gmail call is made with: the login's access token, the run's HTTP client and workspace. */
function gmailOptions(creds: Credentials, ctx: ConnectorContext): GmailOptions {
  const accessToken = requiredCredential(creds, "access_token", "Gmail access token is missing");
  return { accessToken, client: ctx.http, ...(ctx.workspace_dir ? { workspaceDir: ctx.workspace_dir } : {}) };
}

/** The Gmail tool `name`: `work` on its decoded arguments, a `GmailError` answered as a `ConnectorError`. */
function gmailTool<P extends TObject>(
  name: string,
  parameters: P,
  work: (input: Static<P>, options: GmailOptions) => Promise<string>,
): AdapterTool {
  return adapterTool({
    name,
    parameters,
    run: (input, creds, ctx) => {
      const options = gmailOptions(creds, ctx);
      return translated(GmailError, () => work(input, options));
    },
  });
}

const TOOLS = [
  gmailTool("search_threads", ThreadSearch, searchThreads),
  gmailTool("get_thread", ThreadLookup, (input, options) => getThread(input.thread_id, options)),
  gmailTool("get_message", MessageLookup, (input, options) => getMessage(input.message_id, options)),
  gmailTool("download_attachment", AttachmentDownload, downloadAttachment),
  gmailTool("list_labels", NoParameters, (_input, options) => listLabels(options)),
  gmailTool("list_drafts", DraftPage, listDrafts),
  gmailTool("create_draft", OutgoingMessage, createDraft),
  gmailTool("send_message", OutgoingMessage, sendMessage),
];

export default toolsAdapter(TOOLS, {
  async validate(creds, ctx) {
    const accessToken = requiredCredential(creds, "access_token", "Gmail access token is missing");
    return translated(GmailError, () => ping(accessToken, { client: ctx.http }));
  },
});
