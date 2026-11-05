import { expect, it, vi } from "vitest";

const daemonRpc = vi.fn((_repo: string) => async () => {});
vi.mock("../ipc", () => ({ daemonRpc: (repo: string) => daemonRpc(repo), daemonRpcCancel: () => {} }));

import { admin, daemonTransport } from "./transport";

it("keeps one transport per repo key", () => {
  expect(daemonTransport("/repo/a")).toBe(daemonTransport("/repo/a"));
  expect(daemonTransport("/repo/a")).not.toBe(daemonTransport("/repo/b"));
  expect(daemonRpc.mock.calls.map((c) => c[0])).toEqual(["/repo/a", "/repo/b"]);
});

it("builds an Admin client on that transport", () => {
  expect(typeof admin("/repo/a").hello).toBe("function");
  expect(daemonRpc).toHaveBeenCalledTimes(2);
});
