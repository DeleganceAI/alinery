import { expect, spyOn, test } from "bun:test";
import { admitIdleCompaction, compactionSignature, compactionsOf, handleLiveDocTick, type CompactionCarry, type CompactionWatch } from "./compactionState.ts";

const running = { reason: "threshold", blocking: false, attempt: 1 };

test("starting, retrying, and clearing a compaction each change the signature", () => {
  const absent = compactionSignature(undefined);
  const started = compactionSignature({ compactions: [running] });
  const retrying = compactionSignature({ compactions: [{ ...running, retry: { at: 50, error: "busy" } }] });
  const cleared = compactionSignature({ compactions: undefined });
  expect(started).not.toBe(absent);
  expect(retrying).not.toBe(started);
  expect(cleared).not.toBe(retrying);
  expect(cleared).toBe(absent);
});

test("an empty list and an absent list are the same signature", () => {
  expect(compactionSignature({ compactions: [] })).toBe(compactionSignature({}));
  expect(compactionSignature({ compactions: [] })).toBe(compactionSignature(null));
  expect(compactionSignature({ compactions: [] })).toBe(compactionSignature(undefined));
});

test("setting and clearing a failure changes the signature", () => {
  const none = compactionSignature({});
  const failed = compactionSignature({ compactionFailure: { reason: "overflow", error: "too long" } });
  const cleared = compactionSignature({ compactionFailure: undefined });
  expect(failed).not.toBe(none);
  expect(cleared).toBe(none);
});

test("an unchanged run plus a changed compaction signature does not short-circuit", () => {
  const runningFlag = false;
  const runId = "run-1";
  const before = compactionSignature({ compactions: [running] });
  const after = compactionSignature({ compactions: [{ ...running, attempt: 2 }] });
  // The LiveDoc watcher's early return: run flag, run id, and compaction signature must all hold.
  const shortCircuit = (lastRunning: boolean, lastRunId: string | undefined, lastSig: string, sig: string) => lastRunning === runningFlag && lastRunId === runId && lastSig === sig;
  expect(shortCircuit(runningFlag, runId, before, before)).toBe(true);
  expect(shortCircuit(runningFlag, runId, before, after)).toBe(false);
});

test("an idle compaction change publishes before a rejected turn-outcome read", async () => {
  const row: CompactionCarry = {};
  const watch: CompactionWatch = { signature: undefined };
  const published: string[] = [];
  const publish = () => {
    published.push("publish");
  };
  const reject = async () => {
    throw new Error("turn outcome unavailable");
  };

  await expect(admitIdleCompaction(row, watch, { compactions: [running] }, publish, reject)).rejects.toThrow("turn outcome unavailable");
  expect(published).toEqual(["publish"]);
  expect(row.compactions).toEqual([running]);

  await expect(
    admitIdleCompaction(row, watch, { compactions: [{ ...running, retry: { at: 50, error: "busy" } }] }, publish, reject),
  ).rejects.toThrow("turn outcome unavailable");
  expect(published).toEqual(["publish", "publish"]);

  await expect(admitIdleCompaction(row, watch, { compactions: undefined }, publish, reject)).rejects.toThrow("turn outcome unavailable");
  expect(published).toEqual(["publish", "publish", "publish"]);
  expect(row.compactions).toBeUndefined();
  expect(row.compaction_failure).toBeUndefined();

  // The first tick already published. A following tick with the same signature does not have to.
  await expect(admitIdleCompaction(row, watch, { compactions: undefined }, publish, reject)).rejects.toThrow("turn outcome unavailable");
  expect(published).toEqual(["publish", "publish", "publish"]);

  const stuck: CompactionWatch = { signature: watch.signature };
  const next: CompactionCarry = {};
  await expect(
    admitIdleCompaction(next, stuck, { compactions: [running] }, () => {
      throw new Error("publish failed");
    }, async () => {}),
  ).rejects.toThrow("publish failed");
  expect(stuck.signature).toBe(watch.signature);
  const retried: string[] = [];
  await admitIdleCompaction(next, stuck, { compactions: [running] }, () => {
    retried.push("ok");
  }, async () => {});
  expect(retried).toEqual(["ok"]);
  expect(next.compactions).toEqual([running]);
});

