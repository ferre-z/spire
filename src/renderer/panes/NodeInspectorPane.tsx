import { MousePointer2, Save } from "lucide-react";
import type {
  CheckpointNode,
  GraphDefinitionV2,
  GraphEdge,
  GraphNode,
  HarnessId,
  ModelOption,
  PlanMutation,
} from "../../shared/domain";
import { useAppStore, isGraphV2 } from "../store";
import { useSaveGraph } from "./GraphSettingsPane";

/** Every `NodeAuthority.actions` value, in stable order, for the checkbox list. */
export const PLAN_MUTATIONS: PlanMutation[] = [
  "retry",
  "skip",
  "reorder",
  "reroute",
  "pause",
  "replace",
  "insert",
  "remove",
  "edit",
];

function SettingBlock({
  label,
  children,
  help,
}: {
  label: string;
  children: React.ReactNode;
  help?: string;
}) {
  return (
    <div className="setting-block">
      <label>{label}</label>
      {children}
      {help ? <small className="field-help">{help}</small> : null}
    </div>
  );
}

export function NodeInspectorPane() {
  const graph = useAppStore((state) => state.graph);
  const selectedNodeId = useAppStore((state) => state.selectedNodeId);
  const updateNode = useAppStore((state) => state.updateNode);
  const harnesses = useAppStore((state) => state.harnesses);
  const harnessModels = useAppStore((state) => state.harnessModels);
  const loadHarnessModels = useAppStore((state) => state.loadHarnessModels);
  const loadHarnesses = useAppStore((state) => state.loadHarnesses);
  const validationResult = useAppStore((state) => state.validationResult);
  const save = useSaveGraph();

  const v2Graph =
    graph && isGraphV2(graph) ? (graph as GraphDefinitionV2) : undefined;
  const node =
    v2Graph && selectedNodeId
      ? (v2Graph.nodes.find((item) => item.id === selectedNodeId) as
          | GraphNode
          | undefined)
      : undefined;

  if (!v2Graph || !node) {
    return (
      <div
        className="pane pane-empty"
        data-pane="node-inspector"
        data-section="empty"
      >
        <MousePointer2 size={22} />
        <h3>No node selected</h3>
        <p>Select an agent on the canvas to edit its job, runtime, access, and authority.</p>
      </div>
    );
  }

  return (
    <div className="pane pane-scroll pane-form" data-pane="node-inspector">
      <div className="inspector-header">
        <strong>{node.name}</strong>
        <small>
          {kindBadge(node)} <span className="node-dot" /> {node.id}
        </small>
      </div>

      {"job" in node && (
        <section data-section="job">
          <h4>JOB</h4>
          <SettingBlock
            label="INSTRUCTIONS"
            help="Instructions that drive this node's harness."
          >
            <textarea
              value={"job" in node ? node.job : ""}
              onChange={(event) =>
                updateNode(node.id, { job: event.target.value })
              }
              data-job-input
            />
          </SettingBlock>
        </section>
      )}

      {"harnessId" in node && (
        <section data-section="runtime">
          <h4>RUNTIME</h4>
          <SettingBlock label="HARNESS">
            <select
              value={node.harnessId}
              onChange={(event) =>
                updateNode(node.id, {
                  harnessId: event.target.value as HarnessId,
                })
              }
            >
              {harnesses.length === 0 ? (
                <option value={node.harnessId}>{node.harnessId}</option>
              ) : (
                harnesses.map((harness) => (
                  <option
                    key={harness.id}
                    value={harness.id}
                    disabled={!harness.status.connected}
                  >
                    {harness.name} ({harness.status.connected ? "connected" : "offline"})
                  </option>
                ))
              )}
            </select>
          </SettingBlock>
          <SettingBlock label="MODEL">
            <select
              data-model-select
              value={node.modelId}
              onChange={(event) =>
                updateNode(node.id, { modelId: event.target.value })
              }
            >
              {listOptions(harnessModels[node.harnessId] ?? [])}
            </select>
            <button
              className="compact-button"
              data-refresh-models
              title="Refresh models"
              onClick={() => void loadHarnessModels(node.harnessId).catch(() => {})}
            >
              ↻
            </button>
          </SettingBlock>
          <SettingBlock label="MAX VISITS">
            <input
              type="number"
              min={1}
              value={node.maxVisits}
              onChange={(event) =>
                updateNode(node.id, {
                  maxVisits: Number(event.target.value),
                })
              }
            />
          </SettingBlock>
          <SettingBlock label="ACTIVATION">
            <select
              value={node.activation}
              onChange={(event) =>
                updateNode(node.id, {
                  activation: event.target.value as "all" | "any",
                })
              }
            >
              <option value="all">All</option>
              <option value="any">Any</option>
            </select>
          </SettingBlock>
        </section>
      )}

      {"access" in node && (
        <section data-section="access">
          <h4>ACCESS</h4>
        <SettingBlock label="MODE">
            <select
              value={node.access.mode}
              onChange={(event) =>
                updateNode(node.id, {
                  access: {
                    mode: event.target.value as "read-only" | "workspace-write",
                    writeScopes: node.access.writeScopes,
                  },
                })
              }
            >
              <option value="read-only">Read-only</option>
              <option value="workspace-write">Workspace write</option>
            </select>
          </SettingBlock>
          <SettingBlock
            label="WRITE SCOPES"
            help="Repo-relative globs that the node may edit, one per line."
          >
            <textarea
              data-write-scopes
              value={node.access.writeScopes.join("\n")}
              onChange={(event) =>
                updateNode(node.id, {
                  access: {
                    mode: node.access.mode,
                    writeScopes: event.target.value
                      .split("\n")
                      .map((line) => line.trim())
                      .filter(Boolean),
                  },
                })
              }
            />
          </SettingBlock>
        </section>
      )}

      {"authority" in node && (
        <section data-section="authority">
          <h4>AUTHORITY</h4>
          <SettingBlock label="SCOPE">
            <select
              value={node.authority.scope}
              onChange={(event) =>
                updateNode(node.id, {
                  authority: {
                    scope: event.target.value as "self" | "connected" | "group" | "graph",
                    actions: node.authority.actions,
                  },
                })
              }
            >
              <option value="self">Self</option>
              <option value="connected">Connected</option>
              <option value="group">Group</option>
              <option value="graph">Graph</option>
            </select>
          </SettingBlock>
          <div className="authority-actions">
            {PLAN_MUTATIONS.map((action) => {
              const on = node.authority.actions.includes(action);
              return (
                <button
                  key={action}
                  data-action={action}
                  type="button"
                  aria-pressed={on}
                  className={`compact-button authority-toggle ${on ? "is-on" : ""}`}
                  onClick={() => {
                    const actions = on
                      ? node.authority.actions.filter((item) => item !== action)
                      : [...new Set([...node.authority.actions, action])];
                    updateNode(node.id, {
                      authority: {
                        scope: node.authority.scope,
                        actions,
                      },
                    });
                  }}
                >
                  {action}
                </button>
              );
            })}
          </div>
        </section>
      )}

      <section data-section="routing">
        <h4>ROUTING</h4>
        {v2Graph.edges.filter((edge) => edge.source === node.id).length === 0 ? (
          <p className="field-help">No outgoing edges.</p>
        ) : (
          <ul className="edge-list">
            {v2Graph.edges
              .filter((edge) => edge.source === node.id)
              .map((edge) => (
                <li key={edge.id}>
                  <code>{edge.when}</code> → <strong>{edge.target}</strong>{" "}
                  <span className="field-help">{edge.label}</span>
                </li>
              ))}
          </ul>
        )}
      </section>

      <section data-section="failure">
        <h4>FAILURE ROUTING</h4>
        {failureRoutes(v2Graph, node).length === 0 ? (
          <p className="field-help">No failure/escalation edges leave this node.</p>
        ) : (
          <ul className="edge-list">
            {failureRoutes(v2Graph, node).map((edge) => (
              <li key={edge.id}>
                <code>{edge.when}</code> → <strong>{edge.target}</strong>{" "}
                <span className="field-help">{edge.label}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {"kind" in node && node.kind === "checkpoint" && (
        <section data-section="checkpoint">
          <h4>CHECKPOINT</h4>
          <SettingBlock label="MODE">
            <select
              value={(node as CheckpointNode).mode}
              onChange={(event) =>
                updateNode(node.id, {
                  mode: event.target.value as "automatic" | "manual",
                })
              }
            >
              <option value="automatic">Automatic</option>
              <option value="manual">Manual</option>
            </select>
          </SettingBlock>
        </section>
      )}

      {validationResult && (
        <div className="inspector-validation">
          <span>{validationResult.valid ? "Valid" : "Invalid"}</span>
          {validationResult.issues.length > 0
            ? ` — ${validationResult.issues.join("; ")}`
            : ""}
        </div>
      )}

      <div className="inspector-actions">
        <button
          className="primary-button compact-button liquid-border"
          data-action="save"
          onClick={() => void save()}
        >
          <Save size={15} /> Save version
        </button>
        <button
          className="compact-button"
          onClick={() => void loadHarnesses()}
          title="Refresh harness connections"
        >
          ↻ connections
        </button>
      </div>
    </div>
  );
}

// --- helpers ---------------------------------------------------------------

function listOptions(models: ModelOption[]) {
  if (models.length === 0) return <option value="">no models</option>;
  return models.map((model) => (
    <option key={model.id} value={model.id}>
      {model.name}
    </option>
  ));
}

function kindBadge(node: GraphNode): string {
  return (node as { kind: string }).kind.toUpperCase();
}

function failureRoutes(
  graph: GraphDefinitionV2,
  node: GraphNode,
): GraphEdge[] {
  return graph.edges.filter(
    (edge) =>
      edge.source === node.id &&
      (edge.when === "failure" || edge.kind === "escalation"),
  );
}
