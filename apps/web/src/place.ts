import { forNewArt } from "./isolation.ts";
import { placeParent } from "./selection.ts";
import { useStore } from "./store.ts";
import { toDoc } from "./viewport.ts";

/**
 * Place (ADR-0017) and Relink POST the file to the Worker, which writes it as the user; the canvas
 * follows the `tx` broadcast like any other write. Failures and warnings show as the notice. On
 * success, what it placed or relinked becomes the Selection and the Isolation goes `from` → `to`,
 * unless the tab or its Isolation changed while the request was in flight.
 */
async function postFile(
  docId: string,
  url: string,
  body: BodyInit,
  what: string,
  from: string | null,
  to = from,
) {
  const notice = (text: string) => useStore.setState({ notice: text });
  try {
    const res = await fetch(url, { method: "POST", body });
    const json = (await res.json()) as {
      message?: string;
      hint?: string;
      warnings?: { message: string }[];
      createdIds?: string[];
      updatedIds?: string[];
      /** Place's: what went into the parent, the Group or a copy's Nodes. */
      nodes?: { id: string }[];
    };
    if (!res.ok) notice(`Could not ${what}: ${json.message} ${json.hint ?? ""}`);
    else {
      const s = useStore.getState();
      useStore.setState({
        notice: json.warnings?.map((w) => w.message).join(" ") || null,
        ...(s.doc?.id === docId &&
          s.isolated === from && {
            isolated: to,
            selection: json.nodes?.map((n) => n.id) ?? [
              ...(json.createdIds ?? []),
              ...(json.updatedIds ?? []),
            ],
          }),
      });
    }
  } catch (e) {
    notice(`Could not ${what}: ${String(e)}`);
  }
}

const isSvg = (file: File) => file.type === "image/svg+xml" || /\.svg$/i.test(file.name);

/** What Place takes, for File > Place… and a drop on the canvas. */
export const PLACEABLE = ".svg,image/*";
export const placeable = (file: File) => isSvg(file) || file.type.startsWith("image/");

/**
 * Place at the centre of the canvas, or pasted text where it was with `inPlace`, in placeParent's
 * Layer or isolated Group or sub-Layer, an isolated leaf left once it succeeds (ADR-0058): an SVG
 * as a Group (ADR-0017), or a Zibel copy's Nodes as they were (ADR-0030), any other file as an
 * Image, which the Worker checks (ADR-0023).
 */
export function place(file: File | string, inPlace = false) {
  const s = useStore.getState();
  const { doc, viewport: v, size } = s;
  const at = doc && forNewArt(doc, s);
  const parentId = doc && at && placeParent(doc, at.selection, at.isolated);
  if (!doc || !v || !at || !parentId) return;
  const docId = doc.id;
  const { x, y } = toDoc(v, size.width / 2, size.height / 2);
  const query = new URLSearchParams({ parentId, x: String(x), y: String(y) });
  const post = (path: string, body: BodyInit, what: string) =>
    postFile(docId, `/api/docs/${docId}/${path}?${query}`, body, what, s.isolated, at.isolated);
  if (typeof file === "string") {
    if (inPlace) query.set("inPlace", "");
    post("place", file, "place the pasted SVG");
  } else if (isSvg(file)) {
    query.set("name", file.name);
    file.text().then(
      (text) => post("place", text, `place ${file.name}`),
      (e) => useStore.setState({ notice: `Could not place ${file.name}: ${String(e)}` }),
    );
  } else {
    post("place-image", file, `place ${file.name}`);
  }
}

/** Object > Relink… (ADR-0042): the file becomes the Image's pixels; the Worker checks it. */
export function relink(nodeId: string, file: File) {
  const { doc, isolated } = useStore.getState();
  if (!doc) return;
  const query = new URLSearchParams({ nodeId, name: file.name });
  postFile(
    doc.id,
    `/api/docs/${doc.id}/relink-image?${query}`,
    file,
    `relink ${file.name}`,
    isolated,
  );
}

/** What a paste places: SVG text, else the first image file. */
export const pastedArt = (text: string, files: File[]) =>
  text.trimStart().startsWith("<") ? text : files.find((f) => f.type.startsWith("image/"));

/**
 * Edit > Paste from the menu, which gets no paste event: the async clipboard, which the browser
 * may ask the user to allow.
 */
export async function pasteClipboard(inPlace: boolean) {
  try {
    const items = await navigator.clipboard.read();
    const text = async (type: string) => {
      const item = items.find((i) => i.types.includes(type));
      return item ? (await item.getType(type)).text() : "";
    };
    const files = await Promise.all(
      items.flatMap((i) =>
        i.types
          .filter((t) => t.startsWith("image/") && t !== "image/svg+xml")
          .map(async (t) => new File([await i.getType(t)], "pasted", { type: t })),
      ),
    );
    const art = pastedArt((await text("image/svg+xml")) || (await text("text/plain")), files);
    if (art) place(art, inPlace);
  } catch (e) {
    useStore.setState({ notice: `Could not paste: ${String(e)}` });
  }
}
