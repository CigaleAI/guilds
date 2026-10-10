/**
 * Hands a GitHub App manifest to GitHub as a top-level form post. GitHub shows its confirmation
 * page, then sends the browser back to this box, which stores the App.
 */
export function submitManifestForm(action: string, manifest: Record<string, unknown>): void {
  const form = document.createElement("form");
  form.method = "post";
  form.action = action;
  form.hidden = true;
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = "manifest";
  input.value = JSON.stringify(manifest);
  form.append(input);
  document.body.append(form);
  form.submit();
}
