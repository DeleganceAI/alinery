// Decoder for the session PTY byte channel.
//
// The Rust side (`frame_session_channel_bytes`, src-tauri/src/session.rs) writes:
//
//     [ u32 payload length, little-endian ][ payload ][ zero padding ]
//
// The padding exists because Tauri delivers raw channel bodies under 1 KiB through
// `webview.eval` as JavaScript array literals, which is ruinous for chatty TUIs — so every
// frame is padded up to TAURI_RAW_FETCH_MIN_BYTES (1024) to stay on the fast path. That
// makes the length header load-bearing: `bytes.byteLength` is the wrong length for any
// payload under ~1 KiB, and writing the whole buffer to xterm would emit a burst of NUL
// bytes after every short read.
//
// Kept out of SessionTerminal.tsx so it can be tested without pulling in xterm and its CSS.
export function decodeChannelFrame(bytes: ArrayBuffer): Uint8Array | null {
  if (bytes.byteLength < 4) return null;
  const payloadLength = new DataView(bytes).getUint32(0, true);
  // A length longer than the buffer means a truncated or corrupt frame: drop it rather
  // than reading past the end.
  if (payloadLength > bytes.byteLength - 4) return null;
  return new Uint8Array(bytes, 4, payloadLength);
}
