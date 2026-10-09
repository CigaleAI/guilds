import { loadToolConfig } from "../config/index.js";
import { connect } from "../db/client.js";
import { seedOperator } from "../db/seed/operator.js";
import { seedSystem } from "../db/seed/system.js";
import { seedTest } from "../db/seed/test.js";

const kind = process.argv[2];
if (kind !== "system" && kind !== "operator" && kind !== "test") {
  throw new Error("usage: seed.ts system|operator|test");
}

const config = loadToolConfig();
const database = await connect(config.databaseUrl);
try {
  if (kind === "system") {
    await seedSystem(database.pool);
  } else if (kind === "operator") {
    await seedOperator(database.pool);
  } else {
    await seedTest(database.pool);
  }
} finally {
  await database.close();
}
