import { MessageCircle, Send, RefreshCw } from "lucide-react";
import React from "react";
import { useAppStore } from "../store";

/**
 * Collaboration pane: read-only view of the selected run's Markdown-handoff
 * conversation plus a small composer to send a message on the runner's behalf.
 * The pane is a pure reader/writer over the store; the store owns the
 * paginated `runs.messages.list` / `runs.messages.send` control calls.
 */
export function CollaborationPane() {
  const selectedRunId = useAppStore((state) => state.selectedRunId);
  const selectedNodeId = useAppStore((state) => state.selectedNodeId);
  const messages = useAppStore((state) => state.messages);
  const messagesLoading = useAppStore((state) => state.messagesLoading);
  const messagesHasMore = useAppStore((state) => state.messagesHasMore);
  const loadMessages = useAppStore((state) => state.loadMessages);
  const sendMessage = useAppStore((state) => state.sendMessage);
  const setBusy = useAppStore((state) => state.setBusy);
  const setError = useAppStore((state) => state.setError);

  if (!selectedRunId) {
    return (
      <div className="pane pane-empty" data-pane="collaboration">
        <MessageCircle size={22} />
        <h3>No run selected</h3>
        <p>Select a run to view its collaboration messages.</p>
      </div>
    );
  }

  return (
    <div className="pane pane-column" data-pane="collaboration">
      <header className="pane-header">
        <h2>Collaboration</h2>
        <button
          className="compact-button"
          title="Refresh messages"
          onClick={() => void loadMessages()}
        >
          <RefreshCw size={14} />
        </button>
      </header>

      <ul className="message-list">
        {messages.map((message) => (
          <li key={message.id} className="message-item">
            <div className="message-meta">
              <strong>{message.senderNodeId}</strong>
              <code>{message.kind}</code>
              <span>{new Date(message.createdAt).toLocaleTimeString()}</span>
            </div>
            <div className="message-subject">{message.subject}</div>
            {message.body ? <p className="message-body">{message.body}</p> : null}
          </li>
        ))}
      </ul>

      {messagesHasMore && (
        <button
          className="compact-button"
          disabled={messagesLoading}
          onClick={() => void loadMessages()}
        >
          Load older
        </button>
      )}

      <MessageComposer
        selectedNodeId={selectedNodeId}
        submitting={messagesLoading}
        onSubmit={async (draft) => {
          setBusy(true);
          try {
            await sendMessage(draft);
          } catch (error) {
            setError(error instanceof Error ? error.message : String(error));
          } finally {
            setBusy(false);
          }
        }}
      />
    </div>
  );
}

function MessageComposer({
  selectedNodeId,
  submitting,
  onSubmit,
}: {
  selectedNodeId?: string;
  submitting: boolean;
  onSubmit: (draft: {
    recipient: { kind: "node"; id: string };
    kind: "handoff" | "question" | "report" | "decision";
    subject: string;
    body: string;
    artifactPaths: string[];
  }) => Promise<void>;
}) {
  const [subject, setSubject] = React.useState("");
  const [body, setBody] = React.useState("");

  return (
    <form
      className="message-compose"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!subject || !body) return;
        await onSubmit({
          recipient: { kind: "node", id: selectedNodeId ?? "planner" },
          kind: "handoff",
          subject,
          body,
          artifactPaths: [],
        });
        setSubject("");
        setBody("");
      }}
    >
      <input
        data-message-subject
        value={subject}
        placeholder="Subject"
        onChange={(event) => setSubject(event.target.value)}
      />
      <textarea
        data-message-body
        value={body}
        placeholder="Message…"
        onChange={(event) => setBody(event.target.value)}
      />
      <button className="primary-button compact-button" type="submit" disabled={submitting}>
        <Send size={14} /> Send
      </button>
    </form>
  );
}
