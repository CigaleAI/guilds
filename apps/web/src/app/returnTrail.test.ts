import assert from "node:assert/strict";
import { test } from "node:test";
import { nextReturnPoint, placeOf, type ReturnPoint } from "./returnTrail";

const chat = "/guilds/g1/agents/a1";
const memory = "/guilds/g1/agents/a1/state/memory";
const notes = "/guilds/g1/agents/a1/state/notes";
const guildSettings = "/guilds/g1/settings";

test("an agent's tabs are places of that agent; sub-pages of a tab are the same place", () => {
  assert.equal(placeOf(chat).label, "Chat");
  assert.equal(placeOf(`${chat}/history`).key, placeOf(chat).key);
  assert.equal(placeOf(memory).key, placeOf(notes).key);
  assert.notEqual(placeOf(memory).key, placeOf(chat).key);
  assert.equal(placeOf(memory).container, "agent:a1");
  assert.equal(placeOf(chat).fullLabel, "agent chat");
});

test("a guild's tabs are places of the guild, and other pages stand alone", () => {
  assert.equal(placeOf("/guilds/g1").fullLabel, "group chat");
  assert.equal(placeOf(guildSettings).fullLabel, "guild settings");
  assert.equal(placeOf(guildSettings).container, "guild:g1");
  assert.equal(placeOf("/settings").container, null);
  assert.equal(placeOf("/settings").label, "Settings");
});

test("a content link to another place leaves a way back to where it was followed from", () => {
  const back = nextReturnPoint(null, `${chat}?run=r1&call=c1`, chat, memory, true);
  assert.equal(back?.href, `${chat}?run=r1&call=c1`);
  assert.equal(back?.place.label, "Chat");
});

test("moving within a place keeps the way back; coming back to it clears it", () => {
  const back: ReturnPoint = { href: chat, place: placeOf(chat) };
  assert.equal(nextReturnPoint(back, memory, memory, notes, true), back);
  assert.equal(nextReturnPoint(back, notes, notes, `${chat}?run=r1`, false), null);
});

test("the app's own navigation to another place leaves no way back", () => {
  const back: ReturnPoint = { href: chat, place: placeOf(chat) };
  assert.equal(nextReturnPoint(null, chat, chat, memory, false), null);
  assert.equal(nextReturnPoint(back, memory, memory, guildSettings, false), null);
});

test("a content link from the place a way back leads elsewhere replaces it", () => {
  const back: ReturnPoint = { href: chat, place: placeOf(chat) };
  const next = nextReturnPoint(back, memory, memory, guildSettings, true);
  assert.equal(next?.place.key, placeOf(memory).key);
});
