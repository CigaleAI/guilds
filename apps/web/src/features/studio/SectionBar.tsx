import { Link } from "@tanstack/react-router";
import { PillCount, TabsNav, tabsTrigger } from "@guildsrun/ui";
import { studioSectionLabel, studioSections } from "./location";
import { countOpen } from "./pendingModel";
import { useStudio } from "./StudioContext";

/**
 * The workspace's four sections: the guild, its agents, its state, and the tools they call, each
 * with how many of the coach's requests wait in it.
 */
export function SectionBar() {
  const { session, search, approvals } = useStudio();
  const counts = countOpen(approvals.proposals, (proposal) => proposal.place);
  return (
    <TabsNav aria-label="Studio sections" className="border-t-0">
      {studioSections.map((section) => (
        <Link
          key={section}
          to="/studio/$sessionId"
          params={{ sessionId: session.id }}
          search={{ section }}
          aria-current={section === search.section ? "page" : undefined}
          className={tabsTrigger({ look: "bar" })}
        >
          {studioSectionLabel[section]}
          {counts[section] ? <PillCount>{counts[section]}</PillCount> : null}
        </Link>
      ))}
    </TabsNav>
  );
}
