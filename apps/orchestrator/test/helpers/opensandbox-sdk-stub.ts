// An OpenSandbox SDK with no sandboxes, loaded through OPENSANDBOX_SDK_MODULE by a test that
// boots the server and never starts one. It records the connection each manager was created with.

export const managers: Array<{ domain: string; apiKey: string }> = [];

export const SandboxManager = {
  create(options: { connectionConfig?: { domain?: string; apiKey?: string; api_key?: string } } = {}) {
    const connection = options.connectionConfig ?? {};
    managers.push({
      domain: String(connection.domain ?? ""),
      apiKey: String(connection.apiKey ?? connection.api_key ?? ""),
    });
    return {
      async listSandboxInfos() {
        return { items: [] };
      },
      async killSandbox() {},
      async close() {},
    };
  },
};

export const Sandbox = {
  async create(): Promise<never> {
    throw new Error("the stub SDK starts no sandbox");
  },
  async connect(): Promise<never> {
    throw new Error("the stub SDK starts no sandbox");
  },
};
