import type { LucideIcon, LucideProps } from "lucide-react";
import { cn } from "../cn";

export type IconSize = 14 | 16 | 18 | 20 | 24;

export type IconProps = Omit<LucideProps, "size" | "ref"> & {
  icon: LucideIcon;
  size?: IconSize;
  /** Accessible name; without it the icon is decorative and hidden from assistive tech. */
  label?: string;
};

/** A Lucide glyph at a 1.5px stroke whatever its size, in the surrounding text colour. */
export function Icon({ icon: Glyph, size = 16, label, className, ...props }: IconProps) {
  return (
    <Glyph
      size={size}
      strokeWidth={1.5}
      absoluteStrokeWidth
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
      className={cn("shrink-0", className)}
      {...props}
    />
  );
}
