import { CloudOff, type LucideIcon } from "lucide-react";
import { EmptyState, type EmptyStateProps } from "./EmptyState";

export type PageErrorProps = Omit<EmptyStateProps, "icon" | "tone"> & {
  icon?: LucideIcon;
};

/** A view that could not load or lost its live connection, with the one action that recovers it. */
export function PageError({ icon = CloudOff, ...props }: PageErrorProps) {
  return <EmptyState role="alert" tone="error" icon={icon} {...props} />;
}
