import {
  assert,
  type Bounds,
  type Check,
  hex,
  type Leaf,
  leaves,
  n3,
  openSvg,
  type Setup,
  type SvgCheck,
} from "./mcp.ts";

/** A person's A5 page as Inkscape 1.2.2 saves it: millimetres, style attributes, Layer and Group
 * transforms and a star with its sodipodi parameters. */
export const BADGE = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg
   width="210mm"
   height="148mm"
   viewBox="0 0 210 148"
   version="1.1"
   id="svg5"
   sodipodi:docname="badge.svg"
   xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
   xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
   xmlns="http://www.w3.org/2000/svg"
   xmlns:svg="http://www.w3.org/2000/svg">
  <sodipodi:namedview
     id="namedview7"
     pagecolor="#ffffff"
     inkscape:document-units="mm"
     bordercolor="#000000"
     borderopacity="0.25"
     inkscape:showpageshadow="2"
     inkscape:pageopacity="0.0"
     inkscape:pagecheckerboard="0"
     inkscape:deskcolor="#d1d1d1" />
  <defs
     id="defs2" />
  <g
     inkscape:label="Background"
     inkscape:groupmode="layer"
     id="layer1">
    <rect
       style="fill:#f4f1ea;stroke:none"
       id="rect101"
       width="210"
       height="148"
       x="0"
       y="0" />
    <rect
       style="fill:#29335c;stroke:none"
       id="rect103"
       inkscape:label="Band"
       width="210"
       height="24"
       x="0"
       y="124" />
  </g>
  <g
     inkscape:label="Artwork"
     inkscape:groupmode="layer"
     id="layer2"
     transform="translate(12,8)">
    <g
       id="g210"
       inkscape:label="Badge"
       transform="matrix(0.8,0,0,0.8,4,6)">
      <circle
         style="fill:#e4572e;stroke:none"
         id="path201"
         inkscape:label="Disc"
         cx="40"
         cy="40"
         r="32" />
      <path
         sodipodi:type="star"
         style="fill:#ffd23f;stroke:none"
         id="path203"
         inkscape:label="Star"
         inkscape:flatsided="false"
         sodipodi:sides="5"
         sodipodi:cx="40"
         sodipodi:cy="42"
         sodipodi:r1="22"
         sodipodi:r2="9"
         sodipodi:arg1="-1.5707963"
         sodipodi:arg2="-0.9424778"
         inkscape:rounded="0"
         inkscape:randomized="0"
         d="M 40,20 45.29,34.72 60.92,35.2 48.56,44.78 52.93,59.8 40,51 27.07,59.8 31.44,44.78 19.08,35.2 34.71,34.72 Z" />
    </g>
    <text
       xml:space="preserve"
       style="font-size:12px;font-family:'Source Sans 3';fill:#3d3d44"
       x="96"
       y="44"
       id="text301"
       inkscape:label="Title"><tspan
         sodipodi:role="line"
         id="tspan303"
         x="96"
         y="44">Open day</tspan></text>
    <circle
       style="fill:#2a9d8f;stroke:none"
       id="path305"
       inkscape:label="Dot"
       cx="170"
       cy="80"
       r="10" />
  </g>
</svg>
`;

/** Where the Badge's bounds' centre must end up, in pt from the page's top-left. */
const CENTRE = { x: 450, y: 120 };
const BLUE = "#3565E8";

/** badge.svg, opened in Kalamo for the MCP arm. */
export const setup: Setup = async (call) => ({
  docId: await openSvg(call, BADGE),
  files: { "badge.svg": BADGE },
});

const near = (a: number, b: number) => Math.abs(a - b) <= 0.5;

const check: Check = async (call, docId) => {
  const { nodes: found } = (await call("kalamo_node_query", { docId, nameRegex: "^Badge$" }))
    .structuredContent as { nodes: { geometricBounds: Bounds }[] };
  const badge = found[0]?.geometricBounds;
  assert(found.length === 1 && badge, `${found.length} Nodes named Badge, want 1`);
  const cx = badge.x + badge.width / 2;
  const cy = badge.y + badge.height / 2;
  assert(
    near(cx, CENTRE.x) && near(cy, CENTRE.y),
    `the Badge's centre (${n3(cx)}, ${n3(cy)}), want (${CENTRE.x}, ${CENTRE.y})`,
  );

  // Against the page as the person left it: the Badge's shapes moved with it, the Star recoloured.
  const before = await leaves(call, await openSvg(call, BADGE));
  const after = await leaves(call, docId);
  assert(after.length === before.length, `${after.length} shapes and texts, want ${before.length}`);
  const disc = before.find((n) => n.name === "Disc")?.geometricBounds;
  assert(disc, "the page has no Disc");
  const dx = cx - (disc.x + disc.width / 2);
  const dy = cy - (disc.y + disc.height / 2);
  const look = (n: Leaf, fills = n.appearance.fills.map((f) => hex(f.color))) =>
    JSON.stringify({
      type: n.type,
      name: n.name,
      content: n.content,
      fills,
      strokes: n.appearance.strokes,
    });
  for (const [i, was] of before.entries()) {
    const now = after[i] as Leaf;
    const moved = was.name === "Disc" || was.name === "Star";
    const want = look(was, was.name === "Star" ? [BLUE] : undefined);
    assert(look(now) === want, `Node ${i} is ${look(now)}, want ${want}`);
    const [a, b] = [was.geometricBounds, now.geometricBounds];
    const at = { ...a, x: a.x + (moved ? dx : 0), y: a.y + (moved ? dy : 0) };
    assert(
      near(b.x, at.x) && near(b.y, at.y) && near(b.width, at.width) && near(b.height, at.height),
      `${now.name || `Node ${i}`} is at ${JSON.stringify(b)}, want ${JSON.stringify(at)}`,
    );
  }
};

export default check;

export const svgCheck: SvgCheck = async (call, files) =>
  check(call, await openSvg(call, files["badge.svg"]), []);
