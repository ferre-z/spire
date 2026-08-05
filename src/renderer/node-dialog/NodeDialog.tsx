import { useEffect, useLayoutEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Box, Save, X } from "lucide-react";
import { useAppStore } from "../store";
import { InputPanel, OutputPanel } from "./NodeDialogPanels";
import { NodeSettings } from "./NodeSettings";
import { projectExecution } from "./selectors";

type DialogSection = "input" | "settings" | "output";

const SECTIONS: readonly { readonly id: DialogSection; readonly label: string }[] = [
  { id: "input", label: "Input" },
  { id: "settings", label: "Settings" },
  { id: "output", label: "Output" },
];

export function NodeDialog() {
  const graph = useAppStore((state) => state.graph);
  const selectedNodeId = useAppStore((state) => state.selectedNodeId);
  const selectNode = useAppStore((state) => state.selectNode);
  const loadHarnesses = useAppStore((state) => state.loadHarnesses);
  const loadHarnessModels = useAppStore((state) => state.loadHarnessModels);
  const nodeExecutions = useAppStore((state) => state.nodeExecutions);
  const nodeExecutionsLoading = useAppStore((state) => state.nodeExecutionsLoading);
  const messages = useAppStore((state) => state.messages);
  const messagesLoading = useAppStore((state) => state.messagesLoading);
  const validationResult = useAppStore((state) => state.validationResult);
  const error = useAppStore((state) => state.error);
  const setError = useAppStore((state) => state.setError);
  const saveCurrentGraph = useAppStore((state) => state.saveCurrentGraph);
  const node = graph?.nodes.find((candidate) => candidate.id === selectedNodeId);
  const execution = node ? projectExecution(nodeExecutions, node.id) : undefined;
  const [activeSection, setActiveSection] = useState<DialogSection>("settings");
  const [saving, setSaving] = useState(false);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const restoreCanvasNodeIdRef = useRef<string | undefined>(undefined);
  const trackedCanvasFocusRef = useRef<HTMLElement | null>(null);
  const segmentRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const wasOpenRef = useRef(false);
  const open = node !== undefined;
  const runtimeNodeId = node?.kind === "agent" || node?.kind === "decision" ? node.id : undefined;
  const runtimeHarnessId = node?.kind === "agent" || node?.kind === "decision" ? node.harnessId : undefined;

  useEffect(() => {
    const trackCanvasFocus = (event: FocusEvent): void => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest("[data-pane='graph-canvas'], [aria-label='Graph canvas']")
      ) {
        trackedCanvasFocusRef.current = target;
        restoreCanvasNodeIdRef.current = target.closest<HTMLElement>(
          ".react-flow__node[data-id]",
        )?.dataset.id;
      }
    };
    document.addEventListener("focusin", trackCanvasFocus);
    return () => document.removeEventListener("focusin", trackCanvasFocus);
  }, []);

  useLayoutEffect(() => {
    if (open && !wasOpenRef.current) {
      const focusedElement = trackedCanvasFocusRef.current ?? (
        document.activeElement instanceof HTMLElement ? document.activeElement : null
      );
      restoreFocusRef.current = focusedElement;
      restoreCanvasNodeIdRef.current = focusedElement?.closest<HTMLElement>(
        ".react-flow__node[data-id]",
      )?.dataset.id ?? node?.id;
      setActiveSection("settings");
    }
    wasOpenRef.current = open;
  }, [node?.id, open]);

  useEffect(() => {
    if (!runtimeNodeId || !runtimeHarnessId) return;
    void Promise.all([loadHarnesses(), loadHarnessModels(runtimeHarnessId)]).catch(
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [loadHarnessModels, loadHarnesses, runtimeHarnessId, runtimeNodeId, setError]);

  const restoreFocus = (): void => {
    const canvasNodeId = restoreCanvasNodeIdRef.current;
    const currentCanvasNode = canvasNodeId
      ? [...document.querySelectorAll<HTMLElement>(".react-flow__node[data-id]")].find(
          (candidate) => candidate.dataset.id === canvasNodeId,
        )
      : undefined;
    (currentCanvasNode ?? restoreFocusRef.current)?.focus();
  };
  const close = (): void => {
    selectNode(undefined);
    queueMicrotask(restoreFocus);
    setTimeout(restoreFocus, 50);
  };
  const save = async (): Promise<void> => {
    setSaving(true);
    await saveCurrentGraph();
    setSaving(false);
  };
  const moveSectionFocus = (event: React.KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let nextIndex: number | undefined;
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowUp":
        nextIndex = (index - 1 + SECTIONS.length) % SECTIONS.length;
        break;
      case "ArrowRight":
      case "ArrowDown":
        nextIndex = (index + 1) % SECTIONS.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = SECTIONS.length - 1;
        break;
      default:
        return;
    }
    const nextSection = SECTIONS[nextIndex];
    if (!nextSection) return;
    event.preventDefault();
    setActiveSection(nextSection.id);
    segmentRefs.current[nextIndex]?.focus();
  };

  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => { if (!nextOpen) close(); }}>
      {graph && node ? (
        <Dialog.Portal>
          <Dialog.Overlay className="node-dialog-overlay" />
          <Dialog.Content
            className="node-dialog"
            aria-describedby="node-dialog-description"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              restoreFocus();
            }}
          >
            <Dialog.Description id="node-dialog-description" className="visually-hidden">Edit the selected graph node and inspect its runtime input and output.</Dialog.Description>
            <header className="node-dialog-header">
              <div className="node-dialog-kind"><Box size={18} /><span>{node.kind}</span></div>
              <div className="node-dialog-title">
                <Dialog.Title>{node.name}</Dialog.Title>
                <code>{node.id}</code>
              </div>
              <span className={`node-dialog-status status-${execution?.status ?? "idle"}`}>{execution?.status ?? "not run"}</span>
              <Dialog.Close asChild><button type="button" className="node-dialog-icon-button" aria-label="Close node dialog" title="Close node dialog"><X size={18} /></button></Dialog.Close>
            </header>

            <div className="node-dialog-segments" role="radiogroup" aria-label="Node dialog section">
              {SECTIONS.map((section, index) => <button key={section.id} ref={(element) => { segmentRefs.current[index] = element; }} type="button" role="radio" aria-checked={activeSection === section.id} tabIndex={activeSection === section.id ? 0 : -1} onClick={() => setActiveSection(section.id)} onKeyDown={(event) => moveSectionFocus(event, index)}>{section.label}</button>)}
            </div>

            <div className="node-dialog-columns">
              <section className="node-dialog-column node-dialog-input" data-node-dialog-section="input" data-active={activeSection === "input"} aria-label="Node input">
                <div className="node-dialog-column-heading"><span>INPUT</span>{messagesLoading ? <small>Loading…</small> : null}</div>
                <InputPanel graph={graph} nodeId={node.id} messages={messages} />
              </section>
              <section className="node-dialog-column node-dialog-settings" data-node-dialog-section="settings" data-active={activeSection === "settings"} aria-label="Node settings">
                <div className="node-dialog-column-heading"><span>SETTINGS</span></div>
                <NodeSettings graph={graph} node={node} />
              </section>
              <section className="node-dialog-column node-dialog-output" data-node-dialog-section="output" data-active={activeSection === "output"} aria-label="Node output">
                <div className="node-dialog-column-heading"><span>OUTPUT</span>{nodeExecutionsLoading ? <small>Loading…</small> : null}</div>
                <OutputPanel graph={graph} nodeId={node.id} messages={messages} executions={nodeExecutions} />
              </section>
            </div>

            <footer className="node-dialog-footer">
              <div className="node-dialog-validation" aria-live="polite">
                {validationResult ? <span role={validationResult.valid ? undefined : "alert"} className={validationResult.valid ? "is-valid" : "is-invalid"}>{validationResult.valid ? "Graph is valid." : validationResult.issues.join(" ") || "Graph validation failed."}</span> : error ? <span role="alert" className="is-invalid">{error}</span> : <span>Unsaved edits are retained when this dialog closes.</span>}
              </div>
              <button type="button" className="secondary-button" onClick={close}>Close</button>
              <button type="button" className="primary-button" data-action="save-node-dialog" disabled={saving} onClick={() => void save()}><Save size={16} /> {saving ? "Saving…" : "Save version"}</button>
            </footer>
          </Dialog.Content>
        </Dialog.Portal>
      ) : null}
    </Dialog.Root>
  );
}
