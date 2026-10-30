import { useState } from "react";
import { useSetMessageLimit } from "../../api/queries/chat";
import type { GroupChatState } from "../../api/types";
import {
  Button,
  TextField,
  Popover,
  PopoverContent,
  PopoverTrigger,
  toast,
  cn,
} from "@guildsrun/ui";
const presets = [25, 50, 100, 200];

/** How full the budget is: a ring drawn around its centre. */
function Ring({ used }: { used: number }) {
  const radius = 7;
  const length = 2 * Math.PI * radius;
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden className="-rotate-90">
      <circle
        cx="9"
        cy="9"
        r={radius}
        fill="none"
        strokeWidth="2.5"
        className="stroke-on-plum-hover"
      />
      <circle
        cx="9"
        cy="9"
        r={radius}
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={`${Math.min(1, used) * length} ${length}`}
        className={cn(used >= 1 ? "stroke-plum-t" : used >= 0.7 ? "stroke-ochre" : "stroke-signal")}
      />
    </svg>
  );
}

/**
 * The guild's message budget in its header: how many messages agents posted in a row since an
 * operator last did, against the limit at which they pause, with the limit to change.
 */
export function MessageBudget({ guildId, state }: { guildId: string; state: GroupChatState }) {
  const save = useSetMessageLimit(guildId);
  const [value, setValue] = useState(String(state.agent_message_limit));
  const limit = state.agent_message_limit;
  const count = state.agent_message_count;

  const set = (next: number) =>
    save.mutate(next, {
      onSuccess: () => toast({ kind: "success", title: `Agents now pause after ${next} messages` }),
      onError: (error) =>
        toast({ kind: "error", title: "Couldn't change the limit", description: error.message }),
    });

  return (
    <Popover onOpenChange={(open) => open && setValue(String(limit))}>
      <PopoverTrigger asChild>
        <Button
          variant="on-plum"
          size="sm"
          title={`${count} of ${limit} agent messages since an operator last posted`}
        >
          <Ring used={limit ? count / limit : 0} />
          <span className="font-mono">
            {count}/{limit}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-72 flex-col gap-3 p-4">
        <div className="flex flex-col gap-1">
          <span className="text-md font-semibold">Message limit</span>
          <span className="text-xs text-muted">
            Agent messages in a row before the guild waits for an operator. {count} since an
            operator last posted.
          </span>
        </div>
        <div className="flex gap-1.5" role="group" aria-label="Preset limits">
          {presets.map((preset) => (
            <Button
              key={preset}
              variant={preset === limit ? "primary" : "outline"}
              size="sm"
              disabled={save.isPending}
              onClick={() => set(preset)}
            >
              {preset}
            </Button>
          ))}
        </div>
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const next = Number(value);
            if (Number.isInteger(next) && next >= 1 && next !== limit) set(next);
          }}
        >
          <TextField
            tone="surface"
            label="Custom"
            type="number"
            min={1}
            max={10000}
            className="flex-1"
            value={value}
            onChange={(event) => setValue(event.currentTarget.value)}
          />
          <Button type="submit" size="md" disabled={save.isPending || Number(value) === limit}>
            Save
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
