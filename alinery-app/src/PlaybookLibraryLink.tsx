import { ExternalLink } from "lucide-react";
import * as ipc from "./ipc";
import { toast } from "./toast";

export function PlaybookLibraryLink({ className }: { className?: string }) {
  return (
    <a
      className={`btn ghost playbook-library-link${className ? ` ${className}` : ""}`}
      href="https://alinery.ai/playbooks"
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => {
        event.stopPropagation();
        event.preventDefault();
        void ipc.openUrl("https://alinery.ai/playbooks").catch((cause: unknown) => toast(String(cause), "error"));
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      Browse the Playbook Library
      <ExternalLink size={14} strokeWidth={1.5} aria-hidden="true" />
    </a>
  );
}
