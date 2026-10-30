import { useRouter } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { IconButton, Tooltip, cn } from "@guildsrun/ui";
import { useReturnPoint } from "./returnTrail";

type ReturnButtonProps = { className?: string };

/**
 * Back to where a content link was followed from, such as the chat a call's memory chip left: a
 * round arrow floating over the top left of the body it is placed before, taking no room.
 */
export function ReturnButton({ className }: ReturnButtonProps) {
  const router = useRouter();
  const back = useReturnPoint();
  if (!back) return null;
  return (
    <div className="relative z-20 h-0 shrink-0">
      <Tooltip label={`Back to ${back.label}`} side="right">
        <IconButton
          icon={ArrowLeft}
          label={`Back to ${back.label}`}
          variant="surface"
          size={32}
          round
          data-return-ignore=""
          className={cn("absolute top-2 left-2 shadow-pop md:top-3 md:left-3", className)}
          onClick={() => void router.navigate({ href: back.href })}
        />
      </Tooltip>
    </div>
  );
}
