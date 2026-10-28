import { loadToolConfig } from "../config/index.js";
import { createPool, repairMigrations } from "../db/client.js";
import { startErrorReporting } from "../error-reporting.js";
import { reportPoolError } from "../observability/runtime.js";

// Applies core's committed migrations to the database, keeping its data, after giving each
// recorded migration its committed stamp. `make migrate` runs it on the development stack.
startErrorReporting();
const config = loadToolConfig();
const pool = await createPool(config.databaseUrl, reportPoolError);
try {
  const restamped = await repairMigrations(pool);
  console.log(restamped.length ? `re-stamped ${restamped.join(", ")}; migrations applied` : "migrations applied");
} finally {
  await pool.end();
}
