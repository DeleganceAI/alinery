import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CustomCheck } from "../chat/providers";
import { CUSTOM_ENDPOINT_REFERENCE, CUSTOM_ENDPOINT_STARTER } from "../customEndpointExample";
import { mockIpc } from "../test/mockIpc";
import { CustomEndpointEditor } from "./CustomEndpointEditor";

vi.mock("../ipc", () => mockIpc());

afterEach(cleanup);

const keyError: CustomCheck = { problems: [{ path: "my-endpoint.apiKey", message: "replace <your key> with your key", error: true }], tests: [] };
const clean: CustomCheck = { problems: [{ path: "my-endpoint.models[0].maxTokens", message: "not set; Alinery assumes 8,192", error: false }], tests: [] };

it("starts from the starter, lists each problem by field, and holds Save while one is an error", async () => {
  const check = vi.fn(async (config: string) => (config.includes("<your key>") ? keyError : clean));
  render(<CustomEndpointEditor editing={null} check={check} save={vi.fn()} onClose={vi.fn()} />);
  const source = screen.getByLabelText("Endpoint configuration") as HTMLTextAreaElement;
  expect(source.value).toBe(CUSTOM_ENDPOINT_STARTER);
  expect(await screen.findByText("replace <your key> with your key")).toBeTruthy();
  expect(screen.getByText("my-endpoint.apiKey")).toBeTruthy();
  expect(screen.getByText("1 error to fix")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Test and save" }) as HTMLButtonElement).disabled).toBe(true);

  fireEvent.change(source, { target: { value: CUSTOM_ENDPOINT_STARTER.replace("<your key>", "sk-1") } });
  expect(await screen.findByText("Ready to test. 1 warning")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Test and save" }) as HTMLButtonElement).disabled).toBe(false);

  fireEvent.click(screen.getByText("Start from this example"));
  expect(source.value).toBe(CUSTOM_ENDPOINT_REFERENCE);
});

it("tests the models before saving, and offers Save anyway when one fails", async () => {
  const failing: CustomCheck = { problems: [], tests: [{ provider: "p", model: "org/m", ok: false, detail: "model not found" }] };
  const check = vi.fn(async (_config: string, live: boolean) => (live ? failing : { problems: [], tests: [] }));
  const save = vi.fn(async () => undefined);
  const onClose = vi.fn();
  render(<CustomEndpointEditor editing={{ id: "p", name: "P", config: "p:\n  apiKey: <saved>\n" }} check={check} save={save} onClose={onClose} />);
  await screen.findByText("Ready to test");
  fireEvent.click(screen.getByRole("button", { name: "Test and save" }));
  expect(await screen.findByText("model not found")).toBeTruthy();
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Save anyway" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith("p:\n  apiKey: <saved>\n", "p"));
  expect(onClose).toHaveBeenCalled();
});
