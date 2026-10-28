import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { decodeMasterKey } from "../../src/config/index.js";
import { encryptPayload } from "../../src/credentials/crypto.js";
import {
  QontoError,
  callTool,
  isMissingInvoice,
  ping,
  readInvoiceFile,
} from "../../src/connectors/qonto/client.js";
import { ListedTool, McpPool } from "../../src/mcp/index.js";
import { CONNECTORS } from "../../src/connectors/index.js";
import { HEX_MASTER_KEY } from "../helpers/env.js";
import { mockFetch } from "../helpers/http.js";
import { serverRow } from "../helpers/servers.js";
import { connectionRow } from "../helpers/servers.js";
import { MemoryMcpDatabase } from "../helpers/mcp-database.js";

/** A temporary host directory named after agent a_1, as its home sits on its machine. */
async function agentWorkspace(prefix: string): Promise<string> {
  const workspace = path.join(await mkdtemp(path.join(os.tmpdir(), prefix)), "a_1");
  await mkdir(workspace);
  return workspace;
}

const KEY = decodeMasterKey(HEX_MASTER_KEY);
const TOOLS = CONNECTORS.bySlug("qonto")!.manifest.tools!;
const CREDS = { login: "org-login", secretKey: "org-secret" };

function tx(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "tx-1",
    settled_at: "2026-09-01T12:00:00.000Z",
    amount: 42,
    currency: "EUR",
    side: "debit",
    label: "Acme",
    operation_type: "card",
    category: "office_supplies",
    card_last_digits: "4242",
    note: null,
    reference: null,
    bank_account_id: "acc-1",
    attachment_ids: [],
    attachment_required: true,
    attachment_lost: false,
    ...extra,
  };
}

function organization(accounts = [{ id: "acc-1", name: "Main", iban: "FR76", currency: "EUR", status: "active" }]) {
  return { organization: { name: "Elektro", bank_accounts: accounts } };
}

test("isMissingInvoice applies the three rules", () => {
  assert.equal(isMissingInvoice(tx()), true);
  assert.equal(isMissingInvoice(tx({ attachment_ids: ["att"] })), false);
  assert.equal(isMissingInvoice(tx({ attachment_required: false })), false);
  assert.equal(isMissingInvoice(tx({ attachment_lost: true })), false);
});

test("readInvoiceFile reads an invoice under the workspace and nothing a link points out of it", async () => {
  const base = await agentWorkspace("qonto-");
  const workspace = path.join(base, "a_1");
  await mkdir(path.join(workspace, "invoices"), { recursive: true });
  await writeFile(path.join(workspace, "invoices", "a.pdf"), "%PDF-1.4");
  const host = path.join(base, "host.pdf");
  await writeFile(host, "%PDF orchestrator file");
  await symlink(host, path.join(workspace, "planted.pdf"));
  const read = await readInvoiceFile(workspace, "/home/a_1/invoices/a.pdf");
  assert.equal(read.path, path.join(workspace, "invoices", "a.pdf"));
  assert.equal(read.mime, "application/pdf");
  assert.equal(read.content.toString(), "%PDF-1.4");
  await assert.rejects(() => readInvoiceFile(workspace, "planted.pdf"), /not a link out of it/);
  await assert.rejects(() => readInvoiceFile(workspace, "/etc/passwd"), /under \/home\/a_1/);
  await assert.rejects(() => readInvoiceFile(workspace, "../host.pdf"), /under \/home\/a_1/);
  await assert.rejects(() => readInvoiceFile(workspace, "missing.pdf"), /file not found: missing.pdf/);
});

test("list_bank_accounts maps fields and sends secret-key auth", async () => {
  let authorization = "";
  const stored = await callTool(
    "list_bank_accounts",
    {},
    {
      ...CREDS,
      client: mockFetch((url, init) => {
        authorization = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
        assert.ok(url.endsWith("/v2/organization"));
        return { status: 200, json: organization() };
      }),
    },
  );
  assert.equal(authorization, "org-login:org-secret");
  assert.equal(stored, "acc-1  Main  FR76  EUR  active");
});

