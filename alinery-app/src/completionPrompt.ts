import type { ChatEntry } from "./chat/types";
import { selectorsOverlap } from "./PlaybookGraph";
import { reduceFlowConnections } from "./playbookGraphLayout";
import type { ExecutionRecord, NormalizedPlaybook } from "./types";

export function completionPrompt(
  definition: NormalizedPlaybook | undefined,
  execution: ExecutionRecord | undefined,
): Pick<Extract<ChatEntry, { type: "approval" }>, "action" | "detail" | "scope" | "allowLabel" | "denyLabel"> {
  const step = definition?.step.find((candidate) => candidate.key === execution?.candidate.step_key);
  // Definition order is not execution order. Reuse the graph's dependency reduction;
  // these are following steps, not a promise that their other inputs are ready.
  const connections =
    definition && step && !execution?.candidate.manual
      ? reduceFlowConnections(
          definition.step.flatMap((from) =>
            definition.step
              .filter((to) => from.outputs.some((output) => to.inputs.some((input) => selectorsOverlap(output.path, input.path))))
              .map((to) => ({ from: from.key, to: to.key })),
          ),
        )
      : [];
  const next = definition?.step.filter((candidate) => connections.some((edge) => edge.from === step?.key && edge.to === candidate.key)) ?? [];
  return {
    action: "Ready to finish this step?",
    detail: `Allowing completion lets Alinery validate the assigned publications, requiring at least one valid artifact overall and rejecting invalid present outputs; individual outputs may be omitted. Accepted completion ends this session.${next.length ? " Only following steps whose inputs are satisfied by accepted publications can start, after this session exits." : ""} This permission does not waive the step's work or substantive decisions. To make changes first, continue working here and send the agent a message.`,
    scope: step ? `Current step: ${step.title}${next.length ? ` · Possible following steps: ${next.map((candidate) => candidate.title).join(", ")}` : ""}` : undefined,
    allowLabel: "Finish step",
    denyLabel: "Continue working in this session",
  };
}
