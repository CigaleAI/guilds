import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { installClientLog, reportThrown } from "./api/clientLog";
import { setSignInPath } from "./api/session";
import { App } from "./app/App";
import type { AppSlots } from "./app/slots";
import { applyTheme, readThemePreference } from "./app/theme";

/** Starts the app in the page's `#root`, with what the edition adds to it. */
export function mount(slots: AppSlots = {}): void {
  installClientLog();
  applyTheme(readThemePreference());
  setSignInPath(slots.signInPath ?? null);

  const root = document.getElementById("root");
  if (!root) throw new Error("index.html has no #root element");
  createRoot(root, {
    onUncaughtError: (error) => reportThrown("react", error),
    onCaughtError: (error) => reportThrown("react", error),
  }).render(
    <StrictMode>
      <App slots={slots} />
    </StrictMode>,
  );
}