test("the mapped shape drops the harness task id", () => {
  const mapped = compactionsOf({
    compactions: [{ taskId: "t1" as never, reason: "manual", blocking: true, attempt: 2, retry: { at: 9, error: "later" } }],
    compactionFailure: { taskId: "t0" as never, reason: "overflow", error: "no room" },
  });
  expect(mapped.compactions).toEqual([{ reason: "manual", blocking: true, attempt: 2, retry: { at: 9, error: "later" } }]);
  expect(mapped.compaction_failure).toEqual({ reason: "overflow", error: "no room" });
  expect(JSON.stringify(mapped)).not.toContain("t1");
  expect(compactionsOf(undefined)).toEqual({});
  expect(compactionsOf({ compactions: [] })).toEqual({});
});

function watched() {
  return {
    id: "s1",
    taskSlug: "",
    liveRun: false,
    agent: { state: "idle" },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a compaction tick while idle does not cancel the run-end title", async () => {
  const state = { version: 0, lastRunning: undefined as boolean | undefined, owedFinish: false, compaction: { signature: undefined as string | undefined } };
  const row = watched();
  const titles: string[] = [];
  let release: (failure?: { id: string; reason: string }) => void = () => {};
  const pending = new Promise<{ id: string; reason: string } | undefined>((resolve) => {
    release = resolve;
  });
  const idle = {
    publish: () => {},
    abandoned: () => false,
    title: () => titles.push("compaction"),
    readFailure: async () => undefined,
  };
  handleLiveDocTick(state, row, { run: { inputs: ["run-1"] } }, { ...idle, title: () => titles.push("run") });
  handleLiveDocTick(state, row, { compactions: [{ reason: "threshold", blocking: false, attempt: 1 }] }, {
    ...idle,
    title: () => titles.push("run-end"),
    readFailure: () => pending,
  });
  const versionAfterEnd = state.version;
  expect(state.owedFinish).toBe(true);
  handleLiveDocTick(state, row, { compactions: [{ reason: "threshold", blocking: false, attempt: 1, retry: { at: 50, error: "busy" } }] }, idle);
  expect(row.compactions?.[0]?.retry?.error).toBe("busy");
  expect(state.owedFinish).toBe(true);
  expect(state.version).toBe(versionAfterEnd);
  handleLiveDocTick(state, row, { compactionFailure: { reason: "overflow", error: "too long" } }, idle);
  expect(row.compaction_failure).toEqual({ reason: "overflow", error: "too long" });
  expect(state.owedFinish).toBe(true);
  handleLiveDocTick(state, row, {}, idle);
  expect(row.compactions).toBeUndefined();
  expect(row.compaction_failure).toBeUndefined();
  expect(state.owedFinish).toBe(true);
  expect(state.version).toBe(versionAfterEnd);
  await flush();
  expect(titles).toEqual([]);
  release(undefined);
  await pending;
  await flush();
  expect(titles).toEqual(["run-end"]);
  expect(state.owedFinish).toBe(false);
  handleLiveDocTick(state, row, { compactions: [{ reason: "manual", blocking: true, attempt: 1 }] }, idle);
  await flush();
  expect(titles).toEqual(["run-end"]);
});

test("a new run cancels the in-flight run-end read before it can title", async () => {
  const state = { version: 0, lastRunning: undefined as boolean | undefined, owedFinish: false, compaction: { signature: undefined as string | undefined } };
  const row = watched();
  const titles: string[] = [];
  let release: (failure?: { id: string; reason: string }) => void = () => {};
  const pending = new Promise<{ id: string; reason: string } | undefined>((resolve) => {
    release = resolve;
  });
  const deps = {
    publish: () => {},
    abandoned: () => false,
    title: () => titles.push("run-end"),
    readFailure: () => pending,
  };
  handleLiveDocTick(state, row, { run: { inputs: ["run-1"] } }, deps);
  handleLiveDocTick(state, row, {}, deps);
  expect(state.owedFinish).toBe(true);
  handleLiveDocTick(state, row, { run: { inputs: ["run-2"] } }, deps);
  expect(state.owedFinish).toBe(false);
  release(undefined);
  await pending;
  await flush();
  expect(titles).toEqual([]);
});

