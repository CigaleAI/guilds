import type { ComponentProps } from "react";
import { cn } from "../../cn";

export type BrandMarkSize = 28 | 32 | 48;

const markBox: Record<BrandMarkSize, string> = { 28: "size-7", 32: "size-8", 48: "size-12" };

/** Two squares, 0.65 of the box: signal behind and low-left, plum in front and high-right. */
const markSquares: Record<BrandMarkSize, { back: string; front: string }> = {
  28: { back: "top-1.5 left-0 size-4.5 rounded-sm", front: "top-0 left-2.5 size-4.5 rounded-sm" },
  32: { back: "top-1.5 left-0 size-5.5 rounded-sm", front: "top-0 left-2.5 size-5.5 rounded-sm" },
  48: { back: "top-2.5 left-0 size-8 rounded-md", front: "top-0 left-4 size-8 rounded-md" },
};

const wordmarkType: Record<BrandMarkSize, string> = {
  28: "text-xl font-semibold tracking-tight",
  32: "text-2xl font-semibold tracking-tight",
  48: "type-h2",
};

export type BrandMarkProps = Omit<ComponentProps<"span">, "children"> & {
  size?: BrandMarkSize;
  /** Follow the mark with "guilds.run". */
  wordmark?: boolean;
  /** The app icon: the mark on an ink tile. */
  appIcon?: boolean;
};

/** The guilds.run logo. */
export function BrandMark({ size = 32, wordmark, appIcon, className, ...props }: BrandMarkProps) {
  const squares = markSquares[size];
  const mark = (
    <span aria-hidden className={cn("relative block shrink-0", markBox[size])}>
      <span className={cn("absolute bg-signal", squares.back)} />
      <span className={cn("absolute bg-plum", squares.front)} />
    </span>
  );

  if (appIcon) {
    return (
      <span
        role="img"
        aria-label="guilds.run"
        className={cn("inline-flex shrink-0 rounded-lg bg-panel p-2.5", className)}
        {...props}
      >
        {mark}
      </span>
    );
  }

  return (
    <span
      role={wordmark ? undefined : "img"}
      aria-label={wordmark ? undefined : "guilds.run"}
      className={cn("inline-flex shrink-0 items-center gap-3 text-fg", className)}
      {...props}
    >
      {mark}
      {wordmark ? (
        <span className={cn("whitespace-nowrap", wordmarkType[size])}>
          guilds<span className="text-signal-t">.run</span>
        </span>
      ) : null}
    </span>
  );
}
