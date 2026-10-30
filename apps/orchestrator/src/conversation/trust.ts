export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Untrusted content shown to the model: where it came from, its text, and where it sits in its source. */
export type Evidence = {
  source: string;
  body: string;
  coordinates?: Record<string, unknown>;
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

export function excerptBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.length <= maxBytes) {
    return { text, truncated: false };
  }
  return { text: encoded.subarray(0, maxBytes).toString("utf8"), truncated: true };
}

export function excerptWords(text: string, maxWords: number): { text: string; truncated: boolean; words: number } {
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
