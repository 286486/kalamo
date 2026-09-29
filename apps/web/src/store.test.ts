import { afterEach, expect, it, vi } from "vitest";
import { connect, useStore } from "./store.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("keeps each Document Tab's Isolation while another tab is shown, and none for a new one", () => {
  vi.stubGlobal("location", { protocol: "http:", host: "localhost" });
  vi.stubGlobal(
    "WebSocket",
    class {
      close() {}
    },
  );
  let stop = connect("a");
  useStore.setState({ isolated: "group-a", selection: ["x"] });
  stop();
  stop = connect("b");
  expect(useStore.getState()).toMatchObject({ isolated: null, selection: [] });
  stop();
  stop = connect("a");
  expect(useStore.getState()).toMatchObject({ isolated: "group-a", selection: ["x"] });
  stop();
});

it("forgets the Layer rows on any Selection change that does not set them, equal contents too", () => {
  useStore.setState({ selection: [], layerRows: ["L"] });
  expect(useStore.getState().layerRows).toEqual(["L"]);
  // Another empty Selection, as a click on empty canvas makes: the row does not come back.
  useStore.setState({ selection: [] });
  expect(useStore.getState().layerRows).toEqual([]);
  useStore.setState({ selection: [] });
  expect(useStore.getState().layerRows).toEqual([]);
  useStore.setState({ selection: ["x"], layerRows: ["L"] });
  useStore.setState({ notice: null });
  expect(useStore.getState().layerRows).toEqual(["L"]);
  useStore.setState({ selection: ["x"] });
  expect(useStore.getState().layerRows).toEqual([]);
});
