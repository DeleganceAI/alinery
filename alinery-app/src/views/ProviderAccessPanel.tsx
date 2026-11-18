import { useEffect, useRef, useState } from "react";
import { CopyTextButton } from "../chat/CopyMessage";
import type { useProviderAccess } from "../chat/providerAccess";
import type { ProviderLoginStatus } from "../chat/providers";
import { confirmDanger } from "../confirm";
import * as ipc from "../ipc";
import { CustomEndpointEditor } from "./CustomEndpointEditor";

type Access = ReturnType<typeof useProviderAccess>;
type LoginEvent = ProviderLoginStatus["events"][number];

/** The code and link instructions are typed into the browser, so they show only while the sign-in waits. */
const isCodeEvent = (event: LoginEvent) => event.type === "device_code" || (event.type === "auth_url" && !!event.instructions);

function eventText(event: LoginEvent): string {
  if (event.type === "info" || event.type === "progress") return event.message;
  // An auth_url is shown as itself: the page it opens, and the instructions it came with.
  return "";
}

/** What a sign-in needs typed into the browser. A device flow's instructions end with `code: XXXX`, so that part gets a copy control. */
function SignInInstructions({ text, code = /code:?\s*(\S+)\s*$/i.exec(text)?.[1] }: { text: string; code?: string }) {
  return (
    <p className="chat-sign-in-instructions">
      {text} {code ? <CopyTextButton text={code} label="code" /> : null}
    </p>
  );
}

function CodeEvent({ event }: { event: LoginEvent }) {
  if (event.type === "device_code") {
    return (
      <>
        <SignInInstructions text={`Enter code: ${event.userCode}`} code={event.userCode} />
        <p className="dim">at {event.verificationUri}</p>
      </>
    );
  }
  return event.type === "auth_url" && event.instructions ? <SignInInstructions text={event.instructions} /> : null;
}

/** The sign-in page opens itself, but the tab can be gone (closed, or a browser that refused to open): keep a way back to it. */
function SignInPage({ event }: { event: LoginEvent }) {
  if (event.type !== "auth_url") return null;
  return (
    <p className="chat-sign-in-page">
      <button type="button" className="btn ghost small" onClick={() => void ipc.openUrl(event.url).catch(() => undefined)}>
        Open sign-in page
      </button>
      <CopyTextButton text={event.url} label="sign-in link" />
      <span className="dim">{hostOf(event.url)}</span>
    </p>
  );
}

/**
 * A browser sign-in finishes on a loopback address that only the daemon's own machine answers. When the
 * sign-in runs on another machine (a remote repository), the browser shows "Can't connect to the server"
 * and that error page's address is exactly what has to be pasted back. Nobody guesses that, so say it.
 */
function CallbackHelp({ placeholder }: { placeholder?: string }) {
  const target = /^https?:\/\/([^/]+)/.exec(placeholder ?? "")?.[1];
  return (
    <p className="chat-sign-in-callback">
      After you approve the sign-in, your browser lands on <code>{target ?? "a local address"}</code> and shows <strong>“Can’t connect to the server”</strong>. That is expected
      when the sign-in runs on another machine. Copy the <strong>whole address from the address bar</strong> and paste it below to finish.
    </p>
  );
}

