import { Banner, cn } from "@guildsrun/ui";
import { formatMib } from "./machines";

/**
 * A share of a limit as a bar: what is used, then what a placement adds in a lighter fill. Past the
 * limit the bar scales to the total and turns ochre.
 */
function Meter({
  used,
  adds = 0,
  max,
  label,
}: {
  used: number;
  adds?: number;
  max: number;
  label: string;
}) {
  const total = used + adds;
  const scale = Math.max(max, total, 1);
  const over = total > max;
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={total}
      className="flex h-2 w-full overflow-hidden rounded-full bg-well"
    >
      <div
        className={over ? "bg-ochre" : "bg-signal"}
        style={{ width: `${(used / scale) * 100}%` }}
      />
      {adds > 0 ? (
        <div
          className={cn("border-l border-surface", over ? "bg-ochre/60" : "bg-signal-2")}
          style={{ width: `${(adds / scale) * 100}%` }}
        />
      ) : null}
    </div>
  );
}

function percent(part: number, whole: number): string {
  return `${Math.round((part / Math.max(whole, 1)) * 100)}%`;
}

/**
 * A machine's planned memory against its memory: every agent on it working at once, plus what a
 * placement adds. Over 100% it warns, with what to do next.
 */
export function MemoryBudget({
  plannedMib,
  addsMib = 0,
  addsLabel,
  memoryMib,
  remedy,
}: {
  plannedMib: number;
  addsMib?: number;
  /** Who adds `addsMib`: "this agent", "the recipe's agents". */
  addsLabel?: string;
  memoryMib: number;
  /** What to do when it is over, after the warning. */
  remedy: string;
}) {
  const total = plannedMib + addsMib;
  return (
    <div className="flex flex-col gap-1.5">
      <Meter used={plannedMib} adds={addsMib} max={memoryMib} label="Planned memory" />
      <p className="text-xs text-muted">
        {formatMib(total)} of {formatMib(memoryMib)} planned ({percent(total, memoryMib)})
        {addsMib > 0 && addsLabel ? `, ${formatMib(addsMib)} of it for ${addsLabel}` : ""}. The plan
        counts every agent working at once.
      </p>
      {total > memoryMib ? (
        <Banner
          tone="warning"
          title={`Agents on this machine may run out of memory when they all work at once; ${remedy}.`}
        />
      ) : null}
    </div>
  );
}

/** Disk used against a cap, or a note that nothing has been measured yet. */
export function DiskMeter({
  usedMib,
  maxMib,
  label,
}: {
  usedMib: number | null;
  maxMib: number;
  label: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Meter used={usedMib ?? 0} max={maxMib} label={label} />
      <p className="text-xs text-muted">
        {usedMib === null
          ? `Not measured yet, of ${formatMib(maxMib)}. Disk is measured after a generation.`
          : `${formatMib(usedMib)} of ${formatMib(maxMib)} (${percent(usedMib, maxMib)}). Measured after the last generation.`}
      </p>
    </div>
  );
}
