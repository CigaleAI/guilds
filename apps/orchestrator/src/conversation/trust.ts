export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Where evidence sits in its source, each coordinate written as an attribute; one left out or null is not written. */
export type EvidenceAttributes = { [name: string]: string | number | boolean | null | undefined };

/** Untrusted content shown to the model: where it came from, its text, and where it sits in its source. */
export type Evidence = {
  source: string;
  body: string;
  coordinates?: EvidenceAttributes;
};

export function wrapEvidence(evidence: Evidence): string {
  const parts = [`trust="untrusted"`, `source="${escapeXml(evidence.source)}"`];
  for (const [key, value] of Object.entries(evidence.coordinates ?? {})) {
    if (value === null || value === undefined) {
      continue;
    }
    parts.push(`${key}="${escapeXml(String(value))}"`);
  }
  return `<evidence ${parts.join(" ")}>\n${evidence.body.trimEnd()}\n</evidence>`;
}

export function wrapUntrustedText(label: string, value: string): string {
  return wrapEvidence({ source: label, body: value });
}

/** The start of a text, and whether the text went on past it. */
export type Excerpt = { text: string; truncated: boolean };

/** The start of a text cut at a word, and how many words it holds. */
export type WordExcerpt = Excerpt & { words: number };

export function excerptBytes(text: string, maxBytes: number): Excerpt {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.length <= maxBytes) {
    return { text, truncated: false };
  }
  return { text: encoded.subarray(0, maxBytes).toString("utf8"), truncated: true };
}

export function excerptWords(text: string, maxWords: number): WordExcerpt {
  const matches = [...text.matchAll(/\S+/g)];
  if (matches.length <= maxWords) {
    return { text, truncated: false, words: matches.length };
  }
  const last = matches[maxWords - 1];
  if (!last) {
    return { text: "", truncated: false, words: 0 };
  }
  const end = (last.index ?? 0) + last[0].length;
  return { text: text.slice(0, end), truncated: true, words: maxWords };
}
