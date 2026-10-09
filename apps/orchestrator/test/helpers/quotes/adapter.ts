import { ConnectorError, requiredCredential, type Adapter } from "../../../src/connectors/types.js";

// A connector for tests of settings, lookup, and State: a login pins symbols, a search fills the
// pin list, and the State hook quotes each pinned symbol.
const BASE = "https://quotes.example.com";

function pinned(settings: Readonly<Record<string, unknown>>): Array<{ id: string }> {
  return Array.isArray(settings.symbols) ? (settings.symbols as Array<{ id: string }>) : [];
}

const adapter: Adapter = {
  async validate(creds, ctx) {
    requiredCredential(creds, "token", "Quotes API key is missing");
    const count = pinned(ctx.settings).length;
    return count ? `${count} symbol${count === 1 ? "" : "s"}` : "";
  },
  async lookup(property, query, creds, ctx) {
    if (property !== "symbols") {
      throw new ConnectorError(`quotes has no search for ${property}`, 404);
    }
    const token = requiredCredential(creds, "token", "Quotes API key is missing");
    const response = await ctx.http(`${BASE}/search?query=${encodeURIComponent(query)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await response.json()) as { results?: Array<{ id: string; name: string }> };
    return (body.results ?? []).map((item) => ({ value: { id: item.id, name: item.name }, label: item.name }));
  },
  async state(creds, ctx) {
    const symbols = pinned(ctx.settings);
    if (!symbols.length) {
      return null;
    }
    const token = requiredCredential(creds, "token", "Quotes API key is missing");
    const ids = symbols.map((item) => item.id).join(",");
    const response = await ctx.http(`${BASE}/prices?ids=${encodeURIComponent(ids)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const prices = (await response.json()) as Record<string, number>;
    return symbols.map((item) => ({ id: item.id, price: prices[item.id] ?? null }));
  },
};

export default adapter;
