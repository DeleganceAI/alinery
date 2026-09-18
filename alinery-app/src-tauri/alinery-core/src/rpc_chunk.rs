//! Reassemble OMP protocol-v2 `rpc_chunk` stdout frames.
//!
//! Official wire: [oh-my-pi `docs/rpc.md`](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md).
//! alineryd runs this before forwarding lines to `rpc_attach` clients.

use serde_json::Value;

pub const MAX_REASSEMBLED_FRAME_BYTES: usize = 64 * 1024 * 1024;

pub struct RpcChunkAssembler {
    pending: Option<Pending>,
}

struct Pending {
    chunk_id: String,
    count: usize,
    byte_length: usize,
    parts: Vec<Option<Vec<u8>>>,
    received: usize,
}

impl Default for RpcChunkAssembler {
    fn default() -> Self {
        Self::new()
    }
}

impl RpcChunkAssembler {
    pub fn new() -> Self {
        Self { pending: None }
    }

    pub fn reset(&mut self) {
        self.pending = None;
    }

    /// `line` is one JSONL frame, including a trailing newline when present.
    /// Returns `Ok(None)` while a chunk sequence is still incomplete.
    pub fn push_jsonl(&mut self, line: &[u8]) -> Result<Option<Vec<u8>>, String> {
        let trimmed = trim_nl(line);
        if trimmed.is_empty() {
            return Ok(None);
        }
        let value: Value = serde_json::from_slice(trimmed).map_err(|_| "rpc_chunk: malformed json".to_string())?;
        if value.get("type").and_then(Value::as_str) != Some("rpc_chunk") {
            if self.pending.is_some() {
                self.pending = None;
                return Err("rpc_chunk: interrupted by non-chunk frame".into());
            }
            return Ok(Some(with_newline(trimmed)));
        }
        self.push_chunk(&value)
    }

    fn push_chunk(&mut self, value: &Value) -> Result<Option<Vec<u8>>, String> {
        let chunk_id = value.get("chunkId").and_then(Value::as_str).ok_or("rpc_chunk: missing chunkId")?.to_string();
        let index = value.get("index").and_then(Value::as_u64).ok_or("rpc_chunk: missing index")? as usize;
        let count = value.get("count").and_then(Value::as_u64).ok_or("rpc_chunk: missing count")? as usize;
        let byte_length = value.get("byteLength").and_then(Value::as_u64).ok_or("rpc_chunk: missing byteLength")? as usize;
        let data = value.get("data").and_then(Value::as_str).ok_or("rpc_chunk: missing data")?;
        if count == 0 || byte_length == 0 {
            return Err("rpc_chunk: empty sequence".into());
        }
        if byte_length > MAX_REASSEMBLED_FRAME_BYTES {
            return Err("rpc_chunk: exceeds reassembly limit".into());
        }
        if index >= count {
            return Err("rpc_chunk: index out of range".into());
        }
        let decoded = decode_base64(data).map_err(|error| format!("rpc_chunk: {error}"))?;
        match &mut self.pending {
            Some(pending) => {
                if pending.chunk_id != chunk_id || pending.count != count || pending.byte_length != byte_length {
                    self.pending = None;
                    return Err("rpc_chunk: interleaved sequence".into());
                }
                if pending.parts[index].is_some() {
                    self.pending = None;
                    return Err("rpc_chunk: duplicate index".into());
                }
                pending.parts[index] = Some(decoded);
                pending.received += 1;
            }
            None => {
                if index != 0 {
                    return Err("rpc_chunk: sequence did not start at index 0".into());
                }
                let mut parts = vec![None; count];
                parts[0] = Some(decoded);
                self.pending = Some(Pending {
                    chunk_id,
                    count,
                    byte_length,
                    parts,
                    received: 1,
                });
            }
        }
        let Some(pending) = &self.pending else {
            return Ok(None);
        };
        if pending.received != pending.count {
            return Ok(None);
        }
        let finished = self.pending.take().expect("complete sequence");
        let mut out = Vec::with_capacity(finished.byte_length);
        for part in finished.parts {
            out.extend_from_slice(&part.expect("filled part"));
        }
        if out.len() != finished.byte_length {
            return Err("rpc_chunk: byteLength mismatch".into());
        }
        if std::str::from_utf8(&out).is_err() {
            return Err("rpc_chunk: reassembled bytes are not utf-8".into());
        }
        serde_json::from_slice::<Value>(&out).map_err(|_| "rpc_chunk: reassembled bytes are not json".to_string())?;
        Ok(Some(with_newline(&out)))
    }
}

fn trim_nl(line: &[u8]) -> &[u8] {
    let mut end = line.len();
    while end > 0 && (line[end - 1] == b'\n' || line[end - 1] == b'\r') {
        end -= 1;
    }
    &line[..end]
}

fn with_newline(bytes: &[u8]) -> Vec<u8> {
    let mut out = bytes.to_vec();
    out.push(b'\n');
    out
}

/// Standard padded base64. ASCII whitespace is accepted for the OMP chunk wire.
pub fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    let length = input.bytes().filter(|byte| !byte.is_ascii_whitespace()).count();
    if !length.is_multiple_of(4) {
        return Err("invalid base64 length".into());
    }
    let mut out = Vec::with_capacity(length / 4 * 3);
    let mut bytes = input.bytes().filter(|byte| !byte.is_ascii_whitespace());
    for offset in (0..length).step_by(4) {
        let a = b64_val(bytes.next().unwrap())?;
        let b = b64_val(bytes.next().unwrap())?;
        let c = bytes.next().unwrap();
        let d = bytes.next().unwrap();
        if c == b'=' {
            if d != b'=' || offset + 4 != length || b & 0x0f != 0 {
                return Err("invalid base64 padding".into());
            }
            out.push((a << 2) | (b >> 4));
        } else {
            let cv = b64_val(c)?;
            if d == b'=' && (offset + 4 != length || cv & 0x03 != 0) {
                return Err("invalid base64 padding".into());
            }
            out.push((a << 2) | (b >> 4));
            out.push(((b & 0x0f) << 4) | (cv >> 2));
            if d != b'=' {
                out.push(((cv & 0x03) << 6) | b64_val(d)?);
            }
        }
    }
    Ok(out)
}

