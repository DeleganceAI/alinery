import { describe, expect, it } from "vitest";
import { decodeChannelFrame } from "./channelFrame";

// Mirrors `frame_session_channel_bytes` in src-tauri/src/session.rs:
//   [u32 payload length, LE][payload][zero padding to at least 1024 bytes]
// Kept as an explicit re-implementation rather than a fixture so that a change to the
// Rust framing shows up here as a failing test rather than as a silently stale blob.
const TAURI_RAW_FETCH_MIN_BYTES = 1024;
function frameLikeRust(payload: number[]): ArrayBuffer {
  const frameLen = Math.max(4 + payload.length, TAURI_RAW_FETCH_MIN_BYTES);
  const buf = new ArrayBuffer(frameLen);
  new DataView(buf).setUint32(0, payload.length, true);
  new Uint8Array(buf).set(payload, 4);
  return buf;
}

describe("decodeChannelFrame", () => {
  // The whole reason the length header exists. Rust pads every frame up to 1 KiB to keep
  // Tauri off the `webview.eval` slow path, so `bytes.byteLength` is the wrong length for
  // any short read — trusting it would write ~1000 NUL bytes into xterm after every
  // keystroke's worth of output.
  it("returns only the payload, not the padding Rust added", () => {
    const payload = [...new TextEncoder().encode("hello")];
    const frame = frameLikeRust(payload);

    expect(frame.byteLength).toBe(TAURI_RAW_FETCH_MIN_BYTES);
    const decoded = decodeChannelFrame(frame);
    expect(decoded).not.toBeNull();
    expect(decoded?.length).toBe(5);
    expect(new TextDecoder().decode(decoded as Uint8Array)).toBe("hello");
  });

  it("round-trips a payload larger than the padding threshold", () => {
    const payload = Array.from({ length: 4096 }, (_, i) => i % 256);
    const decoded = decodeChannelFrame(frameLikeRust(payload));
    expect(decoded?.length).toBe(4096);
    expect([...(decoded as Uint8Array)]).toEqual(payload);
  });

  it("decodes an empty payload as empty, not as the whole padded frame", () => {
    const decoded = decodeChannelFrame(frameLikeRust([]));
    expect(decoded?.length).toBe(0);
  });

  it("reads the length little-endian", () => {
    // 0x00000102 LE == 258. Read big-endian this would be 0x02010000, wildly out of range.
    const buf = new ArrayBuffer(1024);
    new DataView(buf).setUint32(0, 258, true);
    expect(decodeChannelFrame(buf)?.length).toBe(258);
  });

  it("drops a frame too short to hold a header", () => {
    expect(decodeChannelFrame(new ArrayBuffer(0))).toBeNull();
    expect(decodeChannelFrame(new ArrayBuffer(3))).toBeNull();
  });

  it("drops a frame whose declared length runs past the buffer", () => {
    const buf = new ArrayBuffer(64);
    new DataView(buf).setUint32(0, 9999, true);
    // Without the bounds check this constructs a Uint8Array past the end and throws,
    // killing the channel handler for the rest of the session.
    expect(decodeChannelFrame(buf)).toBeNull();
  });

  it("accepts a frame that is exactly header plus payload with no padding", () => {
    const buf = new ArrayBuffer(4 + 3);
    new DataView(buf).setUint32(0, 3, true);
    new Uint8Array(buf).set([1, 2, 3], 4);
    expect([...(decodeChannelFrame(buf) as Uint8Array)]).toEqual([1, 2, 3]);
  });
});
