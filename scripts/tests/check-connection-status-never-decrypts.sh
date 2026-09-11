#!/usr/bin/env bash
# Invariant guard:
#
#   The connection-status path must never read or parse the Linear credential.
#
# Opening Settings -> Connections used to decrypt the stored OAuth token purely to draw a
# badge. The Keychain item's ACL is keyed to the binary's code signature, which changes on
# every rebuild, so macOS raised "Alinery wants to use your confidential information" every
# single time and the grant never stuck. The fix was an existence-only lookup: a null
# password buffer means macOS never decrypts the item, so it never prompts.
#
# Nothing else can catch a regression here. A decrypt on the status path still compiles,
# still passes clippy, and still returns the right badge -- on a developer machine that has
# already clicked Always Allow, it even looks fine. The failure only shows up as a modal in
# front of a user, which no test in this repo can observe.
#
# So this asserts the shape instead: the status functions call exists(), and the decrypting
# functions have exactly one caller, the import path that genuinely needs the token.
#
# Run: ./scripts/tests/check-connection-status-never-decrypts.sh   (wired into scripts/check.sh)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONNECTIONS="$ROOT/alinery-app/src-tauri/src/connections.rs"

[ -f "$CONNECTIONS" ] || { echo "ERROR: cannot find $CONNECTIONS" >&2; exit 1; }

# The status path is linear_connection_status; its body runs to the next top-level fn.
status_body="$(awk '/^fn linear_connection_status/{f=1} f{print} f&&/^}/{exit}' "$CONNECTIONS")"

[ -n "$status_body" ] || { echo "ERROR: linear_connection_status not found -- this guard has drifted." >&2; exit 1; }

if printf '%s' "$status_body" | grep -qE 'load_linear_oauth_tokens|linear_oauth_access_token|macos_keychain::read|parse_linear_oauth_tokens'; then
  echo "ERROR: linear_connection_status decrypts or parses the Linear credential." >&2
  echo "       That is the macOS Keychain prompt this app removed. Use linear_tokens_present()," >&2
  echo "       which finds the item with a null password buffer and never decrypts it." >&2
  printf '%s\n' "$status_body" | grep -nE 'load_linear_oauth_tokens|linear_oauth_access_token|macos_keychain::read|parse_linear_oauth_tokens' >&2
  exit 1
fi

if ! printf '%s' "$status_body" | grep -q 'linear_tokens_present'; then
  echo "ERROR: linear_connection_status no longer asks linear_tokens_present() -- how does it" >&2
  echo "       decide the row is connected?" >&2
  exit 1
fi

# The existence check has to stay a null-buffer find, or the status path prompts again even
# though it calls the right function.
exists_body="$(awk '/pub fn exists/{f=1} f{print} f&&/^    }/{exit}' "$CONNECTIONS")"
if [ "$(printf '%s' "$exists_body" | grep -c 'ptr::null_mut()')" -lt 3 ]; then
  echo "ERROR: macos_keychain::exists no longer passes null for password_length, password_data" >&2
  echo "       and item_ref. A non-null password buffer makes macOS decrypt, and decrypting is" >&2
  echo "       what raises the prompt." >&2
  exit 1
fi

# The decrypting path is allowed to exist -- the import needs a real token -- but only for
# the import. A second caller is how this regresses without touching the status function.
callers="$(grep -n 'linear_oauth_access_token()' "$ROOT/alinery-app/src-tauri/src" -r | grep -v 'fn linear_oauth_access_token' || true)"
caller_count="$(printf '%s' "$callers" | grep -c . || true)"
if [ "$caller_count" -ne 1 ]; then
  echo "ERROR: linear_oauth_access_token has $caller_count callers; expected exactly 1 (the import)." >&2
  echo "       Every caller decrypts the Keychain item and can raise the prompt, so a new one" >&2
  echo "       needs to be a deliberate decision, not a side effect." >&2
  echo "$callers" >&2
  exit 1
fi

echo "OK: connection status never decrypts the Linear credential"
