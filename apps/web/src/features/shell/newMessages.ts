import { useLocation } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import type { MessageNotice } from "../../api/types/chat";
import { useIdentity } from "../../app/identity";
import { playChime, primeChime } from "./chime";
import { useDesktopNotification } from "./desktopNotifications";

/** The least time between two chimes, so a burst of replies rings once. */
export const chimeGapMs = 2000;

export type Reader = {
  /** The operator's name, as messages carry it. */
  name: string;
  pathname: string;
  /** The tab is shown and the window has focus. */
  attending: boolean;
};

/** Whether the page at `pathname` shows the guild's group chat: its home, or an agent over it. */
export function showsGroupChat(pathname: string, guildId: string): boolean {
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== "guilds" || parts[1] !== guildId) return false;
  return parts.length === 2 || parts[2] === "agents";
}

/** A message is announced when someone else wrote it and the reader is not watching that chat. */
export function announces(notice: MessageNotice, reader: Reader): boolean {
  if (notice.author_type === "user" && notice.author_name === reader.name) return false;
  return !(reader.attending && showsGroupChat(reader.pathname, notice.guild_id));
}

/** Whether a chime at `now` is due, given when the last one rang. */
export function chimeDue(lastAt: number | null, now: number): boolean {
  return lastAt === null || now - lastAt >= chimeGapMs;
}

function isAttending(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

/** Rings at most once per `chimeGapMs`, once the browser allows sound. */
function useChime(): () => void {
  const lastAt = useRef<number | null>(null);
  useEffect(primeChime, []);
  return () => {
    if (!chimeDue(lastAt.current, Date.now())) return;
    if (playChime()) lastAt.current = Date.now();
  };
}

/**
 * Announces a message the operator would otherwise miss: the chime, and a desktop notification
 * when they turned those on. Feed it the inbox stream's notices.
 */
export function useNewMessageAlerts(): (notice: MessageNotice) => void {
  const { user } = useIdentity();
  const pathname = useLocation({ select: (location) => location.pathname });
  const chime = useChime();
  const notify = useDesktopNotification();
  return (notice) => {
    if (!announces(notice, { name: user.name, pathname, attending: isAttending() })) return;
    chime();
    notify(notice);
  };
}
