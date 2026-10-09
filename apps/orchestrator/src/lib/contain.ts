import path from "node:path";

export function isRelativeTo(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

export function pythonQuote(value: string, safe = ""): string {
  let out = "";
  for (const char of value) {
    if (/[A-Za-z0-9]/.test(char) || safe.includes(char)) {
      out += char;
      continue;
    }
    for (const byte of Buffer.from(char, "utf8")) {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}
