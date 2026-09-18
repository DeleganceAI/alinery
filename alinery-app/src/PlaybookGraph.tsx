import { ArrowRight } from "lucide-react";
import type { NormalizedStep } from "./types";

/** The same literal-plus-one-star language as core; source order is not an edge. */
export function selectorsOverlap(left: string, right: string): boolean {
  const split = (path: string) => {
    const slash = path.lastIndexOf("/");
    const name = path.slice(slash + 1);
    const star = name.indexOf("*");
    return { directory: path.slice(0, slash + 1), prefix: star < 0 ? name : name.slice(0, star), suffix: star < 0 ? "" : name.slice(star + 1), wildcard: star >= 0 };
  };
  const a = split(left);
  const b = split(right);
  if (a.directory !== b.directory) return false;
  if (!a.wildcard && !b.wildcard) return a.prefix === b.prefix;
  if (a.wildcard && b.wildcard) return (a.prefix.startsWith(b.prefix) || b.prefix.startsWith(a.prefix)) && (a.suffix.endsWith(b.suffix) || b.suffix.endsWith(a.suffix));
  const pattern = a.wildcard ? a : b;
  const exact = a.wildcard ? b.prefix : a.prefix;
  return exact.length >= pattern.prefix.length + pattern.suffix.length && exact.startsWith(pattern.prefix) && exact.endsWith(pattern.suffix);
}

export function PlaybookGraph({ title, steps, countsByStep = {}, selectedAutoAdvance = [] }: {
  title: string; steps: NormalizedStep[]; countsByStep?: Record<string, number>; selectedAutoAdvance?: string[];
}) {
  const edges = steps.flatMap((producer) => steps.flatMap((consumer) => consumer.inputs.flatMap((input) =>
    producer.outputs.filter((output) => selectorsOverlap(output.path, input.path)).map((output) => ({ from: producer, to: consumer, input, output }))
  )));
  return <section className="playbook-graph-view" aria-label={`${title} graph`}>
    <div className="playbook-graph-title">{title}</div>
    <div className="playbook-chain" aria-label="Graph steps">
      {steps.map((step) => <div className={`playbook-node${countsByStep[step.key] ? " solid" : " future"}`} key={step.key}>
        <div className="playbook-node-main"><span className="playbook-node-key">{step.short || step.key}</span><span className="playbook-node-title">{step.title}</span></div>
        <span aria-label={`${step.title}: ${countsByStep[step.key] ?? 0} active sessions`}>{countsByStep[step.key] ?? 0} active</span>
        {selectedAutoAdvance.includes(step.key) && <span title="Completion automatically authorized">Automatic</span>}
      </div>)}
    </div>
    <ul aria-label="Artifact dependencies">
      {edges.map(({ from, to, input, output }) => <li key={`${from.key}:${output.path}:${to.key}:${input.path}`} aria-label={`${from.title} to ${to.title}: ${input.mode}`}>
        <span>{from.title}</span> <ArrowRight size={12} aria-hidden="true" /> <span>{to.title}</span>
        <code>{output.path} → {input.path}</code> <span>({input.mode})</span>
      </li>)}
    </ul>
  </section>;
}
