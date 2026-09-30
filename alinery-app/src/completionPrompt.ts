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
  const destination = next.length === 1 ? next[0].title : "the next steps";
  return {
    action: next.length ? `Ready to move on to ${destination}?` : `Ready to finish ${step?.title ?? "this step"}?`,
    detail: `Alinery will check the required outputs, then end this session.${next.length ? " Following steps start in new sessions when their inputs are ready." : ""} To make changes first, continue working here and send the agent a message.`,
    scope: step ? `Current step: ${step.title}${next.length ? ` · Following: ${next.map((candidate) => candidate.title).join(", ")}` : ""}` : undefined,
    allowLabel: next.length ? `Move to ${next.length === 1 ? next[0].title : "next steps"}` : "Finish step",
    denyLabel: "Continue working in this session",
  };
}
