import {
  BUNDLED_FAMILIES,
  BUNDLED_FONT,
  type BundledFamily,
  type Document,
  drawnFamily,
} from "@zibel/core";
import krBoldUrl from "@zibel/render/fonts/NotoSansKR-Bold.otf?url";
import krRegularUrl from "@zibel/render/fonts/NotoSansKR-Regular.otf?url";
import scBoldUrl from "@zibel/render/fonts/NotoSansSC-Bold.otf?url";
import scRegularUrl from "@zibel/render/fonts/NotoSansSC-Regular.otf?url";
import blackUrl from "@zibel/render/fonts/SourceSans3-Black.ttf?url";
import blackItalicUrl from "@zibel/render/fonts/SourceSans3-BlackIt.ttf?url";
import boldUrl from "@zibel/render/fonts/SourceSans3-Bold.ttf?url";
import boldItalicUrl from "@zibel/render/fonts/SourceSans3-BoldIt.ttf?url";
import italicUrl from "@zibel/render/fonts/SourceSans3-It.ttf?url";
import regularUrl from "@zibel/render/fonts/SourceSans3-Regular.ttf?url";

/**
 * The files the Worker renders each bundled family with (ADR-0013, ADR-0028, ADR-0063, ADR-0066), as
 * `[url, weight, style]`. A file without a style is the family's only face at its weight and is
 * registered upright and italic, so an italic text draws it upright as `render` does, never slanted
 * by font synthesis.
 */
export const FONT_FILES: Record<
  BundledFamily,
  readonly (readonly [url: string, weight: string, style?: "normal" | "italic"])[]
> = {
  "Source Sans 3": [
    [regularUrl, "400", "normal"],
    [italicUrl, "400", "italic"],
    [boldUrl, "700", "normal"],
    [boldItalicUrl, "700", "italic"],
    [blackUrl, "900", "normal"],
    [blackItalicUrl, "900", "italic"],
  ],
  "Noto Sans SC": [
    [scRegularUrl, "400"],
    [scBoldUrl, "700"],
  ],
  "Noto Sans KR": [
    [krRegularUrl, "400"],
    [krBoldUrl, "700"],
  ],
};

const loads = new Map<BundledFamily, Promise<void>>();
/**
 * Loads a family's files once per page, each fetched once. Settled, not all: a face that fails
 * leaves the others to draw.
 */
export function loadFamily(family: BundledFamily) {
  let load = loads.get(family);
  if (!load) {
    load = Promise.allSettled(
      FONT_FILES[family].map(async ([url, weight, style]) => {
        const bytes = await (await fetch(url)).arrayBuffer();
        return Promise.all(
          (style ? [style] : (["normal", "italic"] as const)).map((s) => {
            const face = new FontFace(family, bytes, { weight, style: s });
            document.fonts.add(face);
            return face.load();
          }),
        );
      }),
    ).then((faces) => {
      for (const f of faces)
        if (f.status === "rejected")
          console.warn(`A ${family} face did not load; its text draws in a fallback.`, f.reason);
    });
    loads.set(family, load);
  }
  return load;
}

/**
 * The lazily loaded families some text in `doc` draws a character in (ADR-0063, ADR-0066). Source
 * Sans 3 loads with the page.
 */
export const drawnLazyFamilies = (doc: Document) =>
  BUNDLED_FAMILIES.filter(
    (family) =>
      family !== BUNDLED_FONT &&
      [...doc.nodes.values()].some(
        (n) => n.type === "text" && [...n.content].some((c) => drawnFamily(n, c) === family),
      ),
  );
