import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { CollaborationMessage } from "../../shared/collaboration";
import type { AgentNode, DecisionNode } from "../../shared/domain";

/**
 * App-managed Markdown collaboration space for a run.
 *
 * Lives at `<userData>/runs/<runId>/collaboration/` — deliberately outside the
 * run's Git worktree so agent communication never shows up in `git status` or
 * leaks into diffs. Layout:
 *
 *   inbox/<node>.md          append-only per-node inbox (all delivered kinds)
 *   handoffs/                one document per handoff message
 *   decisions/               one document per decision message
 *   reports/                 one document per report message
 *   checkpoints/             one document per checkpoint pass
 *   index.md                 chronological index of every document
 *
 * Document filenames are deterministic (`<seq>-<sender>-<subject-slug>.md`)
 * and sanitized, so namespaced node ids (`S/p`) and hostile subjects can
 * never escape the workspace. Everything is append-only: a fresh instance
 * over the same directory (app restart) keeps reading prior inboxes and
 * continues document numbering.
 */

export type CollaborationNodeInfo = {
  id: string;
  name: string;
  groupId?: string;
};

export type CollaborationEdgeInfo = {
  source: string;
  target: string;
};

export type CollaborationWorkspaceOptions = {
  /** Electron userData root; the workspace lives under runs/<runId>/. */
  userDataDir: string;
  runId: string;
  /** Run objective, quoted at the top of every context packet. */
  goal: string;
  /** Compiled graph nodes (for group fan-out). */
  nodes: CollaborationNodeInfo[];
  /** Compiled graph edges (for successors fan-out). */
  edges: CollaborationEdgeInfo[];
};

export type ContextPacketPredecessor = {
  nodeId: string;
  name: string;
  status: string;
  summary?: string;
  artifacts?: Array<{ name: string; path: string; mediaType?: string }>;
};

export type ContextPacketInput = {
  node: AgentNode | DecisionNode;
  /** Where the harness will run (integration worktree or node worktree). */
  directory: string;
  /** Latest outcomes of nodes with an edge into this node. */
  predecessors: ContextPacketPredecessor[];
};

/** Message kinds that get a standalone append-only document. */
const DOCUMENT_KINDS = {
  handoff: "handoffs",
  decision: "decisions",
  report: "reports",
} as const;

/**
 * Map an arbitrary id/subject to a flat, traversal-safe filename segment.
 * Anything outside [A-Za-z0-9._-] collapses to a dash; dot-only or empty
 * results are replaced so `..` can never survive.
 */
export function safeSegment(input: string): string {
  const cleaned = input
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .replace(/-{2,}/g, "-");
  return cleaned.length > 0 ? cleaned : "item";
}

function slug(input: string, max = 48): string {
  const segment = safeSegment(input.toLowerCase());
  return segment.length > max ? segment.slice(0, max).replace(/[.-]+$/g, "") : segment;
}

function pad(sequence: number): string {
  return String(sequence).padStart(6, "0");
}

function artifactLinks(paths: string[]): string {
  if (paths.length === 0) return "";
  return `\nArtifacts:\n${paths.map((p) => `- [${p}](${p})`).join("\n")}\n`;
}

export class CollaborationWorkspace {
  readonly root: string;
  private readonly goal: string;
  private readonly nodes: CollaborationNodeInfo[];
  private readonly edges: CollaborationEdgeInfo[];

  constructor(options: CollaborationWorkspaceOptions) {
    this.root = path.join(
      options.userDataDir,
      "runs",
      options.runId,
      "collaboration",
    );
    this.goal = options.goal;
    this.nodes = options.nodes;
    this.edges = options.edges;
  }

  /**
   * Deliver a persisted message: append it to every resolved recipient's
   * inbox, write a standalone document for handoff/decision/report kinds,
   * and append to the chronological index. Returns document paths written
   * (empty for questions, which are inbox-only).
   */
  async deliver(message: CollaborationMessage): Promise<string[]> {
    const recipients = this.resolveRecipients(message);
    await this.ensureLayout();
    const written: string[] = [];
    let documentLink: string | undefined;

    const directory =
      DOCUMENT_KINDS[message.kind as keyof typeof DOCUMENT_KINDS];
    if (directory) {
      const filename = `${pad(message.sequence)}-${safeSegment(message.senderNodeId)}-${slug(message.subject)}.md`;
      const documentPath = path.join(this.root, directory, filename);
      const to = recipients.length > 0 ? recipients.join(", ") : "(none)";
      const content =
        `# ${message.kind}: ${message.subject}\n\n` +
        `- From: ${message.senderNodeId}\n` +
        `- To: ${to}\n` +
        `- Sequence: ${message.sequence}\n` +
        `- At: ${message.createdAt}\n\n` +
        `${message.body}\n` +
        artifactLinks(message.artifactPaths);
      await appendFile(documentPath, content, "utf8");
      written.push(documentPath);
      documentLink = `${directory}/${filename}`;
    }

    const entry =
      `\n## [${pad(message.sequence)}] ${message.kind} from ${message.senderNodeId}: ${message.subject}\n\n` +
      `${message.createdAt}\n\n` +
      `${message.body}\n` +
      (documentLink ? `\nDocument: [${documentLink}](../${documentLink})\n` : "") +
      artifactLinks(message.artifactPaths);
    for (const recipient of recipients) {
      await appendFile(
        path.join(this.root, "inbox", `${safeSegment(recipient)}.md`),
        entry,
        "utf8",
      );
    }

    await this.appendIndex(
      `- [${pad(message.sequence)}] ${message.kind} ${message.senderNodeId} → ${recipients.join(", ") || "(none)"}: ` +
        (documentLink
          ? `[${message.subject}](${documentLink})`
          : `${message.subject} (inbox only)`) +
        ` — ${message.createdAt}\n`,
    );
    return written;
  }

