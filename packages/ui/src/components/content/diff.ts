/** One line of a line diff. Removed lines carry `oldNo`, added lines `newNo`, context lines both. */
export type DiffLine = {
  kind: "add" | "del" | "ctx";
  text: string;
  oldNo?: number;
  newNo?: number;
};

function toLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Line diff of two texts by longest common subsequence; within a change, removals come first. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = toLines(before);
  const b = toLines(after);

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const n = midA.length;
  const m = midB.length;
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        midA[i] === midB[j]
          ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + j + 1] ?? 0);
    }
  }

  const out: DiffLine[] = [];
  let oldNo = 1;
  let newNo = 1;
  const context = (text: string) => out.push({ kind: "ctx", text, oldNo: oldNo++, newNo: newNo++ });

  for (let k = 0; k < head; k++) context(a[k] ?? "");
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && midA[i] === midB[j]) {
      context(midA[i] ?? "");
      i++;
      j++;
    } else if (
      j >= m ||
      (i < n && (lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + j + 1] ?? 0))
    ) {
      out.push({ kind: "del", text: midA[i] ?? "", oldNo: oldNo++ });
      i++;
    } else {
      out.push({ kind: "add", text: midB[j] ?? "", newNo: newNo++ });
      j++;
    }
  }
  for (let k = a.length - tail; k < a.length; k++) context(a[k] ?? "");
  return out;
}
