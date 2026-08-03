import { ArrowDownToLine, ArrowUpFromLine, FileOutput, MessageSquareText } from "lucide-react";
import type { CollaborationMessage } from "../../shared/collaboration";
import type { GraphDefinitionV2 } from "../../shared/domain";
import type { NodeExecution } from "../../shared/execution";
import { projectExecution, projectMessages, projectTopology } from "./selectors";

function EmptyState({ children }: { readonly children: React.ReactNode }) {
  return <p className="node-dialog-empty">{children}</p>;
}

function MessageList({ messages }: { readonly messages: readonly CollaborationMessage[] }) {
  if (messages.length === 0) return <EmptyState>No messages.</EmptyState>;
  return (
    <ul className="node-dialog-list">
      {messages.map((message) => (
        <li key={message.id}>
          <div><strong>{message.subject}</strong><code>{message.kind}</code></div>
          <p>{message.body || "No message body."}</p>
          {message.artifactPaths.length > 0 ? <small>{message.artifactPaths.join(", ")}</small> : null}
        </li>
      ))}
    </ul>
  );
}

export function InputPanel({ graph, nodeId, messages }: {
  readonly graph: GraphDefinitionV2;
  readonly nodeId: string;
  readonly messages: readonly CollaborationMessage[];
}) {
  const topology = projectTopology(graph, nodeId);
  const projectedMessages = projectMessages(messages, nodeId);
  return (
    <div className="node-dialog-panel-body">
      <section>
        <h3><ArrowDownToLine size={16} /> Incoming edges</h3>
        {topology.incoming.length === 0 ? <EmptyState>No incoming edges.</EmptyState> : (
          <ul className="node-dialog-list">
            {topology.incoming.map((edge) => (
              <li key={edge.id}>
                <div><strong>{edge.endpointName}</strong><code>{edge.kind}</code></div>
                <p>{edge.label}</p><small>Condition: {edge.when}</small>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h3><MessageSquareText size={16} /> Received messages</h3>
        <MessageList messages={projectedMessages.received} />
      </section>
    </div>
  );
}

function ExecutionSummary({ execution }: { readonly execution?: NodeExecution }) {
  if (!execution) return <EmptyState>No execution recorded for the selected run.</EmptyState>;
  return (
    <div className="node-execution-summary">
      <dl>
        <div><dt>Status</dt><dd>{execution.status}</dd></div>
        <div><dt>Visits</dt><dd>{execution.visits}</dd></div>
      </dl>
      {execution.outcome ? (
        <div className="node-outcome">
          <strong>{execution.outcome.status}</strong>
          <p>{execution.outcome.summary || "No outcome summary."}</p>
          {execution.outcome.artifacts.length > 0 ? (
            <ul>{execution.outcome.artifacts.map((artifact) => <li key={artifact.path}><FileOutput size={14} /> {artifact.name} <code>{artifact.path}</code></li>)}</ul>
          ) : <EmptyState>No execution artifacts.</EmptyState>}
        </div>
      ) : <EmptyState>No outcome yet.</EmptyState>}
      {execution.error ? <p className="node-dialog-error" role="alert">{execution.error}</p> : null}
    </div>
  );
}

export function OutputPanel({ graph, nodeId, messages, executions }: {
  readonly graph: GraphDefinitionV2;
  readonly nodeId: string;
  readonly messages: readonly CollaborationMessage[];
  readonly executions: readonly NodeExecution[];
}) {
  const topology = projectTopology(graph, nodeId);
  const projectedMessages = projectMessages(messages, nodeId);
  return (
    <div className="node-dialog-panel-body">
      <section>
        <h3><ArrowUpFromLine size={16} /> Outgoing edges</h3>
        {topology.outgoing.length === 0 ? <EmptyState>No outgoing edges.</EmptyState> : (
          <ul className="node-dialog-list">
            {topology.outgoing.map((edge) => (
              <li key={edge.id}>
                <div><strong>{edge.endpointName}</strong><code>{edge.kind}</code></div>
                <p>{edge.label}</p><small>Condition: {edge.when}</small>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section><h3><MessageSquareText size={16} /> Authored messages</h3><MessageList messages={projectedMessages.authored} /></section>
      <section><h3>Execution</h3><ExecutionSummary execution={projectExecution(executions, nodeId)} /></section>
    </div>
  );
}
