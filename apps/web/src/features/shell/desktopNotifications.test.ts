import assert from "node:assert/strict";
import { test } from "node:test";
import type { MessageNotice } from "../../api/types/chat";
import {
  desktopNotificationsKey,
  desktopNotificationsOn,
  noticeFor,
  plainPreview,
  previewLength,
  rasterIcon,
} from "./desktopNotifications";

const notice: MessageNotice = {
  guild_id: "g1",
  seq: 4,
  author_type: "agent",
  author_name: "scout",
  preview: "**Done.** The feed is back, see [the log](https://x.test/log).",
  agent: { id: "a1", name: "scout", avatar_shape: "clay:scout", avatar_color: "#1d9bf0" },
};

test("a preview drops markdown marks, keeps link text, and reads on one line", () => {
  assert.equal(plainPreview(notice.preview), "Done. The feed is back, see the log.");
  assert.equal(
    plainPreview("## Title\n\n> quoted\n- one\n2. two\n`code` ~~gone~~"),
    "Title quoted one two code gone",
  );
  assert.equal(
    plainPreview("![alt text](img.png) and snake_case stays"),
    "alt text and snake_case stays",
  );
  assert.equal(plainPreview("   "), "");
});

test("a long preview is cut to its length with an ellipsis", () => {
  const long = plainPreview("x".repeat(previewLength + 20));
  assert.equal(long.length, previewLength);
  assert.ok(long.endsWith("…"));
  assert.equal(plainPreview("y".repeat(previewLength)).length, previewLength);
});

test("the notification names the author and guild, previews the message, and takes the agent's mascot", () => {
  const shown = noticeFor(notice, "watch-room");
  assert.equal(shown.title, "scout in watch-room");
  assert.equal(shown.body, "Done. The feed is back, see the log.");
  assert.equal(shown.tag, "guild:g1");
  assert.ok(shown.icon?.startsWith("/avatars/clay.svg?seed=scout&color="));
});

test("an operator's message has no mascot, and an unknown guild leaves only the author", () => {
  const theirs = noticeFor(
    { ...notice, author_type: "user", author_name: "bo", agent: null },
    undefined,
  );
  assert.equal(theirs.title, "bo");
  assert.equal("icon" in theirs, false);
});

class FakeImage {
  static failing = new Set<string>();
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(value: string) {
    queueMicrotask(() => (FakeImage.failing.has(value) ? this.onerror?.() : this.onload?.()));
  }
}

const fakeDocument = {
  blankCanvas: false,
  createElement() {
    const context = { drawImage() {} };
    return {
      width: 0,
      height: 0,
      getContext: () => (fakeDocument.blankCanvas ? null : context),
      toDataURL: () => "data:image/png;base64,ok",
    };
  },
};

test("an icon is drawn to a PNG data URL once, and the URL stands in when it cannot be", async () => {
  (globalThis as { Image?: unknown }).Image = FakeImage;
  (globalThis as { document?: unknown }).document = fakeDocument;
  assert.equal(await rasterIcon("/avatars/clay.svg?seed=scout"), "data:image/png;base64,ok");
  fakeDocument.blankCanvas = true;
  assert.equal(
    await rasterIcon("/avatars/clay.svg?seed=scout"),
    "data:image/png;base64,ok",
    "drawn once",
  );
  assert.equal(
    await rasterIcon("/avatars/clay.svg?seed=other"),
    "/avatars/clay.svg?seed=other",
    "no canvas",
  );
  fakeDocument.blankCanvas = false;
  FakeImage.failing.add("/avatars/missing.svg");
  assert.equal(
    await rasterIcon("/avatars/missing.svg"),
    "/avatars/missing.svg",
    "image failed to load",
  );
});

test("notifications are on only when chosen here and allowed by the browser", () => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  };
  assert.equal(desktopNotificationsOn(), false, "nothing chosen");
  store.set(desktopNotificationsKey, "true");
  assert.equal(desktopNotificationsOn(), false, "no Notification API");
  (globalThis as { Notification?: unknown }).Notification = { permission: "default" };
  assert.equal(desktopNotificationsOn(), false, "not allowed yet");
  (globalThis as { Notification?: unknown }).Notification = { permission: "granted" };
  assert.equal(desktopNotificationsOn(), true);
});
