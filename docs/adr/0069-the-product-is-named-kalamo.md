---
status: accepted
date: 2026-09-29
---

# The product is named Kalamo

The product was named Zibel. Arabic زِبْل *zibl* means "manure, dung", said almost exactly like "zibel", and Modern Hebrew זבל *zevel* and Egyptian زبالة *zebāla* mean "garbage". A vector editor meant to be shown worldwide cannot ship under that name, so it is replaced before the M1 announcement (#172). The candidates, their evidence and what was not checked are in #172; `docs/research/05-name-conflict-check.md` stays as the history of the Zibel choice.

## Decision

**The name is Kalamo**: `kalamo` in identifiers, `Kalamo` capitalised, the workspace scope `@kalamo/*`, the MCP tool prefix `kalamo_`, and the SVG namespace `https://kalamo.dev/ns/svg` with the prefix `kalamo:`. It comes from Greek *kálamos*, the reed pen, which lives on as Latin *calamus*, Arabic *qalam*, Turkish *kalem*, Hindi and Urdu *kalam* and Russian *калам*. It is said KAH-lah-moh. The Chinese reading is **卡拉莫** (kǎ lā mò), the Japanese カラモ. The owner chose it on 2026-09-29.

**Risks the owner accepted** when choosing it:

- **A same-name product.** Kalamo at `kalamo.ai` (econf.ai) is a live AI captioning and translation service for conferences. It serves event attendees and venues with speech captions, not developers and agents with drawing.
- **Trademarks are not cleared.** No live US KALAMO mark exists in classes 9 and 42. EUIPO, WIPO and CNIPA were not searched. Before M1, the owner confirms that nobody holds a KALAMO mark in those classes (#173). If a blocking mark turns up, this decision reopens with **Kalamos** as the fallback.
- **The prefix.** *kal-* is "mud" in several Slavic languages, and Russian *кал* is the medical word for faeces. The whole word carries neither sense.
- **Domains and handles.** `kalamo.com` is parked, `kalamo.app` and `kalamo.net` are registered by others, and the GitHub login `kalamo` is a personal user. `kalamo.dev` was unregistered on 2026-09-29; it names the SVG namespace, and registering it is #173.

**Every surface is renamed.** Code, packages, MCP names, formats, auth, storage, docs, the landing page, the GitHub repository and the Cloudflare deployment all say Kalamo. Only the old forms below are still read.

**Read both.** These old forms keep working after the rename:

| Old form | Rule |
| --- | --- |
| SVG namespace `https://zibel.dev/ns/svg` (`zibel:*`) | Import reads it **permanently**, beside the new one. When an element carries both, the new namespace wins. Export writes only the new one, and warnings name the `kalamo:` prefix. |
| Saved file `<doc>.zibel.json` | Opens unchanged. Open detects a file by content, not by name, and the file holds no brand string. Saving writes `<doc>.kalamo.json`. |
| Browser storage `zibel:tabs`, `zibel:pencil` | Read once: when the `kalamo:` key is absent and the old key is present, the old value is used, written under the new key and the old key is removed. The cutover also carries each browser's keys from the old Worker's origin to the new one while the old Worker exists. |

**No aliases for MCP names.** The 25 `zibel_*` tools, the `zibel` server name, the `skill://zibel/*` resources, the `zibel_json` format and the `zibel:read` and `zibel:write` scopes are renamed without aliases. The server is stateless and every client reads `tools/list` fresh (ADR-0006), nothing is announced before M1, and no OAuth grant exists. An old tool name fails as any unknown tool does. `zibel_json` fails with `INVALID_INPUT` and the nearest-value hint names `kalamo_json` (ADR-0050).

**Cloudflare moves to Kalamo, and the old deployment is deleted only after a verified migration.** The owner decided on 2026-09-29 that the Worker, its Durable Object namespace, the D1 database and the R2 bucket all take Kalamo names. A D1 database cannot be renamed and Durable Object storage belongs to its Worker, so the Kalamo resources are created and the live Documents are moved into them. Writes on `zibel` are frozen, a final copy of both Documents and their state is taken, and both are verified field for field against that copy before traffic switches (#180). Only then is the old `zibel` deployment deleted, from an explicit target list checked before and after, with a report of what can still be recovered (#181). The owner authorized that deletion but not any loss of data. Resources of other projects on the same account, including the KV namespace `OAUTH_KV`, are never touched.

**The old-name guard.** `fixtures/old-name.test.ts`, part of `pnpm check`, fails on any case-insensitive `zibel` in a tracked file's content or path that no allowlist entry covers. Each entry states why the hit stays and which rename ticket removes it, and the test also fails on an entry that covers nothing, so each ticket deletes the entries it empties. When the rename is done, only the entries for the read-both rules above, the `zibel_json` rejection test, research note 05, the research note on the rename (`docs/research/07-…`, added in #177), this ADR and the Cloudflare migration records remain.

## Considered Options

- **Keep Zibel.** Rejected: the meaning is not a niche reading but the everyday word in Arabic and Hebrew.
- **Duktus**, the stroke order of a letterform. The cleanest registry and trademark profile, but obscure and harder to say and remember.
- **Pennel**, "a little pen". The best domains, but one letter from PENTEL, a famous pen brand in this product space.
- **Kalamos**, the Greek word itself. It shares Kalamo's neighbours and adds a crates.io conflict and a transcription app at `kalamos.app`; it stays the fallback.
- Lineva, Calamo and Kresba were eliminated for near-identical drawing apps or taken domains, and a longer list at the screen; #172 has the evidence for each.

## Consequences

- The rename lands in serial tickets under #172, each merged and verified on its own: internal code (#174), protocol and storage surfaces (#175), the repository (#176), docs (#177), the landing page (#178), and the Cloudflare inventory, migration and deletion (#179 to #181), then issues and memory (#182).
- The DO class `DocumentObject` has no brand and keeps its name.
- Agent developers must update permission allowlists such as `mcp__zibel__*`, their `claude mcp add` name and the server URL. The README says so (#175).
- #67 (Character Ranges) keeps ADR-0068 and resumes rebased onto the renamed `main`, spelling its changes with the new names.