pub fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0];
        let b1 = chunk.get(1).copied().unwrap_or(0);
        let b2 = chunk.get(2).copied().unwrap_or(0);
        out.push(TABLE[(b0 >> 2) as usize] as char);
        out.push(TABLE[(((b0 & 3) << 4) | (b1 >> 4)) as usize] as char);
        out.push(if chunk.len() > 1 { TABLE[(((b1 & 15) << 2) | (b2 >> 6)) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[(b2 & 63) as usize] as char } else { '=' });
    }
    out
}

/// Attachment JSON uses only a canonical base64 string, never a byte array.
pub mod base64_bytes {
    use serde::{de::{Error, Visitor}, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&super::encode_base64(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
        struct Base64Visitor;
        impl Visitor<'_> for Base64Visitor {
            type Value = Vec<u8>;
            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a standard padded base64 string")
            }
            fn visit_str<E: Error>(self, value: &str) -> Result<Self::Value, E> {
                if value.bytes().any(|byte| byte.is_ascii_whitespace()) {
                    return Err(E::custom("base64 attachment must not contain whitespace"));
                }
                super::decode_base64(value).map_err(E::custom)
            }
        }
        deserializer.deserialize_str(Base64Visitor)
    }
}

fn b64_val(byte: u8) -> Result<u8, String> {
    match byte {
        b'A'..=b'Z' => Ok(byte - b'A'),
        b'a'..=b'z' => Ok(byte - b'a' + 26),
        b'0'..=b'9' => Ok(byte - b'0' + 52),
        b'+' => Ok(62),
        b'/' => Ok(63),
        _ => Err("invalid base64".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_standard_vectors_and_arbitrary_bytes_roundtrip() {
        for (bytes, encoded) in [
            (&b""[..], ""), (&b"f"[..], "Zg=="), (&b"fo"[..], "Zm8="),
            (&b"foo"[..], "Zm9v"), (&[0, 255, 128, 10][..], "AP+ACg=="),
        ] {
            assert_eq!(encode_base64(bytes), encoded);
            assert_eq!(decode_base64(encoded).unwrap(), bytes);
        }
        let bytes: Vec<u8> = (0..=255).collect();
        let attachment = crate::task_creation::TaskAttachment { name: "binary.bin".into(), bytes };
        let wire = serde_json::to_string(&attachment).unwrap();
        let decoded: crate::task_creation::TaskAttachment = serde_json::from_str(&wire).unwrap();
        assert_eq!(decoded.bytes, attachment.bytes);
        assert_eq!(decode_base64(" Z m 8 =\r\n").unwrap(), b"fo");
    }

    #[test]
    fn attachment_base64_rejects_arrays_and_malformed_encoding() {
        for encoded in ["Zg", "=m9v", "Zg=A", "Zg==AAAA", "Zh==", "Zm9=", "____", "é=="] {
            assert!(decode_base64(encoded).is_err(), "{encoded:?}");
        }
        for bytes in [serde_json::json!([0, 255]), serde_json::json!(" Zg=="), serde_json::json!("Zh==")] {
            assert!(serde_json::from_value::<crate::task_creation::TaskAttachment>(
                serde_json::json!({"name":"bad.bin","bytes":bytes})
            ).is_err());
        }
        let attachment: crate::task_creation::TaskAttachment =
            serde_json::from_str(r#"{"name":"empty.bin","bytes":""}"#).unwrap();
        assert!(attachment.bytes.is_empty());
    }

    #[test]
    fn pass_through_ready() {
        let mut assembler = RpcChunkAssembler::new();
        let line = br#"{"type":"ready"}"#;
        let out = assembler.push_jsonl(line).unwrap().unwrap();
        assert_eq!(out, b"{\"type\":\"ready\"}\n");
    }

    #[test]
    fn reassembles_two_chunks() {
        let mut assembler = RpcChunkAssembler::new();
        let first = assembler
            .push_jsonl(br#"{"type":"rpc_chunk","chunkId":"rpc-1","index":0,"count":2,"byteLength":35,"data":"eyJ0eXBlIjoibm90aWNlIiw="}"#)
            .unwrap();
        assert!(first.is_none());
        let second = assembler
            .push_jsonl(br#"{"type":"rpc_chunk","chunkId":"rpc-1","index":1,"count":2,"byteLength":35,"data":"InRleHQiOiJjaHVuay1vayJ9"}"#)
            .unwrap()
            .unwrap();
        assert_eq!(second, b"{\"type\":\"notice\",\"text\":\"chunk-ok\"}\n");
    }

    #[test]
    fn rejects_interleaved_non_chunk() {
        let mut assembler = RpcChunkAssembler::new();
        assembler
            .push_jsonl(br#"{"type":"rpc_chunk","chunkId":"rpc-1","index":0,"count":2,"byteLength":35,"data":"eyJ0eXBlIjoibm90aWNlIiw="}"#)
            .unwrap();
        let err = assembler.push_jsonl(br#"{"type":"ready"}"#).unwrap_err();
        assert!(err.contains("interrupted"));
    }
}
