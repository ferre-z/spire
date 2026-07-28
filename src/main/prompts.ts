import type {
  GraphDefinition,
  ImplementationReport,
  ReviewVerdict,
  TaskBrief,
} from "../shared/domain";

export const jsonOnly = (schema: string): string => `
Return only valid JSON. Do not wrap it in Markdown or add commentary.
The JSON must match this schema:
${schema}`;

export function plannerSystem(graph: GraphDefinition): string {
  const planner = graph.nodes.find((node) => node.role === "planner")!;
  return `${planner.instructions}

You are the planning and review node in a bounded two-agent coding graph.
Never modify files. Inspect the repository carefully and ground claims in evidence.`;
}

export function implementationSystem(graph: GraphDefinition): string {
  const implementer = graph.nodes.find((node) => node.role === "implementer")!;
  return `${implementer.instructions}

You are the implementation node in a bounded coding graph.
Work only inside the provided repository. Implement the brief, run relevant
validation, and leave all changes uncommitted. Never push to a remote.`;
}

export function planningPrompt(goal: string): string {
  return `Analyze this repository and prepare an implementation brief for:

${goal}

Keep the scope achievable in one coding pass. Include objective acceptance
checks that a reviewer can verify.

${jsonOnly(`{
  "goal": "string",
  "constraints": ["string"],
  "acceptanceChecks": ["string"],
  "implementationNotes": ["string"]
}`)}`;
}

export function implementationPrompt(
  brief: TaskBrief,
  feedback: string[],
): string {
  return `Implement this task brief:

${JSON.stringify(brief, null, 2)}

${
  feedback.length
    ? `The previous review requested these changes:\n${feedback.map((item) => `- ${item}`).join("\n")}`
    : "This is the first implementation attempt."
}

After editing and validating the repository, report the result.

${jsonOnly(`{
  "summary": "string",
  "changedFiles": ["string"],
  "validations": [{"command": "string", "status": "passed|failed|unknown"}],
  "blockers": ["string"]
}`)}`;
}

export function reviewPrompt(
  brief: TaskBrief,
  implementation: ImplementationReport,
  diff: string,
): string {
  return `Review the current repository state against the task brief.
Inspect files and run focused checks when useful. Do not edit anything.

TASK BRIEF
${JSON.stringify(brief, null, 2)}

IMPLEMENTER REPORT
${JSON.stringify(implementation, null, 2)}

CURRENT GIT DIFF
${diff || "(No tracked diff was produced.)"}

Accept only when the acceptance checks are genuinely satisfied. Otherwise,
provide concrete feedback for the next implementation iteration.

${jsonOnly(`{
  "decision": "accepted|needs_changes",
  "evidence": ["string"],
  "feedback": ["string"]
}`)}`;
}

export function repairPrompt(schemaName: string, invalid: string): string {
  return `Your previous response was not valid ${schemaName} JSON.
Return the same answer again as raw valid JSON only, with every required field.
Do not use Markdown.

Previous response:
${invalid.slice(0, 6000)}`;
}

export function parseJson<T>(
  text: string,
  parser: { parse(value: unknown): T },
): T {
  const trimmed = text.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  return parser.parse(JSON.parse(withoutFence));
}

export type StructuredOutput = TaskBrief | ImplementationReport | ReviewVerdict;
