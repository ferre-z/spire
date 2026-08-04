import type { GraphDefinitionV2, GraphNode, ModelOption, PlanMutation } from "../../shared/domain";
import type { HarnessStatus } from "../../shared/control";
import { useAppStore } from "../store";
import { projectTopology } from "./selectors";

const PLAN_MUTATIONS: readonly PlanMutation[] = ["retry", "skip", "reorder", "reroute", "pause", "replace", "insert", "remove", "edit"];

function Field({ label, children, hint }: { readonly label: string; readonly children: React.ReactNode; readonly hint?: string }) {
  return <label className="node-dialog-field"><span>{label}</span>{children}{hint ? <small>{hint}</small> : null}</label>;
}

function AgentSettings({ node }: {
  readonly node: Extract<GraphNode, { readonly kind: "agent" | "decision" }>;
}) {
  const updateNode = useAppStore((state) => state.updateNode);
  return <>
    <section data-section="job"><h3>JOB</h3><Field label="INSTRUCTIONS" hint="Instructions sent to this node's harness."><textarea value={node.job} onChange={(event) => updateNode(node.id, { job: event.target.value })} /></Field></section>
    <section data-section="access"><h3>ACCESS</h3><div className="node-dialog-field-grid"><Field label="MODE"><select value={node.access.mode} onChange={(event) => updateNode(node.id, { access: { ...node.access, mode: event.target.value === "workspace-write" ? "workspace-write" : "read-only" } })}><option value="read-only">Read-only</option><option value="workspace-write">Workspace write</option></select></Field><Field label="WRITE SCOPES" hint="One repo-relative glob per line."><textarea value={node.access.writeScopes.join("\n")} onChange={(event) => updateNode(node.id, { access: { ...node.access, writeScopes: event.target.value.split("\n").map((line) => line.trim()).filter(Boolean) } })} /></Field></div></section>
    <section data-section="authority"><h3>AUTHORITY</h3><Field label="SCOPE"><select value={node.authority.scope} onChange={(event) => { const scope = ["connected", "group", "graph"].includes(event.target.value) ? event.target.value : "self"; if (scope === "self" || scope === "connected" || scope === "group" || scope === "graph") updateNode(node.id, { authority: { ...node.authority, scope } }); }}><option value="self">Self</option><option value="connected">Connected</option><option value="group">Group</option><option value="graph">Graph</option></select></Field><div className="node-authority-actions">{PLAN_MUTATIONS.map((action) => { const selected = node.authority.actions.includes(action); return <button key={action} type="button" aria-pressed={selected} onClick={() => updateNode(node.id, { authority: { ...node.authority, actions: selected ? node.authority.actions.filter((item) => item !== action) : [...new Set([...node.authority.actions, action])] } })}>{action}</button>; })}</div></section>
  </>;
}

export function NodeSettings({ graph, node, harnesses, harnessModels }: {
  readonly graph: GraphDefinitionV2;
  readonly node: GraphNode;
  readonly harnesses: readonly HarnessStatus[];
  readonly harnessModels: Readonly<Record<string, readonly ModelOption[]>>;
}) {
  const updateNode = useAppStore((state) => state.updateNode);
  const routes = projectTopology(graph, node.id).outgoing;
  return <div className="node-dialog-panel-body node-settings-body">
    <section><h3>IDENTITY</h3><Field label="NAME"><input aria-label="Node name" value={node.name} onChange={(event) => updateNode(node.id, { name: event.target.value })} /></Field></section>
    {node.kind === "agent" || node.kind === "decision" ? <AgentSettings node={node} /> : null}
    {node.kind === "checkpoint" ? <section data-section="checkpoint"><h3>CHECKPOINT</h3><Field label="MODE"><select value={node.mode} onChange={(event) => updateNode(node.id, { mode: event.target.value === "automatic" ? "automatic" : "manual" })}><option value="automatic">Automatic</option><option value="manual">Manual</option></select></Field></section> : null}
    {node.kind === "subgraph" ? <section data-section="subgraph"><h3>SUBGRAPH</h3><div className="node-dialog-field-grid"><Field label="GRAPH ID"><input value={node.graphId} onChange={(event) => updateNode(node.id, { graphId: event.target.value })} /></Field><Field label="VERSION"><input type="number" min={1} value={node.graphVersion ?? ""} onChange={(event) => updateNode(node.id, { graphVersion: event.target.value ? Number(event.target.value) : undefined })} /></Field></div></section> : null}
    <section data-section="routing"><h3>ROUTING</h3>{routes.length === 0 ? <p className="node-dialog-empty">No outgoing routes.</p> : <ul className="node-dialog-list">{routes.map((edge) => <li key={edge.id}><div><strong>{edge.endpointName}</strong><code>{edge.kind}</code></div><p>{edge.label}</p><small>{edge.when}</small></li>)}</ul>}</section>
    <section data-section="failure"><h3>FAILURE ROUTING</h3>{routes.filter((edge) => edge.when === "failure" || edge.kind === "escalation").length === 0 ? <p className="node-dialog-empty">No failure or escalation routes.</p> : <ul className="node-dialog-list">{routes.filter((edge) => edge.when === "failure" || edge.kind === "escalation").map((edge) => <li key={edge.id}><strong>{edge.endpointName}</strong><small>{edge.label}</small></li>)}</ul>}</section>
  </div>;
}
