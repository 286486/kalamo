/**
 * Where Area Type may break a line: after white space that breaks (ADR-0022, ADR-0087); between CJK
 * characters (ADR-0064); and after a solidus, a hyphen or a break-after dash in Latin text
 * (ADR-0085). Each follows Pango 1.50's UAX #14, so Inkscape 1.2.2 wraps the exported SVG at the same
 * places. `Intl.Segmenter` has no line granularity, so the classes live here.
 */

// ponytail: UAX #14 reduced to flags and small sets, checked against Pango 1.50.12: every CJK code
// point beside an ideograph and a Latin letter (ADR-0064), and random Latin strings with `/`, `-`,
// BA (ADR-0085) and no-break spaces (ADR-0087). Still left out: EX (`x!|y`), IN (`x…|y`), B2
// (`a|—|b`), emoji as ID (`x|🙂|y`), ZWSP, IS/CL/CP before PR/OP (`a)|(b`), U+00AD, BA outside ASCII,
// Latin-1 and General Punctuation, Thai, and rules across spaces. Each needs its own class here; past
// a few more, the pair table pays off.

/** A character that breaks from its neighbours unless a flag below forbids it: UAX #14's ID, H2/H3, JL/JV/JT, CJ, NS, CL and OP of CJK width. */
const CJK =
  /[\u1100-\u11FF\u2E80-\u2FFF\u3000-\u3247\u3250-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uA960-\uA97F\uAC00-\uD7FF\uF900-\uFAFF\uFE11\uFE12\uFE15-\uFE1F\uFE30-\uFE4F\uFF01-\uFF03\uFF06-\uFFDC\uFFE2-\uFFE4\u{1F200}-\u{1F2FF}\u{20000}-\u{3FFFD}]/u;

