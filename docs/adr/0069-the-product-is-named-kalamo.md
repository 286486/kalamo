---
status: accepted
date: 2026-09-29
---

# The product is named Kalamo

The product's former name is said almost exactly like Arabic زِبْل *zibl*, "manure, dung", and is close to Modern Hebrew זבל *zevel* and Egyptian زبالة *zebāla*, "garbage". A vector editor meant to be shown worldwide cannot ship under that name, so it is replaced before the M1 announcement (#172). The candidates, their evidence and what was not checked are in `docs/research/07-kalamo-name-check.md` and #172. The check that chose the former name is in git history only.

## Decision

**The name is Kalamo**: `kalamo` in identifiers, `Kalamo` capitalised, the workspace scope `@kalamo/*`, the MCP tool prefix `kalamo_`, and the SVG namespace `https://kalamo.cc/ns/svg` with the prefix `kalamo:`. It comes from Greek *kálamos*, the reed pen, which lives on as Latin *calamus*, Arabic *qalam*, Turkish *kalem*, Hindi and Urdu *kalam* and Russian *калам*. It is said KAH-lah-moh. The Chinese reading is **卡拉莫** (kǎ lā mò), the Japanese カラモ. The owner chose it on 2026-09-29.

**Risks the owner accepted** when choosing it:

