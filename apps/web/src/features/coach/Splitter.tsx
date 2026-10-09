import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

const minShare = 0.35;
const maxShare = 0.75;

const clamp = (share: number) => Math.min(maxShare, Math.max(minShare, share));

function savedShare(key: string, fallback: number): number {
  try {
    const share = Number(localStorage.getItem(key));
    return share ? clamp(share) : fallback;
  } catch {
    return fallback;
  }
}

function saveShare(key: string, share: number) {
  try {
    localStorage.setItem(key, String(share));
  } catch {
    // Without storage the split resets on the next visit.
  }
}

/** The first pane's share of a split workspace, remembered across visits under `key`. */
export function useSplitShare(key: string, fallback: number) {
  return useState(() => savedShare(key, fallback));
}

type SplitterProps = {
  /** Where the share is remembered; the same key as `useSplitShare`. */
  storageKey: string;
  share: number;
  onShareChange: (share: number) => void;
  label: string;
};

/** The bar between a workspace's two panes: drag it, or focus it and use the arrow keys. */
export function Splitter({ storageKey, share, onShareChange, label }: SplitterProps) {
  const bar = useRef<HTMLDivElement>(null);

  const shareAt = (event: PointerEvent<HTMLDivElement>) => {
    const box = bar.current?.parentElement?.getBoundingClientRect();
    return box ? clamp((event.clientX - box.left) / box.width) : share;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowLeft" ? -0.05 : event.key === "ArrowRight" ? 0.05 : 0;
    if (!step) return;
    event.preventDefault();
    const next = clamp(share + step);
    onShareChange(next);
    saveShare(storageKey, next);
  };

  return (
    <div
      ref={bar}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={minShare * 100}
      aria-valuemax={maxShare * 100}
      aria-valuenow={Math.round(share * 100)}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) onShareChange(shareAt(event));
      }}
      onPointerUp={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        saveShare(storageKey, shareAt(event));
      }}
      className="group flex w-2 shrink-0 cursor-col-resize touch-none justify-center focus-visible:outline-none"
    >
      <span className="w-px bg-line transition-colors group-hover:w-0.5 group-hover:bg-rule group-focus-visible:w-0.5 group-focus-visible:bg-focus" />
    </div>
  );
}
