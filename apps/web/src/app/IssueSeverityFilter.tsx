import { Segmented } from "@guildsrun/ui";
import type { Issue } from "../api/types/issues";
import { severityFilterOptions, type SeverityFilter } from "./issues";

type IssueSeverityFilterProps = {
  /** The issues the filter narrows; each choice counts those of its level. */
  issues: readonly Pick<Issue, "severity">[];
  value: SeverityFilter;
  onValueChange: (value: SeverityFilter) => void;
};

/** The choice of one severity, or every one, over a list of issues. Nothing over an empty list. */
export function IssueSeverityFilter({ issues, value, onValueChange }: IssueSeverityFilterProps) {
  if (!issues.length) return null;
  return (
    <Segmented
      size="sm"
      fill="paper"
      label="Issue severity"
      className="self-start"
      value={value}
      onValueChange={onValueChange}
      options={severityFilterOptions(issues)}
    />
  );
}
