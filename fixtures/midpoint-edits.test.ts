// The hand-written `.kalamo.json` of the midpoint fixture stays what the serializer writes.
import { expect, it } from "vitest";
import { serializeDocument } from "../packages/core/src/index.ts";
import { MIDPOINT_DOC } from "./midpoint-edits.ts";
import { midpointDocument } from "./midpoint-export.ts";

it("writes MIDPOINT_DOC as serializeDocument writes the Document it opens to", () => {
  expect(JSON.parse(MIDPOINT_DOC)).toEqual(JSON.parse(serializeDocument(midpointDocument())));
});
