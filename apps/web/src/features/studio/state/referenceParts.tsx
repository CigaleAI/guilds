import type { ReactNode } from "react";
import { Icon, Row } from "@guildsrun/ui";
import type { ReferenceNode } from "../../../api/types/studio";
import { referenceKindIcon } from "./ReferencesMap";

type ReferenceSectionProps = { title: string; children: ReactNode };

/** A labelled group of rows under the map or in the detail. */
export function ReferenceSection({ title, children }: ReferenceSectionProps) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="type-label text-muted">{title}</h3>
      {children}
    </div>
  );
}

type NodeRowProps = {
  node: ReferenceNode;
  meta: string;
  onSelect: (id: string) => void;
};

/** One node as a row that selects it on the map. */
export function NodeRow({ node, meta, onSelect }: NodeRowProps) {
  return (
    <Row
      asChild
      density="compact"
      interactive
      mono={node.kind !== "task"}
      lead={<Icon icon={referenceKindIcon[node.kind]} size={16} className="text-muted" />}
      title={node.label}
      meta={meta}
    >
      <button type="button" title={node.id} onClick={() => onSelect(node.id)} />
    </Row>
  );
}
