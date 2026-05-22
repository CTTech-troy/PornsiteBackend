import { useEffect, useRef } from 'react';

/**
 * Calls `fn` immediately and then every `intervalMs` milliseconds.
 * Stops when the component unmounts or when `enabled` becomes false.
 */
export function useAutoRefresh(fn: () => void, intervalMs: number, enabled = true) {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!enabled) return;
    fnRef.current();
    const id = setInterval(() => fnRef.current(), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, enabled]);
}
