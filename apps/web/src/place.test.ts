import { createDocument, createNodes } from "@zibel/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { place } from "./place.ts";
import { useStore } from "./store.ts";

/** A Rect isolated in the default Layer, with another Rect selected. */
function isolateLeaf() {
  const { doc, defaultLayerId: layer } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 200, height: 100 }],
  });
  const rect = (clientKey: string) =>
    ({ type: "rect", clientKey, parentId: layer, x: 0, y: 0, width: 10, height: 10 }) as const;
  const { keyMap } = createNodes(doc, [rect("leaf"), rect("other")]);
  const view = { isolated: keyMap.leaf as string, selection: [keyMap.other as string] };
  useStore.setState({
    doc,
    viewport: { x: 0, y: 0, zoom: 1 } as never,
    size: { width: 100, height: 100 },
    notice: null,
    ...view,
  });
  return { ...view, leaf: keyMap.leaf as string };
}

const view = () => {
  const { isolated, selection } = useStore.getState();
  return { isolated, selection };
};
const flush = async () => {
  for (let i = 0; i < 3; i++) await new Promise((f) => setTimeout(f, 0));
};
const answer = (status: number, json: object) =>
  new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });

/** Every place() input: a pasted SVG, pasted in place, an SVG file and an image file. */
const inputs: [string, () => File | string, boolean?][] = [
  ["pasted SVG", () => "<svg/>"],
  ["pasted SVG in place", () => "<svg/>", true],
  ["SVG file", () => new File(["<svg/>"], "a.svg", { type: "image/svg+xml" })],
  ["image file", () => new File([new Uint8Array([1])], "a.png", { type: "image/png" })],
];

let resolve: (res: Response) => void;
beforeEach(() => {
  vi.stubGlobal("fetch", () => new Promise<Response>((f) => (resolve = f)));
});
afterEach(() => vi.unstubAllGlobals());

describe.each(inputs)("place: a %s with a leaf isolated (ADR-0058)", (_, input, inPlace) => {
  it("changes nothing while the request is in flight", async () => {
    const before = isolateLeaf();
    place(input(), inPlace);
    await flush();
    expect(view()).toEqual({ isolated: before.isolated, selection: before.selection });
  });

  it("leaves the Isolation and Selection alone when the Worker refuses it, and says why", async () => {
    const before = isolateLeaf();
    place(input(), inPlace);
    await flush();
    resolve(answer(400, { message: "bad file" }));
    await flush();
    expect(view()).toEqual({ isolated: before.isolated, selection: before.selection });
    expect(useStore.getState().notice).toMatch(/^Could not place .*bad file/);
  });

  it("goes up one level and selects the placed Nodes when the Worker takes it", async () => {
    isolateLeaf();
    place(input(), inPlace);
    await flush();
    resolve(answer(200, { nodes: [{ id: "placed" }] }));
    await flush();
    expect(view()).toEqual({ isolated: null, selection: ["placed"] });
  });

  it("keeps an Isolation changed while the request was in flight, as after Esc", async () => {
    const { leaf } = isolateLeaf();
    place(input(), inPlace);
    await flush();
    useStore.setState({ isolated: null, selection: [leaf] });
    resolve(answer(200, { nodes: [{ id: "placed" }] }));
    await flush();
    expect(view()).toEqual({ isolated: null, selection: [leaf] });
  });

  it("leaves another tab's view alone", async () => {
    const before = isolateLeaf();
    place(input(), inPlace);
    await flush();
    const doc = useStore.getState().doc;
    useStore.setState({ doc: doc && { ...doc, id: "other tab" } });
    resolve(answer(200, { nodes: [{ id: "placed" }] }));
    await flush();
    expect(view()).toEqual({ isolated: before.isolated, selection: before.selection });
  });
});

describe("place: failures before the Worker answers", () => {
  it("leaves the Isolation alone when the network fails", async () => {
    const before = isolateLeaf();
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("offline")));
    place("<svg/>");
    await flush();
    expect(view()).toEqual({ isolated: before.isolated, selection: before.selection });
    expect(useStore.getState().notice).toMatch(/offline/);
  });

  it("leaves the Isolation alone when an SVG file cannot be read", async () => {
    const before = isolateLeaf();
    const file = new File(["<svg/>"], "a.svg", { type: "image/svg+xml" });
    file.text = () => Promise.reject(new Error("unreadable"));
    place(file);
    await flush();
    expect(view()).toEqual({ isolated: before.isolated, selection: before.selection });
    expect(useStore.getState().notice).toMatch(/Could not place a.svg: .*unreadable/);
  });
});
