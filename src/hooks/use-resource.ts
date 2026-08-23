import { useCallback, useEffect, useState } from "react";

export interface Resource<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** Re-runs the loader. Keeps the previous `data` visible while in flight. */
  reload: () => void;
  /** Apply a local edit without a round trip — for optimistic list updates. */
  set: (next: T) => void;
}

/**
 * The read half of every settings screen: run an async loader, expose
 * `{data, error, loading}`, and hand back a `reload` for after a mutation.
 *
 * Deliberately not a cache. Blackhouse is a single-instance harness with a
 * handful of screens; a query library would be more machinery than the whole
 * client needs, and stale-while-revalidate is the wrong default for a page
 * whose subject is "what does this host actually have".
 *
 * The loader is called with an `AbortSignal` and its result is discarded if
 * the effect has already been torn down, so a slow response cannot overwrite
 * a newer one.
 */
export function useResource<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  deps: unknown[] = [],
): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- caller owns `deps`
  const run = useCallback(loader, deps);

  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    setLoading(true);

    run(controller.signal)
      .then((result) => {
        if (!live) return;
        setData(result);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!live || controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (live) setLoading(false);
      });

    return () => {
      live = false;
      controller.abort();
    };
  }, [run, nonce]);

  return {
    data,
    error,
    loading,
    reload: useCallback(() => setNonce((n) => n + 1), []),
    set: useCallback((next: T) => setData(next), []),
  };
}
