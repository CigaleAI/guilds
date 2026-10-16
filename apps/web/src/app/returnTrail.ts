import { useLocation, useRouter } from "@tanstack/react-router";
import { useEffect, useSyncExternalStore } from "react";

/**
 * Where a page sits: an agent's tab, a guild's tab, or another page. Moving between places by a
 * link in a page's content leaves a way back to the place the link was in.
 */
export type Place = {
  /** One per place: a tab of one agent or guild, or a top-level page. */
  key: string;
  /** The agent or guild the place belongs to; null for a top-level page. */
  container: string | null;
  /** The place's name within its container, such as "Chat" or "Settings". */
  label: string;
  /** The place's name from elsewhere, such as "agent chat" or "guild settings". */
  fullLabel: string;
};

const agentTabs: Record<string, string> = {
  "": "Chat",
  history: "Chat",
  prompt: "Prompt",
  state: "State",
  routine: "Routine",
  browser: "Browser",
  cli: "CLI",
  tools: "Tools",
  secrets: "Secrets",
  usage: "Usage",
  settings: "Settings",
};

const guildTabs: Record<string, string> = {
  "": "Group chat",
  settings: "Settings",
  state: "State",
  routines: "Routines",
  issues: "Issues",
  tools: "Tools",
  secrets: "Secrets",
  usage: "Usage",
};

const pages: Record<string, string> = {
  "": "Home",
  inbox: "Inbox",
  settings: "Settings",
  admin: "Admin",
  recipes: "Recipes",
  builder: "Builder",
  studio: "Studio",
  databases: "Databases",
  applies: "Recipes",
};

function tabLabel(tabs: Record<string, string>, tab: string): string {
  return tabs[tab] ?? tab.charAt(0).toUpperCase() + tab.slice(1);
}

/** The place a path is in. */
export function placeOf(pathname: string): Place {
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "guilds" && parts[1]) {
    const guild = `guild:${parts[1]}`;
    if (parts[2] === "agents" && parts[3]) {
      const tab = parts[4] ?? "";
      const label = tabLabel(agentTabs, tab);
      const container = `agent:${parts[3]}`;
      return {
        key: `${container}:${label}`,
        container,
        label,
        fullLabel: `agent ${label.toLowerCase()}`,
      };
    }
    const tab = parts[2] ?? "";
    const label = tabLabel(guildTabs, tab);
    return {
      key: `${guild}:${label}`,
      container: guild,
      label,
      fullLabel: tab ? `guild ${label.toLowerCase()}` : "group chat",
    };
  }
  const page = parts[0] ?? "";
  const label = tabLabel(pages, page);
  return {
    key: `page:${page}:${parts[1] ?? ""}`,
    container: null,
    label,
    fullLabel: label.toLowerCase(),
  };
}

/** Where to go back to: the location a content link was followed from, and its place. */
export type ReturnPoint = { href: string; place: Place };

/**
 * What a navigation leaves as the way back: the place it started from when a content link
 * started it and it changed place, none when it came back to the way back's place or anything
 * else moved it to another place, and the current one otherwise.
 */
export function nextReturnPoint(
  current: ReturnPoint | null,
  fromHref: string,
  fromPath: string,
  toPath: string,
  byContentLink: boolean,
): ReturnPoint | null {
  const from = placeOf(fromPath);
  const to = placeOf(toPath);
  if (current && to.key === current.place.key) return null;
  if (from.key === to.key) return current;
  return byContentLink ? { href: fromHref, place: from } : null;
}

/** A click marks the navigation it starts as a content link for this long. */
const CLICK_WINDOW_MS = 3000;

/** Clicks inside this mark their navigation as a content link: a page's body, not its chrome. */
const SOURCE = "[data-return-source]";
/** Chrome inside a source: tab rows and headers, whose links are the app's own navigation. */
const CHROME = "nav, header, [data-return-ignore]";

let point: ReturnPoint | null = null;
const listeners = new Set<() => void>();

function setPoint(next: ReturnPoint | null) {
  if (next === point) return;
  point = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether a click landed on a link or button in a page's content. */
function contentClick(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const control = target.closest("a[href], button, [role='menuitem']");
  return Boolean(control?.closest(SOURCE)) && !control?.closest(CHROME);
}

/** Follows navigations to keep the way back; mounted once, by the app shell. */
export function useReturnTrail() {
  const router = useRouter();
  useEffect(() => {
    let clickedAt = 0;
    const onClick = (event: MouseEvent) => {
      clickedAt = contentClick(event.target) ? Date.now() : 0;
    };
    document.addEventListener("click", onClick, true);
    const unsubscribe = router.subscribe("onResolved", ({ fromLocation, toLocation }) => {
      const byContentLink = clickedAt > 0 && Date.now() - clickedAt < CLICK_WINDOW_MS;
      clickedAt = 0;
      if (!fromLocation) return;
      setPoint(
        nextReturnPoint(
          point,
          fromLocation.href,
          fromLocation.pathname,
          toLocation.pathname,
          byContentLink,
        ),
      );
    });
    return () => {
      document.removeEventListener("click", onClick, true);
      unsubscribe();
    };
  }, [router]);
}

/**
 * The way back from the current page, with its label as read from here: the place's own name
 * within the same agent or guild, its full name from elsewhere. Null when there is none.
 */
export function useReturnPoint(): { href: string; label: string } | null {
  const current = useSyncExternalStore(subscribe, () => point);
  const { pathname } = useLocation();
  if (!current) return null;
  const here = placeOf(pathname);
  if (here.key === current.place.key) return null;
  const sameContainer = here.container !== null && here.container === current.place.container;
  return {
    href: current.href,
    label: sameContainer ? current.place.label : current.place.fullLabel,
  };
}
