import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeMasterKey } from "../../src/config/index.js";
import type { RemoteInfo } from "../../src/connectors/types.js";
import { encryptPayload } from "../../src/credentials/crypto.js";
import type { Queryable } from "../../src/db/pg.js";
import { discardAttempt, fillFromEndpoint, type ConnectFlowServices } from "../../src/mcp/connect-flow.js";
import { McpError } from "../../src/mcp/errors.js";
import type { McpPool } from "../../src/mcp/pool.js";
import { HEX_MASTER_KEY } from "../helpers/env.js";
import { connectionRow, serverRow } from "../helpers/servers.js";

const KEY = decodeMasterKey(HEX_MASTER_KEY);

/** A database that records each statement it is sent, and answers it with no rows or fails with `failure`. */
function recordingDb(statements: string[], failure: Error | null = null): Queryable {
  return {
    query: async (text: string) => {
      statements.push(text.trim().split(/\s+/)[0]!);
      if (failure !== null) {
        throw failure;
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Queryable;
}

/** A pool whose endpoint answers `initialize` with `info`, or fails with `failure`. */
function describing(info: RemoteInfo, failure: Error | null = null): McpPool {
  return {
    describeEndpoint: async () => {
      if (failure !== null) {
        throw failure;
      }
      return info;
    },
  } as unknown as McpPool;
}

const BLANK_ORG_SERVER = serverRow("wiki", { owner_org_id: "org_1" });
const SAYS: RemoteInfo = { name: "Wiki", instructions: "Searches the wiki." };

test("discarding_a_sign_in_whose_pending_payload_no_longer_decrypts_deletes_the_login", async () => {
  const statements: string[] = [];
  const services: ConnectFlowServices = { db: recordingDb(statements), mcp: null, masterKey: KEY };
  await discardAttempt(services, connectionRow({ status: "pending" }));
  assert.deepEqual(statements, ["DELETE"]);
});

test("discarding_a_sign_in_whose_pending_payload_replaces_a_login_disconnects_it", async () => {
  const statements: string[] = [];
  const services: ConnectFlowServices = { db: recordingDb(statements), mcp: null, masterKey: KEY };
  const [ciphertext, nonce] = encryptPayload({ oauth: { replaces: true } }, KEY);
  await discardAttempt(services, connectionRow({ status: "pending", ciphertext, nonce }));
  assert.deepEqual(statements, ["UPDATE"]);
});

test("filling_from_an_endpoint_that_does_not_answer_keeps_the_server_as_it_is", async () => {
  const statements: string[] = [];
  const services: ConnectFlowServices = {
    db: recordingDb(statements),
    mcp: describing(SAYS, new McpError("mcp 503", 503)),
    masterKey: KEY,
  };
  await fillFromEndpoint(services, connectionRow(), BLANK_ORG_SERVER);
  assert.deepEqual(statements, []);
});

test("filling_from_an_endpoint_writes_what_it_says_and_a_failed_write_surfaces", async () => {
  const statements: string[] = [];
  const services: ConnectFlowServices = { db: recordingDb(statements), mcp: describing(SAYS), masterKey: KEY };
  await fillFromEndpoint(services, connectionRow(), BLANK_ORG_SERVER);
  assert.deepEqual(statements, ["UPDATE"]);
  const down = new Error("connection terminated");
  const failing: ConnectFlowServices = { ...services, db: recordingDb([], down) };
  await assert.rejects(fillFromEndpoint(failing, connectionRow(), BLANK_ORG_SERVER), down);
});
