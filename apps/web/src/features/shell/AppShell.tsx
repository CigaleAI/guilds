import { Outlet, useLocation } from "@tanstack/react-router";
import { Menu } from "lucide-react";
import { Dialog as RadixDialog } from "radix-ui";
import { useEffect, useState } from "react";
import { useInboxStream } from "../../api/streams";
import { ReturnButton } from "../../app/ReturnButton";
import { placeOf, useReturnTrail } from "../../app/returnTrail";
import { useSlots } from "../../app/slots";
import { useStoredFlag } from "../../app/storage";
import { IconButton, BrandMark, dialogScrim } from "@guildsrun/ui";
import { ModelSetupGate } from "../models/ModelSetupGate";
import { GuildRail } from "./GuildRail";
import { GuildSidebar } from "./GuildSidebar";
import { useNewMessageAlerts } from "./newMessages";

/** Whether the sidebar is folded into the rail. */
const retractedKey = "guilds-rail-retracted";

/**
 * The workspace frame: navigation on the left, the current page on paper, and the model setup
 * gate over everything while the organisation has no provider connected. On a phone the
 * navigation opens as a drawer from a top bar and closes once a page is picked. A link followed
 * from a page's content leaves a way back; a guild or agent shows it in its tab row, any other
 * page above itself. A message posted where the operator is not looking rings a chime, and
 * shows a desktop notification when they turned those on.
 */
export function AppShell() {
  useInboxStream(useNewMessageAlerts());
  useReturnTrail();
  const { shellBanners = [] } = useSlots();
  const [retracted, setRetracted] = useStoredFlag(retractedKey);
  const [drawer, setDrawer] = useState(false);
  const location = useLocation();
  const [openedAt, setOpenedAt] = useState(location.href);
  if (drawer && openedAt !== location.href) setDrawer(false);

  // ⌘B / Ctrl+B folds the sidebar into the rail and back.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setRetracted(!retracted);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [retracted, setRetracted]);

  return (
    <div className="flex h-dvh min-h-0 flex-col bg-page md:flex-row md:gap-3 md:p-3">
      <div className="hidden md:flex">
        {retracted ? (
          <GuildRail onExpand={() => setRetracted(false)} />
        ) : (
          <GuildSidebar onRetract={() => setRetracted(true)} />
        )}
      </div>
      <header className="flex shrink-0 items-center gap-2 px-3 py-2 md:hidden">
        <IconButton
          icon={Menu}
          label="Open navigation"
          variant="surface"
          onClick={() => {
            setOpenedAt(location.href);
            setDrawer(true);
          }}
        />
        <BrandMark wordmark />
      </header>
      <RadixDialog.Root open={drawer} onOpenChange={setDrawer}>
        <RadixDialog.Portal>
          <RadixDialog.Overlay className={dialogScrim({ gutter: "none" })}>
            <RadixDialog.Content
              aria-describedby={undefined}
              className="anim-modal fixed inset-y-0 left-0 flex w-80 max-w-full p-2 outline-none"
            >
              <RadixDialog.Title className="sr-only">Navigation</RadixDialog.Title>
              <GuildSidebar onRetract={() => setDrawer(false)} />
            </RadixDialog.Content>
          </RadixDialog.Overlay>
        </RadixDialog.Portal>
      </RadixDialog.Root>
      <main
        data-return-source=""
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden contain-paint bg-paper md:rounded-2xl md:shadow-float"
      >
        {shellBanners.map((Notice, index) => (
          <Notice key={index} />
        ))}
        <ModelSetupGate />
        {placeOf(location.pathname).container === null ? <ReturnButton /> : null}
        <Outlet />
      </main>
    </div>
  );
}
