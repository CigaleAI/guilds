import { Link } from "@tanstack/react-router";

const MODEL_KEYS_HREF = "/settings?tab=keys";

/** Settings → Model keys, in a new tab so a create or edit form stays open. */
export function ModelKeysLink() {
  return (
    <Link
      to="/settings"
      search={{ tab: "keys" }}
      target="_blank"
      rel="noopener noreferrer"
      className="underline"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        window.open(MODEL_KEYS_HREF, "_blank", "noopener,noreferrer");
      }}
    >
      Model keys
    </Link>
  );
}
