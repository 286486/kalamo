import {
  type Agent,
  assert,
  browserUser,
  type Check,
  type Commit,
  hex,
  type Logged,
  leaves,
  n3,
  type Setup,
} from "./mcp.ts";

/** Each session's Actor and MCP client, in order: Claude Code drafts, Codex restyles. */
export const agents: Agent[] = [
  { actor: "agent-a", client: "claude" },
  { actor: "agent-b", client: "codex" },
];

const BLUE = "#3565E8";
const NAVY = "#1D3557";
const TEAL = "#2A9D8F";
const TITLE = "Release plan";

/** Where `agent-a` is asked to draw `Step i`. */
const stepAt = (i: number) => ({ x: 40 + 150 * (i - 1), y: 120 });

/** The tools that commit, or stage, a change to a Document. */
const WRITES = new Set(
  [
    "node_create",
    "node_update",
    "node_delete",
    "node_transform",
    "node_reparent",
    "node_reorder",
    "node_duplicate",
    "mask_make",
    "mask_release",
    "path_edit",
    "path_op",
    "freehand_stroke",
    "svg_import",
    "image_place",
    "tx_commit",
  ].map((t) => `kalamo_${t}`),
);

const succeeded = (c: Logged) => c.result !== undefined && !c.result.isError;

const conflicted = (c: Logged) => {
  try {
    return JSON.parse(c.result?.content[0]?.text ?? "").code === "REV_CONFLICT";
  } catch {
    return false;
  }
};

/** An empty Document, and alice and bob on its WebSocket, who edit before each Agent's first write. */
export const setup: Setup = async (call, name, _other, connect) => {
  assert(connect, "collab's people need browser sockets");
  const { docId, defaultLayerId, rev } = (
    await call("kalamo_doc_create", { name, artboards: [{ width: 800, height: 320 }] })
  ).structuredContent;
  const commits: Commit[] = [{ actor: "agent-a", rev }];
  const alice = await browserUser(connect, "alice", docId);
  const bob = await browserUser(connect, "bob", docId);
  const started = new Set<string>();
  return {
    docId,
    commits,
    interject: async (actor, tool) => {
      if (!WRITES.has(tool) || started.has(actor)) return;
      started.add(actor);
      if (actor === "agent-a") {
        const title = { type: "text", parentId: defaultLayerId, name: "Title", x: 40, y: 60 };
        commits.push(await alice.send({ type: "create", nodes: [{ ...title, content: TITLE }] }));
      } else {
        const move = { nodeIds: [alice.id("Step 2")], translate: { x: 0, y: 40 } };
        commits.push(await alice.send({ type: "transform", input: move }));
        const fills = [{ color: TEAL }];
        const recolour = [{ nodeId: bob.id("Step 4"), appearance: { fills } }];
        commits.push(await bob.send({ type: "appearance", updates: recolour }));
      }
    },
    close: () => {
      alice.close();
      bob.close();
    },
  };
};

const check: Check = async (
  call,
  docId,
  _tools,
  { calls, commits } = { calls: [], commits: [] },
) => {
  const all = await leaves(call, docId);
  const names = all.map((n) => n.name).sort();
  assert(
    names.join() === "Step 1,Step 2,Step 3,Step 4,Step 5,Title",
    `the Document holds ${names}, want Step 1 to Step 5 and Title`,
  );
  for (const n of all) {
    if (n.name === "Title") {
      assert(n.content === TITLE, `the Title reads "${n.content}", want "${TITLE}"`);
      continue;
    }
    const i = Number(n.name.slice(5));
    const want = stepAt(i);
    if (i === 2) want.y += 40;
    const b = n.geometricBounds;
    assert(
      n.type === "rect" &&
        n3(b.x) === want.x &&
        n3(b.y) === want.y &&
        n3(b.width) === 120 &&
        n3(b.height) === 80,
      `${n.name} is a ${n.type} at ${JSON.stringify(b)}, want a 120×80 pt rect at (${want.x}, ${want.y})`,
    );
    const { fills, strokes } = n.appearance;
    const stroked = strokes.length === 1 && hex(strokes[0]?.color) === NAVY;
    assert(
      fills.length === 1 &&
        (i === 4
          ? hex(fills[0]?.color) === TEAL && strokes.length === 0
          : hex(fills[0]?.color) === BLUE && stroked && strokes[0]?.width === 2),
      `${n.name} has appearance ${JSON.stringify(n.appearance)}, want ${i === 4 ? `${TEAL} and no Stroke` : `${BLUE} with a 2 pt ${NAVY} Stroke`}`,
    );
  }

  const seen = agents.map(({ actor }) => [
    ...new Set(calls.filter((c) => c.actor === actor).map((c) => c.client)),
  ]);
  assert(
    seen.every((s) => s.length === 1) && new Set(seen.flat()).size === agents.length,
    `the Agents' MCP clients were ${agents.map((a, i) => `${a.actor}: ${seen[i]}`).join(", ")}, want one each and no two the same`,
  );

  for (const { actor: agent } of agents) {
    const mine = calls.filter((c) => c.actor === agent);
    assert(mine.some(conflicted), `no write of ${agent}'s failed with REV_CONFLICT`);
    mine.forEach((c, k) => {
      if (!conflicted(c)) return;
      const w = mine.findIndex((d, j) => j > k && WRITES.has(d.name) && succeeded(d));
      const read = mine
        .slice(k + 1, w < 0 ? undefined : w)
        .some((d) => d.name === "kalamo_doc_changes" && d.args.sinceRev <= c.args.ifRev);
      assert(
        read,
        `${agent}'s ${c.name} call ${k + 1} failed with REV_CONFLICT at ifRev ${c.args.ifRev}, and it did not read kalamo_doc_changes from there before writing again`,
      );
    });
  }

  // Who committed each rev, as the people and the Agents' receipts say.
  const by = new Map(commits.map((c) => [c.rev, c.actor]));
  for (const c of calls)
    if (WRITES.has(c.name) && succeeded(c) && (c.name === "kalamo_tx_commit" || !c.args.txId))
      by.set(c.result?.structuredContent.rev, c.actor);
  const { changes } = (await call("kalamo_doc_changes", { docId, sinceRev: 0, limit: 1000 }))
    .structuredContent as { changes: { rev: number; actor: string }[] };
  for (const c of changes)
    assert(
      by.get(c.rev) === c.actor,
      `rev ${c.rev} is attributed to ${c.actor}, want ${by.get(c.rev)}`,
    );
  assert(
    changes.length === by.size,
    `history lists ${changes.length} changes, want ${by.size}: ${changes.map((c) => c.rev)}`,
  );
};

export default check;
