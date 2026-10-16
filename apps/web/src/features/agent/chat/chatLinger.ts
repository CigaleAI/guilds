import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

/** Idle time after a chat generation ends before the next window focus closes the inspector. */
export const chatIdleCloseMs = 3 * 60 * 1000;

const held = new Map<string, string | null>();
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of listeners) listener();
}

/**
 * Remembers what Chat shows for this agent: a run, kept when its generation finishes, or `null`
 * for a new session the operator opened, kept even while another run is generating.
 */
export function holdChatRun(agentId: string, runId: string | null): void {
  if (held.get(agentId) === runId) return;
  held.set(agentId, runId);
  changed();
}

/** Forgets what Chat held for this agent, so it shows the generating run or a new session. */
export function releaseChatRun(agentId: string): void {
  if (held.delete(agentId)) changed();
}

/** What Chat holds for this agent: a run, `null` for a new session, `undefined` for nothing. */
export function heldChatRun(agentId: string): string | null | undefined {
  return held.get(agentId);
}

/** What Chat holds for this agent, re-rendering when it changes. */
export function useHeldChatRun(agentId: string): string | null | undefined {
  const subscribe = useCallback((listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, []);
  return useSyncExternalStore(subscribe, () => held.get(agentId));
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
      releaseChatRun(args.agentId);
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
