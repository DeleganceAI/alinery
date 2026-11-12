// Members of a daemon someone else started: a coworker's app on a shared box asks to join, a member says yes or no, and the
// asker collects a token equal to the daemon's own. Tokens live in memory and die with the daemon, so a restart makes everyone
// but its starter ask again.
import { create } from "@bufbuild/protobuf";
import { EntitySchema, JoinRequestsSchema } from "alinery-proto/alinery/v1/entities_pb";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Store } from "../sync/store.ts";

export const JOIN_REQUESTS_KEY = "daemon/_/join-requests";

const REQUEST_TTL_MS = 10 * 60_000;
// Anyone who can reach the socket may ask, so the pending list is bounded.
const MAX_PENDING = 20;
const MAX_LABEL = 120;

type Request = { id: string; label: string; secret: Buffer; at: number; approved: boolean };
export type JoinAnswer = { state: "pending" | "approved" | "denied"; token: string };

const sameBytes = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

export class Members {
  private readonly requests = new Map<string, Request>();
  private readonly tokens: Buffer[] = [];

  constructor(
    private readonly changed: (pending: { id: string; label: string; at: number }[]) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  request(label: string): { id: string; secret: string } {
    this.prune();
    if ([...this.requests.values()].filter((r) => !r.approved).length >= MAX_PENDING) throw new Error("too many join requests are waiting");
    const id = randomBytes(8).toString("hex");
    const secret = randomBytes(32).toString("hex");
    const clean = label.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_LABEL) || "someone";
    this.requests.set(id, { id, label: clean, secret: Buffer.from(secret), at: this.now(), approved: false });
    this.publish();
    return { id, secret };
  }

  /** The asker's poll. An approved request hands out its token once and is gone; an unknown, expired or denied one reads denied. */
  collect(id: string, secret: string): JoinAnswer {
    this.prune();
    const request = this.requests.get(id);
    if (!request || !sameBytes(request.secret, Buffer.from(secret))) return { state: "denied", token: "" };
    if (!request.approved) return { state: "pending", token: "" };
    this.requests.delete(id);
    const token = randomBytes(32).toString("hex");
    this.tokens.push(Buffer.from(token));
    return { state: "approved", token };
  }

  /** False when the request is no longer waiting (expired, or another member answered). */
  decide(id: string, approve: boolean): boolean {
    this.prune();
    const request = this.requests.get(id);
    if (!request || request.approved) return false;
    if (approve) request.approved = true;
    else this.requests.delete(id);
    this.publish();
    return true;
  }

  has(token: string): boolean {
    const given = Buffer.from(token);
    let found = false;
    for (const known of this.tokens) if (sameBytes(given, known)) found = true; // every one compared: the time names none
    return found;
  }

  /** Drop expired requests; main runs it on a timer so a stale request leaves the members' screens. */
  prune(): void {
    const cutoff = this.now() - REQUEST_TTL_MS;
    let dropped = false;
    for (const [id, request] of this.requests)
      if (request.at < cutoff) {
        this.requests.delete(id);
        dropped = true;
      }
    if (dropped) this.publish();
  }

  private publish(): void {
    this.changed([...this.requests.values()].filter((r) => !r.approved).map(({ id, label, at }) => ({ id, label, at })));
  }
}

export function commitJoinRequests(store: Store, pending: { id: string; label: string; at: number }[]): void {
  store.commit([
    create(EntitySchema, {
      key: JOIN_REQUESTS_KEY,
      value: { case: "joinRequests", value: create(JoinRequestsSchema, { requests: pending.map((r) => ({ id: r.id, label: r.label, requestedAtMs: BigInt(r.at) })) }) },
    }),
  ]);
}
