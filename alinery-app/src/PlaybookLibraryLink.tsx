import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import * as ipc from "./ipc";
import { toast } from "./toast";
import type { PlaybookRef } from "./types";

const LIBRARY_URL = "https://alinery.ai/playbooks";

/** The library's own deep link: `?playbook=<scope>:<key>` opens that playbook's page instead of the list. */
export const playbookLibraryUrl = (playbook?: PlaybookRef) => (playbook ? `${LIBRARY_URL}?playbook=${encodeURIComponent(`${playbook.scope}:${playbook.key}`)}` : LIBRARY_URL);

export function PlaybookLibraryLink({ className, playbook, children }: { className?: string; playbook?: PlaybookRef; children?: ReactNode }) {
  const url = playbookLibraryUrl(playbook);
  return (
    <a
      className={`btn ghost playbook-library-link${className ? ` ${className}` : ""}`}
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => {
        event.stopPropagation();
        event.preventDefault();
        void ipc.openUrl(url).catch((cause: unknown) => toast(String(cause), "error"));
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {children ?? "Browse the Playbook Library"}
      <ExternalLink size={14} strokeWidth={1.5} aria-hidden="true" />
    </a>
  );
}
