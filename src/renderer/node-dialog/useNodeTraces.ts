import { useCallback, useEffect, useState } from "react";
import type { TraceCursor, TraceEvent } from "../../shared/trace";

/**
 * Scoped live-trace hook for a single node.
 *
 * Supplies the per-node trace events consumed by the Work tab and the
 * ActivityGraph. It owns a purely local event window (ascending by sequence,
 * hard-capped at MAX_EVENTS) and never touches the store's global trace state
 * (traceWindow/traceCursor/traceFilters) — the LiveStream pane owns that.
 *
 * The bringer renderer receives ALL global trace events via onTraceEvent, so
 * this hook filters client-side to the scoped node (matching runId + nodeId
 * only) and ignores global events where either is undefined.
 */

const PAGE_LIMIT = 1000;
/** Initial page plus up to 2 follow-up pages (≤ 3000 events). */
const MAX_PAGES = 3;
const MAX_EVENTS = 5000;

/** Dedupe by sequence, preserving ascending order (input must be ascending). */
function dedupeAscending(events: TraceEvent[]): TraceEvent[] {
  const seen = new Set<number>();
  const unique: TraceEvent[] = [];
  for (const event of events) {
    if (seen.has(event.sequence)) continue;
    seen.add(event.sequence);
    unique.push(event);
  }
  return unique;
}

/** Hard cap: drop the oldest events (lowest sequence) beyond the cap. */
function capEvents(events: TraceEvent[]): TraceEvent[] {
  return events.length > MAX_EVENTS
    ? events.slice(events.length - MAX_EVENTS)
    : events;
}

export function useNodeTraces(
  runId: string | undefined,
  nodeId: string | undefined,
): { events: TraceEvent[]; loading: boolean; refresh: () => void } {
  const scope = runId !== undefined && nodeId !== undefined ? `${runId}\0${nodeId}` : undefined;
  const [scopeState, setScopeState] = useState({ scope, generation: 0 });
  const scopeChanged = scopeState.scope !== scope;
  const generation = scopeChanged ? scopeState.generation + 1 : scopeState.generation;
  if (scopeChanged) {
    setScopeState({ scope, generation });
  }
  const stateKey = scope === undefined ? undefined : `${generation}\0${scope}`;
  const [traceState, setTraceState] = useState<{
    readonly key: string | undefined;
    readonly events: TraceEvent[];
    readonly loading: boolean;
  }>(() => ({ key: stateKey, events: [], loading: stateKey !== undefined }));
  const currentState = traceState.key === stateKey
    ? traceState
    : { key: stateKey, events: [], loading: stateKey !== undefined };
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (runId === undefined || nodeId === undefined || stateKey === undefined) return;

    let cancelled = false;

    const fetchPage = async (
      cursor: TraceCursor | undefined,
      depth: number,
      acc: TraceEvent[],
    ): Promise<TraceEvent[]> => {
      const page = await window.spire.queryTraces({
        runId,
        nodeId,
        limit: PAGE_LIMIT,
        ...(cursor ? { cursor } : {}),
      });
      const merged = dedupeAscending([...acc, ...page.events]);
      if (page.nextCursor && depth < MAX_PAGES - 1) {
        return fetchPage(page.nextCursor, depth + 1, merged);
      }
      return merged;
    };

    // Subscribe before the initial query: live events delivered while the
    // page is in flight are appended to state immediately. When the query
    // resolves we MERGE the fetched pages into the current state (rather than
    // replacing it) so those in-flight live events are preserved; dedupe by
    // sequence keeps the overlap between the fetched pages and the live stream
    // from producing duplicates.
    const unsubscribe = window.spire.onTraceEvent((event) => {
      if (event.runId !== runId || event.nodeId !== nodeId) return;
      setTraceState((current) => {
        const currentEvents = current.key === stateKey ? current.events : [];
        const next = dedupeAscending([...currentEvents, event]);
        next.sort((a, b) => a.sequence - b.sequence);
        return { key: stateKey, events: capEvents(next), loading: true };
      });
    });

    void fetchPage(undefined, 0, [])
      .then((fetched) => {
        if (cancelled) return;
        // Merge into current state so live events that arrived while the query
        // was in flight are preserved rather than dropped by a replace.
        setTraceState((current) => {
          const currentEvents = current.key === stateKey ? current.events : [];
          const merged = [...currentEvents, ...fetched];
          merged.sort((a, b) => a.sequence - b.sequence);
          return { key: stateKey, events: capEvents(dedupeAscending(merged)), loading: false };
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.error("useNodeTraces: failed to load node traces", error);
        setTraceState((current) => ({
          key: stateKey,
          events: current.key === stateKey ? current.events : [],
          loading: false,
        }));
      });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [runId, nodeId, reload, stateKey]);

  const refresh = useCallback(() => {
    if (stateKey !== undefined) {
      setTraceState((current) => ({
        key: stateKey,
        events: current.key === stateKey ? current.events : [],
        loading: true,
      }));
    }
    setReload((count) => count + 1);
  }, [stateKey]);

  return { events: currentState.events, loading: currentState.loading, refresh };
}
