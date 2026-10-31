import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { StudioError, useStudio } from "./StudioContext";

test("reading the Studio outside a session throws a StudioError", () => {
  function Reader() {
    useStudio();
    return null;
  }
  assert.throws(() => renderToString(createElement(Reader)), StudioError);
});
