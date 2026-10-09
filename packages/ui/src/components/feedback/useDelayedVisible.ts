import { useEffect, useState } from "react";

/**
 * False until `delay` ms after mount, then true. Loading placeholders wait on it so a fast
 * response never flashes a skeleton.
 */
export function useDelayedVisible(delay = 300): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (delay <= 0) return;
    const timer = window.setTimeout(() => setElapsed(true), delay);
    return () => window.clearTimeout(timer);
  }, [delay]);
  return elapsed || delay <= 0;
}