- **A same-name product.** Kalamo at `kalamo.ai` (econf.ai) is a live AI captioning and translation service for conferences. It serves event attendees and venues with speech captions, not developers and agents with drawing.
- **Trademarks are not cleared.** No live US KALAMO mark exists in classes 9 and 42. EUIPO, WIPO and CNIPA were not searched. Before M1, the owner confirms that nobody holds a KALAMO mark in those classes (#173). If a blocking mark turns up, this decision reopens with **Kalamos** as the fallback.
- **The prefix.** *kal-* is "mud" in several Slavic languages, and Russian *кал* is the medical word for faeces. The whole word carries neither sense.
- **Domains and handles.** `kalamo.com` is parked, `kalamo.app` and `kalamo.net` are registered by others, and the GitHub login `kalamo` is a personal user. The product domain is `kalamo.cc`, which the owner chose on 2026-09-29; it names the SVG namespace, and confirming that the owner has registered and controls it is #173.

**Every surface is renamed.** Code, packages, MCP names, formats, auth, storage, docs, the landing page, the GitHub repository and the Cloudflare deployment all say Kalamo. Only the old forms below are still read.

**Read both.** These old forms keep working after the rename:

| Old form | Rule |
| --- | --- |
| The former SVG namespace and its prefix (`LEGACY_SVG_NS` in `packages/core/src/legacy.ts`) | Import reads it **permanently**, beside the new one. When an element carries both, the new namespace wins. Export writes only the new one, and warnings name the `kalamo:` prefix. |
| A saved file named `<doc>.<former name>.json` | Opens unchanged. Open detects a file by content, not by name, and the file holds no brand string. Saving writes `<doc>.kalamo.json`. |
| Browser storage keys `<former name>:tabs` and `<former name>:pencil` | Read once: when the `kalamo:` key is absent and the old key is present, the old value is used, written under the new key and the old key is removed. The cutover also carries each browser's keys from the old Worker's origin to the new one while the old Worker exists: the old origin's last page puts them in the new URL's fragment, `#carry=<JSON>`, and the app stores each one under its `kalamo:` key unless that key, or its old form, is already set. |

**No aliases for MCP names.** The 25 tools with the former prefix, the former server name, its `skill://` resources, its `…_json` export format and its `:read` and `:write` scopes are renamed without aliases. The server is stateless and every client reads `tools/list` fresh (ADR-0006), nothing is announced before M1, and no OAuth grant exists. An old tool name fails as any unknown tool does. The former `…_json` format fails with `INVALID_INPUT` and the nearest-value hint names `kalamo_json` (ADR-0050).

**Cloudflare moves to Kalamo, and the old deployment is deleted only after a verified migration.** The owner decided on 2026-09-29 that the Worker, its Durable Object namespace, the D1 database and the R2 bucket all take Kalamo names. A D1 database cannot be renamed and Durable Object storage belongs to its Worker, so the Kalamo resources are created and the live Documents are moved into them. Writes on the old Worker are frozen, a final copy of both Documents and their state is taken, and both are verified field for field against that copy before traffic switches (#180). Only then is the old deployment deleted, from an explicit target list checked before and after, with a report of what can still be recovered (#181). The owner authorized that deletion but not any loss of data. Resources of other projects on the same account, including the KV namespace `OAUTH_KV`, are never touched.

**The Documents move by export and import, not by a Durable Object transfer (#180).** A `transferred_classes` migration would name the old Worker in the tracked config, would take the objects away from the old Worker so that rolling back needs a reverse transfer, and cannot be rehearsed locally. Instead a one-off version of the old Worker, its deployed code unchanged underneath, refuses every write and gives the owner a read-only dump of each Document's whole Durable Object storage: every table and row, the alarm and every KV key. D1 is exported the usual way. Kalamo's D1 takes that export and then migrations 0002–0006. A one-off version of `kalamo` loads each dump into a new Durable Object in the old schema and resets it, so the legacy upgrade runs in the constructor as it would for any old Document, and dumps it again for a field-by-field check against the copy. Only then is `kalamo` deployed from `main`. The old Worker keeps its data untouched, so rolling back is redeploying its original version. The tooling lives outside the working tree with the final copy, and the whole path, rollback included, was rehearsed under `wrangler dev` first.

**No trace of the old name is left in the working tree.** The owner decided on 2026-09-29 that when the rename is done, a case-insensitive search for the old name over every tracked file's content and path finds nothing: code, tests, XML and JSON fixtures, docs and config alike, with no allowlist entry left to keep a brand trace. GitHub Issues and the Claude project memory reach the same state (#182). Git history is not rewritten, and the Cloudflare backups and recovery records of #179 and #180 are kept outside the working tree, where they do not count. Reading the old forms needs the old name, so `packages/core/src/legacy.ts` is its one source: it builds the name from parts, so no tracked file spells it out, and derives the legacy SVG namespace from it. The SVG importer, the browser-storage fallback and the old-name guard take it from there, and tests build their legacy inputs from it at run time instead of keeping legacy fixtures.

**The old-name guard.** `fixtures/old-name.test.ts`, part of `pnpm check`, fails on any case-insensitive hit of the old name in a tracked file's content or path that no allowlist entry covers. Each entry states why the hit stays and which rename ticket removes it, and the test also fails on an entry that covers nothing, so each ticket deletes the entries it empties. No entry is permanent: when the rename is done, the allowlist is empty and the guard stays as the check that it remains so.

## Considered Options

- **Keep the former name.** Rejected: the meaning is not a niche reading but the everyday word in Arabic and Hebrew.
- **Duktus**, the stroke order of a letterform. The cleanest registry and trademark profile, but obscure and harder to say and remember.
- **Pennel**, "a little pen". The best domains, but one letter from PENTEL, a famous pen brand in this product space.
- **Kalamos**, the Greek word itself. It shares Kalamo's neighbours and adds a crates.io conflict and a transcription app at `kalamos.app`; it stays the fallback.
- Lineva, Calamo and Kresba were eliminated for near-identical drawing apps or taken domains, and a longer list at the screen; #172 has the evidence for each.

## Consequences

- The rename lands in serial tickets under #172, each merged and verified on its own: internal code (#174), protocol and storage surfaces (#175), the repository (#176), docs (#177), the landing page (#178), and the Cloudflare inventory, migration and deletion (#179 to #181), then issues and memory (#182).
- The DO class `DocumentObject` has no brand and keeps its name.
- Agent developers must update their MCP permission allowlists to `mcp__kalamo__*`, their `claude mcp add` name to `kalamo` and the server URL. The README says so (#175).
- #67 (Character Ranges) keeps ADR-0068 and resumes rebased onto the renamed `main`, spelling its changes with the new names.
