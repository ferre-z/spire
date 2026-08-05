import { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { HarnessId } from "../../shared/domain";
import { useAppStore } from "../store";

export function ModelComboBox({ harnessId, modelId, onChange }: {
  readonly harnessId: string;
  readonly modelId: string;
  readonly onChange: (modelId: string) => void;
}) {
  const harnessModels = useAppStore((state) => state.harnessModels);
  const loadHarnessModels = useAppStore((state) => state.loadHarnessModels);
  const models = harnessModels[harnessId];
  const currentName = models?.find((model) => model.id === modelId)?.name ?? "";
  const [query, setQuery] = useState(currentName);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);

  useEffect(() => {
    setQuery(currentName);
    setHighlight(0);
    // Reset the internal query whenever the bound model or harness changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId, harnessId]);

  const filtered = useMemo(() => {
    if (!models) return [];
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return models;
    return models.filter(
      (model) =>
        model.name.toLowerCase().includes(trimmed) ||
        model.id.toLowerCase().includes(trimmed),
    );
  }, [models, query]);

  const select = (id: string): void => {
    const model = models?.find((item) => item.id === id);
    onChange(id);
    setQuery(model?.name ?? "");
    setOpen(false);
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setOpen(true);
        setHighlight((current) => (filtered.length === 0 ? 0 : (current + 1) % filtered.length));
        break;
      case "ArrowUp":
        event.preventDefault();
        setOpen(true);
        setHighlight((current) => (filtered.length === 0 ? 0 : (current - 1 + filtered.length) % filtered.length));
        break;
      case "Enter": {
        event.preventDefault();
        const selected = filtered[highlight];
        if (selected) select(selected.id);
        break;
      }
      case "Escape":
        event.preventDefault();
        setOpen(false);
        break;
      default:
        break;
    }
  };

  const empty = !models || models.length === 0;

  return (
    <div className="node-combobox">
      <input
        className="node-combobox-input"
        data-model-search
        value={query}
        placeholder="Search models…"
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
          setHighlight(0);
        }}
        onKeyDown={onKeyDown}
      />
      {open ? (
        <div className="node-combobox-list" data-model-options>
          {empty ? (
            <div className="node-combobox-empty" data-model-empty>
              <span>No models — refresh</span>
              <button
                type="button"
                aria-label="Refresh models"
                title="Refresh models"
                onClick={() => void loadHarnessModels(harnessId as HarnessId)}
              >
                <RefreshCw size={15} />
              </button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="node-combobox-empty" data-model-empty>No matches</div>
          ) : (
            filtered.map((model, index) => (
              <button
                key={model.id}
                type="button"
                className="node-combobox-option"
                data-model-option
                data-highlighted={index === highlight || undefined}
                onMouseEnter={() => setHighlight(index)}
                onClick={() => select(model.id)}
              >
                <span>{model.name}</span>
                <small>{model.id}</small>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}