test("list_missing_invoices paginates, filters, and skips closed accounts", async () => {
  const seen: string[] = [];
  const stored = await callTool(
    "list_missing_invoices",
    {},
    {
      ...CREDS,
      now: () => new Date("2026-09-28T12:00:00Z"),
      client: mockFetch((url) => {
        seen.push(url);
        const parsed = new URL(url);
        if (parsed.pathname === "/v2/organization") {
          return {
            status: 200,
            json: organization([
              { id: "acc-1", name: "Main", iban: "FR76", currency: "EUR", status: "active" },
              { id: "acc-2", name: "Old", iban: "FR77", currency: "EUR", status: "closed" },
            ]),
          };
        }
        assert.equal(parsed.searchParams.get("status[]"), "completed");
        assert.equal(parsed.searchParams.get("with_attachments"), "false");
        assert.equal(parsed.searchParams.get("side"), "debit");
        assert.equal(parsed.searchParams.get("settled_at_from"), "2026-06-30");
        assert.equal(parsed.searchParams.get("settled_at_to"), "2026-09-28");
        const page = parsed.searchParams.get("page") ?? "1";
        if (page === "1") {
          return {
            status: 200,
            json: {
              transactions: [
                tx({ id: "keep-1", settled_at: "2026-09-20T10:00:00.000Z", amount: 10 }),
                tx({ id: "has-file", attachment_ids: ["x"] }),
              ],
              meta: { next_page: 2 },
            },
          };
        }
        return {
          status: 200,
          json: {
            transactions: [
              tx({ id: "lost", attachment_lost: true }),
              tx({ id: "keep-2", settled_at: "2026-09-10T10:00:00.000Z", amount: 5 }),
              tx({ id: "optional", attachment_required: false }),
            ],
            meta: { next_page: null },
          },
        };
      }),
    },
  );
  assert.ok(!seen.some((url) => url.includes("acc-2")));
  assert.match(stored, /^count=2 {2}total=15 {2}EUR\n/);
  assert.match(stored, /keep-1/);
  assert.match(stored, /keep-2/);
  assert.ok(!stored.includes("has-file"));
  assert.ok(!stored.includes("lost"));
});

test("retry honors Retry-After then succeeds", async () => {
  let hits = 0;
  await ping(CREDS, {
    client: mockFetch(() => {
      hits += 1;
      if (hits === 1) {
        return { status: 429, headers: { "retry-after": "0" }, json: { errors: [{ detail: "slow" }] } };
      }
      return { status: 200, json: organization() };
    }),
    sleep: async () => undefined,
  });
  assert.equal(hits, 2);
});

test("401 is bad credentials and is not retried", async () => {
  let hits = 0;
  await assert.rejects(
    () =>
      ping(CREDS, {
        client: mockFetch(() => {
          hits += 1;
          return { status: 401, json: { errors: [{ detail: "nope" }] } };
        }),
      }),
    (error: unknown) => error instanceof QontoError && error.status === 401 && error.message === "bad credentials",
  );
  assert.equal(hits, 1);
});

test("get_transaction 404 is unknown transaction", async () => {
  await assert.rejects(
    () =>
      callTool("get_transaction", { transaction_id: "missing" }, {
        ...CREDS,
        client: mockFetch(() => ({ status: 404, json: { errors: [{ detail: "Transaction not found" }] } })),
      }),
    (error: unknown) => error instanceof QontoError && error.message === "unknown transaction",
  );
});

test("upload_invoice refuses a duplicate without force", async () => {
  const workspace = await agentWorkspace("qonto-");
  const invoice = path.join(workspace, "receipt.pdf");
  await writeFile(invoice, "%PDF-1.4");
  let posted = false;
  const stored = await callTool(
    "upload_invoice",
    { transaction_id: "tx-1", file_path: "/home/a_1/receipt.pdf" },
    {
      ...CREDS,
      workspaceDir: workspace,
      client: mockFetch((url, init) => {
        if (init?.method === "POST") {
          posted = true;
        }
        return { status: 200, json: { transaction: tx({ attachment_ids: ["att-1"] }) } };
      }),
    },
  );
  assert.equal(stored, "status=skipped_already_attached  tx=tx-1  attachments=att-1");
  assert.equal(posted, false);
});

