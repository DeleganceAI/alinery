import * as ipc from "../ipc";
import { extensionUiConfirm } from "../ompRpc";

/** Extension URLs may only use HTTP(S); custom schemes can invoke other applications. */
function browsableUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? raw : null;
  } catch {
    return null;
  }
}

/** Acknowledge whether the browser actually opened, including invalid URLs and opener failures. */
export async function settleOpenUrl(sessionId: string, requestId: string, raw: string | undefined, reportError: (error: string) => void): Promise<void> {
  const url = browsableUrl(raw);
  if (!url) reportError("Blocked that link: only http and https links can be opened.");
  const opened = url
    ? await ipc.openUrl(url).then(
        () => true,
        (error) => {
          reportError(String(error));
          return false;
        },
      )
    : false;
  await ipc.rpcWriteSession(sessionId, extensionUiConfirm(requestId, opened));
}
