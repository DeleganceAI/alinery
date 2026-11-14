//! Base64 for the bytes that cross a JSON field (task attachments, the telemetry basic-auth header).
//!
//! The module keeps its old name; the old agent's `rpc_chunk` reassembler it was written for ran in the JSON-lines daemon.

/// Standard padded base64. ASCII whitespace is accepted.
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
    use serde::{
        de::{Error, Visitor},
        Deserializer, Serializer,
    };

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
            (&b""[..], ""),
            (&b"f"[..], "Zg=="),
            (&b"fo"[..], "Zm8="),
            (&b"foo"[..], "Zm9v"),
            (&[0, 255, 128, 10][..], "AP+ACg=="),
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
            assert!(serde_json::from_value::<crate::task_creation::TaskAttachment>(serde_json::json!({"name":"bad.bin","bytes":bytes})).is_err());
        }
        let attachment: crate::task_creation::TaskAttachment = serde_json::from_str(r#"{"name":"empty.bin","bytes":""}"#).unwrap();
        assert!(attachment.bytes.is_empty());
    }
}