test("upload_invoice rejects a non-pdf/jpeg/png", async () => {
  const workspace = await agentWorkspace("qonto-");
  const notes = path.join(workspace, "notes.txt");
  await writeFile(notes, "hello");
  await assert.rejects(
    () =>
      callTool("upload_invoice", { transaction_id: "tx-1", file_path: "notes.txt" }, {
        ...CREDS,
        workspaceDir: workspace,
        client: mockFetch(() => ({ status: 200, json: {} })),
      }),
    /only PDF, JPEG, and PNG/,
  );
});

test("upload_invoice posts, reuses the idempotency key, and polls", async () => {
  const workspace = await agentWorkspace("qonto-");
  const invoice = path.join(workspace, "receipt.pdf");
  await writeFile(invoice, "%PDF-1.4");
  const keys: string[] = [];
  let gets = 0;
  let posts = 0;
  const stored = await callTool(
    "upload_invoice",
    { transaction_id: "tx-1", file_path: "receipt.pdf" },
    {
      ...CREDS,
      workspaceDir: workspace,
      sleep: async () => undefined,
      client: mockFetch((_url, init) => {
        const method = init?.method ?? "GET";
        if (method === "POST") {
          posts += 1;
          keys.push(String((init?.headers as Record<string, string> | undefined)?.["X-Qonto-Idempotency-Key"] ?? ""));
          if (posts === 1) {
            return { status: 503, json: {} };
          }
          return { status: 200, json: {} };
        }
        gets += 1;
        if (gets < 3) {
          return { status: 200, json: { transaction: tx() } };
        }
        return { status: 200, json: { transaction: tx({ attachment_ids: ["att-9"] }) } };
      }),
    },
  );
  assert.equal(posts, 2);
  assert.equal(keys[0], keys[1]);
  assert.match(keys[0] ?? "", /^[0-9a-f-]{36}$/i);
  assert.equal(stored, "status=uploaded  tx=tx-1  attachments=att-9");
});

test("sync Qonto writes the curated catalog", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  let pinged = 0;
  const pool = new McpPool(new MemoryMcpDatabase(), 10 * 60 * 1000);
  pool.connectors = CONNECTORS.withAdapter("qonto", {
    async validate(stored) {
      const creds = { login: stored.login, secretKey: stored.secret_key };
      pinged += 1;
      assert.equal(creds.login, "org-login");
      assert.equal(creds.secretKey, "org-secret");
      return "Elektro";
    },
  });
  const [ciphertext, nonce] = encryptPayload({ login: "org-login", secret_key: "org-secret" }, KEY);
  const connection = connectionRow({ id: "conn_qonto", status: "connected", ciphertext, nonce });
  const server = serverRow("qonto", { id: "mcp_qonto", auth: "token" });
  const first = await pool.syncTools(connection, server, { force: true });
  const second = await pool.syncTools(connection, server);
  assert.equal(pinged, 1);
  assert.deepEqual(first.map((tool) => tool.namespaced_name), TOOLS.map((spec) => `qonto_${spec.name}`));
  assert.deepEqual(first, second);
  assert.deepEqual(first[0], new ListedTool("list_bank_accounts", "qonto_list_bank_accounts", TOOLS[0]!.description, TOOLS[0]!.input_schema));
});

test("call Qonto dispatches with stored login and secret", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const seen: Record<string, unknown> = {};
  const pool = new McpPool(new MemoryMcpDatabase());
  pool.connectors = CONNECTORS.withAdapter("qonto", {
    async call(name, arguments_, creds, ctx) {
      seen.name = name;
      seen.arguments = arguments_;
      seen.login = creds.login;
      seen.secret = creds.secret_key;
      seen.workspace = ctx.workspace_dir;
      return "count=0  total=0";
    },
  });
  const [ciphertext, nonce] = encryptPayload({ login: "org-login", secret_key: "org-secret" }, KEY);
  const stored = await pool.call(
    connectionRow({ id: "conn_qonto", status: "connected", ciphertext, nonce }),
    serverRow("qonto", { id: "mcp_qonto", auth: "token" }),
    { tool: "list_missing_invoices", arguments: { side: "debit" }, caller: { orgId: null, workspaceDir: "/tmp/ws" } },
  );
  assert.equal(stored, "count=0  total=0");
  assert.deepEqual(seen, {
    name: "list_missing_invoices",
    arguments: { side: "debit" },
    login: "org-login",
    secret: "org-secret",
    workspace: "/tmp/ws",
  });
});
