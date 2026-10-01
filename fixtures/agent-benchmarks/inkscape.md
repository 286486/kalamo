## Prompt

Using the kalamo tools, edit the Kalamo Document `{{docId}}`, a page a person drew in Inkscape and opened in Kalamo.

Move the Group `Badge` so the centre of its bounds is at (450, 120) pt from the top-left corner of the page, and fill the `Star` in it `#3565E8`. Change nothing else.

## SVG prompt

The file `badge.svg` in the current directory is a page a person drew and saved in Inkscape. Edit it in place.

Move the group labelled `Badge` so the centre of its bounds is at (450, 120) pt from the top-left corner of the page (1 pt is 1/72 in), and fill the shape labelled `Star` in it `#3565E8`. Change nothing else.

## Assertions

`BADGE` in `inkscape.ts` is the page, an A5 sheet in millimetres as Inkscape 1.2.2 saved it.

- The Node named `Badge` has its bounds' centre within 0.5 pt of (450, 120).
- Against the page opened as the person left it, every shape and text is the same, within 0.5 pt, in the same order, but the Badge's `Disc` and `Star` have moved with it and the `Star` is filled `#3565E8`.
- The SVG arm's `badge.svg`, opened in Kalamo, passes the same assertions.
