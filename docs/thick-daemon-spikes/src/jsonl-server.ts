// Baseline: today's wire shape, one JSON line per connection (vinculum-daemon/src/main.ts:1075).
import { createServer } from "node:net";
import { rmSync } from "node:fs";
const socketPath = process.argv[2];
rmSync(socketPath, { force: true });
createServer((socket) => {
  let buf = "";
  socket.on("data", (chunk) => {
    buf += chunk;
    const nl = buf.indexOf("\n");
    if (nl < 0) return;
    const req = JSON.parse(buf.slice(0, nl));
    socket.end(`${JSON.stringify({ protocol: 24, data: req.data })}\n`);
  });
}).listen(socketPath, () => console.log(`listening jsonl ${socketPath}`));
