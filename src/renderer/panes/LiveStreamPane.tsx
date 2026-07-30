import { useEffect, useState } from "react";
import { Copy, Filter, LoaderCircle } from "lucide-react";
import type { TraceEvent, TraceLevel } from "../../shared/trace";
import { useAppStore, type TraceFilters } from "../store";

const TRACE_LEVELS: TraceLevel[] = ["debug", "info", "warn", "error"];

function rowClass(event: TraceEvent): string {
  if (event.level === "error") return "event-row event-error";
  if (event.level === "warn") return "event-row event-warning";
  return "event-row";
}

function TraceRow({ event }: { event: TraceEvent }) {
  const filters = useAppStore((state) => state.traceFilters);
  const setTraceFilters = useAppStore((state) => state.setTraceFilters);

  return (
    <div className={rowClass(event)} data-sequence={event.sequence}>
      <span className="event-sequence">
        {String(event.sequence).padStart(3, "0")}
      </span>
      <span className="event-content">
        <small>
          {event.subsystem} · {event.kind} · {event.level.toUpperCase()}
        </small>
        <strong>{event.message}</strong>
        {event.payload !== undefined && (
          <details className="trace-payload">
            <summary>payload</summary>
            <pre>{JSON.stringify(event.payload, null, 2)}</pre>
          </details>
        )}
      </span>
      <button
        className="trace-correlation"
        title="Filter by this correlation ID"
        onClick={() =>
          void setTraceFilters({
            ...filters,
            correlationId: event.correlationId,
          })
        }
      >
        {event.correlationId}
      </button>
      <button
        className="ghost-button"
        aria-label="Copy event JSON"
        onClick={() =>
          void navigator.clipboard.writeText(JSON.stringify(event, null, 2))
        }
      >
        <Copy size={13} />
      </button>
      <time>
        {new Date(event.timestamp).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })}
      </time>
    </div>
  );
}

export function LiveStreamPane() {
  const events = useAppStore((state) => state.traceWindow);
  const filters = useAppStore((state) => state.traceFilters);
  const hasOlder = useAppStore((state) => state.traceHasOlder);
  const loading = useAppStore((state) => state.traceLoading);
  const loadInitialTraces = useAppStore((state) => state.loadInitialTraces);
  const loadOlderTraces = useAppStore((state) => state.loadOlderTraces);
  const receiveTraceEvent = useAppStore((state) => state.receiveTraceEvent);
  const setTraceFilters = useAppStore((state) => state.setTraceFilters);

  const [draft, setDraft] = useState<TraceFilters>(filters);
  const [draftBase, setDraftBase] = useState<TraceFilters>(filters);

  // Keep the form in sync when filters change elsewhere (correlation nav):
  // adjust draft state during render rather than in an effect.
  if (filters !== draftBase) {
    setDraftBase(filters);
    setDraft(filters);
  }

  // Subscribe before the initial query: events delivered live and present in
  // the page are deduplicated by sequence in the store, so the overlap race
  // is safe and no event is missed in between.
  useEffect(() => {
    const unsubscribe = window.spire.onTraceEvent(receiveTraceEvent);
    void loadInitialTraces();
    return unsubscribe;
  }, [receiveTraceEvent, loadInitialTraces]);

  function updateDraft(key: keyof TraceFilters, value: string) {
    setDraft((current) => ({ ...current, [key]: value || undefined }));
  }

  return (
    <div className="pane pane-column" data-pane="live-stream">
      <div className="section-heading">
        <span>TRACE JOURNAL</span>
      </div>
      <form
        className="trace-filters"
        onSubmit={(event) => {
          event.preventDefault();
          void setTraceFilters(draft);
        }}
      >
        <input
          aria-label="Filter by run"
          placeholder="Run"
          value={draft.runId ?? ""}
          onChange={(event) => updateDraft("runId", event.target.value)}
        />
        <input
          aria-label="Filter by node"
          placeholder="Node"
          value={draft.nodeId ?? ""}
          onChange={(event) => updateDraft("nodeId", event.target.value)}
        />
        <input
          aria-label="Filter by subsystem"
          placeholder="Subsystem"
          value={draft.subsystem ?? ""}
          onChange={(event) => updateDraft("subsystem", event.target.value)}
        />
        <input
          aria-label="Filter by kind"
          placeholder="Kind"
          value={draft.kind ?? ""}
          onChange={(event) => updateDraft("kind", event.target.value)}
        />
        <input
          aria-label="Filter by correlation ID"
          placeholder="Correlation"
          value={draft.correlationId ?? ""}
          onChange={(event) =>
            updateDraft("correlationId", event.target.value)
          }
        />
        <input
          aria-label="Filter by text"
          placeholder="Text"
          value={draft.text ?? ""}
          onChange={(event) => updateDraft("text", event.target.value)}
        />
        <select
          aria-label="Filter by level"
          value={draft.level ?? ""}
          onChange={(event) => updateDraft("level", event.target.value)}
        >
          <option value="">Any level</option>
          {TRACE_LEVELS.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
        <button type="submit" className="ghost-button labeled">
          <Filter size={13} /> Apply
        </button>
      </form>
      <div className="event-stream pane-scroll">
        {events.length === 0 ? (
          <div className="waiting-events">
            <LoaderCircle className="spin" size={18} /> Waiting for trace
            events…
          </div>
        ) : (
          events.map((event) => <TraceRow key={event.sequence} event={event} />)
        )}
      </div>
      <footer className="run-actions">
        <button
          className="ghost-button labeled"
          disabled={!hasOlder || loading}
          onClick={() => void loadOlderTraces()}
        >
          {loading ? <LoaderCircle className="spin" size={13} /> : null}
          Load older
        </button>
      </footer>
    </div>
  );
}
