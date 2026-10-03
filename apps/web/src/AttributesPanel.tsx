import { memo } from "react";
import { directionOf, fillRuleOf, pressDirection, setFillRule } from "./attributes.ts";
import { guard } from "./GradientPanel.tsx";
import { useStore } from "./store.ts";

/**
 * Illustrator's Attributes panel, its controls that decide how a Compound Path fills: the fill
 * rule of the selected paths, and the direction of the subpaths Direct Selection chose (ADR-0108).
 * Each button sets a value, pressed while the Selection has it; neither is pressed when mixed.
 */
export const AttributesPanel = memo(function AttributesPanel() {
  const rule = useStore(fillRuleOf);
  const on = useStore(directionOf);
  return (
    <section
      aria-label="Attributes"
      // Enter and Space press the focused button; they must not pan or reach the menu bar.
      onKeyDown={guard}
      onKeyUp={guard}
      style={{ padding: 8, borderBottom: "1px solid #CCC", display: "grid", gap: 6 }}
    >
      <strong>Attributes</strong>
      {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would add its own border and legend */}
      <div role="group" aria-label="Fill Rule" style={{ display: "flex", gap: 4 }}>
        <Choice
          label="Use Non-Zero Winding Fill Rule"
          text="Non-Zero"
          value={rule}
          is="nonzero"
          set={() => setFillRule(useStore.getState(), "nonzero")}
        />
        <Choice
          label="Use Even-Odd Fill Rule"
          text="Even-Odd"
          value={rule}
          is="evenodd"
          set={() => setFillRule(useStore.getState(), "evenodd")}
        />
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would add its own border and legend */}
      <div role="group" aria-label="Reverse Path Direction" style={{ display: "flex", gap: 4 }}>
        <Choice
          label="Reverse Path Direction Off"
          text="Direction Off"
          value={on}
          is={false}
          set={() => pressDirection(false)}
        />
        <Choice
          label="Reverse Path Direction On"
          text="Direction On"
          value={on}
          is={true}
          set={() => pressDirection(true)}
        />
      </div>
    </section>
  );
});

/** A button that sets `is`; disabled when the Selection gives it nothing to set (`value` null). */
function Choice<T>(props: {
  label: string;
  text: string;
  value: T | "mixed" | null;
  is: T;
  set: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      aria-pressed={props.value === props.is}
      disabled={props.value === null}
      onClick={props.set}
    >
      {props.text}
    </button>
  );
}
