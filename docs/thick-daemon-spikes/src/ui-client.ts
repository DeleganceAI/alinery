// S0.1 check: the UI imports generated code the way alinery-app will, built by the app's Vite.
// `vite build --config vite.config.mjs` must succeed with protoc-gen-es's default (no) import extension.
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { AdminService } from "../gen/alinery/v1/admin_pb";
import { SyncService } from "../gen/alinery/v1/sync_pb";

const transport = createConnectTransport({ baseUrl: "http://daemon", useBinaryFormat: true });
export const admin = createClient(AdminService, transport);
export const sync = createClient(SyncService, transport);
