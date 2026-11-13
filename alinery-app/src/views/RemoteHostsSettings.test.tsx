import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import * as ipc from "../ipc";
import type { RemoteHostView } from "../types";
import { RemoteHostsSettings } from "./RemoteHostsSettings";

vi.mock("../WindowChrome", () => ({ WindowControls: () => null }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const host = (state: RemoteHostView["state"]) =>
  ({ host_id: "strix", label: "Jon/Strix", destination: "aagent", state, phase: "", erased_sign_ins: [] }) as unknown as RemoteHostView;

it("connects a host that is not connected from its row", async () => {
  let state: RemoteHostView["state"] = "idle";
  vi.spyOn(ipc, "remoteHosts").mockImplementation(async () => [host(state)]);
  const connect = vi.spyOn(ipc, "remoteConnect").mockImplementation(async () => {
    state = "connected";
  });
  render(<RemoteHostsSettings />);
  fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Connect" })).toBeNull());
  expect(connect).toHaveBeenCalledWith("strix", false);
  expect(screen.getByText("Connected")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Credentials" }).hasAttribute("disabled")).toBe(false);
});
