import type { SendOutcome, Status } from "@guildsrun/ui";

/** Where a widget card's reply to the coach stands: awaited, on its way, or delivered. */
export type WidgetState = "open" | "sending" | "settled";

/** What moves a widget card: the operator sends a reply, and the post ends. */
export type WidgetEvent = "send" | SendOutcome;

/** The badge a widget card's button row shows beside its buttons. */
export type WidgetBadge = { label: string; status: Status };

/** A widget card's button row in one state: whether its controls take input, and its badge. */
export type WidgetRow = { disabled: boolean; badge: WidgetBadge | null };
