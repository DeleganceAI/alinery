// S0.2 spike client and benchmark. Usage:
//   bun src/rpc-bench.ts <rpc socket> <jsonl socket> [http1|http2] [server pid]
import { connect } from "node:net";
import { execSync } from "node:child_process";
import { Code, ConnectError, createClient, type Interceptor } from "@connectrpc/connect";
import { createConnectTransport, createGrpcTransport } from "@connectrpc/connect-node";
import { AdminService } from "../gen/alinery/v1/admin_pb";
import { SpikeService } from "../gen/alinery/v1/spike_pb";

const [rpcSock, jsonlSock, mode = "http1", serverPid] = process.argv.slice(2);
const bearer = (token: string): Interceptor => (next) => (req) => {
  if (token) req.header.set("authorization", `Bearer ${token}`);
  return next(req);
};
function transport(token: string) {
  return mode === "http2"
    ? createGrpcTransport({ baseUrl: "http://daemon", nodeOptions: { path: rpcSock } as never, interceptors: [bearer(token)] })
    : createConnectTransport({ httpVersion: "1.1", baseUrl: "http://daemon", useBinaryFormat: true, nodeOptions: { socketPath: rpcSock }, interceptors: [bearer(token)] });
}
const pct = (xs: number[], p: number) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];
const ms = (n: number) => `${n.toFixed(3)} ms`;
const out: Record<string, unknown> = { runtime: `bun ${Bun.version}`, platform: `${process.platform}-${process.arch}`, mode };

// 1. auth
for (const token of ["", "wrong-token-wrong-token-wrong"]) {
  try {
    await createClient(AdminService, transport(token)).hello({});
    out[`auth_${token ? "wrong" : "none"}`] = "ACCEPTED (bad)";
  } catch (e) {
    out[`auth_${token ? "wrong" : "none"}`] = ConnectError.from(e).code === Code.Unauthenticated ? "UNAUTHENTICATED" : String(e);
  }
}
const t = transport("spike-secret-0123456789abcdef");
const admin = createClient(AdminService, t);
const spike = createClient(SpikeService, t);
const hello = await admin.hello({});
out.hello_stats = JSON.parse(hello.buildId);

// 2. unary latency, 1,000 sequential 100-byte echos (after 100 warm-up calls)
const body = new Uint8Array(100);
for (let i = 0; i < 100; i++) await spike.echo({ data: body });
const lat: number[] = [];
for (let i = 0; i < 1000; i++) {
  const t0 = performance.now();
  await spike.echo({ data: body });
  lat.push(performance.now() - t0);
}
out.unary_p50 = ms(pct(lat, 50));
out.unary_p99 = ms(pct(lat, 99));

// 3. unary throughput, 16 in flight
{
  const t0 = performance.now();
  let done = 0;
  await Promise.all(Array.from({ length: 16 }, async () => { while (done < 4000) { done++; await spike.echo({ data: body }); } }));
  out.unary_16_concurrent_per_s = Math.round(4000 / ((performance.now() - t0) / 1000));
}

// 4. baseline: today's one-JSON-line-per-connection wire
async function jsonlCall(): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = connect(jsonlSock);
    let got = "";
    s.on("data", (c) => (got += c));
    s.on("end", () => resolve());
    s.on("error", reject);
    s.write(`${JSON.stringify({ op: "version", data: "x".repeat(100) })}\n`);
  });
}
for (let i = 0; i < 100; i++) await jsonlCall();
const base: number[] = [];
for (let i = 0; i < 1000; i++) {
  const t0 = performance.now();
  await jsonlCall();
  base.push(performance.now() - t0);
}
out.jsonl_p50 = ms(pct(base, 50));
out.jsonl_p99 = ms(pct(base, 99));

// 5. server-stream throughput: 16 KiB frames, no interval, 5 s
{
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 5000);
  let bytes = 0;
  let frames = 0;
  const t0 = performance.now();
  try {
    for await (const m of spike.ticks({ size: 16384 }, { signal: ac.signal })) { bytes += m.data.length; frames++; }
  } catch (e) {
    if (ConnectError.from(e).code !== Code.Canceled) throw e;
  }
  const secs = (performance.now() - t0) / 1000;
  out.stream_MB_per_s = Math.round(bytes / secs / 1e6);
  out.stream_frames_per_s = Math.round(frames / secs);
}
await Bun.sleep(200);
out.cancel_reaches_server = JSON.parse((await admin.hello({})).buildId).aborted >= 1;

// 6. 100 idle streams (one frame every 15 s, like the heartbeat): server RSS before and after
const rssOf = async () => JSON.parse((await admin.hello({})).buildId).rss as number;
const rss0 = await rssOf();
const idle = new AbortController();
const streams = Array.from({ length: 100 }, async () => {
  try { for await (const _ of spike.ticks({ size: 16, intervalMs: 15000 }, { signal: idle.signal })); } catch {}
});
await Bun.sleep(1500);
const stats = JSON.parse((await admin.hello({})).buildId);
out.idle_streams_open = stats.open;
out.server_rss_MB_before = +(rss0 / 1e6).toFixed(1);
out.server_rss_MB_100_idle = +(stats.rss / 1e6).toFixed(1);
if (serverPid) out.server_rss_ps_MB = +(Number(execSync(`ps -o rss= -p ${serverPid}`).toString().trim()) / 1024).toFixed(1);
idle.abort();
await Promise.all(streams);
await Bun.sleep(300);
out.idle_streams_after_abort = JSON.parse((await admin.hello({})).buildId).open;
console.log(JSON.stringify(out, null, 2));
process.exit(0);
