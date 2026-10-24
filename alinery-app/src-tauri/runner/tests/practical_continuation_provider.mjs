import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

// Provider replies and latches only. The daemon and unchanged native tools own
// every lifecycle transition, artifact write, queue and acceptance decision.
const { values } = parseArgs({
  options: {
    port: { type: "string", default: "0" },
    scenario: { type: "string" },
    "control-dir": { type: "string" },
  },
});
if (!values.scenario || !values["control-dir"]) throw new Error("--scenario and --control-dir are required");
const directory = path.resolve(values["control-dir"]);
await mkdir(directory, { recursive: true });
let sequence = 0;
const sockets = new Set();
const server = createServer(async (request, response) => {
  const number = ++sequence;
  try {
    if (request.method !== "POST" || !request.url.endsWith("/chat/completions")) {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    await writeFile(path.join(directory, `request-${number}.json`), JSON.stringify({ scenario: values.scenario, body }));
    let script;
    // The test creates response-N.json to release this exact request. A missing
    // response never invents model behavior or counts as successful settlement.
    while (!response.destroyed) {
      try {
        script = JSON.parse(await readFile(path.join(directory, `response-${number}.json`), "utf8"));
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await delay(10);
    }
    if (response.destroyed) return;
    if (script.error) {
      response.writeHead(script.status ?? 500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: script.error }));
      return;
    }
    const message = { role: "assistant", content: script.content ?? null };
    if (script.tool_calls) message.tool_calls = script.tool_calls;
    const finish = script.tool_calls?.length ? "tool_calls" : "stop";
    const common = { id: `loopback-${number}`, created: 0, model: body.model };
    if (!body.stream) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ...common,
          object: "chat.completion",
          choices: [{ index: 0, message, finish_reason: finish }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    } else {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const delta = { ...message };
      if (delta.tool_calls) delta.tool_calls = delta.tool_calls.map((tool, index) => ({ ...tool, index }));
      response.write(`data: ${JSON.stringify({ ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      response.write(
        `data: ${JSON.stringify({ ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    }
    await writeFile(path.join(directory, `responded-${number}`), "released\n");
  } catch (error) {
    await writeFile(path.join(directory, `error-${number}`), String(error));
    if (!response.headersSent) response.writeHead(500);
    response.end();
  }
});
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(Number(values.port), "127.0.0.1", resolve);
});
console.log(JSON.stringify({ port: server.address().port }));
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, () => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
