import { useState } from "react";
import { X } from "lucide-react";
import type { GraphNode, ThinkingEffort } from "../../shared/domain";
import { harnessIdSchema } from "../../shared/domain";
import { useAppStore } from "../store";
import { ModelComboBox } from "./ModelComboBox";

const EFFORTS: readonly ThinkingEffort[] = ["low", "medium", "high"];

function isAgentLike(node: GraphNode): node is Extract<GraphNode, { readonly kind: "agent" | "decision" }> {
  return node.kind === "agent" || node.kind === "decision";
}

export function BrainTab({ node }: { readonly node: GraphNode }) {
  const updateNode = useAppStore((state) => state.updateNode);
  const changeNodeHarness = useAppStore((state) => state.changeNodeHarness);
  const harnesses = useAppStore((state) => state.harnesses);
  const [harnessChanging, setHarnessChanging] = useState(false);
  const [skillInput, setSkillInput] = useState("");

  if (!isAgentLike(node)) {
    return <p className="node-dialog-empty">Only agent and decision nodes have a brain.</p>;
  }

  const onHarnessChange = async (value: string): Promise<void> => {
    const parsed = harnessIdSchema.safeParse(value);
    if (!parsed.success) return;
    setHarnessChanging(true);
    await changeNodeHarness(node.id, parsed.data);
    setHarnessChanging(false);
  };

  const addSkill = (): void => {
    const trimmed = skillInput.trim();
    if (!trimmed) return;
    const next = node.skills.some((skill) => skill.toLowerCase() === trimmed.toLowerCase())
      ? node.skills
      : [...node.skills, trimmed];
    updateNode(node.id, { skills: next });
    setSkillInput("");
  };

  const effortIndex = EFFORTS.indexOf(node.thinkingEffort);

  return (
    <section data-section="brain">
      <h3>BRAIN</h3>
      <div className="node-dialog-field-grid">
        <label className="node-dialog-field"><span>HARNESS</span><select aria-label="Harness" disabled={harnessChanging} value={node.harnessId} onChange={(event) => void onHarnessChange(event.target.value)}>{harnesses.length === 0 ? <option value={node.harnessId}>{node.harnessId}</option> : harnesses.map((harness) => <option key={harness.id} value={harness.id} disabled={!harness.status.connected}>{harness.name} · {harness.status.connected ? "connected" : "offline"}</option>)}</select></label>
        <label className="node-dialog-field"><span>MODEL</span><ModelComboBox harnessId={node.harnessId} modelId={node.modelId} onChange={(id) => updateNode(node.id, { modelId: id })} /></label>
        <label className="node-dialog-field"><span>THINKING EFFORT</span><input type="range" min={0} max={2} step={1} data-thinking-effort aria-label="Thinking effort" value={effortIndex} onChange={(event) => updateNode(node.id, { thinkingEffort: EFFORTS[Number(event.target.value)] as ThinkingEffort })} /><div className="node-effort-segments">{EFFORTS.map((effort, index) => <span key={effort} data-active={index === effortIndex || undefined}>{effort}</span>)}</div><small>{node.thinkingEffort}</small></label>
        <label className="node-dialog-field"><span>ACTIVATION</span><select aria-label="Activation" value={node.activation} onChange={(event) => updateNode(node.id, { activation: event.target.value === "any" ? "any" : "all" })}><option value="all">All inputs</option><option value="any">Any input</option></select></label>
        <label className="node-dialog-field"><span>MAX VISITS</span><input type="number" aria-label="Max visits" min={1} value={node.maxVisits} onChange={(event) => updateNode(node.id, { maxVisits: Number(event.target.value) })} /></label>
      </div>
      <div className="node-dialog-field"><span>SKILLS</span><ul className="node-skill-list">{node.skills.map((skill) => <li key={skill} className="node-skill-row" data-skill-row><span>{skill}</span><button type="button" data-skill-remove aria-label={`Remove skill ${skill}`} title={`Remove ${skill}`} onClick={() => updateNode(node.id, { skills: node.skills.filter((item) => item !== skill) })}><X size={14} /></button></li>)}</ul><div className="node-skill-add"><input data-skill-input value={skillInput} placeholder="Add a skill…" onChange={(event) => setSkillInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addSkill(); } }} /><button type="button" data-skill-add onClick={addSkill}>Add</button></div></div>
    </section>
  );
}