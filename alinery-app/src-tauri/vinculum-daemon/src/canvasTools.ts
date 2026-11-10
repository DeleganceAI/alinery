// The canvas tools a chat thread's agent gets once the user enabled its canvas (domain/canvas.ts). They are the daemon's
// own tools, not MCP's: the thread is the conversation the call came from, so the agent never names it and cannot name
// another. A thread without the canvas does not see them (`openSession` removes them), and a call that slips through
// is refused by the domain.
import { Type } from "@earendil-works/pi-ai";
import { type ConversationId, defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { canvasEnabled, canvasReport, canvasRel, layoutCanvas, type PanelKind, putPanel } from "./domain/canvas.ts";

export type CanvasToolDeps = {
  repo: string;
  /** The chat thread a tool call or section belongs to; undefined for a task session or no session. */
  threadOf(env: unknown, conversationId: ConversationId): string | undefined;
  refresh(rel: string): Promise<void>;
};

export const CANVAS_INSTRUCTION = `This thread has a canvas: up to four panels (p1 to p4) beside the conversation, which the user sees as you write them. Use it to show, not to tell: a chart, a table, a document, or a small web page, when that communicates better than text.
- alinery_canvas_put_markdown, _put_table, _put_chart (a Vega-Lite spec with inline data.values) and _put_html each fill the first free panel, or the one you name with panel. Naming a panel replaces it.
- alinery_canvas_layout reorders, focuses or closes panels. alinery_canvas_get shows the layout, which panels the user closed, and the exact body of one panel.
- An html panel is one self-contained file (HTML with inline <style> and <script>). It runs sandboxed with no network: no external scripts, styles, fonts, images or fetch, and no storage. Inline everything; images as data: URLs.
- Keep a short reply in the chat saying what you put on the canvas. Do not paste a panel's body into the conversation.`;

const panelParam = Type.Optional(Type.String({ description: "p1 to p4. Omit to use the first free panel; name one to replace it." }));
const titleParam = Type.Optional(Type.String({ description: "A short title shown above the panel." }));
const cell = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);

type Reply = { output: { type: "text"; text: string }[]; isError?: boolean };
const text = (t: string, isError = false): Reply => ({ output: [{ type: "text", text: t }], ...(isError ? { isError } : {}) });

export function canvasTools(d: CanvasToolDeps) {
  /** Runs a canvas call for the calling thread, then puts the change in the store before the agent hears back. */
  const run = async (api: { env?: unknown; conversationId: ConversationId }, write: boolean, fn: (thread: string) => Promise<string> | string): Promise<Reply> => {
    const thread = d.threadOf(api.env, api.conversationId);
    if (!thread) return text("The canvas belongs to chat threads; this session has none.", true);
    try {
      const out = await fn(thread);
      if (write) await d.refresh(canvasRel(thread));
      return text(out);
    } catch (error) {
      return text(error instanceof Error ? error.message : String(error), true);
    }
  };
  const put = (kind: PanelKind, name: string, description: string, bodyParam: Parameters<typeof Type.Object>[0], bodyOf: (args: Record<string, unknown>) => unknown) =>
    defineTool({
      name,
      description,
      parameters: Type.Object({ panel: panelParam, title: titleParam, ...bodyParam }),
      execute: (args, api) =>
        run(api, true, async (thread) => {
          const a = args as Record<string, unknown>;
          const out = await putPanel(d.repo, thread, { panel: a.panel as string | undefined, title: a.title as string | undefined, kind, body: bodyOf(a) });
          return `Wrote ${out.panel} (${kind}, rev ${out.rev}).`;
        }),
    });
  const tools = [
    defineTool({
      name: "alinery_canvas_get",
      description: "Read this thread's canvas: its panels in order, which the user closed, and with panel the exact body of that panel.",
      parameters: Type.Object({ panel: Type.Optional(Type.String({ description: "p1 to p4: include this panel's body." })) }),
      execute: (args, api) => run(api, false, (thread) => canvasReport(d.repo, thread, args.panel || undefined)),
    }),
    put("markdown", "alinery_canvas_put_markdown", "Show a Markdown document (GitHub flavoured) in a canvas panel.", { markdown: Type.String() }, (a) => a.markdown),
    put("table", "alinery_canvas_put_table", "Show a table in a canvas panel: column names and rows of cells.", { columns: Type.Array(Type.String()), rows: Type.Array(Type.Array(cell)) }, (a) => ({ columns: a.columns, rows: a.rows })),
    put(
      "chart",
      "alinery_canvas_put_chart",
      "Show a Vega-Lite chart in a canvas panel. Data must be inline (data.values); URLs are refused.",
      { spec: Type.Record(Type.String(), Type.Unknown(), { description: "A Vega-Lite spec object." }) },
      (a) => a.spec,
    ),
    put("html", "alinery_canvas_put_html", "Show a self-contained web page (inline CSS and JS, no network) in a sandboxed canvas panel.", { html: Type.String() }, (a) => a.html),
    defineTool({
      name: "alinery_canvas_layout",
      description: "Arrange this thread's canvas: close panels, set the order of the open ones, or focus one (\"\" clears focus).",
      parameters: Type.Object({
        close: Type.Optional(Type.Array(Type.String())),
        order: Type.Optional(Type.Array(Type.String({ description: "Every open panel id, once." }))),
        focus: Type.Optional(Type.String()),
      }),
      execute: (args, api) =>
        run(api, true, async (thread) => {
          const canvas = await layoutCanvas(d.repo, thread, args);
          return `Canvas: ${canvas.order.join(", ") || "no panels"}${canvas.focus ? `; focused ${canvas.focus}` : ""}.`;
        }),
    }),
  ];
  const extension = defineExtension({
    name: "alinery-canvas",
    tools,
    sections: [
      section("canvas", (input) => {
        const thread = d.threadOf(input.env, input.conversationId);
        return thread && canvasEnabled(d.repo, thread) ? CANVAS_INSTRUCTION : undefined;
      }),
    ],
  });
  return { extension, tools };
}
