// Bearer-token auth and capabilities for the RPC socket (plan 2.1.10, R8).
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { Code, ConnectError, createContextKey, createContextValues, type ContextValues, type HandlerContext } from "@connectrpc/connect";
import { Capability } from "alinery-proto/alinery/v1/admin_pb";
import { ErrorDetailSchema } from "alinery-proto/alinery/v1/common_pb";

/** What the accept-time check made of the connection's peer.
 * - shell: the peer is the app's executable (`ALINERY_HOST_EXECUTABLE`).
 * - other: any other local process; agents run as the same user and can read the app's copy of the
 *   token, so a token alone does not give APPROVE or ADMIN.
 * - ssh: the daemon has no host executable (the app started it over ssh), so the peer is sshd and
 *   cannot be told from anything else. The token never leaves the Mac except in the file the
 *   daemon deletes at start, so the token is the proof. */
export type PeerClass = "shell" | "other" | "ssh";
export const PEER_CLASSES: readonly PeerClass[] = ["shell", "other", "ssh"];

export const CAPS = createContextKey<ReadonlySet<Capability>>(new Set(), { description: "capabilities of the credential" });

const FULL = [Capability.VIEW, Capability.ACT, Capability.APPROVE, Capability.ADMIN];
const LOCAL_OTHER = [Capability.VIEW, Capability.ACT];

/** Read the secret the app left in a file and delete the file, before anything listens or resumes.
 * A missing file gives an empty secret: no token then matches, and only a minted token works. */
export function takeSecretFile(path: string): Buffer {
  let secret = Buffer.alloc(0);
  try {
    secret = Buffer.from(readFileSync(path, "utf8").trim());
  } catch {
    /* no secret */
  }
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
  return secret;
}

function bearer(header: Headers): string | null {
  const value = header.get("authorization");
  if (value === null) return null;
  return value.startsWith("Bearer ") ? value.slice("Bearer ".length) : "";
}

function matches(given: string, secret: Buffer): boolean {
  if (secret.length < 32) return false;
  const actual = Buffer.from(given);
  return actual.length === secret.length && timingSafeEqual(actual, secret);
}

/** The AGENT tokens this daemon has minted (plan 2.1.10, O20 c): the daemon's own for the MCP it runs for each harness, and the
 * ones the shell asks for with `AdminService.MintToken`. They live in memory and die with the daemon. A label names one token: a
 * second mint with the same label replaces the first, so a client that refreshes does not pile them up. */
export class TokenRegistry {
  private readonly byLabel = new Map<string, Buffer>();

  mint(label: string): string {
    const token = randomBytes(32).toString("hex");
    this.byLabel.set(label, Buffer.from(token));
    return token;
  }

  has(given: string): boolean {
    const actual = Buffer.from(given);
    let found = false;
    // Every token is compared, so the time does not say which one matched.
    for (const token of this.byLabel.values()) if (actual.length === token.length && timingSafeEqual(actual, token)) found = true;
    return found;
  }
}

const rpc = (service: string, method: string) => `alinery.v1.${service}/${method}`;

/** What an AGENT credential may call: exactly the RPCs behind `alinery-mcp`'s 26 tools (plan S5.1, O18 b), each with the capability its
 * handler checks, which the credential holds for that call only. Never `Shutdown`, the rest of ADMIN, or anything that needs APPROVE.
 * `mcpServer/tools.ts` names the RPCs behind each tool, and `auth.test.ts` holds the two lists equal. */
export const AGENT_RPCS: ReadonlyMap<string, Capability> = new Map([
  [rpc("SyncService", "Subscribe"), Capability.VIEW],
  [rpc("BlobService", "ReadBlob"), Capability.VIEW],
  // `alinery_create_task` carries its attachments as bytes; the daemon stages them as an upload.
  [rpc("BlobService", "BeginUpload"), Capability.ACT],
  [rpc("BlobService", "UploadChunk"), Capability.ACT],
  [rpc("BlobService", "CommitUpload"), Capability.ACT],
  [rpc("SessionService", "ReadHistory"), Capability.VIEW],
  [rpc("SessionService", "CreateSession"), Capability.ACT],
  [rpc("SessionService", "StartSession"), Capability.ACT],
  [rpc("TaskService", "CreateTask"), Capability.ACT],
  [rpc("TaskService", "ArchiveTask"), Capability.ACT],
  [rpc("SettingsService", "WriteOverrides"), Capability.ACT],
  [rpc("PlaybookService", "ReadPlaybook"), Capability.VIEW],
  [rpc("PlaybookService", "SavePlaybook"), Capability.ACT],
  [rpc("SubtaskService", "CreateSubtask"), Capability.ACT],
  [rpc("SubtaskService", "InspectSubtaskFinish"), Capability.VIEW],
  [rpc("SubtaskService", "FinalizeSubtask"), Capability.ACT],
  [rpc("ArtifactService", "InstallReviewHandoff"), Capability.ACT],
  [rpc("ArtifactService", "RecordOutboundHandoff"), Capability.ACT],
  [rpc("JobService", "StartStorageScan"), Capability.ACT],
  [rpc("JobService", "StartBackup"), Capability.ACT],
  [rpc("JobService", "StartPurge"), Capability.ADMIN],
]);

/** Every request carries a token. A header that is not the daemon's own or a minted one, including an empty or malformed one, is
 * never treated as no header, and no header is UNAUTHENTICATED too (R8). `method` is `<service>/<method>`: a minted token holds AGENT, and
 * for a method in `AGENT_RPCS` also the capability that method checks. */
export function credentials(header: Headers, peer: PeerClass, secret: Buffer, minted: TokenRegistry, method: string): ContextValues {
  const given = bearer(header);
  if (given === null) throw new ConnectError("a token is required", Code.Unauthenticated);
  let caps: Capability[];
  if (matches(given, secret)) caps = peer === "other" ? LOCAL_OTHER : FULL;
  else if (minted.has(given)) {
    const need = AGENT_RPCS.get(method);
    caps = need === undefined ? [Capability.AGENT] : [Capability.AGENT, need];
  } else throw new ConnectError("wrong token", Code.Unauthenticated);
  return createContextValues().set(CAPS, new Set(caps));
}

export function capabilitiesOf(ctx: HandlerContext): ReadonlySet<Capability> {
  return ctx.values.get(CAPS);
}

export function requireCapability(ctx: HandlerContext, capability: Capability): void {
  if (capabilitiesOf(ctx).has(capability)) return;
  throw new ConnectError(`needs ${Capability[capability]}`, Code.PermissionDenied, undefined, [
    { desc: ErrorDetailSchema, value: { code: "permission_denied", message: `this credential cannot do that; it needs ${Capability[capability]}` } },
  ]);
}
