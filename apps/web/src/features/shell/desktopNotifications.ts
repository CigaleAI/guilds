import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "@guildsrun/ui";
import { keys } from "../../api/queries";
import type { Guild, MessageNotice } from "../../api/types";
import { agentLook } from "../../app/agents";
import { readStored, useStoredFlag } from "../../app/storage";

/** Whether the operator turned desktop notifications on in this browser. */
export const desktopNotificationsKey = "guilds-desktop-notifications";
/** How much of a message the notification shows. */
export const previewLength = 140;
const iconSize = 128;

/** Markdown marks a one-line preview drops, in the order they are dropped. */
const marks: [RegExp, string][] = [
  [/!?\[([^\]]*)\]\([^)]*\)/g, "$1"],
  [/^\s*(?:#{1,6}|>)\s?/gm, ""],
  [/^\s*(?:[-+*]|\d+[.)])\s+/gm, ""],
  [/[*`~]+/g, ""],
  [/\s+/g, " "],
];

/** The message as a notification body: markdown marks dropped, one line, cut to `previewLength`. */
export function plainPreview(markdown: string): string {
  const text = marks.reduce((acc, [mark, to]) => acc.replace(mark, to), markdown).trim();
  return text.length > previewLength ? `${text.slice(0, previewLength - 1)}…` : text;
}

export type DesktopNotice = { title: string; body: string; tag: string; icon?: string };

/** What the notification shows: who wrote where, the start of the message, and the author's mascot. */
export function noticeFor(notice: MessageNotice, guildName: string | undefined): DesktopNotice {
  const icon = notice.agent ? agentLook(notice.agent).src : undefined;
  return {
    title: guildName ? `${notice.author_name} in ${guildName}` : notice.author_name,
    body: plainPreview(notice.preview),
    tag: `guild:${notice.guild_id}`,
    ...(icon ? { icon } : {}),
  };
}

const icons = new Map<string, Promise<string>>();

/**
 * The icon as a PNG data URL, since browsers do not draw an SVG notification icon; the URL
 * itself when it cannot be drawn.
 */
export function rasterIcon(src: string): Promise<string> {
  const known = icons.get(src);
  if (known) return known;
  const raster = new Promise<string>((resolve) => {
    const image = new Image(iconSize, iconSize);
    image.onload = () => resolve(drawIcon(image) ?? src);
    image.onerror = () => resolve(src);
    image.src = src;
  });
  icons.set(src, raster);
  return raster;
}

function drawIcon(image: HTMLImageElement): string | null {
  const canvas = document.createElement("canvas");
  canvas.width = iconSize;
  canvas.height = iconSize;
  const context = canvas.getContext("2d");
  if (!context) return null;
  try {
    context.drawImage(image, 0, 0, iconSize, iconSize);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

/** The browser's answer to showing notifications; "unsupported" where the API is missing. */
function permissionState(): NotificationPermission | "unsupported" {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

/** The operator turned notifications on here, and the browser allows the page to show them. */
export function desktopNotificationsOn(): boolean {
  return readStored(desktopNotificationsKey) === "true" && permissionState() === "granted";
}

export type DesktopNotificationsChoice = {
  /** Wanted, and allowed by the browser. */
  on: boolean;
  /** The browser can show notifications at all. */
  supported: boolean;
  /** Turns them off, or asks the browser's permission and turns them on once it is given. */
  toggle: () => Promise<void>;
};

/** The desktop notifications choice for this browser, as the account menu shows and sets it. */
export function useDesktopNotificationsChoice(): DesktopNotificationsChoice {
  const [wanted, setWanted] = useStoredFlag(desktopNotificationsKey);
  const [permission, setPermission] = useState(permissionState);
  const toggle = async () => {
    if (wanted) {
      setWanted(false);
      return;
    }
    const answer = permission === "granted" ? "granted" : await Notification.requestPermission();
    setPermission(answer);
    setWanted(answer === "granted");
    if (answer === "denied") {
      toast({
        kind: "error",
        title: "Your browser blocks notifications for this site",
        description: "Allow them in the browser's site settings, then turn them on again.",
      });
    }
  };
  return {
    on: wanted && permission === "granted",
    supported: permission !== "unsupported",
    toggle,
  };
}

async function show(notice: DesktopNotice, onOpen: () => void): Promise<void> {
  const icon = notice.icon ? await rasterIcon(notice.icon) : undefined;
  const shown = new Notification(notice.title, {
    body: notice.body,
    tag: notice.tag,
    ...(icon ? { icon } : {}),
  });
  shown.onclick = () => {
    shown.close();
    onOpen();
  };
}

/**
 * Shows the message as a desktop notification when the operator turned those on. Opening it
 * brings the window forward and opens the chat at that message.
 */
export function useDesktopNotification(): (notice: MessageNotice) => void {
  const client = useQueryClient();
  const navigate = useNavigate();
  return (notice) => {
    if (!desktopNotificationsOn()) return;
    const guilds = client.getQueryData<Guild[]>(keys.guilds);
    const guild = guilds?.find((known) => known.id === notice.guild_id);
    const open = () => {
      window.focus();
      void navigate({
        to: "/guilds/$guildId",
        params: { guildId: notice.guild_id },
        search: { seq: notice.seq },
      });
    };
    void show(noticeFor(notice, guild?.name), open);
  };
}