  /** Append a checkpoint-pass document and index it. */
  async recordCheckpoint(input: {
    nodeId: string;
    name: string;
    summary: string;
  }): Promise<string> {
    await this.ensureLayout();
    const sequence = await this.nextCheckpointSequence();
    const filename = `${pad(sequence)}-${safeSegment(input.nodeId)}-passed.md`;
    const documentPath = path.join(this.root, "checkpoints", filename);
    const at = new Date().toISOString();
    await appendFile(
      documentPath,
      `# checkpoint: ${input.name} passed\n\n` +
        `- Node: ${input.nodeId}\n` +
        `- At: ${at}\n\n` +
        `${input.summary}\n`,
      "utf8",
    );
    await this.appendIndex(
      `- [c${pad(sequence)}] checkpoint ${input.nodeId}: [${input.name} passed](checkpoints/${filename}) — ${at}\n`,
    );
    return documentPath;
  }

  /**
   * Assemble the Markdown context packet for a node attempt: run objective,
   * node job, working directory and accessible repository paths, authority,
   * this node's incoming messages (read back from its inbox, so packets are
   * complete again after an app restart), and relevant predecessor outputs.
   */
  async buildContextPacket(input: ContextPacketInput): Promise<string> {
    const { node } = input;
    const sections: string[] = [];
    sections.push(`# Context for ${node.name} (${node.id})`);
    sections.push(`## Run objective\n\n${this.goal}`);
    sections.push(`## Your job\n\n${node.job}`);
    sections.push(`## Goal\n\n${node.goal || this.goal || "(none set)"}`);
    if (node.subGoals.length > 0) {
      sections.push(
        `## Sub-goals\n\n${node.subGoals.map((sub) => `- ${sub.trim()}`).join("\n")}`,
      );
    }
    if (node.skills.length > 0) {
      sections.push(
        `## Skills\n\n${node.skills.map((skill) => `- ${skill}`).join("\n")}`,
      );
    }
    sections.push(`## Thinking effort\n\n${node.thinkingEffort}`);

    const access =
      node.access.mode === "workspace-write"
        ? `workspace-write — you may modify only the write scopes below.`
        : `read-only — do not modify the repository.`;
    sections.push(`## Working directory\n\n${input.directory}\n\nAccess: ${access}`);

    const writeLines =
      node.access.mode === "workspace-write"
        ? node.access.writeScopes.length > 0
          ? node.access.writeScopes.map((scope) => `- write: ${scope}`)
          : ["- write: (nothing — no write scopes granted)"]
        : ["- write: (none — read-only node)"];
    sections.push(
      `## Accessible repository paths\n\n- read: ${input.directory}\n${writeLines.join("\n")}`,
    );

    const actions =
      node.authority.actions.length > 0
        ? node.authority.actions.join(", ")
        : "none";
    sections.push(
      `## Authority\n\nScope: ${node.authority.scope}\nActions: ${actions}`,
    );

    const inbox = await this.readInbox(node.id);
    sections.push(
      `## Incoming messages\n\n${inbox ?? "No messages yet."}`,
    );

    const outputs = input.predecessors.map((predecessor) => {
      const lines = [`### ${predecessor.name} (${predecessor.nodeId}) — ${predecessor.status}`];
      if (predecessor.summary) lines.push(predecessor.summary);
      for (const artifact of predecessor.artifacts ?? []) {
        lines.push(`- [${artifact.name}](${artifact.path})`);
      }
      return lines.join("\n");
    });
    sections.push(
      `## Relevant outputs\n\n${outputs.length > 0 ? outputs.join("\n\n") : "No predecessor outputs."}`,
    );
    return sections.join("\n\n");
  }

  // --- Internals ------------------------------------------------------------

  private resolveRecipients(message: CollaborationMessage): string[] {
    const recipient = message.recipient;
    switch (recipient.kind) {
      case "node":
        return [recipient.id];
      case "group":
        return this.nodes
          .filter((node) => node.groupId === recipient.id)
          .map((node) => node.id);
      case "successors":
        return this.edges
          .filter((edge) => edge.source === message.senderNodeId)
          .map((edge) => edge.target);
    }
  }

  private async ensureLayout(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(path.join(this.root, "inbox"), { recursive: true });
    for (const directory of Object.values(DOCUMENT_KINDS)) {
      await mkdir(path.join(this.root, directory), { recursive: true });
    }
    await mkdir(path.join(this.root, "checkpoints"), { recursive: true });
  }

  private async appendIndex(line: string): Promise<void> {
    const indexPath = path.join(this.root, "index.md");
    try {
      await readFile(indexPath, "utf8");
    } catch {
      await appendFile(indexPath, `# Collaboration index\n\n`, "utf8");
    }
    await appendFile(indexPath, line, "utf8");
  }

  private async readInbox(nodeId: string): Promise<string | undefined> {
    try {
      const content = await readFile(
        path.join(this.root, "inbox", `${safeSegment(nodeId)}.md`),
        "utf8",
      );
      return content.trim().length > 0 ? content.trim() : undefined;
    } catch {
      return undefined;
    }
  }

  /** Next checkpoint document number, derived from what is already on disk. */
  private async nextCheckpointSequence(): Promise<number> {
    try {
      const existing = await readdir(path.join(this.root, "checkpoints"));
      return existing.filter((name) => name.endsWith(".md")).length;
    } catch {
      return 0;
    }
  }
}
