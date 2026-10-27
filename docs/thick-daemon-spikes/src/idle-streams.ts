// Server memory with N idle server streams (S0.2 "RSS with 100 idle streams").
// Usage: bun src/idle-streams.ts <rpc socket> <server pid> [n]
import { execSync } from "node:child_process";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { SpikeService } from "../gen/alinery/v1/spike_pb";
const [sock, pid, n = "100"] = process.argv.slice(2);
const rss = () => Math.round(Number(execSync(`ps -o rss= -p ${pid}`).toString().trim()) / 1024);
const spike = createClient(SpikeService, createConnectTransport({
  httpVersion: "1.1", baseUrl: "http://daemon", useBinaryFormat: true, nodeOptions: { socketPath: sock },
  interceptors: [(next) => (req) => { req.header.set("authorization", "Bearer spike-secret-0123456789abcdef"); return next(req); }],
}));
await spike.echo({ data: new Uint8Array(1) });
const before = rss();
const ac = new AbortController();
const all = Array.from({ length: Number(n) }, async () => { try { for await (const _ of spike.ticks({ size: 16, intervalMs: 15000 }, { signal: ac.signal })); } catch {} });
await Bun.sleep(2000);
const during = rss();
ac.abort(); await Promise.all(all);
console.log(JSON.stringify({ streams: Number(n), server_rss_MB_before: before, server_rss_MB_with_streams: during, per_stream_KB: Math.round(((during - before) * 1024) / Number(n)) }));
process.exit(0);
