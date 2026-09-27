import { type Document, transformNodes } from "@zibel/core";
import { applyBroadcast, type ServerMessage } from "@zibel/sync";

/** The Selection being dragged by (dx, dy) pt. `commandId` is set once its move has been sent. */
export interface Drag {
  nodeIds: string[];
  dx: number;
  dy: number;
  commandId: string | null;
}

export interface ViewState {
  doc: Document | null;
  /** UI state only, never sent as a Document property (CONTEXT.md). */
  selection: string[];
  /** Drawn until the answer to its command arrives, so a committed move does not flicker. */
  drag: Drag | null;
  /** Why the last command was rejected. */
  notice: string | null;
}

/**
 * The ViewState after one server message (ADR-0009, ADR-0010), or null when a `rev` was missed and
 * the browser must reconnect for the whole Document.
 */
export function receive(
  s: ViewState,
  msg: ServerMessage,
  docId: string,
): Partial<ViewState> | null {
  if (msg.type === "rejected") {
    const gone = msg.error.code === "NODE_GONE";
    return {
      ...(s.drag?.commandId === msg.id && { drag: null }),
      notice: gone
        ? "Someone else deleted that object first; it stays deleted."
        : msg.error.message,
    };
  }
  let doc: Document;
  if (msg.type === "document") {
    const { rev, name, artboards, nodes } = msg;
    doc = {
      id: docId,
      name,
      version: 1,
      rev,
      artboards,
      nodes: new Map(nodes.map((n) => [n.id, n])),
      // The canvas fetches image files by id; it never needs their metadata (ADR-0023).
      images: new Map(),
    };
  } else if (s.doc && msg.rev === s.doc.rev + 1) {
    doc = applyBroadcast(s.doc, msg);
  } else {
    return null;
  }
  // A reconnect loses the answer to a command in flight, so its preview goes with it.
  const answered =
    msg.type === "document" || (!!msg.commandId && msg.commandId === s.drag?.commandId);
  const skipped = msg.type === "tx" ? (msg.skippedIds?.length ?? 0) : 0;
  // A selected Node that a browser's command moved into a new Group selects that Group, as Make
  // Clipping Mask does; an Agent's edit leaves the person's Selection alone.
  const made = new Set(msg.type === "tx" && msg.commandId ? msg.created.map((n) => n.id) : []);
  const selection = s.selection.flatMap((id) => {
    const parentId = doc.nodes.get(id)?.parentId;
    if (parentId === undefined) return [];
    return parentId && made.has(parentId) ? [parentId] : [id];
  });
  return {
    doc,
    selection: [...new Set(selection)],
    ...(answered && { drag: null }),
    ...(skipped > 0 && { notice: `Skipped ${skipped} deleted object(s); they stay deleted.` }),
  };
}

/**
 * `doc` with the drag applied by core, as the Document DO will apply it. Nodes deleted meanwhile
 * are left out here; the command still names them, so it is rejected (ADR-0010).
 */
export function preview(doc: Document, { nodeIds, dx, dy }: Drag): Document {
  const shown = { ...doc, nodes: new Map(doc.nodes) };
  const present = nodeIds.filter((id) => doc.nodes.has(id));
  if (present.length > 0) transformNodes(shown, { nodeIds: present, translate: { x: dx, y: dy } });
  return shown;
}
