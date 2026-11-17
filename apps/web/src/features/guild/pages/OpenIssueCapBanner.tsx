import { Banner } from "@guildsrun/ui";
import type { GuildIssueList } from "../../../api/types/issues";

type OpenIssueCapBannerProps = { list: GuildIssueList | undefined };

/**
 * A warning while the guild holds as many open issues as it may: from then on every report its
 * agents file is refused, and nothing else tells the operator they are lost.
 */
export function OpenIssueCapBanner({ list }: OpenIssueCapBannerProps) {
  if (!list?.at_open_cap) return null;
  return (
    <Banner tone="warning" title={`This guild has reached its limit of ${list.open_cap} open issues`}>
      Its agents' new reports are refused, blocking ones included, until some are resolved.
    </Banner>
  );
}
