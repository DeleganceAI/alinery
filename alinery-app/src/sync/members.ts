// Who may use a repository's daemon besides its starter. A request to join is asked and collected by the shell (it keeps the
// token); a member answers it here, from the `daemon/_/join-requests` entity.
import { createClient } from "@connectrpc/connect";
import { AdminService } from "alinery-proto/alinery/v1/admin_pb";
import { daemonTransport } from "../daemon/transport";

export const JOIN_REQUESTS_KEY = "daemon/_/join-requests";

export async function decideJoin(repo: string, requestId: string, approve: boolean): Promise<void> {
  await createClient(AdminService, daemonTransport(repo)).decideJoin({ requestId, approve });
}
