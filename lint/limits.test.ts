import { RuleTester } from "oxlint/plugins-dev";

import limits from "./limits.js";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const options = [{ max: 1 }];
const bumpy = (name: string) => ({ messageId: "bumpy", data: { name, count: 2, max: 1 } });

tester.run("limits/bumpy-road", limits.rules["bumpy-road"], {
  valid: [
    { code: "function one(a, b) { if (a) { if (b) { go(); } } }", options },
    { code: "function flat(a, b) { if (a) { go(); } if (b) { stop(); } }", options },
    {
      code: "function inner(a, b) { if (a) { if (b) { go(); } } } function caller(c, d) { if (c) { for (const x of d) { inner(x); } } }",
      options,
    },
    {
      code: "function outer(a, b) { function inner() { if (a) { if (b) { go(); } } } if (a) { while (b) { inner(); } } }",
      options,
    },
    { code: "function wrap(a, items) { if (a) { items.forEach((item) => { for (const x of item) { go(x); } }); } }", options },
  ],
  invalid: [
    {
      code: "function two(a, b) { if (a) { if (b) { go(); } } for (const x of b) { while (x) { stop(); } } }",
      options,
      errors: [bumpy("two")],
    },
    {
      code: "function mixed(a, items) { if (a) { if (items) { go(); } } items.map((item) => { switch (item) { case 1: if (a) { go(); } } }); }",
      options,
      errors: [bumpy("mixed")],
    },
    {
      code: "function guarded(a, b) { if (a) { try { go(); } catch { stop(); } } if (b) { if (a) { go(); } } }",
      options,
      errors: [bumpy("guarded")],
    },
    {
      code: "class Runner { run(a, b) { if (a) { if (b) { go(); } } while (b) { if (a) { stop(); } } } }",
      options,
      errors: [bumpy("run")],
    },
    {
      code: "export const handle = (a: boolean, b: number[]) => { if (a) { for (const x of b) { go(x); } } if (b) { do { stop(); } while (a); } };",
      options,
      errors: [bumpy("handle")],
    },
  ],
});
