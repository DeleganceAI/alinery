// Bearer-token auth and capabilities for the RPC socket (plan 2.1.10, R8).
import { timingSafeEqual } from "node:crypto";
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
 * A missing file gives an empty secret: no token then matches, and only the no-token class works. */
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

/** No header is the unauthenticated class (AGENT only). A header that is not the daemon's token,
 * including an empty or malformed one, is never treated as no header. */
export function credentials(header: Headers, peer: PeerClass, secret: Buffer): ContextValues {
  const given = bearer(header);
  let caps: Capability[];
  if (given === null) caps = [Capability.AGENT];
  else if (!matches(given, secret)) throw new ConnectError("wrong token", Code.Unauthenticated);
  else caps = peer === "other" ? LOCAL_OTHER : FULL;
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
