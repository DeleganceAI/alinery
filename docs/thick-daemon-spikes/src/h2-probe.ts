import { connect } from "node:net";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { AdminService } from "../gen/alinery/v1/admin_pb";
const t = createGrpcTransport({ baseUrl: "http://daemon", nodeOptions: { createConnection: () => connect(process.argv[2]) } as never,
  interceptors: [(next) => (req) => { req.header.set("authorization", "Bearer spike-secret-0123456789abcdef"); return next(req); }] });
try { const r = await createClient(AdminService, t).hello({}); console.log("h2 grpc OK", JSON.parse(r.buildId).peer); } catch (e) { console.log("h2 grpc FAIL", String(e)); }
process.exit(0);
