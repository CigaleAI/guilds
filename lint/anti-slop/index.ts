// Rules vendored from anti-slop (https://github.com/dmmulroy/anti-slop, MIT, LICENSE beside this
// file), as its author intends: copied, read, and kept here. Each refuses a type or a construct
// that carries no evidence, as docs/contributing/code-guidelines.md (Types and errors) asks.
import { eslintCompatPlugin } from "@oxlint/plugins";

import { noKnownValueWideningRule } from "./rules/no-known-value-widening.ts";
import { noModuleMockingRule } from "./rules/no-module-mocking.ts";
import { noObjectParametersRule } from "./rules/no-object-parameters.ts";
import { noReduceAccumulatorCopyRule } from "./rules/no-reduce-accumulator-copy.ts";
import { noRuntimeTypeofRule } from "./rules/no-runtime-typeof.ts";
import { noUnknownParametersRule } from "./rules/no-unknown-parameters.ts";
import { noUnsafeDictionaryTypeRule } from "./rules/no-unsafe-dictionary-type.ts";

export default eslintCompatPlugin({
  meta: { name: "anti-slop" },
  rules: {
    "no-known-value-widening": noKnownValueWideningRule,
    "no-module-mocking": noModuleMockingRule,
    "no-object-parameters": noObjectParametersRule,
    "no-reduce-accumulator-copy": noReduceAccumulatorCopyRule,
    "no-runtime-typeof": noRuntimeTypeofRule,
    "no-unknown-parameters": noUnknownParametersRule,
    "no-unsafe-dictionary-type": noUnsafeDictionaryTypeRule,
  },
});
