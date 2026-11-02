import type { JsonValue } from "../../api/wire";

/** A file picked for import: the JSON it holds, which the API validates as a recipe, or not JSON. */
export type RecipeFile = { kind: "json"; recipe: JsonValue } | { kind: "not-json" };

/** Reads a picked file as JSON; a file that cannot be read or parsed is not JSON. */
export async function readRecipeFile(file: Blob): Promise<RecipeFile> {
  try {
    const recipe: JsonValue = JSON.parse(await file.text());
    return { kind: "json", recipe };
  } catch {
    return { kind: "not-json" };
  }
}
