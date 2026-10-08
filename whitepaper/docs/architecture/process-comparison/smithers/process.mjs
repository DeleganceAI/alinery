import { Action, Flow, Interpreter } from '@smthrs/flow';
import { FlowEngine } from '@smthrs/engine';
import { Node } from '@smthrs/plan';
import { Effect, Layer, Schema } from 'effect';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import { schemas } from './agents.mjs';

// Native schema projection of the shared contract, not a second contract.
function native(s) {
  if (s.type === 'object') return Schema.Struct(Object.fromEntries(
    Object.entries(s.properties).map(([key, value]) => [key, native(value)])));
  if (s.type === 'array') return Schema.Array(native(s.items));
  if (s.type === 'string') return Schema.String;
  if (s.type === 'boolean') return Schema.Boolean;
  if (s.type === 'integer') return Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(s.minimum));
  throw new Error(`Unsupported shared schema: ${JSON.stringify(s)}`);
}
const State = native(schemas.frame);
const Source = native(schemas.discover.properties.sources.items);
const Discovery = native(schemas.discover);
const Assessment = native(schemas.read);
const Synthesis = native(schemas.synthesize);
const input = {
  frame: { question: Schema.String },
  discover: { state: State },
  read: { state: State, source: Source },
  synthesize: { state: State, discovery: Discovery, assessments: Schema.Array(Assessment) },
  decide: { state: State, synthesis: Synthesis },
  finish_empty: { state: State, notes: Schema.String }
};
const actions = Object.fromEntries(Object.entries(input).map(([phase, payload]) => [phase,
  Action.make(`literature/${phase}`, { payload, success: native(schemas[phase]), error: Schema.String })
]));

export const LiteratureReview = Flow.make('literature/start', {
  payload: { question: Schema.String }, success: Schema.String, error: Schema.String,
  body: ({ question }) => actions.frame.call({ question }).pipe(
    Node.bindPlanned(state => DiscoverRound.to({ state })))
});

const DiscoverRound = Flow.make('literature/discover-round', {
  payload: { state: State }, success: Schema.String, error: Schema.String,
  body: ({ state }) => actions.discover.call({ state }).pipe(
    Node.map(discovery => {
      const seen = new Set(state.seen);
      const sources = discovery.sources.flatMap(source => {
        const url = source.url.trim();
        if (!url || seen.has(url)) return [];
        seen.add(url);
        return [{ ...source, url }];
      });
      return { ...discovery, sources };
    }),
    Node.branch({
      if: discovery => discovery.sources.length === 0,
      then: discovery => actions.finish_empty.call({ state, notes: discovery.notes })
        .pipe(Node.map(result => result.report)),
      else: discovery => ReadersRound.to({ state, discovery })
    }))
});

const ReadersRound = Flow.make('literature/readers-round', {
  payload: { state: State, discovery: Discovery }, success: Schema.String, error: Schema.String,
  body: ({ state, discovery }) => Node.all(Object.fromEntries(
    discovery.sources.map((source, index) => [String(index), actions.read.call({ state, source })])
  )).pipe(
    Node.map(results => Object.values(results)),
    Node.bindPlanned(assessments => Node.all({
      assessments: Node.succeed(assessments),
      synthesis: actions.synthesize.call({ state, discovery, assessments })
    })),
    Node.bindPlanned(result => DecisionRound.to({
      state, discovery, assessments: result.assessments, synthesis: result.synthesis
    })))
});

const DecisionRound = Flow.make('literature/decision-round', {
  payload: { state: State, discovery: Discovery, assessments: Schema.Array(Assessment), synthesis: Synthesis },
  success: Schema.String, error: Schema.String,
  body: ({ state, discovery, assessments, synthesis }) => {
    const current = { ...state, seen: [...state.seen, ...discovery.sources.map(source => source.url)],
      assessments: [...state.assessments, ...assessments], synthesis: synthesis.text };
    return actions.decide.call({ state: current, synthesis }).pipe(
    Node.branch({
      if: decision => decision.continue,
      then: decision => Node.succeed(decision).pipe(
        Node.map(value => ({ ...current, round: current.round + 1, queries: value.queries })),
        Node.bindPlanned(next => DiscoverRound.to({ state: next }))),
      else: decision => Node.succeed(decision.report)
    }));
  }
});

export function runReview(agent, question, executionId) {
  const implementations = Object.entries(actions).map(([phase, action]) => action.toLayer(payload =>
    Effect.tryPromise({ try: signal => agent(phase, payload, signal), catch: error => String(error) })));
  // The low-level interpreter uses process-local callback identity. This
  // in-memory example makes no durable cross-process replay/cache claim.
  const runtime = Layer.mergeAll(...implementations,
    ...[LiteratureReview, DiscoverRound, ReadersRound, DecisionRound].map(flow => Interpreter.layer(flow))
  ).pipe(Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory), Layer.provideMerge(NodeCrypto.layer));
  return Effect.runPromise(LiteratureReview.execute({ question }, { executionId }).pipe(Effect.provide(runtime)));
}
