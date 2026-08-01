import { Cpu, RefreshCw, Unplug, CheckCircle } from "lucide-react";
import { useAppStore } from "../store";
import type { HarnessId } from "../../shared/domain";

/**
 * Harness pane: shows installed/OpenCode/Codex/Claude Code connection state
 * and cached model options per harness, with refresh controls. Reads only from
 * the store (`harnesses.list` / `harnesses.models`); credentials are never
 * surfaced here.
 */
export function HarnessesPane() {
  const harnesses = useAppStore((state) => state.harnesses);
  const harnessModels = useAppStore((state) => state.harnessModels);
  const harnessLoading = useAppStore((state) => state.harnessLoading);
  const loadHarnesses = useAppStore((state) => state.loadHarnesses);
  const loadHarnessModels = useAppStore((state) => state.loadHarnessModels);

  if (harnessLoading && harnesses.length === 0) {
    return (
      <div className="pane pane-empty" data-pane="harnesses">
        <Cpu size={22} />
        <h3>Probing harnesses…</h3>
      </div>
    );
  }

  if (harnesses.length === 0) {
    return (
      <div className="pane pane-column" data-pane="harnesses">
        <header className="pane-header">
          <h2>Harness connections</h2>
          <button
            className="compact-button"
            title="Probe installed harnesses"
            onClick={() => void loadHarnesses()}
          >
            <RefreshCw size={14} />
          </button>
        </header>
        <p className="field-help">No harnesses configured.</p>
      </div>
    );
  }

  return (
    <div className="pane pane-column" data-pane="harnesses">
      <header className="pane-header">
        <h2>Harness connections</h2>
        <button
          className="compact-button"
          title="Re-probe all harnesses"
          onClick={() => void loadHarnesses()}
        >
          <RefreshCw size={14} />
        </button>
      </header>

      <ul className="harness-list">
        {harnesses.map((harness) => (
          <li key={harness.id} className="harness-item">
            <div className="harness-summary">
              <span className="harness-name">{harness.name}</span>
              <HarnessStatusBadge status={harness.status.connected} />
              <span className="field-help">
                {harness.status.installed
                  ? harness.status.compatible
                    ? "ready"
                    : "incompatible"
                  : "not installed"}
              </span>
            </div>

            <details className="harness-models">
              <summary>Models ({harnessModels[harness.id]?.length ?? 0})</summary>
              <button
                className="compact-button"
                title={`Refresh ${harness.name} models`}
                onClick={() =>
                  void loadHarnessModels(harness.id as HarnessId).catch(() => {})
                }
              >
                ↻
              </button>
              <ul>
                {(harnessModels[harness.id] ?? []).map((model) => (
                  <li key={model.id}>{model.name}</li>
                ))}
              </ul>
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}

function HarnessStatusBadge({ status }: { status: boolean }) {
  return status ? (
    <CheckCircle size={14} className="status-good" />
  ) : (
    <Unplug size={14} className="status-off" />
  );
}
