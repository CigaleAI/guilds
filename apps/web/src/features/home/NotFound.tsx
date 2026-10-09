import { Link } from "@tanstack/react-router";
import { SearchX } from "lucide-react";
import { EmptyState } from "@guildsrun/ui";
export function NotFound() {
  return (
    <div className="grid flex-1 place-items-center p-6">
      <EmptyState
        icon={SearchX}
        title="Nothing lives at this address"
        action={
          <Link to="/" className="font-semibold text-signal-t underline">
            Back to your guilds
          </Link>
        }
      />
    </div>
  );
}
