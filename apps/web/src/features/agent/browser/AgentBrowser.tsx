import { Link, useParams } from "@tanstack/react-router";
import { ArrowDownToLine, Check, Copy, Globe, RotateCw } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../../../api/client";
import { useAgent } from "../../../api/queries";
import { Button, IconButton, TextField, EmptyState, StatusBadge } from "@guildsrun/ui";
/** The sandbox desktop is fixed at 1280 × 720 and scales to the pane. */
const desktopRatio = 16 / 9;

const XK_CONTROL_L = 0xffe3;
const XK_C = 0x0063;
const XK_V = 0x0076;
const EXTENDED_CLIPBOARD_NOTIFY = 1 << 27;

/** The parts of noVNC's RFB connection the clipboard bridge uses. */
type Rfb = {
  focus: () => void;
  sendKey: (keysym: number, code: string, down: boolean) => void;
  clipboardPasteFrom: (text: string) => void;
  addEventListener: (
    type: "clipboard",
    listener: (event: CustomEvent<{ text?: string }>) => void,
  ) => void;
  _clipboardServerCapabilitiesActions?: Record<number, boolean>;
};

type NovncWindow = Window & { guildsNovnc?: { rfb?: Rfb } };

/** Hides noVNC's own controls so the desktop fills the pane. */
const embedStyle = `
  #noVNC_control_bar_anchor, #noVNC_control_bar, #noVNC_clipboard, #noVNC_status, #noVNC_hint_anchor {
    display: none !important;
  }
  html, body, #noVNC_container, #noVNC_screen {
    width: 100% !important; height: 100% !important; margin: 0 !important;
    overflow: hidden !important; background: #111018 !important; border-radius: 0 !important;
  }
`;

function viewerUrl(agentId: string, nonce: number): string {
  const base = `/api/agents/${encodeURIComponent(agentId)}/browser/vnc`;
  // noVNC opens its socket at the origin root plus `path`, so the path carries no leading slash.
  const socket = encodeURIComponent(
    `api/agents/${encodeURIComponent(agentId)}/browser/vnc/websockify`,
  );
  return `${base}/vnc.html?autoconnect=1&reconnect=1&resize=scale&path=${socket}&_=${nonce}`;
}

