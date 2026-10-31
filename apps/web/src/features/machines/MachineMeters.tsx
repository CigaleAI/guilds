import { Banner, cn } from "@guildsrun/ui";
import {
  formatMib,
  loadShares,
  overcommit,
  sizingNote,
  type LoadShare,
  type MachineSize,
} from "./machines";

type MeterProps = {
  used: number;
  adds?: number;
  max: number;
  label: string;
};

/**
 * A share of a limit as a bar: what is used, then what a placement adds in a lighter fill. Past the
 * limit the bar scales to the total and turns ochre.
 */
function Meter({ used, adds = 0, max, label }: MeterProps) {
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

/** A CPU count without float noise: 1.5, 0.75. */
function formatCpu(cpu: number): string {
  return String(Number(cpu.toFixed(2)));
}

type LoadMeterProps = {
  label: string;
  share: LoadShare;
  format: (value: number) => string;
  size: string;
  factor: number;
};

/** One resource of a machine's planned load against its capacity, with what the capacity is. */
function LoadMeter({ label, share, format, size, factor }: LoadMeterProps) {
  const total = share.planned + share.adds;
  return (
    <div className="flex flex-col gap-1.5">
      <Meter
        used={share.planned}
        adds={share.adds}
        max={share.capacity}
        label={`Planned ${label}`}
      />
      <p className="text-xs text-muted">
        <span className="font-medium text-fg-2">{label}</span> {format(total)} of{" "}
        {format(share.capacity)} planned ({percent(total, share.capacity)})
        {share.adds > 0 ? `, ${format(share.adds)} added` : ""}. Capacity is {factor}× its {size}.
      </p>
    </div>
  );
}

type LoadBudgetProps = {
  size: MachineSize;
  /** The planned load of the agents already on it. */
  planned: MachineSize;
  /** What a placement adds. */
  adds?: MachineSize | undefined;
  /** Who adds `adds`: "this agent", "the recipe's agents". */
  addsLabel?: string;
  /** What to do when it is over, after the warning. */
  remedy: string;
  /** Show the sizing rules under the meters; off where the page states them once. */
  rules?: boolean;
};

/**
 * A machine's planned load against its capacity, CPUs and memory each: the sum of its agents'
 * minimums, plus what a placement adds, against its size times the overcommit factors. The sizing
 * rules sit under it; past either capacity it warns, with what to do next.
 */
export function LoadBudget({
  size,
  planned,
  adds,
  addsLabel,
  remedy,
  rules = true,
}: LoadBudgetProps) {
  const shares = loadShares(
    { ...size, planned_cpu: planned.cpu, planned_mib: planned.memory_mib },
    adds,
  );
  const over = [
    shares.cpu.over ? "slow down" : null,
    shares.memory.over ? "run out of memory" : null,
  ]
    .filter(Boolean)
    .join(" and ");
  return (
    <div className="flex flex-col gap-2">
      <div className="grid gap-3 sm:grid-cols-2">
        <LoadMeter
          label="CPU"
          share={shares.cpu}
          format={(value) => `${formatCpu(value)} CPU`}
          size={`${formatCpu(size.cpu)} CPU`}
          factor={overcommit.cpu}
        />
        <LoadMeter
          label="Memory"
          share={shares.memory}
          format={formatMib}
          size={formatMib(size.memory_mib)}
          factor={overcommit.memory}
        />
      </div>
      {rules || (adds && addsLabel) ? (
        <p className="text-xs text-muted">
          {adds && addsLabel ? `The added share is ${addsLabel}. ` : ""}
          {rules ? sizingNote : null}
        </p>
      ) : null}
      {over ? (
        <Banner
          tone="warning"
          title={`Agents on this machine may ${over} when many work at once; ${remedy}.`}
        />
      ) : null}
    </div>
  );
}

type DiskMeterProps = {
  usedMib: number | null;
  maxMib: number;
  label: string;
};

/** Disk used against a cap, or a note that nothing has been measured yet. */
export function DiskMeter({ usedMib, maxMib, label }: DiskMeterProps) {
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

type DiskBudgetProps = {
  othersMib: number;
  addsMib: number;
  unreservedMib: number;
  machineMib: number;
  /** The machine's cap less its homes as last measured; null before a measure. */
  freeMib: number | null;
};

/**
 * A machine's disk as its agents' own caps reserve it, plus the cap of the agent being placed: the
 * room left unreserved, and the disk free as last measured. Past the unreserved room it warns.
 */
export function DiskBudget({
  othersMib,
  addsMib,
  unreservedMib,
  machineMib,
  freeMib,
}: DiskBudgetProps) {
  const total = othersMib + addsMib;
  return (
    <div className="flex flex-col gap-1.5">
      <Meter used={othersMib} adds={addsMib} max={machineMib} label="Reserved disk" />
      <p className="text-xs text-muted">
        {formatMib(total)} of {formatMib(machineMib)} reserved by agents&apos; disk caps (
        {percent(total, machineMib)}), {formatMib(addsMib)} of it for this agent.{" "}
        {unreservedMib > 0
          ? `Up to ${formatMib(unreservedMib)} is safe: the other agents' caps leave it unreserved.`
          : "The other agents' caps reserve all of it."}{" "}
        {freeMib === null
          ? "Free disk is measured after a generation."
          : `${formatMib(freeMib)} free now, measured after the last generation.`}
      </p>
      {total > machineMib ? (
        <Banner
          tone="warning"
          title={
            unreservedMib > 0
              ? `The machine's disk may fill before this agent reaches its own cap; set Max disk to ${formatMib(unreservedMib)} or less, or pick another machine.`
              : "The machine's disk may fill before this agent reaches its own cap; pick another machine, or raise this machine's disk cap."
          }
        />
      ) : null}
    </div>
  );
}
