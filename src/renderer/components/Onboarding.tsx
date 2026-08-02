import { useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  LoaderCircle,
  RefreshCw,
  TerminalSquare,
} from "lucide-react";
import type { HarnessId, ModelOption } from "../../shared/domain";
import type { HarnessStatus } from "../../shared/control";
import { useAppStore } from "../store";
import { Brand } from "./Brand";
import { Field, StatusBadge, ToolCard } from "./UiPrimitives";

const HARNESS_ORDER: readonly HarnessId[] = [
  "opencode",
  "codex",
  "claude-code",
] as const;

const HARNESS_NAMES: Readonly<Record<HarnessId, string>> = {
  opencode: "OpenCode",
  codex: "Codex",
  "claude-code": "Claude Code",
};

type ModelState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly models: readonly ModelOption[] }
  | { readonly kind: "error"; readonly message: string };

export function Onboarding() {
  const harnesses = useAppStore((state) => state.harnesses);
  const loadHarnesses = useAppStore((state) => state.loadHarnesses);
  const loadHarnessModels = useAppStore((state) => state.loadHarnessModels);
  const applySnapshot = useAppStore((state) => state.applySnapshot);
  const setError = useAppStore((state) => state.setError);
  const [probing, setProbing] = useState(true);
  const [selectedHarness, setSelectedHarness] = useState<HarnessId>();
  const [selectedModel, setSelectedModel] = useState<string>();
  const [modelState, setModelState] = useState<ModelState>({ kind: "idle" });
  const [submitting, setSubmitting] = useState(false);

  async function probeHarnesses(): Promise<void> {
    setProbing(true);
    setError(undefined);
    try {
      await loadHarnesses();
    } finally {
      setProbing(false);
    }
  }

  useEffect(() => {
    void loadHarnesses().finally(() => setProbing(false));
  }, [loadHarnesses]);

  async function chooseHarness(harnessId: HarnessId): Promise<void> {
    setSelectedHarness(harnessId);
    setSelectedModel(undefined);
    setModelState({ kind: "loading" });
    try {
      const models = await loadHarnessModels(harnessId);
      setModelState({ kind: "ready", models });
    } catch (error) {
      setModelState({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function complete(): Promise<void> {
    if (!selectedHarness || !selectedModel) return;
    setSubmitting(true);
    setError(undefined);
    try {
      const snapshot = await window.spire.completeOnboarding({
        harnessId: selectedHarness,
        modelId: selectedModel,
      });
      applySnapshot(snapshot);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }

  const byId = new Map(harnesses.map((harness) => [harness.id, harness]));
  const harnessList = HARNESS_ORDER.map(
    (id): HarnessStatus | undefined => byId.get(id),
  );
  const readyCount = harnesses.filter((harness) => harness.status.connected).length;

  return (
    <main className="onboarding-shell">
      <header className="onboarding-header">
        <Brand />
        <span>LOCAL RUNTIME SETUP</span>
      </header>
      <section className="onboarding-panel" aria-labelledby="onboarding-title">
        <div className="onboarding-copy">
          <span className="onboarding-step">
            {selectedHarness ? "STEP 2 OF 2" : "STEP 1 OF 2"}
          </span>
          <h1 id="onboarding-title">
            {selectedHarness ? "Choose a local model." : "Choose your local harness."}
          </h1>
          <p>
            Spire uses the authentication already owned by your CLI. Select a
            connected harness, then choose one of its available models.
          </p>
        </div>

        {!selectedHarness ? (
          <div className="onboarding-stage">
            <fieldset className="harness-selector">
              <legend>Available local harnesses</legend>
              {probing
                ? HARNESS_ORDER.map((id) => (
                    <div className="harness-skeleton" key={id} aria-label={`Probing ${HARNESS_NAMES[id]}`}>
                      <span />
                      <span />
                    </div>
                  ))
                : harnessList.map((harness, index) => {
                    const id = HARNESS_ORDER[index];
                    if (!id) return null;
                    return (
                      <HarnessChoice
                        key={id}
                        id={id}
                        harness={harness}
                        onSelect={() => void chooseHarness(id)}
                      />
                    );
                  })}
            </fieldset>
            {!probing && readyCount === 0 && (
              <div className="onboarding-recovery">
                <p>No connected harness is ready. Authenticate in its CLI, then scan again.</p>
                <button className="secondary-button" onClick={() => void probeHarnesses()}>
                  <RefreshCw size={15} /> Re-scan harnesses
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="onboarding-stage">
            <button
              type="button"
              className="onboarding-back"
              onClick={() => {
                setSelectedHarness(undefined);
                setSelectedModel(undefined);
                setModelState({ kind: "idle" });
              }}
            >
              <ArrowLeft size={14} /> Change harness
            </button>
            <Field label={`${HARNESS_NAMES[selectedHarness]} models`}>
              <ModelSelector
                state={modelState}
                selectedModel={selectedModel}
                onSelect={setSelectedModel}
              />
            </Field>
            <button
              type="button"
              className="primary-button onboarding-enter"
              disabled={!selectedModel || submitting}
              onClick={() => void complete()}
            >
              {submitting ? <LoaderCircle className="spin" size={17} /> : <ArrowRight size={17} />}
              Enter Spire
            </button>
          </div>
        )}
      </section>
      <footer className="onboarding-footer">
        <span>CLI-OWNED AUTHENTICATION</span>
        <span>LOCAL FIRST</span>
      </footer>
    </main>
  );
}

function HarnessChoice({
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

function ModelSelector({
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
