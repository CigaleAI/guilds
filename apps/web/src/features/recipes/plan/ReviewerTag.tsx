import { Tag } from "@guildsrun/ui";

type ReviewerTagProps = { by: string };

export function ReviewerTag({ by }: ReviewerTagProps) {
  return (
    <Tag tone="tide" font="sans" title={`Last written by the ${by}`}>
      {by} edit
    </Tag>
  );
}
