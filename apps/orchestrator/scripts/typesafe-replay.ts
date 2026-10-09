// Replay the Jev recipient Choice for one group-chat message and print what
// it decided, so "why did nobody answer?" has an answer after the fact.
//
//   npm run typesafe:replay -- --guild <guild_id>              latest message
//   npm run typesafe:replay -- --guild <guild_id> --seq 42     that message
//   npm run typesafe:replay -- --guild <guild_id> --message "text"
//                                                   hypothetical user post
//   add --json for the raw report, --min 0.7 to try another confidence gate.
import { loadToolConfig } from "../src/config/index.js";
import { connect } from "../src/db/client.js";
import { Repositories } from "../src/db/repositories.js";
import { createTypeSafeClient } from "../src/typesafe/client.js";
import { formatRecipientReplay, replayRecipients } from "../src/typesafe/replay.js";

function parseArgs(argv: string[]): {
  guild: string;
  seq?: number;
  message?: string;
  json: boolean;
  min?: number;
} {
  let guild = "";
  let seq: number | undefined;
  let message: string | undefined;
  let min: number | undefined;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      const value = argv[index];
      if (value === undefined) {
        throw new Error(`${arg} needs a value`);
      }
      return value;
    };
    if (arg === "--guild") {
      guild = next();
    } else if (arg === "--seq") {
      seq = Number(next());
    } else if (arg === "--message") {
      message = next();
    } else if (arg === "--min") {
      min = Number(next());
    } else if (arg === "--json") {
      json = true;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  if (!guild) {
    throw new Error("--guild <guild_id> is required");
  }
  const out: ReturnType<typeof parseArgs> = { guild, json };
  if (seq !== undefined) {
    if (!Number.isInteger(seq) || seq < 1) {
      throw new Error("--seq must be a positive integer");
    }
    out.seq = seq;
  }
  if (message !== undefined) {
    out.message = message;
  }
  if (min !== undefined) {
    if (!Number.isFinite(min) || min < 0 || min > 1) {
      throw new Error("--min must be between 0 and 1");
    }
    out.min = min;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const client = createTypeSafeClient();
if (!client.configured) {
  process.stderr.write("TYPESAFE_API_KEY is not set\n");
  process.exit(2);
}
const config = loadToolConfig();
const database = await connect(config.databaseUrl);
try {
  const repo = new Repositories(database.pool);
  const guild = await repo.getGuild(args.guild);
  if (guild === null) {
    process.stderr.write(`guild ${args.guild} not found\n`);
    process.exit(1);
  }
  const report = await replayRecipients({
    rows: await repo.listGroupMessages(args.guild),
    members: await repo.listAgents(args.guild),
    client,
    ...(args.seq !== undefined ? { seq: args.seq } : {}),
    ...(args.message !== undefined ? { message: args.message } : {}),
    ...(args.min !== undefined ? { confidenceMin: args.min } : {}),
  });
  process.stdout.write(
    args.json ? `${JSON.stringify(report, null, 2)}\n` : formatRecipientReplay(report),
  );
} finally {
  await database.close();
}