test("a thrown compaction publish does not consume the signature or the owed finish", async () => {
  const error = spyOn(console, "error").mockImplementation(() => {});
  const state = { version: 3, lastRunning: false as boolean | undefined, owedFinish: true, compaction: { signature: undefined as string | undefined } };
  const row = watched();
  const value = { compactions: [{ reason: "threshold", blocking: false, attempt: 1 }] };
  handleLiveDocTick(state, row, value, {
    publish: () => {
      throw new Error("publish failed");
    },
    readFailure: async () => undefined,
    title: () => {
      throw new Error("titled");
    },
    abandoned: () => false,
  });
  await flush();
  expect(state.compaction.signature).toBeUndefined();
  expect(state.owedFinish).toBe(true);
  const published: string[] = [];
  handleLiveDocTick(state, row, value, {
    publish: () => published.push("ok"),
    readFailure: async () => undefined,
    title: () => published.push("title"),
    abandoned: () => false,
  });
  await flush();
  // The compaction publish, then the turn-outcome read's publish. The thrown attempt did neither durably.
  expect(published).toEqual(["ok", "ok"]);
  expect(published).not.toContain("title");
  expect(row.compactions).toEqual(value.compactions);
  expect(state.compaction.signature).toBe(compactionSignature(value));
  expect(state.owedFinish).toBe(true);
  error.mockRestore();
});

test("a thrown publish on the idle transition retries and titles once", async () => {
  const error = spyOn(console, "error").mockImplementation(() => {});
  const state = { version: 1, lastRunning: true as boolean | undefined, owedFinish: false, compaction: { signature: undefined as string | undefined } };
  const row = watched();
  row.runId = "run-1";
  row.liveRun = true;
  const value = { compactions: [{ reason: "threshold", blocking: false, attempt: 1 }] };
  const titles: string[] = [];
  let publishes = 0;
  handleLiveDocTick(state, row, value, {
    publish: () => {
      publishes += 1;
      if (publishes === 1) throw new Error("publish failed");
    },
    readFailure: async () => undefined,
    title: () => titles.push("title"),
    abandoned: () => false,
  });
  await flush();
  // The module retries. A second handleLiveDocTick is not the recovery.
  expect(titles).toEqual(["title"]);
  expect(state.lastRunning).toBe(false);
  expect(state.owedFinish).toBe(false);
  expect(state.compaction.signature).toBe(compactionSignature(value));
  expect(publishes).toBeGreaterThan(1);

  handleLiveDocTick(state, row, { compactions: [{ reason: "manual", blocking: true, attempt: 1 }] }, {
    publish: () => {},
    readFailure: async () => undefined,
    title: () => titles.push("again"),
    abandoned: () => false,
  });
  await flush();
  expect(titles).toEqual(["title"]);
  error.mockRestore();
});

test("a rejected finish read retries and titles once, and a compaction tick during the read does not cancel it", async () => {
  const error = spyOn(console, "error").mockImplementation(() => {});
  const state = { version: 1, lastRunning: true as boolean | undefined, owedFinish: false, compaction: { signature: undefined as string | undefined } };
  const row = watched();
  row.runId = "run-1";
  row.liveRun = true;
  const titles: string[] = [];
  let reads = 0;
  let rejectFirst: (error: Error) => void = () => {};
  const first = new Promise<never>((_, reject) => {
    rejectFirst = reject;
  });
  handleLiveDocTick(state, row, { compactions: [{ reason: "threshold", blocking: false, attempt: 1 }] }, {
    publish: () => {},
    readFailure: () => {
      reads += 1;
      return reads === 1 ? first : Promise.resolve(undefined);
    },
    title: () => titles.push("title"),
    abandoned: () => false,
  });
  const versionDuringRead = state.version;
  expect(state.owedFinish).toBe(true);
  expect(state.lastRunning).toBe(true);
  handleLiveDocTick(state, row, { compactions: [{ reason: "threshold", blocking: false, attempt: 2 }] }, {
    publish: () => {},
    readFailure: async () => undefined,
    title: () => titles.push("compaction"),
    abandoned: () => false,
  });
  expect(state.version).toBe(versionDuringRead);
  expect(state.owedFinish).toBe(true);
  expect(row.compactions?.[0]?.attempt).toBe(2);
  expect(titles).toEqual([]);
  // A same-value tick must not swallow the in-flight retry via the early return.
  handleLiveDocTick(state, row, { compactions: [{ reason: "threshold", blocking: false, attempt: 2 }] }, {
    publish: () => {},
    readFailure: async () => undefined,
    title: () => titles.push("same"),
    abandoned: () => false,
  });
  expect(state.version).toBe(versionDuringRead);
  rejectFirst(new Error("read failed"));
  await flush();
  expect(reads).toBe(2);
  expect(titles).toEqual(["title"]);
  expect(state.lastRunning).toBe(false);
  expect(state.owedFinish).toBe(false);
  expect(state.compaction.signature).toBeDefined();
  error.mockRestore();
});

