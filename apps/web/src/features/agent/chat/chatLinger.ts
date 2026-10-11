import { useEffect, useRef } from "react";

/** Idle time after a chat generation ends before the next window focus closes the inspector. */
export const chatIdleCloseMs = 3 * 60 * 1000;

const held = new Map<string, string>();

/** Remembers the run Chat was watching so a finished generation does not drop it. */
export function holdChatRun(agentId: string, runId: string | null): void {
  if (runId) held.set(agentId, runId);
  else held.delete(agentId);
}

/** The run Chat is holding for this agent, if any. */
export function heldChatRun(agentId: string): string | undefined {
  return held.get(agentId);
}

/** Whether a finished chat should close on this focus: idle long enough, and not generating. */
export function shouldCloseFinishedChat(args: {
  generating: boolean;
  lastActionAt: number | null;
  now: number;
  idleMs?: number;
}): boolean {
  if (args.generating || args.lastActionAt === null) return false;
  return args.now - args.lastActionAt >= (args.idleMs ?? chatIdleCloseMs);
}

/**
 * After the agent finishes a generation on Chat, the next window focus that comes after
 * `chatIdleCloseMs` with no operator action closes the inspector.
 */
export function useFinishedChatIdleClose(args: {
  agentId: string;
  generating: boolean;
  enabled: boolean;
  onClose: () => void;
}): void {
  const lastActionAt = useRef<number | null>(null);
  const wasGenerating = useRef(args.generating);
  const onCloseRef = useRef(args.onClose);

  useEffect(() => {
    onCloseRef.current = args.onClose;
  }, [args.onClose]);

  useEffect(() => {
    if (!args.enabled) {
      lastActionAt.current = null;
      wasGenerating.current = args.generating;
      return;
    }
    if (args.generating) lastActionAt.current = null;
    else if (wasGenerating.current) lastActionAt.current = Date.now();
    wasGenerating.current = args.generating;
  }, [args.enabled, args.generating]);

  useEffect(() => {
    if (!args.enabled) return;
    const markAction = () => {
      if (lastActionAt.current !== null) lastActionAt.current = Date.now();
    };
    const onFocus = () => {
      if (
        !shouldCloseFinishedChat({
          generating: args.generating,
          lastActionAt: lastActionAt.current,
          now: Date.now(),
        })
      ) {
        return;
      }
      holdChatRun(args.agentId, null);
      onCloseRef.current();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") onFocus();
    };
    window.addEventListener("pointerdown", markAction);
    window.addEventListener("keydown", markAction);
    window.addEventListener("scroll", markAction, true);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("pointerdown", markAction);
      window.removeEventListener("keydown", markAction);
      window.removeEventListener("scroll", markAction, true);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [args.agentId, args.enabled, args.generating]);
}
