import { type Combining, PATH_OP_TEXT, PATHFINDERS, SHAPE_MODES } from "@kalamo/core";
import { memo } from "react";
import { guard } from "./GradientPanel.tsx";
import { shapeMode, shapeModeTargets } from "./menu.ts";
import { useStore } from "./store.ts";

/**
 * Illustrator's Pathfinder panel, its Shape Modes row and the Pathfinders built so far: each
 * button runs the expanded `path_op` on the selected editable Nodes (ADR-0104).
 */
export const PathfinderPanel = memo(function PathfinderPanel() {
  const enabled = useStore((s) => shapeModeTargets(s).length > 0);
  return (
    <section
      aria-label="Pathfinder"
      // Enter and Space press the focused button; they must not pan or reach the menu bar.
      onKeyDown={guard}
      onKeyUp={guard}
      style={{ padding: 8, borderBottom: "1px solid #CCC", display: "grid", gap: 6 }}
    >
      <strong>Pathfinder</strong>
      <Row label="Shape Modes" ops={SHAPE_MODES} enabled={enabled} />
      <Row label="Pathfinders" ops={PATHFINDERS} enabled={enabled} />
    </section>
  );
});

function Row({
  label,
  ops,
  enabled,
}: {
  label: string;
  ops: readonly Combining[];
  enabled: boolean;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would add its own border and legend
    <div role="group" aria-label={label} style={{ display: "flex", gap: 4 }}>
      {ops.map((op) => (
        <button key={op} type="button" disabled={!enabled} onClick={() => shapeMode(op)}>
          {PATH_OP_TEXT[op].menu}
        </button>
      ))}
    </div>
  );
}
