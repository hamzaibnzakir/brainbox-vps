import { useCallback, useEffect, useRef, useState } from "react";
import type { AppError } from "@/types/generated";
import { toAppError } from "@/services/errors";

export interface AsyncState<T> {
  data: T | undefined;
  error: AppError | null;
  loading: boolean;
  /** True only for the very first load (no data yet). */
  initial: boolean;
  reload: () => Promise<void>;
  setData: (fn: T | ((d: T | undefined) => T)) => void;
}

/**
 * Load data with loading/error state. Re-runs when `deps` change; `enabled`
 * gates the call (e.g. until a server is connected). Stale responses from an
 * earlier call never overwrite newer ones.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], enabled = true): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<AppError | null>(null);
  const [loading, setLoading] = useState(enabled);
  const seq = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const run = useCallback(async () => {
    const id = ++seq.current;
    setLoading(true);
    try {
      const r = await fnRef.current();
      if (id === seq.current) {
        setData(r);
        setError(null);
      }
    } catch (e) {
      if (id === seq.current) setError(toAppError(e));
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled]);

  return {
    data,
    error,
    loading,
    initial: loading && data === undefined,
    reload: run,
    setData: (v) => setData((d) => (typeof v === "function" ? (v as (d: T | undefined) => T)(d) : v)),
  };
}

export function useInterval(fn: () => void, ms: number | null) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (ms == null) return;
    const t = setInterval(() => ref.current(), ms);
    return () => clearInterval(t);
  }, [ms]);
}
