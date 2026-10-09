export type DocsMcpConfig = {
  baseUrl: string;
  apiKey: string | undefined;
  timeoutMs: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DocsMcpConfig {
  const baseUrl = (env.LIGHTRAG_URL ?? "http://127.0.0.1:9621").replace(/\/$/, "");
  const apiKey = env.LIGHTRAG_API_KEY?.trim();
  const timeoutRaw = env.LIGHTRAG_TIMEOUT_MS?.trim();
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000) {
    throw new Error("LIGHTRAG_TIMEOUT_MS must be a number of milliseconds >= 1000");
  }
  return {
    baseUrl,
    apiKey: apiKey === "" ? undefined : apiKey,
    timeoutMs,
  };
}
