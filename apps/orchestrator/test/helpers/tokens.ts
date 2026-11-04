import { getEncoding } from "js-tiktoken";
import { TOKEN_ENCODING, installTokenEncodingLoader } from "../../src/llm/tokens.js";

/** How many times the input-token encoding was loaded, and the token count of each text it encoded, in order. */
export type TokenEncodingUse = { loads: number; counts: number[] };

/** Installs a loader of the real encoding that records each load and the count of each text it encodes. */
export function installCountingTokenEncodingLoader(): TokenEncodingUse {
  const use: TokenEncodingUse = { loads: 0, counts: [] };
  installTokenEncodingLoader(() => {
    use.loads += 1;
    const encoding = getEncoding(TOKEN_ENCODING);
    return {
      encode: (...args) => {
        const tokens = encoding.encode(...args);
        use.counts.push(tokens.length);
        return tokens;
      },
      decode: (tokens) => encoding.decode(tokens),
    };
  });
  return use;
}

/** Puts back the loader the counter starts with. */
export function restoreTokenEncodingLoader(): void {
  installTokenEncodingLoader(() => getEncoding(TOKEN_ENCODING));
}
