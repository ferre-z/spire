import { useCallback, useState, type ReactNode } from "react";
import { Bot, Box, CircleCheck, FolderGit2, GitBranch, LoaderCircle } from "lucide-react";
import { nanoid } from "nanoid";
import type {
  GraphDefinitionV2,
  GraphNode,
  HarnessId,
  ModelOption,
  NodeKind,
} from "../../shared/domain";
import type { HarnessStatus } from "../../shared/control";
import { useAppStore } from "../store";

const HARNESS_PRIORITY: readonly HarnessId[] = ["opencode", "codex", "claude-code"];

export type PaletteItem = {
  readonly kind: NodeKind | "group";
  readonly label: string;
  readonly icon: ReactNode;
};

export const PALETTE_ITEMS = [
  { kind: "agent", label: "Agent", icon: <Bot size={16} /> },
  { kind: "decision", label: "Decision", icon: <GitBranch size={16} /> },
  { kind: "checkpoint", label: "Checkpoint", icon: <CircleCheck size={16} /> },
  { kind: "subgraph", label: "Subgraph", icon: <FolderGit2 size={16} /> },
  { kind: "group", label: "Group", icon: <Box size={16} /> },
] as const satisfies readonly PaletteItem[];

type RuntimeChoice = {
  readonly kind: "ready";
  readonly harnessId: HarnessId;
  readonly modelId: string;
};

type RuntimeUnavailable = {
  readonly kind: "unavailable";
  readonly message: string;
};

export type DefaultRuntimeResult = RuntimeChoice | RuntimeUnavailable;

type LoadHarnessModels = (harnessId: HarnessId) => Promise<readonly ModelOption[]>;

export async function resolveDefaultRuntime(
  harnesses: readonly HarnessStatus[],
  cachedModels: Readonly<Record<string, readonly ModelOption[]>>,
  loadHarnessModels: LoadHarnessModels,
): Promise<DefaultRuntimeResult> {
  for (const harnessId of HARNESS_PRIORITY) {
    const harness = harnesses.find((candidate) => candidate.id === harnessId);
    if (
      !harness?.status.installed ||
      !harness.status.compatible ||
      !harness.status.connected
    ) {
      continue;
    }

    try {
      const models = cachedModels[harnessId] ?? await loadHarnessModels(harnessId);
      const model = models[0];
      if (model) return { kind: "ready", harnessId, modelId: model.id };
    } catch (error) {
      if (error instanceof Error) {
        return {
          kind: "unavailable",
          message: "Could not load harness models. Open Harnesses to retry the connection.",
        };
      }
      throw error;
    }
  }

  return {
    kind: "unavailable",
    message: "No connected harness with models is ready. Open Harnesses to connect one and discover models.",
  };
}

function createNodeTemplate(
  kind: NodeKind,
  graph: GraphDefinitionV2,
  runtime?: RuntimeChoice,
): GraphNode | undefined {
  const id = nanoid();
  const position = { x: 100, y: 100 };
  switch (kind) {
    case "agent":
    case "decision": {
      if (!runtime) return undefined;
      return {
        kind,
        id,
        name: kind === "agent" ? "Agent" : "Decision",
        job: kind === "agent" ? "Describe the agent's job" : "Evaluate options and select a path",
        harnessId: runtime.harnessId,
        modelId: runtime.modelId,
        access: { mode: "read-only", writeScopes: [] },
        authority: { scope: "self", actions: [] },
        activation: "all",
        maxVisits: kind === "agent" ? 3 : 1,
        position,
      };
    }
    case "checkpoint":
      return { kind, id, name: "Checkpoint", mode: "automatic", position };
    case "subgraph":
      return { kind, id, name: "Subgraph", graphId: graph.id, position };
  }
}

function isRuntimeKind(kind: PaletteItem["kind"]): kind is "agent" | "decision" {
  return kind === "agent" || kind === "decision";
}

export function GraphCanvasPalette({ graph }: { readonly graph: GraphDefinitionV2 }) {
  const harnesses = useAppStore((state) => state.harnesses);
  const harnessModels = useAppStore((state) => state.harnessModels);
  const loadHarnessModels = useAppStore((state) => state.loadHarnessModels);
  const addNode = useAppStore((state) => state.addNode);
  const addGroup = useAppStore((state) => state.addGroup);
  const setError = useAppStore((state) => state.setError);
  const [loadingKind, setLoadingKind] = useState<"agent" | "decision">();

  const handleAdd = useCallback(async (item: PaletteItem) => {
    if (item.kind === "group") {
      addGroup({ id: `group-${nanoid(6)}`, name: "Group" });
      return;
    }
    if (!isRuntimeKind(item.kind)) {
      const node = createNodeTemplate(item.kind, graph);
      if (node) addNode(node);
      return;
    }

    setLoadingKind(item.kind);
    const runtime = await resolveDefaultRuntime(
      harnesses,
      harnessModels,
      loadHarnessModels,
    );
    if (runtime.kind === "unavailable") {
      setError(runtime.message);
      setLoadingKind(undefined);
      return;
    }
    const node = createNodeTemplate(item.kind, graph, runtime);
    if (node) addNode(node);
    setError(undefined);
    setLoadingKind(undefined);
  }, [addGroup, addNode, graph, harnessModels, harnesses, loadHarnessModels, setError]);

  return (
    <div
      className="node-tool-cluster"
      role="toolbar"
      aria-label="Add graph node"
      aria-busy={loadingKind !== undefined}
    >
      {PALETTE_ITEMS.map((item) => {
        const loading = loadingKind === item.kind;
        const disabled = isRuntimeKind(item.kind) && loadingKind !== undefined;
        return (
          <button
            key={item.kind}
            type="button"
            className="node-tool-button"
            aria-label={`Add ${item.label}`}
            aria-busy={loading}
            title={`Add ${item.label}`}
            disabled={disabled}
            onClick={() => void handleAdd(item)}
          >
            {loading ? <LoaderCircle className="spin" size={16} /> : item.icon}
          </button>
        );
      })}
    </div>
  );
}
