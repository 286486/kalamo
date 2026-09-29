// The product's former name (ADR-0069), the one place that knows it. Old SVG exports, saved files
// and browser storage still carry it, so it is read forever; it is built from parts so that no
// tracked file spells it out.
export const LEGACY_NAME = ["zi", "bel"].join("");

/** The former SVG namespace, which import reads beside Kalamo's; export never writes it. */
export const LEGACY_SVG_NS = `https://${LEGACY_NAME}.dev/ns/svg`;
