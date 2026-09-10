use crate::MessageAdapter;
use std::io::{self, Write};

pub const BRACKETED_PASTE_START: &[u8] = b"\x1b[200~";
pub const BRACKETED_PASTE_END: &[u8] = b"\x1b[201~";
pub const MESSAGE_SUBMIT: &[u8] = b"\r";

pub fn validate_message_body(adapter: MessageAdapter, body: &[u8]) -> Result<(), &'static str> {
    if adapter == MessageAdapter::Unsupported {
        return Err("message-adapter-unsupported");
    }
    if std::str::from_utf8(body).is_err() {
        return Err("message-body-invalid-utf8");
    }
    if body.is_empty() {
        return Err("message-body-empty");
    }
    if body.windows(BRACKETED_PASTE_END.len()).any(|bytes| bytes == BRACKETED_PASTE_END) {
        return Err("message-body-contains-bracketed-paste-end");
    }
    Ok(())
}

pub fn write_message<W: Write + ?Sized>(adapter: MessageAdapter, writer: &mut W, body: &[u8]) -> io::Result<()> {
    match adapter {
        MessageAdapter::OmpBracketedPaste => {
            writer.write_all(BRACKETED_PASTE_START)?;
            writer.write_all(body)?;
            writer.write_all(BRACKETED_PASTE_END)?;
            writer.write_all(MESSAGE_SUBMIT)
        }
        MessageAdapter::Unsupported => Err(io::Error::new(io::ErrorKind::InvalidInput, "message-adapter-unsupported")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_supported_utf8_without_normalizing() {
        for body in [
            b" hello ".as_slice(),
            b"   ".as_slice(),
            b"\n".as_slice(),
            b" \r\n ".as_slice(),
            "first\nsecond\rthird".as_bytes(),
            "é猫🙂".as_bytes(),
        ] {
            assert_eq!(validate_message_body(MessageAdapter::OmpBracketedPaste, body), Ok(()));
        }
    }

    #[test]
    fn rejects_empty_invalid_unsupported_and_end_marker_bodies() {
        assert_eq!(validate_message_body(MessageAdapter::OmpBracketedPaste, b""), Err("message-body-empty"));
        assert_eq!(validate_message_body(MessageAdapter::OmpBracketedPaste, &[0xff]), Err("message-body-invalid-utf8"));
        assert_eq!(validate_message_body(MessageAdapter::Unsupported, b"hello"), Err("message-adapter-unsupported"));
        for body in [b"\x1b[201~tail".as_slice(), b"head\x1b[201~tail".as_slice(), b"head\x1b[201~".as_slice()] {
            assert_eq!(
                validate_message_body(MessageAdapter::OmpBracketedPaste, body),
                Err("message-body-contains-bracketed-paste-end")
            );
        }
    }

    #[test]
    fn writes_exact_segments_and_one_submit_byte() {
        #[derive(Default)]
        struct RecordingWriter {
            calls: Vec<Vec<u8>>,
        }
        impl Write for RecordingWriter {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                self.calls.push(bytes.to_vec());
                Ok(bytes.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }

        let body = b"  a\n\rb  ";
        let mut writer = RecordingWriter::default();
        write_message(MessageAdapter::OmpBracketedPaste, &mut writer, body).unwrap();
        assert_eq!(
            writer.calls,
            vec![BRACKETED_PASTE_START.to_vec(), body.to_vec(), BRACKETED_PASTE_END.to_vec(), MESSAGE_SUBMIT.to_vec()]
        );
        assert_eq!(writer.calls.concat(), [BRACKETED_PASTE_START, body, BRACKETED_PASTE_END, MESSAGE_SUBMIT].concat());
    }

    #[test]
    fn returns_segment_write_errors() {
        struct FailingWriter(usize);
        impl Write for FailingWriter {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                if self.0 == 0 {
                    return Err(io::Error::other("fixture failure"));
                }
                self.0 -= 1;
                Ok(bytes.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }

        let error = write_message(MessageAdapter::OmpBracketedPaste, &mut FailingWriter(2), b"body").unwrap_err();
        assert_eq!(error.to_string(), "fixture failure");
    }
}
