function prompt(operation, input) {
  return `${PROMPTS[operation]}\n\nINPUT_JSON\n${JSON.stringify(input)}`;
}

async function invoke(operation, input, label) {
  const result = await agent(prompt(operation, input), {
    schema: SCHEMAS[operation],
    label,
  });
  // A failed/stopped native agent returns null: never synthesize a partial batch.
  if (result === null) throw new Error(`Agent ${label} failed or was stopped`);
  if (operation === 'read' && ['id', 'url', 'title'].some(key => result[key] !== input.source[key])) {
    throw new Error(`Reader ${label} changed its assigned source identity`);
  }
  if ((operation === 'finish_empty' || (operation === 'decide' && !result.continue))
      && !result.report.trim()) {
    throw new Error(`Agent ${label} returned an empty final report`);
  }
  return result;
}

if (!args || typeof args.question !== 'string' || !args.question.trim()) {
  throw new Error('Pass args = {question: "your literature-review question"}');
}

let state = await invoke('frame', {question: args.question}, 'frame');
if (state.question !== args.question || state.round !== 1 || state.seen.length
    || state.assessments.length || state.synthesis !== '') {
  throw new Error('Frame returned an invalid initial state');
}
while (true) {
  const discovered = await invoke('discover', {state}, `discover:${state.round}`);
  const seen = new Set(state.seen.map(url => url.trim()));
  const sources = [];
  for (const source of discovered.sources) {
    const url = source.url.trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    sources.push({...source, url});
  }
  const discovery = {...discovered, sources};

  if (sources.length === 0) {
    const result = await invoke('finish_empty', {
      state,
      notes: discovery.notes,
    }, `finish_empty:${state.round}`);
    return result.report;
  }

  const assessments = await pipeline(sources, source =>
    invoke('read', {state, source}, `read:${state.round}:${source.id}`),
  );
  if (assessments.length !== sources.length || assessments.some(value => value === null)) {
    throw new Error('Incomplete reader batch');
  }
  const synthesis = await invoke('synthesize', {
    state, discovery, assessments,
  }, `synthesize:${state.round}`);
  state = {
    ...state,
    seen: [...seen],
    assessments: [...state.assessments, ...assessments],
    synthesis: synthesis.text,
  };
  const decision = await invoke('decide', {
    state, synthesis,
  }, `decide:${state.round}`);
  if (!decision.continue) return decision.report;
  if (!decision.queries.length || decision.queries.some(query => !query.trim())) {
    throw new Error('A continuation requires nonempty search queries');
  }
  state = {
    ...state,
    round: state.round + 1,
    queries: decision.queries,
  };
}