export function ProviderAccessPanel({ access }: { access: Access }) {
  const prompt = access.login?.prompt;
  const waiting = access.login?.status === "pending" || access.login?.status === "prompt";
  const events = access.login?.events ?? [];
  const notes = events.map(eventText).filter(Boolean);
  const shown = !!(access.choice || access.busy || access.signedIn);
  const eventCount = access.login?.events.length ?? 0;
  const promptMessage = prompt?.message;
  const ref = useRef<HTMLDivElement>(null);
  // The panel sits above the provider list; a row clicked near the bottom would otherwise start a login the user can't see.
  useEffect(() => {
    if (!shown && !eventCount && !promptMessage) return;
    ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [shown, eventCount, promptMessage]);
  return (
    <div ref={ref}>
      {access.signedIn ? (
        <p className="chat-ui-prompt" role="status">
          Successfully signed in to {access.signedIn}.
        </p>
      ) : null}
      {access.choice ? (
        <div className="chat-ui-prompt">
          <p className="chat-msg-title">{access.choice.name}</p>
          <div className="chat-ui-prompt-options">
            {access.choice.apiKey ? (
              <button type="button" className="btn small" onClick={() => void access.start(access.choice?.id ?? "", "api_key")}>
                {access.choice.apiKeyName || "API key"}
              </button>
            ) : null}
            {access.choice.oauth ? (
              <button type="button" className="btn small" onClick={() => void access.start(access.choice?.id ?? "", "oauth")}>
                {access.choice.oauthName || "Browser sign-in"}
              </button>
            ) : null}
            <button type="button" className="btn ghost small" onClick={() => access.choose(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {waiting
        ? events.filter(isCodeEvent).map((event, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the daemon appends events and never reorders them
            <CodeEvent key={index} event={event} />
          ))
        : null}
      {waiting
        ? events
            .filter((event) => event.type === "auth_url")
            .map((event, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the daemon appends events and never reorders them
              <SignInPage key={index} event={event} />
            ))
        : null}
      {notes.length > 0 ? <p className="dim">{notes.join("\n")}</p> : null}
      {access.busy && !prompt ? (
        // A login waiting on a device code asks nothing, so this is its only way out.
        <div className="chat-ui-prompt-options">
          <button type="button" className="btn ghost small" onClick={() => void access.cancel()}>
            Cancel sign-in
          </button>
        </div>
      ) : null}
      {prompt ? (
        prompt.type === "select" ? (
          <div className="chat-ui-prompt">
            <p className="chat-msg-title">{prompt.message}</p>
            <div className="chat-ui-prompt-options">
              {(prompt.options ?? []).map((option) => (
                <button key={option.id} type="button" className="btn small" onClick={() => void access.reply(option.id)}>
                  {option.label}
                  {option.description ? ` — ${option.description}` : ""}
                </button>
              ))}
              <button type="button" className="btn ghost small" onClick={() => void access.cancel()}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <PromptForm
            key={`${prompt.type}:${prompt.message}`}
            prompt={prompt}
            secret={prompt.type === "secret"}
            // A pasted callback URL is a long value the browser hands over in the address bar, not something typed.
            callback={prompt.type === "manual_code"}
            // Listening for the redirect makes the paste a fallback, not the instruction.
            armed={access.callbackArmed}
            onSubmit={(value) => void access.reply(value)}
            onCancel={() => void access.cancel()}
          />
        )
      ) : null}
    </div>
  );
}

function PromptForm({
  prompt,
  secret,
  callback,
  armed,
  onSubmit,
  onCancel,
}: {
  prompt: { message: string; placeholder?: string };
  secret: boolean;
  /** The value is the redirect URL the browser failed to deliver; the help says where to get it. */
  callback?: boolean;
  /** This window is listening on the redirect's loopback address: it finishes the sign-in itself. */
  armed?: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const field = (
    <>
      <input
        className="field-input"
        type={secret ? "password" : "text"}
        value={value}
        placeholder={prompt.placeholder}
        aria-label={prompt.message}
        // biome-ignore lint/a11y/noAutofocus: the form is the only thing the panel waits on
        autoFocus
        onChange={(event) => setValue(event.currentTarget.value)}
      />
      <div className="chat-ui-prompt-options">
        <button type="submit" className="btn primary small" disabled={!value.trim()}>
          Continue
        </button>
        <button type="button" className="btn ghost small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </>
  );
  return (
    <form
      className="chat-ui-prompt"
      onSubmit={(event) => {
        event.preventDefault();
        if (value.trim()) onSubmit(value);
      }}
    >
      <p className="chat-msg-title">{prompt.message}</p>
      {armed ? (
        // Armed: the redirect comes back to this window on its own, so the paste is only for when it does not.
        <>
          <p className="chat-sign-in-armed" role="status">
            Finish signing in in your browser. This window picks the result up by itself.
          </p>
          <details className="chat-sign-in-fallback">
            <summary>Didn’t work? Paste the address instead</summary>
            <CallbackHelp placeholder={prompt.placeholder} />
            {field}
          </details>
        </>
      ) : (
        <>
          {callback ? <CallbackHelp placeholder={prompt.placeholder} /> : null}
          {field}
        </>
      )}
    </form>
  );
}

/** The saved custom endpoints, each with Edit and Remove, and Add, which opens the editor. */
export function CustomEndpointForm({ access }: { access: Access }) {
  const [editing, setEditing] = useState<Access["custom"][number] | "new" | null>(null);
  const remove = async (row: Access["custom"][number]) => {
    const what = `${row.models.length === 1 ? "Its model" : `Its ${row.models.length} models`}${row.hasKey ? " and saved key" : ""}`;
    if (await confirmDanger(`Remove ${row.name}?`, `${what} are deleted from this machine. Sessions using them stop working.`, "Remove")) {
      await access.deleteCustom(row.id);
    }
  };
  return (
    <div className="chat-ui-prompt">
      <p className="chat-msg-title">OpenAI-compatible endpoints</p>
      {access.custom.length > 0 ? (
        <ul className="chat-model-list chat-provider-cards">
          {access.custom.map((row) => (
            <li key={row.id}>
              <div className="chat-model-item">
                <span>
                  {row.name}
                  <span className="chat-provider-detail">
                    {row.models.length === 1 ? row.models[0] : `${row.models.length} models`} · {hostOf(row.baseUrl)}
                    {row.hasKey ? "" : " · no key"}
                  </span>
                </span>
                <span className="chat-model-item-side">
                  <button type="button" className="btn ghost small" onClick={() => setEditing(row)}>
                    Edit
                  </button>
                  <button type="button" className="btn ghost small" onClick={() => void remove(row)}>
                    Remove
                  </button>
                </span>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="dsc">Any API that speaks OpenAI's chat completions or responses: DeepInfra, Together, OpenRouter, vLLM, Ollama.</p>
      )}
      <div className="chat-ui-prompt-options">
        <button type="button" className="btn small" onClick={() => setEditing("new")}>
          Add endpoint
        </button>
      </div>
      {editing ? <CustomEndpointEditor editing={editing === "new" ? null : editing} check={access.checkCustom} save={access.saveCustom} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
