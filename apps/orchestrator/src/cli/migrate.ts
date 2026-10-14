import { loadToolConfig } from "../config/index.js";
import { createPool, repairMigrations } from "../db/client.js";

// Applies core's committed migrations to the database, keeping its data, after giving each
// recorded migration its committed stamp. `make migrate` runs it on the development stack.
const config = loadToolConfig();
const pool = await createPool(config.databaseUrl);
try {
  const restamped = await repairMigrations(pool);
  console.log(restamped.length ? `re-stamped ${restamped.join(", ")}; migrations applied` : "migrations applied");
} finally {
  await pool.end();
}
