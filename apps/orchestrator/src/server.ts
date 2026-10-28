import "./instrument.js";
import { loadConfig } from "./config/index.js";
import { runServer } from "./run.js";

await runServer(loadConfig());