/** No break before: UAX #14's CL, CP, EX, IS, SY, NS, CJ, IN, BA, HY, QU, WJ, ZW, CM, U+2011 of GL and the vowel and trailing jamo JV, JT. */
const NO_BREAK_BEFORE =
  /[\p{M}\u1160-\u11FF\uD7B0-\uD7FF\u00AD\u200B-\u200F\u202A-\u202E\u2060\u2066-\u206F\uFEFF!"%'),\-./:;?\]|}\u00AB\u00BB\u2010-\u2013\u2018\u2019\u201B-\u201D\u201F\u2024-\u2027\u2039\u203A\u203C\u203D\u2044\u2046\u2047-\u2049\u2056-\u205B\u205D\u205E\u3001\u3002\u3005\u3009\u300B\u300D\u300F\u3011\u3015\u3017\u3019\u301B\u301C\u301E\u301F\u3035\u303B\u303C\u3041\u3043\u3045\u3047\u3049\u3063\u3083\u3085\u3087\u308E\u3095\u3096\u309B-\u309E\u30A0\u30A1\u30A3\u30A5\u30A7\u30A9\u30C3\u30E3\u30E5\u30E7\u30EE\u30F5\u30F6\u30FB-\u30FE\u31F0-\u31FF\uA015\uFE10-\uFE16\uFE18\uFE19\uFE36\uFE38\uFE3A\uFE3C\uFE3E\uFE40\uFE42\uFE44\uFE48\uFF01\uFF09\uFF0C\uFF0E\uFF1A\uFF1B\uFF1F\uFF3D\uFF5D\uFF60\uFF61\uFF63-\uFF65\uFF67-\uFF70\uFF9E\uFF9F]/u;

/** No break after: UAX #14's OP, QU, BB, GL, WJ and the leading jamo JL. */
const NO_BREAK_AFTER =
  /["'([{\u00A0\u2007\u202F\u1100-\u115F\uA960-\uA97F\u00A1\u00AB\u00B4\u00BB\u00BF\u2011\u2018-\u201F\u2039\u203A\u2045\u2060\u3008\u300A\u300C\u300E\u3010\u3014\u3016\u3018\u301A\u301D\uFE17\uFE35\uFE37\uFE39\uFE3B\uFE3D\uFE3F\uFE41\uFE43\uFE47\uFEFF\uFF08\uFF3B\uFF5B\uFF5F\uFF62]/u;

/** UAX #14's PR: a currency or sign that no line break parts from the ideograph after it. */
const PREFIX =
  /[$+\\\u00A3-\u00A5\u00B1\u20A0-\u20A6\u20A8-\u20B5\u20B7-\u20BA\u20BC\u20BD\u20BF\u2116\uFF04\uFFE1\uFFE5\uFFE6]/u;

/** UAX #14's PO: a unit or sign that no line break parts from the ideograph before it. */
const POSTFIX = /[%¢°‰-‷₧₶₻₾⃀℃℉％￠]/u;

/** Break after: UAX #14's SY and HY, and its BA in ASCII, Latin-1 and General Punctuation but U+00AD and spaces. */
const BREAK_AFTER = /[-/|\u2010\u2012\u2013\u2027\u2056\u2058-\u205B\u205D\u205E]/u;

/** UAX #14's NU: a solidus inside `NU (NU | SY | IS)*` keeps a number, or a sign after it, whole (LB25). */
const DIGIT = /\p{Nd}/u;

/** UAX #14's IS, which continues a number as a solidus does (LB25). */
const INFIX = /[,.:;]/;

/** UAX #14's HL, which LB21a and LB21b keep beside a hyphen or solidus. */
const HEBREW = /[\u05D0-\u05EA\u05EF-\u05F2\uFB1D\uFB1F-\uFB28\uFB2A-\uFB4F]/u;

/** UAX #14's CM, which takes its base's class (LB9). */
const MARK = /\p{M}/u;

/** UAX #14's GL, a no-break space: no break after it, nor before it but after a space, BA or HY (LB12, LB12a). */
const GLUE = /[\u00A0\u2007\u202F]/u;

/** UAX #14's WJ: no break before or after it, a space before it included (LB11). */
const WORD_JOINER = /[\u2060\uFEFF]/u;

/**
 * White space a line breaks after (ADR-0022): every character JavaScript's `/\s/` matches but GL
 * and WJ, which keep their neighbours together (ADR-0087).
 */
export const breakingSpace = (ch: string) =>
  /\s/.test(ch) && !GLUE.test(ch) && !WORD_JOINER.test(ch);

/** Whether a line may break between two non-space characters, one of them CJK. */
function breaksBetween(before: string, after: string) {
  // `$「` and `」%` break; `$字` and `字%` do not.
  if (PREFIX.test(before)) return CJK.test(after) && NO_BREAK_AFTER.test(after);
  if (GLUE.test(after)) return false;
  if (POSTFIX.test(after)) return CJK.test(before) && NO_BREAK_BEFORE.test(before);
  return !NO_BREAK_BEFORE.test(after) && !NO_BREAK_AFTER.test(before);
}

/**
 * Whether a line may break after `breaker`, the base of the marks before `next`, where `before` is
 * the base before it and `inNumber` says `breaker` ends `NU (NU | SY | IS)*`.
 */
function breaksAfter(breaker: string, next: string, before: string, inNumber: boolean) {
  if (!BREAK_AFTER.test(breaker)) return false;
  // `%` is UAX #14's PO, not a non-starter: Pango breaks `a-|%`.
  if (next !== "%" && NO_BREAK_BEFORE.test(next)) return false;
  if (breaker === "/") {
    return (
      !GLUE.test(next) &&
      !HEBREW.test(next) &&
      !(inNumber && (DIGIT.test(next) || PREFIX.test(next) || POSTFIX.test(next)))
    );
  }
  return !HEBREW.test(before) && !(breaker === "-" && DIGIT.test(next));
}

/**
 * A paragraph's unbreakable units, in order: each ends at a break opportunity and keeps the spaces
 * after it, so the units join back into the paragraph.
 */
export function lineBreakUnits(paragraph: string): string[] {
  const units: string[] = [];
  let unit = "";
  let prev = "";
  let base = "";
  let beforeBase = "";
  let inNumber = false;
  for (const ch of paragraph) {
    const breaks =
      CJK.test(prev) || CJK.test(ch)
        ? breaksBetween(prev, ch)
        : breaksAfter(base, ch, beforeBase, inNumber);
    // A breaking space before WJ does not break either (LB11), where it would before anything else.
    if (unit && !breakingSpace(ch) && !WORD_JOINER.test(ch) && (breakingSpace(prev) || breaks)) {
      units.push(unit);
      unit = "";
    }
    unit += ch;
    prev = ch;
    if (!MARK.test(ch)) {
      inNumber = DIGIT.test(ch) || (inNumber && (ch === "/" || INFIX.test(ch)));
      beforeBase = base;
      base = ch;
    }
  }
  if (unit) units.push(unit);
  return units;
}
