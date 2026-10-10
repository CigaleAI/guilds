/** The model's reasoning: open while it is still thinking, collapsed once the reply starts. */
export function Reasoning({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <details open={streaming} className="text-sm">
      <summary className="cursor-pointer font-semibold text-fg-2">
        {streaming ? "Thinking…" : "Reasoning"}
      </summary>
      <p className="mt-1.5 whitespace-pre-wrap text-fg-2">{text}</p>
    </details>
  );
}