test("a later delivery of the stop value publishes after a compaction change during a rejected finish read", async () => {
  const error = spyOn(console, "error").mockImplementation(() => {});
  const state = { version: 1, lastRunning: true as boolean | undefined, owedFinish: false, compaction: { signature: undefined as string | undefined } };
  const row = watched();
  row.runId = "run-1";
  row.liveRun = true;
  const stop = { compactions: [{ reason: "threshold", blocking: false, attempt: 1 }] };
  const mid = { compactions: [{ reason: "threshold", blocking: false, attempt: 1, retry: { at: 50, error: "busy" } }] };
  const published: string[] = [];
  let reads = 0;
  let rejectFirst: (error: Error) => void = () => {};
  const first = new Promise<never>((_, reject) => {
    rejectFirst = reject;
  });
  const deps = {
    publish: () => {
      published.push(row.compactions?.[0]?.retry?.error ?? "stop");
    },
    readFailure: () => {
      reads += 1;
      return reads === 1 ? first : Promise.resolve(undefined);
    },
    title: () => {},
    abandoned: () => false,
  };
  handleLiveDocTick(state, row, stop, deps);
  handleLiveDocTick(state, row, mid, deps);
  expect(row.compactions?.[0]?.retry?.error).toBe("busy");
  expect(state.version).toBe(2);
  expect(state.owedFinish).toBe(true);
  rejectFirst(new Error("read failed"));
  await flush();
  expect(reads).toBe(2);
  // The retry kept the compaction tick's signature. The row is still the in-between state until the stop value is delivered again.
  expect(state.compaction.signature).toBe(compactionSignature(mid));
  expect(row.compactions?.[0]?.retry?.error).toBe("busy");
  const before = published.length;
  handleLiveDocTick(state, row, stop, deps);
  expect(published.length).toBeGreaterThan(before);
  expect(published.at(-1)).toBe("stop");
  expect(row.compactions).toEqual(stop.compactions);
  expect(row.compactions?.[0]?.retry).toBeUndefined();
  await flush();
  error.mockRestore();
});

