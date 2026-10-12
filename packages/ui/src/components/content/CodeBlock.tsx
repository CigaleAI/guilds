import { Fragment, useMemo, type ComponentProps } from "react";
import { cn } from "../../cn";
import { CopyButton } from "../actions/CopyButton";
import { highlight, type CodeLanguage, type CodeSpanKind } from "./highlight";

const spanClass: Record<Exclude<CodeSpanKind, "plain">, string> = {
  comment: "text-code-muted italic",
  string: "text-code-string",
  number: "text-code-number",
  keyword: "text-code-keyword",
  function: "text-code-function",
  decorator: "text-code-decorator",
};

export type CodeBlockProps = Omit<ComponentProps<"div">, "children"> & {
  code: string;
  language?: CodeLanguage;
  /** Numbers the lines, as for a whole file. */
  lineNumbers?: boolean;
  /** A copy button over the top-right corner. */
  copy?: boolean;
  /** `document` for a file on its own card, `compact` inside chat, dialogs and disclosures. */
  density?: "document" | "compact";
};

/** Source the operator reads, set in Solarized dark whatever the theme: a script, a schema, a log. */
export function CodeBlock({
  code,
  language = "text",
  lineNumbers = false,
  copy = true,
  density = "document",
  className,
  ...props
}: CodeBlockProps) {
  const lines = useMemo(() => highlight(code, language), [code, language]);
  const gutter = `${String(lines.length).length}ch`;
  return (
    <div
      className={cn(
        "relative min-w-0 bg-code-bg text-code-fg",
        density === "document" ? "rounded-lg" : "rounded-md",
        className,
      )}
      {...props}
    >
      <pre
        className={cn(
          "overflow-auto font-mono",
          density === "document" ? "px-4 py-3.5 text-sm leading-relaxed" : "px-3 py-2.5 text-xs leading-normal",
          copy && "pr-12",
        )}
      >
        <code
          className={cn("grid", lineNumbers ? "grid-cols-[max-content_1fr] gap-x-4" : "grid-cols-1")}
        >
          {lines.map((line, index) => (
            <Fragment key={index}>
              {lineNumbers ? (
                <span
                  aria-hidden
                  className="text-right text-code-muted select-none"
                  style={{ minWidth: gutter }}
                >
                  {index + 1}
                </span>
              ) : null}
              <span className="whitespace-pre">
                {line.length
                  ? line.map((span, at) =>
                      span.kind === "plain" ? (
                        span.text
                      ) : (
                        <span key={at} className={spanClass[span.kind]}>
                          {span.text}
                        </span>
                      ),
                    )
                  : " "}
              </span>
            </Fragment>
          ))}
        </code>
      </pre>
      {copy ? (
        <CopyButton
          text={code}
          what="code"
          size={24}
          className="absolute top-1.5 right-1.5 text-code-fg hover:bg-code-fg/15"
        />
      ) : null}
    </div>
  );
}
