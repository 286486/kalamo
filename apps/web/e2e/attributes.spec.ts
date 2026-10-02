import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { call } from "./mcp.ts";

// #270: Window > Attributes sets a Compound Path's fill rule and the direction of a subpath chosen
// with Direct Selection, each one undo step (ADR-0108).

/** Each subpath of `d` clockwise on screen, by the signed area of its Anchors. */
function clockwise(d: string): boolean[] {
  return d
    .split("M")
    .filter((s) => s.trim())
    .map((s) => {
      // Each segment's end point is its last two numbers.
      const ends = s.split(/[LCZ]/).flatMap((seg) => {
        const n = seg.trim().split(/\s+/).filter(Boolean).map(Number);
        return n.length >= 2 ? [n.slice(-2) as [number, number]] : [];
      });
      let area = 0;
      for (const [i, [x1, y1]] of ends.entries()) {
        const [x2, y2] = ends[(i + 1) % ends.length] as [number, number];
        area += x1 * y2 - x2 * y1;
      }
      return area > 0;
    });
}

test("Ctrl+F11's Attributes panel makes and removes a ring's hole by direction and fill rule, one undo step each", async ({
  page,
  request,
}) => {
  const { docId, defaultLayerId: parentId } = (
    await call(request, "kalamo_doc_create", {
      name: "Attributes",
      artboards: [{ width: 200, height: 100, background: "#FFFFFF" }],
    })
  ).structuredContent;
  const circle = (r: number) => ({
    ...{ type: "ellipse", parentId, x: 100 - r, y: 50 - r, width: 2 * r, height: 2 * r },
    appearance: { fills: [{ color: "#FF0000" }] },
  });
  await call(request, "kalamo_node_create", { docId, nodes: [circle(40), circle(15)] });
  await page.goto(`/docs/${docId}`);
  await expect(page.getByTestId("status-bar")).toContainText(/\d+%/);
  await page.keyboard.press("Control+1");
  await expect(page.getByTestId("status-bar")).toContainText("100%");
  const box = await page.getByTestId("canvas").boundingBox();
  if (!box) throw new Error("no canvas");
  const at = (x: number, y: number) =>
    [box.x + box.width / 2 + x - 100, box.y + box.height / 2 + y - 50] as const;

  // The centre, in the inner circle, then the ring at x 70.
  const colors = () =>
    page.getByTestId("canvas").evaluate((el: HTMLCanvasElement) => {
      const k = el.width / el.getBoundingClientRect().width;
      const ctx = el.getContext("2d");
      return [100, 70].map((x) => {
        const [px, py] = [(el.width / k / 2 + x - 100) * k, (el.height / k / 2) * k];
        const [r = 0, g = 0, b = 0] = ctx?.getImageData(px, py, 1, 1).data ?? [];
        return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0").toUpperCase()).join("")}`;
      });
    });
  const HOLE = ["#FFFFFF", "#FF0000"];
  const FILLED = ["#FF0000", "#FF0000"];

  await page.keyboard.press("Control+A");
  await page.keyboard.press("Control+8");
  await expect(page.getByRole("button", { name: "<Compound Path>", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const { nodes } = (await call(request, "kalamo_doc_outline", { docId, depth: 9 }))
    .structuredContent;
  const ring = nodes[0].children[0].id as string;
  const stored = async () => {
    const n = (await call(request, "kalamo_node_get", { docId, nodeIds: [ring], detail: "full" }))
      .structuredContent.nodes[0];
    return { fillRule: n.fillRule ?? "nonzero", clockwise: clockwise(n.d) };
  };
  await expect.poll(colors).toEqual(HOLE);

  // Ctrl+F11 shows the panel, checked under Window; Window > Attributes hides it again.
  const panel = page.getByRole("region", { name: "Attributes" });
  const button = (name: string) => panel.getByRole("button", { name, exact: true });
  await expect(panel).toBeHidden();
  await page.keyboard.press("Control+F11");
  await expect(panel).toBeVisible();
  const item = page.getByRole("menuitemcheckbox", { name: "Attributes" });
  await page.getByRole("menuitem", { name: "Window", exact: true }).click();
  await expect(item).toHaveAttribute("aria-checked", "true");
  await item.click();
  await expect(panel).toBeHidden();
  await page.keyboard.press("Control+F11");
  await expect(panel).toBeVisible();

  // The Compound Path selected: its rule shows, and Reverse Path Direction needs Direct Selection.
  await expect(button("Use Non-Zero Winding Fill Rule")).toHaveAttribute("aria-pressed", "true");
  await expect(button("Use Even-Odd Fill Rule")).toHaveAttribute("aria-pressed", "false");
  await expect(button("Reverse Path Direction Off")).toBeDisabled();
  await expect(button("Reverse Path Direction On")).toBeDisabled();
  expect(await stored()).toEqual({ fillRule: "nonzero", clockwise: [false, true] });

  // The inner circle's Anchor at (115, 50), chosen with Direct Selection, is a hole: On.
  await page.keyboard.press("a");
  await page.mouse.click(...at(115, 50));
  await expect(button("Reverse Path Direction On")).toHaveAttribute("aria-pressed", "true");
  await button("Reverse Path Direction Off").click();
  await expect(button("Reverse Path Direction Off")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(stored).toEqual({ fillRule: "nonzero", clockwise: [false, false] });
  await expect.poll(colors).toEqual(FILLED);
  await button("Reverse Path Direction On").click();
  await expect.poll(stored).toEqual({ fillRule: "nonzero", clockwise: [false, true] });
  await expect.poll(colors).toEqual(HOLE);
  await button("Reverse Path Direction Off").click();
  await expect.poll(stored).toEqual({ fillRule: "nonzero", clockwise: [false, false] });
  await expect.poll(colors).toEqual(FILLED);

  // The whole Compound Path under Even-Odd: the hole is back whatever the directions.
  await page.keyboard.press("v");
  await page.mouse.click(...at(70, 50));
  await expect(button("Reverse Path Direction Off")).toBeDisabled();
  await button("Use Even-Odd Fill Rule").click();
  await expect(button("Use Even-Odd Fill Rule")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(stored).toEqual({ fillRule: "evenodd", clockwise: [false, false] });
  await expect.poll(colors).toEqual(HOLE);
  // Pressing the rule it has sends nothing, so the next Undo takes back Even-Odd.
  await button("Use Even-Odd Fill Rule").click();

  await page.keyboard.press("Control+Z");
  await expect.poll(stored).toEqual({ fillRule: "nonzero", clockwise: [false, false] });
  await expect.poll(colors).toEqual(FILLED);
  await page.keyboard.press("Control+Z");
  await expect.poll(stored).toEqual({ fillRule: "nonzero", clockwise: [false, true] });
  await expect.poll(colors).toEqual(HOLE);

  // Nothing selected: every control is disabled.
  await page.keyboard.press("Shift+Control+A");
  for (const name of [
    "Use Non-Zero Winding Fill Rule",
    "Use Even-Odd Fill Rule",
    "Reverse Path Direction Off",
    "Reverse Path Direction On",
  ]) {
    await expect(button(name)).toBeDisabled();
  }
});

/** A Compound Path at x offset `x`: a clockwise square around a counter-clockwise hole, Off. */
const ring = (x: number) =>
  `M${x + 20} 20 L${x + 80} 20 L${x + 80} 80 L${x + 20} 80 Z M${x + 40} 40 L${x + 40} 60 L${x + 60} 60 L${x + 60} 40 Z`;

/** The Anchors of `d` as "x y". */
const points = (d: string) =>
  [...d.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => `${m[1]} ${m[2]}`);

async function rings(page: Page, request: APIRequestContext, xs: number[]) {
  const { docId, defaultLayerId: parentId } = (
    await call(request, "kalamo_doc_create", {
      name: "Reverse rejected",
      artboards: [{ width: 200, height: 100, background: "#FFFFFF" }],
    })
  ).structuredContent;
  const fills = [{ color: "#FF0000" }];
  const ids = (
    await call(request, "kalamo_node_create", {
      docId,
      nodes: xs.map((x) => ({ type: "path", parentId, d: ring(x), appearance: { fills } })),
    })
  ).structuredContent.createdIds as string[];
  /** The `path_reverse` commands held once `hold` is called, each passed on, answered or dropped. */
  const held: { id: string; pass: () => void; answer: (m: object) => void; drop: () => void }[] =
    [];
  let holding = false;
  let sockets = 0;
  await page.routeWebSocket(/\/ws$/, (ws) => {
    sockets += 1;
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const msg = JSON.parse(String(m));
      if (!holding || msg.command?.type !== "path_reverse") return server.send(m);
      held.push({
        id: msg.id,
        pass: () => server.send(m),
        answer: (a) => ws.send(JSON.stringify(a)),
        drop: () => ws.close(),
      });
    });
    server.onMessage((m) => ws.send(m));
  });
  await page.goto(`/docs/${docId}`);
  await expect(page.getByTestId("status-bar")).toContainText(/\d+%/);
  await page.keyboard.press("Control+1");
  await expect(page.getByTestId("status-bar")).toContainText("100%");
  const box = await page.getByTestId("canvas").boundingBox();
  if (!box) throw new Error("no canvas");
  const at = (x: number, y: number) =>
    [box.x + box.width / 2 + x - 100, box.y + box.height / 2 + y - 50] as const;
  const d = async (id: string) =>
    (await call(request, "kalamo_node_get", { docId, nodeIds: [id], detail: "full" }))
      .structuredContent.nodes[0].d as string;
  await page.keyboard.press("Control+F11");
  const button = (name: string) =>
    page.getByRole("region", { name: "Attributes" }).getByRole("button", { name, exact: true });
  return {
    docId,
    ids,
    held,
    hold: () => {
      holding = true;
    },
    sockets: () => sockets,
    at,
    d,
    button,
  };
}

// #272: a rejected Reverse Path Direction press leaves the Direct Selection naming the Anchors the
// person chose, so the next action acts on them.
test("a rejected Reverse Path Direction press restores the chosen Anchors on both Compound Paths", async ({
  page,
  request,
}) => {
  const { ids, held, hold, at, d, button } = await rings(page, request, [0, 100]);
  const [a, b] = ids as [string, string];
  // Each hole's second Anchor, which a reverse renumbers to the fourth at (x + 60, 40).
  await page.keyboard.press("a");
  await page.mouse.click(...at(40, 60));
  await page.keyboard.down("Shift");
  await page.mouse.click(...at(140, 60));
  await page.keyboard.up("Shift");
  await expect(button("Reverse Path Direction Off")).toHaveAttribute("aria-pressed", "true");

  hold();
  await button("Reverse Path Direction On").click();
  await expect.poll(() => held.length).toBe(1);
  const [press] = held;
  press?.answer({
    type: "rejected",
    id: press.id,
    error: { code: "INVALID_PATH", message: "Rejected for the test.", hint: "" },
  });
  await expect(page.getByRole("alert")).toHaveText("Rejected for the test.");
  await expect(button("Reverse Path Direction Off")).toHaveAttribute("aria-pressed", "true");
  expect([points(await d(a)), points(await d(b))]).toEqual([points(ring(0)), points(ring(100))]);

  // Convert makes the chosen Anchors smooth, not those the reverse would have put in their place:
  // the segments either side of each become curves.
  await page
    .getByRole("toolbar", { name: "Anchors" })
    .getByRole("button", { name: "Convert selected anchor points to smooth" })
    .click();
  await expect.poll(() => d(a)).toMatch(/C[^LZ]* 40 60 C/);
  expect(await d(b)).toMatch(/C[^LZ]* 140 60 C/);
  expect([await d(a), await d(b)]).toEqual([
    expect.stringMatching(/L 60 40 Z$/),
    expect.stringMatching(/L 160 40 Z$/),
  ]);
});

// #272, ADR-0109: an Agent reverses the hole while the press is in flight; its edit clears the
// path's Anchors, the press finds nothing to change, and the rejection brings none back.
test("a Reverse Path Direction press an Agent raced is refused and leaves no Anchor chosen", async ({
  page,
  request,
}) => {
  const { docId, ids, held, hold, at, d, button } = await rings(page, request, [0]);
  const [id] = ids as [string];
  await page.keyboard.press("a");
  await page.mouse.click(...at(40, 60));
  await expect(button("Reverse Path Direction Off")).toHaveAttribute("aria-pressed", "true");

  hold();
  await button("Reverse Path Direction On").click();
  await expect.poll(() => held.length).toBe(1);
  await call(request, "kalamo_path_edit", {
    docId,
    nodeId: id,
    ops: [{ op: "reverse", subpath: 1 }],
  });
  const raced = await d(id);
  // The Agent's Transaction arrives first and clears the path's chosen Anchor.
  await expect(button("Reverse Path Direction On")).toBeDisabled();
  held[0]?.pass();
  await expect(page.getByRole("alert")).toHaveText("Those subpaths already run that way.");
  await expect(button("Reverse Path Direction On")).toBeDisabled();
  await expect(button("Reverse Path Direction Off")).toBeDisabled();
  expect(await d(id)).toBe(raced);
});

// #272: the socket drops with the press in flight, before the Document DO saw it. The Document sent
// on reconnect still has the hole as it was, so the chosen Anchor is numbered back.
test("a Reverse Path Direction press lost to a reconnect leaves the chosen Anchor chosen", async ({
  page,
  request,
}) => {
  const { ids, held, hold, sockets, at, d, button } = await rings(page, request, [0]);
  const [id] = ids as [string];
  await page.keyboard.press("a");
  await page.mouse.click(...at(40, 60));
  await expect(button("Reverse Path Direction Off")).toHaveAttribute("aria-pressed", "true");

  hold();
  await button("Reverse Path Direction On").focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => held.length).toBe(1);
  held[0]?.drop();
  await expect.poll(sockets).toBe(2);
  await expect(page.getByTestId("status-bar")).not.toContainText("connecting");
  await expect(button("Reverse Path Direction Off")).toHaveAttribute("aria-pressed", "true");
  expect(points(await d(id))).toEqual(points(ring(0)));

  await page
    .getByRole("toolbar", { name: "Anchors" })
    .getByRole("button", { name: "Convert selected anchor points to smooth" })
    .click();
  await expect.poll(() => d(id)).toMatch(/C[^LZ]* 40 60 C/);
  expect(await d(id)).toMatch(/L 60 40 Z$/);
});

// #274, ADR-0110: while a press is in flight, a click selects the Anchor under the pointer and an
// edit waits for the answer, so both act on the Anchors the person chose whatever the answer.
// The hole runs (40, 40), (40, 60), (60, 60), (60, 40); reversed, (40, 40), (60, 40), (60, 60),
// (40, 60). The chosen (40, 60) and (60, 60) are Anchors 1 and 2, then 3 and 2.
const outer = ["20 20", "80 20", "80 80", "20 80"];
const edits = {
  drag: {
    run: async (page: Page, at: (x: number, y: number) => readonly [number, number]) => {
      await page.mouse.move(...at(40, 60));
      await page.mouse.down();
      await page.mouse.move(...at(45, 60), { steps: 4 });
      await page.mouse.up();
    },
    accepted: ["40 40", "60 40", "65 60", "45 60"],
    rejected: ["40 40", "45 60", "65 60", "60 40"],
  },
  delete: {
    run: async (page: Page) => page.keyboard.press("Delete"),
    // What is left of the hole is one open segment, run as the hole then ran.
    accepted: ["40 40", "60 40"],
    rejected: ["60 40", "40 40"],
  },
  convert: {
    run: async (page: Page) =>
      page
        .getByRole("toolbar", { name: "Anchors" })
        .getByRole("button", { name: "Convert selected anchor points to smooth" })
        .click(),
    accepted: null,
    rejected: null,
  },
};
for (const outcome of ["accepted", "rejected"] as const) {
  for (const [name, edit] of Object.entries(edits)) {
    test(`a click and a ${name} while a Reverse Path Direction press is in flight act on the chosen Anchors, ${outcome}`, async ({
      page,
      request,
    }) => {
      const { ids, held, hold, at, d, button } = await rings(page, request, [0]);
      const [id] = ids as [string];
      await page.keyboard.press("a");
      await page.mouse.click(...at(40, 60));
      await expect(button("Reverse Path Direction Off")).toHaveAttribute("aria-pressed", "true");

      hold();
      await button("Reverse Path Direction On").click();
      await expect.poll(() => held.length).toBe(1);
      await page.keyboard.down("Shift");
      await page.mouse.click(...at(60, 60));
      await page.keyboard.up("Shift");
      await edit.run(page, at);
      // The edit waits for the answer.
      await page.waitForTimeout(200);
      expect(points(await d(id))).toEqual(points(ring(0)));
      const [press] = held;
      if (outcome === "accepted") press?.pass();
      else {
        press?.answer({
          type: "rejected",
          id: press.id,
          error: { code: "INVALID_PATH", message: "Rejected for the test.", hint: "" },
        });
      }
      const hole = edit[outcome];
      if (hole) await expect.poll(async () => points(await d(id))).toEqual([...outer, ...hole]);
      else {
        // The chosen Anchors turn smooth, so the segments either side of each become curves; the
        // others stay corners with straight segments between them.
        await expect.poll(() => d(id)).toMatch(/C[^LZ]* 40 60 C/);
        expect(await d(id)).toMatch(/C[^LZ]* 60 60 C/);
        expect(await d(id)).not.toMatch(/C[^LZ]* (40 40|60 40) C/);
      }
      if (name === "delete") return;
      if (outcome === "accepted") {
        await expect(button("Reverse Path Direction On")).toHaveAttribute("aria-pressed", "true");
      }
      // The keys still name the chosen Anchors after the answer: a Delete now removes those two.
      await page.keyboard.press("Delete");
      await expect
        .poll(async () => points(await d(id)))
        .toEqual([...outer, ...edits.delete[outcome]]);
    });
  }
}

// #276, ADR-0110: the Anchor Point tools and the Curvature tool, used on the hole while a press is
// in flight, wait for the answer and change the point under the pointer whatever it is.
const toolEdits = {
  "an Add Anchor Point click": {
    run: async (page: Page, at: (x: number, y: number) => readonly [number, number]) => {
      await page.keyboard.press("+");
      await page.mouse.click(...at(40, 46));
    },
    accepted: ["40 40", "60 40", "60 60", "40 60", "40 46"],
    rejected: ["40 40", "40 46", "40 60", "60 60", "60 40"],
  },
  "a Delete Anchor Point click": {
    run: async (page: Page, at: (x: number, y: number) => readonly [number, number]) => {
      await page.keyboard.press("-");
      await page.mouse.click(...at(60, 60));
    },
    accepted: ["40 40", "60 40", "40 60"],
    rejected: ["40 40", "40 60", "60 40"],
  },
  "a Curvature drag": {
    run: async (page: Page, at: (x: number, y: number) => readonly [number, number]) => {
      await page.keyboard.press("Shift+~");
      await page.mouse.move(...at(60, 60));
      await page.mouse.down();
      await page.mouse.move(...at(65, 60), { steps: 4 });
      await page.mouse.up();
    },
    accepted: ["40 40", "60 40", "65 60", "40 60"],
    rejected: ["40 40", "40 60", "65 60", "60 40"],
  },
};
for (const outcome of ["accepted", "rejected"] as const) {
  for (const [name, edit] of Object.entries(toolEdits)) {
    test(`${name} while a Reverse Path Direction press is in flight changes the point under the pointer, ${outcome}`, async ({
      page,
      request,
    }) => {
      const { ids, held, hold, at, d, button } = await rings(page, request, [0]);
      const [id] = ids as [string];
      await page.keyboard.press("a");
      await page.mouse.click(...at(40, 60));
      await expect(button("Reverse Path Direction Off")).toHaveAttribute("aria-pressed", "true");

      hold();
      await button("Reverse Path Direction On").click();
      await expect.poll(() => held.length).toBe(1);
      // The panel shows the direction pressed while the press is in flight.
      await expect(button("Reverse Path Direction On")).toHaveAttribute("aria-pressed", "true");
      await edit.run(page, at);
      // The edit waits for the answer.
      await page.waitForTimeout(200);
      expect(points(await d(id))).toEqual(points(ring(0)));
      const [press] = held;
      if (outcome === "accepted") press?.pass();
      else {
        press?.answer({
          type: "rejected",
          id: press.id,
          error: { code: "INVALID_PATH", message: "Rejected for the test.", hint: "" },
        });
      }
      // An added Anchor lands within rounding of the click.
      const rounded = (d: string) =>
        points(d).map((p) =>
          p
            .split(" ")
            .map((v) => Math.round(Number(v)))
            .join(" "),
        );
      await expect.poll(async () => rounded(await d(id))).toEqual([...outer, ...edit[outcome]]);
    });
  }
}

test("the Attributes panel shows the pressed direction until a rejection shows the committed one", async ({
  page,
  request,
}) => {
  const { held, hold, at, button } = await rings(page, request, [0]);
  await page.keyboard.press("a");
  await page.mouse.click(...at(40, 60));
  hold();
  await button("Reverse Path Direction On").click();
  await expect.poll(() => held.length).toBe(1);
  await expect(button("Reverse Path Direction On")).toHaveAttribute("aria-pressed", "true");
  await expect(button("Reverse Path Direction Off")).toHaveAttribute("aria-pressed", "false");
  const [press] = held;
  press?.answer({
    type: "rejected",
    id: press.id,
    error: { code: "INVALID_PATH", message: "Rejected for the test.", hint: "" },
  });
  await expect(button("Reverse Path Direction Off")).toHaveAttribute("aria-pressed", "true");
});