function chord(rfb: Rfb, keysym: number, code: string) {
  rfb.focus();
  rfb.sendKey(XK_CONTROL_L, "ControlLeft", true);
  rfb.sendKey(keysym, code, true);
  rfb.sendKey(keysym, code, false);
  rfb.sendKey(XK_CONTROL_L, "ControlLeft", false);
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Session =
  { kind: "starting" } | { kind: "live"; nonce: number } | { kind: "failed"; detail: string };

/**
 * The agent's Chromium, live: starting its sandbox can take up to a minute. Keyboard and mouse go
 * straight to the desktop; the clipboard strip moves text in and out.
 */
export function AgentBrowser() {
  const { guildId, agentId } = useParams({ from: "/guilds/$guildId/agents/$agentId" });
  const agent = useAgent(agentId);
  const enabled = agent.data?.config.browser ?? false;
  const [session, setSession] = useState<Session>({ kind: "starting" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let current = true;
    api(`/api/agents/${encodeURIComponent(agentId)}/browser`).then(
      () => current && setSession({ kind: "live", nonce: Date.now() }),
      (error: Error) =>
        current &&
        setSession({ kind: "failed", detail: error.message || "Could not start the browser." }),
    );
    return () => {
      current = false;
    };
  }, [agentId, enabled, attempt]);

  const restart = () => {
    setSession({ kind: "starting" });
    setAttempt((count) => count + 1);
  };

  if (agent.data && !enabled) {
    return (
      <div className="grid flex-1 place-items-center p-6">
        <EmptyState
          icon={Globe}
          title="This agent has no browser"
          description="Turn it on in Settings to give the agent a Chromium it can sign in with."
          action={
            <Button asChild size="sm">
              <Link to="/guilds/$guildId/agents/$agentId/settings" params={{ guildId, agentId }}>
                Open Settings
              </Link>
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-7 py-5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-fg-2">
          Chromium in the agent's sandbox. Its signed-in profile stays in /home/agent/.browser.
        </span>
        <span className="flex-1" />
        <StatusBadge
          status={session.kind === "live" ? "ok" : session.kind === "failed" ? "failed" : "running"}
        >
          {session.kind === "live" ? "Live" : session.kind === "failed" ? "Failed" : "Starting"}
        </StatusBadge>
        <IconButton
          icon={RotateCw}
          label="Restart the browser view"
          variant="surface"
          onClick={restart}
        />
      </div>
      {session.kind === "live" ? (
        <Viewer
          key={session.nonce}
          agentId={agentId}
          name={agent.data?.name ?? "Agent"}
          nonce={session.nonce}
        />
      ) : session.kind === "failed" ? (
        <div className="grid flex-1 place-items-center">
          <div className="flex max-w-160 flex-col items-center gap-3 text-center">
            <h3 className="text-lg font-semibold">Browser unavailable</h3>
            <pre className="max-h-60 w-full overflow-auto rounded-md bg-surface p-3 text-left font-mono text-xs whitespace-pre-wrap">
              {session.detail}
            </pre>
            <Button size="sm" onClick={restart}>
              Try again
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid flex-1 place-items-center">
          <div role="status" className="flex flex-col items-center gap-2 text-sm text-muted">
            <StatusBadge status="running">Starting the browser</StatusBadge>
            It can take up to a minute when the sandbox is asleep.
          </div>
        </div>
      )}
    </div>
  );
}

function Viewer({ agentId, name, nonce }: { agentId: string; name: string; nonce: number }) {
  const area = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const rfb = useRef<Rfb | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [clip, setClip] = useState("");
  const [flash, setFlash] = useState<"send" | "copy" | null>(null);
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    const fit = () => {
      const width = Math.min(el.clientWidth, el.clientHeight * desktopRatio);
      setSize({ width, height: width / desktopRatio });
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const flashed = (which: "send" | "copy") => {
    setFlash(which);
    setTimeout(() => setFlash(null), 1500);
  };

  /** Hides noVNC's controls and exposes its RFB connection for the clipboard. */
  const onLoad = () => {
    const doc = frame.current?.contentDocument;
    const win = frame.current?.contentWindow as NovncWindow | null | undefined;
    if (!doc || !win) return;
    if (!doc.getElementById("guilds-novnc-embed")) {
      const style = doc.createElement("style");
      style.id = "guilds-novnc-embed";
      style.textContent = embedStyle;
      doc.head.appendChild(style);
      const script = doc.createElement("script");
      script.type = "module";
      script.textContent = 'import UI from "./app/ui.js"; window.guildsNovnc = UI;';
      doc.head.appendChild(script);
    }
    const started = Date.now();
    const poll = () => {
      const found = win.guildsNovnc?.rfb;
      if (found) {
        rfb.current = found;
        found.addEventListener("clipboard", (event) => setClip(event.detail.text ?? ""));
        setReady(true);
        win.dispatchEvent(new Event("resize"));
      } else if (Date.now() - started < 15000) {
        setTimeout(poll, 200);
      }
    };
    poll();
  };

  const clipRef = useRef(clip);
  useEffect(() => {
    clipRef.current = clip;
  }, [clip]);

  /** Puts the host clipboard, or the field's text, into the browser and pastes it there. */
  const send = async () => {
    const connection = rfb.current;
    if (!connection) return;
    const text = (await navigator.clipboard.readText().catch(() => "")) || clipRef.current;
    if (!text) return;
    setClip(text);
    // TigerVNC advertises the extended clipboard but rarely asks for its payload; send it plainly.
    if (connection._clipboardServerCapabilitiesActions) {
      connection._clipboardServerCapabilitiesActions[EXTENDED_CLIPBOARD_NOTIFY] = false;
    }
    connection.clipboardPasteFrom(text);
    await wait(120);
    chord(connection, XK_V, "KeyV");
    flashed("send");
  };

  /** Copies the browser's selection, which arrives as a clipboard event, to the host clipboard. */
  const copy = async () => {
    const connection = rfb.current;
    if (!connection) return;
    chord(connection, XK_C, "KeyC");
    await wait(400);
    const text = clipRef.current;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      flashed("copy");
    } catch {
      // The page may not be allowed to write the clipboard; the text stays in the field.
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center gap-2">
        <TextField
          tone="surface"
          aria-label="Clipboard"
          className="min-w-0 flex-1"
          placeholder={
            ready ? "Clipboard: paste here, then send to the browser" : "Browser not ready"
          }
          value={clip}
          onChange={(event) => setClip(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void send();
          }}
        />
        <IconButton
          icon={flash === "send" ? Check : ArrowDownToLine}
          label="Paste into the browser"
          variant="surface"
          disabled={!ready}
          onClick={() => void send()}
        />
        <IconButton
          icon={flash === "copy" ? Check : Copy}
          label="Copy the browser's selection"
          variant="surface"
          disabled={!ready}
          onClick={() => void copy()}
        />
      </div>
      <div ref={area} className="grid min-h-0 flex-1 place-items-center">
        <iframe
          ref={frame}
          title={`${name} browser`}
          src={viewerUrl(agentId, nonce)}
          onLoad={onLoad}
          style={{ width: size.width, height: size.height }}
          className="rounded-lg bg-panel"
        />
      </div>
    </div>
  );
}