test("a thrown publish during the finish read does not leave the retry note stuck", async () => {
  const error = spyOn(console, "error").mockImplementation(() => {});
  const state = { version: 1, lastRunning: true as boolean | undefined, owedFinish: false, compaction: { signature: undefined as string | undefined } };
  const row = watched();
  row.runId = "run-1";
  row.liveRun = true;
  const stop = { compactions: [{ reason: "threshold", blocking: false, attempt: 1 }] };
  const mid = { compactions: [{ reason: "threshold", blocking: false, attempt: 1, retry: { at: 50, error: "busy" } }] };
  const published: string[] = [];
  let reads = 0;
  let midAttempts = 0;
  let rejectFirst: (error: Error) => void = () => {};
  const first = new Promise<never>((_, reject) => {
    rejectFirst = reject;
  });
  const deps = {
    publish: () => {
      published.push(row.compactions?.[0]?.retry?.error ?? "stop");
      // The first delivery of the retry throws. The module must retry that publish itself.
      if (row.compactions?.[0]?.retry?.error === "busy" && midAttempts === 0) {
        midAttempts += 1;
        throw new Error("publish failed");
      }
    },
    readFailure: () => {
      reads += 1;
      return reads === 1 ? first : Promise.resolve(undefined);
    },
    title: () => {},
    abandoned: () => false,
  };
  handleLiveDocTick(state, row, stop, deps);
  handleLiveDocTick(state, row, mid, deps);
  // The first publish threw. The module retried once, so the scheduled note is on the row without another tick.
  expect(midAttempts).toBe(1);
  expect(row.compactions?.[0]?.retry?.error).toBe("busy");
  expect(state.compaction.signature).toBe(compactionSignature(mid));
  rejectFirst(new Error("read failed"));
  await flush();
  expect(reads).toBe(2);
  // The stop path must not stamp stop over the retry this window recovered.
  expect(row.compactions?.[0]?.retry?.error).toBe("busy");
  expect(state.compaction.signature).toBe(compactionSignature(mid));
  const beforeLater = published.length;
  const rowBeforeLater = JSON.stringify(row.compactions ?? null);
  handleLiveDocTick(state, row, stop, deps);
  if (published.length === beforeLater) {
    // A later stop delivery may no-op only because the row already matches the stop value.
    expect(rowBeforeLater).toBe(JSON.stringify(stop.compactions));
  } else {
    expect(published.at(-1)).toBe("stop");
  }
  // The stuck probe: signature equal to the stop value, row still busy, later delivery not publishing.
  const stuck = state.compaction.signature === compactionSignature(stop) && row.compactions?.[0]?.retry?.error === "busy" && published.length === beforeLater;
  expect(stuck).toBe(false);
  expect(row.compactions).toEqual(stop.compactions);
  expect(row.compactions?.[0]?.retry).toBeUndefined();
  await flush();
  error.mockRestore();
});

test("a finish that throws twice does not title and does not retry again", async () => {
  const error = spyOn(console, "error").mockImplementation(() => {});
  const state = { version: 1, lastRunning: true as boolean | undefined, owedFinish: false, compaction: { signature: undefined as string | undefined } };
  const row = watched();
  row.runId = "run-1";
  const titles: string[] = [];
  let publishes = 0;
  handleLiveDocTick(state, row, {}, {
    publish: () => {
      publishes += 1;
      throw new Error("publish failed");
    },
    readFailure: async () => undefined,
    title: () => titles.push("title"),
    abandoned: () => false,
  });
  await flush();
  await flush();
  expect(titles).toEqual([]);
  expect(state.lastRunning).toBe(true);
  expect(state.compaction.signature).toBeUndefined();
  expect(state.owedFinish).toBe(true);
  expect(publishes).toBe(2);
  const after = publishes;
  await flush();
  expect(publishes).toBe(after);
  expect(titles).toEqual([]);
  error.mockRestore();
});

test("a finish read that rejects twice does not title and does not retry again", async () => {
  const error = spyOn(console, "error").mockImplementation(() => {});
  const state = { version: 1, lastRunning: true as boolean | undefined, owedFinish: false, compaction: { signature: undefined as string | undefined } };
  const row = watched();
  const titles: string[] = [];
  let reads = 0;
  handleLiveDocTick(state, row, {}, {
    publish: () => {},
    readFailure: async () => {
      reads += 1;
      throw new Error("read failed");
    },
    title: () => titles.push("title"),
    abandoned: () => false,
  });
  await flush();
  await flush();
  expect(titles).toEqual([]);
  expect(reads).toBe(2);
  expect(state.lastRunning).toBe(true);
  expect(state.compaction.signature).toBeUndefined();
  expect(state.owedFinish).toBe(true);
  error.mockRestore();
});

test("a task session does not title when the run stops", async () => {
  const state = { version: 0, lastRunning: true as boolean | undefined, owedFinish: false, compaction: { signature: undefined as string | undefined } };
  const row = watched();
  row.taskSlug = "task";
  const titles: string[] = [];
  handleLiveDocTick(state, row, {}, {
    publish: () => {},
    readFailure: async () => undefined,
    title: () => titles.push("title"),
    abandoned: () => false,
  });
  await flush();
  expect(titles).toEqual([]);
  expect(state.owedFinish).toBe(true);
  expect(state.lastRunning).toBe(false);
});
