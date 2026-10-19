import { Wrench } from "lucide-react";
import { EmptyState } from "@guildsrun/ui";

/** Every tool the guild's agents are offered, and how they call it. */
export function ToolsSection() {
  return (
    <div className="p-6">
      <EmptyState
        icon={Wrench}
        title="Tools"
        description="Each tool the agents are offered, who calls it, and how its calls end show here."
      />
    </div>
  );
}
