import { useState } from "react";
import { ChatMarkdown } from "../chat/CopyMessage";
import type { PendingUi } from "../chatTranscript";

export function ChatExtensionPrompt({ request, onSubmit, onCancel }: { request: PendingUi; onSubmit: (value: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState("");
  const heading = (
    <>
      <p className="chat-msg-title">{request.title || (request.method === "select" ? "Choose an option" : "Input required")}</p>
      {request.instructions ? <ChatMarkdown text={request.instructions} showBlockCopyButtons={false} preserveLineBreaks /> : null}
    </>
  );
  if (request.method === "select") {
    return (
      <div className="chat-ui-prompt">
        {heading}
        <div className="chat-ui-prompt-options">
          {(request.options ?? []).map((option, index) => (
            <button key={option} type="button" className="btn small" onClick={() => onSubmit(option)}>
              {option}
              {request.optionDetails?.[index]?.description ? ` — ${request.optionDetails[index].description}` : ""}
            </button>
          ))}
          <button type="button" className="btn ghost small" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    );
  }
  if (request.method !== "input" && request.method !== "editor") return null;
  return (
    <form
      className="chat-ui-prompt"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) onSubmit(value);
      }}
    >
      {heading}
      <input
        className="field-input"
        value={value}
        placeholder={request.placeholder}
        aria-label={request.title || "Extension input"}
        onChange={(e) => setValue(e.currentTarget.value)}
      />
      <div className="chat-ui-prompt-options">
        <button type="submit" className="btn primary small" disabled={!value.trim()}>
          Send
        </button>
        <button type="button" className="btn ghost small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
