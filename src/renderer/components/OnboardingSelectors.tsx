import { Check, LoaderCircle, TerminalSquare } from "lucide-react";
import type { HarnessId, ModelOption } from "../../shared/domain";
import type { HarnessStatus } from "../../shared/control";
import { StatusBadge, ToolCard } from "./UiPrimitives";

export const HARNESS_ORDER: readonly HarnessId[] = [
  "opencode",
  "codex",
  "claude-code",
] as const;

export const HARNESS_NAMES: Readonly<Record<HarnessId, string>> = {
  opencode: "OpenCode",
  codex: "Codex",
  "claude-code": "Claude Code",
};

export type ModelState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly models: readonly ModelOption[] }
  | { readonly kind: "error"; readonly message: string };

export function HarnessChoice({
  id,
  harness,
  onSelect,
}: {
  readonly id: HarnessId;
  readonly harness?: HarnessStatus;
  readonly onSelect: () => void;
}) {
  const status = harness?.status;
  const connected = status?.connected ?? false;
  return (
    <ToolCard title={HARNESS_NAMES[id]} className="harness-choice">
      <label>
        <input
          type="radio"
          name="harness"
          value={id}
          disabled={!connected}
          onChange={onSelect}
        />
        <span className="harness-choice-icon">
          <TerminalSquare size={18} />
        </span>
        <span className="harness-choice-name">{HARNESS_NAMES[id]}</span>
        {connected && <Check size={16} />}
      </label>
      <div className="harness-statuses">
        <StatusBadge
          label={status?.installed ? "Installed" : "Not installed"}
          tone={status?.installed ? "ready" : "disconnected"}
        />
        <StatusBadge
          label={status?.compatible ? "Compatible" : "Incompatible"}
          tone={status?.compatible ? "ready" : "disconnected"}
        />
        <StatusBadge
          label={connected ? "Connected" : "Disconnected"}
          tone={connected ? "ready" : "disconnected"}
        />
      </div>
    </ToolCard>
  );
}

export function ModelSelector({
  state,
  selectedModel,
  onSelect,
}: {
  readonly state: ModelState;
  readonly selectedModel?: string;
  readonly onSelect: (modelId: string) => void;
}) {
  if (state.kind === "idle" || state.kind === "loading") {
    return (
      <div className="model-state" role="status">
        <LoaderCircle className="spin" size={16} /> Loading models…
      </div>
    );
  }
  if (state.kind === "error") {
    return <div className="model-state is-error" role="alert">{state.message}</div>;
  }
  if (state.models.length === 0) {
    return <div className="model-state">No models available for this harness.</div>;
  }
  return (
    <fieldset className="model-selector">
      <legend>Select a model</legend>
      {state.models.map((model) => (
        <label key={model.id}>
          <input
            type="radio"
            name="model"
            value={model.id}
            checked={selectedModel === model.id}
            onChange={() => onSelect(model.id)}
          />
          <span>{model.name}</span>
          <code>{model.id}</code>
        </label>
      ))}
    </fieldset>
  );
}
