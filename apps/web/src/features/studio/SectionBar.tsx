import { Link } from "@tanstack/react-router";
import { TabsNav, tabsTrigger } from "@guildsrun/ui";
import { studioSectionLabel, studioSections } from "./location";
import { useStudio } from "./StudioContext";

/** The workspace's four sections: the guild, its agents, its state, and the tools they call. */
export function SectionBar() {
  const { session, search } = useStudio();
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
        </Link>
      ))}
    </TabsNav>
  );
}
