import { createContext, useContext, type ComponentType, type ReactNode } from "react";

/** A tab an extension adds to Settings or Admin. `after` names the tab it follows; without it the tab goes last. */
export type TabSlot = { id: string; label: string; after?: string; render: () => ReactNode };

/**
 * What an extension adds to the core app (docs/architecture/extension-points.md). Core fills none of it: the
 * app is whole without a slot.
 */
export type AppSlots = {
  /** The page for a path the extension owns, shown before anyone is identified; null for any other path. */
  publicPage?: (pathname: string) => ReactNode | null;
  /** Where a signed-out request goes to sign in. Without it a 401 is an error on the page. */
  signInPath?: string;
  /** Ends the session; the account menu offers it where people sign in. */
  signOut?: () => Promise<void>;
  settingsTabs?: readonly TabSlot[];
  adminTabs?: readonly TabSlot[];
  /** Notices above every page. */
  shellBanners?: readonly ComponentType[];
  /** Shown under the member list on Settings, Members. */
  membersPanel?: ComponentType;
};

export const SlotsContext = createContext<AppSlots>({});

export function useSlots(): AppSlots {
  return useContext(SlotsContext);
}

type Tab = { value: string; label: string };

/** Core's tabs with an extension's placed among them; slots that follow the same tab keep their order. */
export function placeTabs(core: readonly Tab[], slots: readonly TabSlot[] = []): Tab[] {
  const tabs = [...core];
  const placed = new Map<string, number>();
  for (const slot of slots) {
    const anchor = slot.after ? tabs.findIndex((tab) => tab.value === slot.after) : -1;
    const tab = { value: slot.id, label: slot.label };
    if (anchor === -1 || !slot.after) {
      tabs.push(tab);
      continue;
    }
    const before = placed.get(slot.after) ?? 0;
    tabs.splice(anchor + 1 + before, 0, tab);
    placed.set(slot.after, before + 1);
  }
  return tabs;
}

/** The tab a page shows: the one asked for when it exists, else the first. */
export function chosenTab(tabs: readonly Tab[], asked: string | undefined): string {
  return tabs.some((tab) => tab.value === asked) ? (asked as string) : (tabs[0]?.value ?? "");
}
