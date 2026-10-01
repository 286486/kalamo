## Prompt

Using the kalamo tools, open Document `{{docId}}`: a seat plan with rows `A` to `J` of 20 seats each, seat `C5` named `C5`. Seats `C5` to `C9` have been sold: fill them `#9AA0A6`. Change nothing else.

---

Using the kalamo tools, open Document `{{docId}}`: a seat plan with rows `A` to `J` of 20 seats each, seat `C5` named `C5`. Row `J` has been taken out of the venue: delete its seats. Change nothing else.

---

Using the kalamo tools, open Document `{{docId}}`: a seat plan with rows of 20 seats each, seat `C5` named `C5`. Widen the aisle: move seats 11 to 20 of every row 30 pt to the right. Change nothing else.

## SVG prompt

The file `plan.svg` in the current directory is a seat plan with rows `A` to `J` of 20 seats each, one user unit to the pt, seat `C5` labelled `C5`. Edit it in place. Seats `C5` to `C9` have been sold: fill them `#9AA0A6`. Change nothing else.

---

The file `plan.svg` in the current directory is a seat plan with rows `A` to `J` of 20 seats each, one user unit to the pt, seat `C5` labelled `C5`. Edit it in place. Row `J` has been taken out of the venue: delete its seats. Change nothing else.

---

The file `plan.svg` in the current directory is a seat plan with rows of 20 seats each, one user unit to the pt, seat `C5` labelled `C5`. Edit it in place. Widen the aisle: move seats 11 to 20 of every row 30 pt to the right. Change nothing else.

## Assertions

Three sessions in a row edit one seat plan of 200 seats, each a 20×20 pt rect named for its seat in a Group per row.

- The Document holds 180 shapes: the rects `A1` to `I20`, and no seat of row `J`.
- Each seat is 20×20 pt where it was, seats 11 to 20 of each row 30 pt further right.
- `C5` to `C9` are filled `#9AA0A6`, every other seat `#3565E8`, and none has a Stroke.
- The SVG arm's `plan.svg`, opened in Kalamo, passes the same assertions.
