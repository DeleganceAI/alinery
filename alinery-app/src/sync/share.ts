// Teammates' comments on this repository's shared tasks. The daemon fetches them every heartbeat; this asks for them now.
import { createClient } from "@connectrpc/connect";
import { ShareService } from "alinery-proto/alinery/v1/share_pb";
import { daemonTransport } from "../daemon/transport";

/** The sentence a pull ends with, for the button's toast. */
export async function pullTeamComments(repo: string): Promise<string> {
  const { shared, saved } = await createClient(ShareService, daemonTransport(repo)).pullComments({});
  if (!shared) return "This repository is not shared with a team.";
  return saved === 0 ? "No new comments." : saved === 1 ? "1 new comment." : `${saved} new comments.`;
}
