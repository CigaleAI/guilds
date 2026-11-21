import { TokenCounter } from "../../src/llm/token-counter.js";
import { TOKEN_COUNTER_LIMITS, TOKEN_ENCODING, installTokenCounter } from "../../src/llm/tokens.js";

/** A counter on the real worker that records the token count of each text it counts, in order. */
export class RecordingTokenCounter extends TokenCounter {
  readonly counts: number[] = [];

  constructor() {
    super(TOKEN_ENCODING, TOKEN_COUNTER_LIMITS);
  }

  override async count(text: string, signal?: AbortSignal): Promise<number> {
    const tokens = await super.count(text, signal);
    this.counts.push(tokens);
    return tokens;
  }
}

/** Installs a recording counter for input counts; the returned function closes it and puts back the one it replaced. */
export function installRecordingTokenCounter(): { counter: RecordingTokenCounter; restore: () => Promise<void> } {
  const counter = new RecordingTokenCounter();
  const replaced = installTokenCounter(counter);
  return {
    counter,
    restore: async () => {
      installTokenCounter(replaced);
      await counter.close();
    },
  };
}
