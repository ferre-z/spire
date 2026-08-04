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
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    // No scoped node → clear and idle: no fetch, no subscription.
    if (runId === undefined || nodeId === undefined) {
      setEvents([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

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
    // page is in flight are deduped by sequence on append, so the overlap
    // race is safe and no event is missed in between.
    const unsubscribe = window.spire.onTraceEvent((event) => {
      if (event.runId !== runId || event.nodeId !== nodeId) return;
      setEvents((current) => {
        const next = dedupeAscending([...current, event]);
        next.sort((a, b) => a.sequence - b.sequence);
        return capEvents(next);
      });
    });

    void fetchPage(undefined, 0, [])
      .then((fetched) => {
        if (cancelled) return;
        setEvents(capEvents(dedupeAscending(fetched)));
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.error("useNodeTraces: failed to load node traces", error);
        setLoading(false);
      });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [runId, nodeId, reload]);

  const refresh = useCallback(() => setReload((count) => count + 1), []);

  return { events, loading, refresh };
}