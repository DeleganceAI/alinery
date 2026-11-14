import { createClient, type Transport } from "@connectrpc/connect";
import { createGrpcWebTransport } from "@connectrpc/connect-web";
import { AdminService } from "alinery-proto/alinery/v1/admin_pb";
import * as ipc from "../ipc";
import { grpcWebFetch } from "./bridgeFetch";

// One transport per repo key: the shell keeps one HTTP/2 connection per daemon behind it (plan 2.1.9).
const transports = new Map<string, Transport>();

export function daemonTransport(repo: string): Transport {
  let t = transports.get(repo);
  if (!t) {
    t = createGrpcWebTransport({ baseUrl: "http://daemon", fetch: grpcWebFetch(ipc.daemonRpc(repo), ipc.daemonRpcCancel) });
    transports.set(repo, t);
  }
  return t;
}

export const admin = (repo: string) => createClient(AdminService, daemonTransport(repo));
