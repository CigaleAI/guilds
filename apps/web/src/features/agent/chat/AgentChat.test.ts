import assert from "node:assert/strict";
import { test } from "node:test";
import type { OrgModels } from "../../../api/types/models";
import { attachmentsNote, revealOf } from "./AgentChat";

function modelsWith(attachments: boolean): OrgModels {
  return {
    default: null,
    providers: [],
    models: [
      {
        id: "openai/gpt-5",
        model: "gpt-5",
        label: "GPT-5",
        provider: "openai",
        thinking: true,
        temperature: true,
        attachments,
        context: null,
        price: null,
      },
    ],
  };
}

test("a model that takes images leaves the composer open to them", () => {
  assert.equal(attachmentsNote(modelsWith(true), "openai/gpt-5"), undefined);
});

test("the composer says why it takes no images", () => {
  assert.equal(attachmentsNote(modelsWith(false), "openai/gpt-5"), "GPT-5 does not accept images");
  assert.equal(
    attachmentsNote(modelsWith(true), "openai/other"),
    "This agent's model is not among the organisation's chosen models",
  );
  assert.equal(
    attachmentsNote(undefined, "openai/gpt-5"),
    "Checking whether this model accepts images",
  );
});

test("a subscription agent's composer takes images, whatever the organisation's models take", () => {
  assert.equal(attachmentsNote(modelsWith(false), null), undefined);
  assert.equal(attachmentsNote(undefined, null), undefined);
});

test("a chat link opens at the call or message sequence it names", () => {
  assert.deepEqual(revealOf({ run: "r1", call: "c1" }), { call: "c1" });
  assert.deepEqual(revealOf({ seq: 4 }), { seq: 4 });
  assert.equal(revealOf({ run: "r1", history: true }), undefined);
});
