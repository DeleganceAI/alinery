// A stand-in job child for runner.test.ts: `bun fake-child.ts`, with {mode, ...} as the params on
// stdin. It speaks the same protocol as child.ts.
const emit = (line: object) => process.stdout.write(`${JSON.stringify(line)}\n`);
const params = JSON.parse(await Bun.stdin.text());
const info = { repo_path: String(params.tag ?? "") };

switch (params.mode) {
  case "progress": // `lines` progress lines, `gapMs` apart, then a result
    for (let i = 1; i <= params.lines; i++) {
      emit({ progress: { done: i, total: params.lines, label: `step ${i}` } });
      await Bun.sleep(params.gapMs);
    }
    emit({ result: info });
    break;
  case "fail": // no result, a message on stderr
    console.error("first line\nthe real reason");
    process.exit(1);
  case "silent": // exits 0 with nothing
    break;
  case "error":
    emit({ error: "it broke" });
    break;
  case "hang": // until killed; says its pid so a test can check it is gone
    emit({ progress: { done: 0, total: 1, label: `pid ${process.pid}` } });
    await new Promise(() => {});
    break;
  case "slow": // a result after `ms`
    await Bun.sleep(params.ms);
    emit({ result: info });
    break;
}

