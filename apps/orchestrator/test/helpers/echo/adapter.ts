import { ConnectorError, type Adapter } from "../../../src/connectors/types.js";

// A code connector for registry tests: bundled, it carries its own copy of ConnectorError.
const adapter: Adapter = {
  async call(name, args) {
    if (name === "say") {
      return `echo: ${String(args.text)}`;
    }
    throw new ConnectorError(`echo refuses ${name}`, 422);
  },
};

export default adapter;
