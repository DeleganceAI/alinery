import { useState } from "react";
import type { useProviderAccess } from "../chat/providerAccess";
import type { ProviderLoginStatus } from "../chat/providers";

type Access = ReturnType<typeof useProviderAccess>;

function eventText(event: ProviderLoginStatus["events"][number]): string {
  if (event.type === "device_code") return `Code ${event.userCode} at ${event.verificationUri}`;
  if (event.type === "info" || event.type === "progress") return event.message;
  if (event.type === "auth_url") return event.instructions || "Opened the sign-in page.";
  return "";
}

export function ProviderAccessPanel({ access }: { access: Access }) {
  const prompt = access.login?.prompt;
  return (
    <>
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
      {access.login && access.login.events.length > 0 ? <p className="dim">{access.login.events.map(eventText).filter(Boolean).join("\n")}</p> : null}
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
          <PromptForm prompt={prompt} secret={prompt.type === "secret"} onSubmit={(value) => void access.reply(value)} onCancel={() => void access.cancel()} />
        )
      ) : null}
    </>
  );
}

function PromptForm({
  prompt,
  secret,
  onSubmit,
  onCancel,
}: {
  prompt: { message: string; placeholder?: string };
  secret: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  return (
    <form
      className="chat-ui-prompt"
      onSubmit={(event) => {
        event.preventDefault();
        if (value.trim()) onSubmit(value);
      }}
    >
      <p className="chat-msg-title">{prompt.message}</p>
      <input
        className="field-input"
        type={secret ? "password" : "text"}
        value={value}
        placeholder={prompt.placeholder}
        aria-label={prompt.message}
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
    </form>
  );
}

export function CustomEndpointForm({ access }: { access: Access }) {
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [models, setModels] = useState("");
  const [apiKey, setApiKey] = useState("");
  return (
    <form
      className="chat-ui-prompt"
      onSubmit={(event) => {
        event.preventDefault();
        const id = name
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 32);
        void access
          .saveCustom({
            id,
            name: name.trim(),
            baseUrl: baseUrl.trim(),
            apiKey: apiKey.trim(),
            keepKey: false,
            models: models.split(/[,\s]+/).filter(Boolean),
          })
          .then(() => {
            setName("");
            setBaseUrl("");
            setModels("");
            setApiKey("");
          })
          .catch(() => undefined);
      }}
    >
      <p className="chat-msg-title">OpenAI-compatible endpoint</p>
      {access.custom.length > 0 ? (
        <ul className="chat-model-list">
          {access.custom.map((row) => (
            <li key={row.id}>
              <div className="chat-model-item">
                <span>
                  {row.name} · {row.models.join(", ")}
                </span>
                <button type="button" className="btn ghost small" onClick={() => void access.deleteCustom(row.id)}>
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <input className="field-input" aria-label="Endpoint name" placeholder="Name" value={name} onChange={(event) => setName(event.currentTarget.value)} />
      <input className="field-input" aria-label="Endpoint URL" placeholder="https://host/v1" value={baseUrl} onChange={(event) => setBaseUrl(event.currentTarget.value)} />
      <input className="field-input" aria-label="Model ids" placeholder="model ids, comma separated" value={models} onChange={(event) => setModels(event.currentTarget.value)} />
      <input
        className="field-input"
        type="password"
        aria-label="Endpoint API key"
        placeholder="API key, blank if the server has none"
        value={apiKey}
        onChange={(event) => setApiKey(event.currentTarget.value)}
      />
      <div className="chat-ui-prompt-options">
        <button type="submit" className="btn small" disabled={!name.trim() || !baseUrl.trim() || !models.trim()}>
          Add endpoint
        </button>
      </div>
    </form>
  );
}
