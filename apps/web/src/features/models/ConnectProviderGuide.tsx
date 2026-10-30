import { Link } from "@tanstack/react-router";
import { KeyRound } from "lucide-react";
import { Button, EmptyState } from "@guildsrun/ui";

type ConnectProviderGuideProps = { what?: string };

/** Shown in place of a model picker while the organisation has no provider connected. */
export function ConnectProviderGuide({ what = "an agent" }: ConnectProviderGuideProps) {
  return (
    <EmptyState
      icon={KeyRound}
      title="Connect a model provider first"
      description={`Nothing can run ${what} until the organisation connects a provider and chooses the models it offers.`}
      action={
        <Button asChild>
          <Link to="/settings" search={{ tab: "keys" }}>
            Open Model keys
          </Link>
        </Button>
      }
    />
  );
}
