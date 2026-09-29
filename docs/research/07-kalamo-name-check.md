# Kalamo and the other name candidates (research notes, 2026-09-29)

> **Outcome (2026-09-29)**: the owner chose **Kalamo** to replace the former name, which reads as "manure" or "garbage" in Arabic and Hebrew (ADR-0069, #172). This note keeps the candidate evidence and states what was not checked. The rename itself is ADR-0069.

## Method

All checks ran on 2026-09-29.

- **npm, PyPI and crates.io**: HTTP 404 on the package URL means the name is free.
- **npm scope**: registry search on `scope:<name>`.
- **GitHub**: repository search by name, with the top matches by stars, and whether `github.com/<name>` is a taken login.
- **Domains**: RDAP through rdap.org (404 means unregistered), plus the live page title of each registered domain.
- **US trademarks**: USPTO live marks, fuzzy match (edit distance 1), classes 9 and 42, through the tmsearch backend.
- **Meanings**: Wiktionary, language dictionaries and web search.

Legend: ✅ free / unregistered, ❌ taken / registered.

## Ranked

| # | Name | Verdict |
|---|---|---|
| 1 | **Kalamo** | Recommended, chosen |
| 2 | **Duktus** | Recommended |
| 3 | **Pennel** | Recommended |
| 4 | Kalamos | Backup variant of #1 only |
| 5 | Lineva | Eliminated |
| 6 | Calamo | Eliminated |
| 7 | Kresba | Eliminated |

### 1. Kalamo (recommended)

- **Say it**: KAH-lah-moh. Chinese 卡拉莫 (kǎ lā mò). Japanese カラモ. Open syllables, readable in every major script.
- **Etymology**: from Greek *kálamos*, the reed pen. The same word lives on as Latin *calamus*, Arabic *qalam* ("pen"), Turkish *kalem*, Hindi and Urdu *kalam*, Swahili *kalamu*, Hebrew *kulmus* (quill) and Russian *калам* (reed pen). So it means "pen" in a dozen languages, including the two in which the former name is a problem.
- **Product fit**: strong. The first drawing instrument, for a tool where people and agents draw with the Pen. Six letters, and the tool prefix `kalamo_` reads well.
- **Negative screen**: Tagalog *kalamo* is the sweet-flag plant (neutral), and Bolinao *kalamo'* means "companion" (positive). Two notes, both on the *prefix* only. Czech, Slovak, Serbian, Croatian and Bulgarian *kal* means mud, and Russian *кал* is the medical word for faeces. The whole word is not either of these: *kal-* starts many everyday words in those languages (календарь, калина), and Russian has *калам* itself as "reed pen". Arabic كلام *kalām* is "speech", which is positive. No vulgar sense was found.
- **Registries**: npm ✅, PyPI ✅, crates.io ✅, npm scope ✅ (0 packages). GitHub: 70 repos match by name, the largest has 6★. The login `kalamo` is a personal user.
- **Domains**: `kalamo.dev` ✅, `.design` ✅, `.studio` ✅, `.sh` ✅, `.org` ✅, `getkalamo.com` ✅, `usekalamo.com` ✅. `kalamo.com` ❌ (parked, "may be for sale"). `kalamo.app` ❌ (no page). `kalamo.net` ❌. After this check, on 2026-09-29, the owner chose `kalamo.cc` as the product domain.
- **Existing products**: **Kalamo** at `kalamo.ai` is a live AI captioning and translation SaaS for conferences and meetings from econf.ai, €3–399/month.
- **Trademark (US)**: no live KALAMO mark. Nearest in classes 9 and 42: KALAM (a class 9 language-learning app), KARAMO (films), ALAMO (a car-rental app). EU and WIPO were not checked (see *Evidence limits*).
- **Risk: medium-low.** The one real conflict is the Kalamo captioning product. It is also "AI", but it serves a different audience (event attendees and venues, not developers and agents) and a different function (speech captions, not drawing). That is the same kind of overlap that removed Sable (Sable AI's agent SDK), though weaker. Before M1, a manual EU and WIPO search must confirm econf.ai holds no KALAMO mark in classes 9 and 42.

### 2. Duktus (recommended)

- **Say it**: DOOK-toos. Chinese 杜克图斯. English readers may hear "duct".
- **Etymology**: German spelling of Latin *ductus*, "leading". In calligraphy and palaeography, *ductus* is the direction, number and sequence of strokes that make a letterform. In German typography, *Duktus* is the characteristic stroke of a hand.
- **Product fit**: precise for professionals (stroke order and direction, which is what an agent emits), but obscure to most people, so the brand would need explaining.
- **Negative screen**: nothing vulgar found. Swedish *duk* means cloth (neutral). The anatomical *duct* association is neutral.
- **Registries**: npm ✅, PyPI ✅, crates.io ✅, npm scope ✅. GitHub: 10 repos match by name, all 0★. The login `duktus` is a personal user.
- **Domains**: `duktus.dev` ✅, `.design` ✅. `duktus.com` ❌ (VonRoll Hydro water systems). `duktus.ai` ❌. `duktus.studio` ❌. `duktus.app`: unknown (RDAP was rate-limited).
- **Existing products**: DUKTUS is a German brand of ductile-iron pipe systems, now under VonRoll Hydro. Different goods, likely EU classes 6, 11 and 17.
- **Trademark (US)**: no live DUKTUS or DUCTUS mark in classes 9 and 42. Nearest: AUCTUS (consulting), UCTUS (medical billing software).
- **Risk: low legally, medium on memorability.** It has the cleanest registry and software-trademark profile of the seven. It costs more to say and remember than #1.

### 3. Pennel (recommended)

- **Say it**: PEN-el. Chinese 彭内尔.
- **Etymology**: *pen* + a diminutive ending, echoing Italian *pennello* (paintbrush) and Latin *penicillus* (little brush, the root of *pencil*). Also the name of Joseph Pennell, the illustrator and etcher.
- **Product fit**: good and immediately readable in English: "a little pen".
- **Negative screen**: it sits close to English *penal* and *panel*, and invites schoolyard *pen-* puns. Nothing vulgar was found in the major languages.
- **Registries**: npm ✅, PyPI ✅, crates.io ✅, npm scope ✅. GitHub: 48 repos match by name, the largest has 2★. The login `pennel` is a personal user.
- **Domains**: `pennel.dev` ✅, `pennel.app` ✅, `pennel.ai` ✅. `pennel.com` ❌ (Penn-El, a maker of stuffing tubes).
- **Trademark (US)**: no live PENNEL mark. **PENTEL** is one edit away. Pentel is a world-famous pen and art-supply brand, and the US register also holds a live class 9 PENTEL filing by an unrelated individual. Famous marks get protection beyond their own classes, and "pen" products are exactly Pentel's field.
- **Risk: medium.** It has the best domain availability of the seven (.dev, .app and .ai all free), but the near-homophone of a famous pen brand is a real trademark risk in this product space.

### 4. Kalamos (backup variant of #1 only)

- **Say it**: KAH-lah-mos. It has the same etymology as #1: the Greek word itself.
- **Negative screen**: it is a Greek island and village (neutral). Nothing vulgar was found.
- **Registries**: npm ✅, PyPI ✅, crates.io ❌. GitHub: 18 repos match by name, the largest has 6★.
- **Domains**: `kalamos.dev` ✅, `kalamos.ai` ✅. `kalamos.com` ❌ (placeholder site). `kalamos.app` ❌: **Kalamos, offline transcription software for Mac**.
- **Trademark (US)**: nearest marks are ALAMOS (a class 9 audio DSP software feature, and a gold miner) and KAAMOS (guitar pedals).
- **Risk: medium.** It shares #1's speech-product neighbourhood and adds a crates.io conflict. Keep it only as a fallback if a Kalamo mark blocks #1.

### 5. Lineva (eliminated)

- **Say it**: li-NEH-vah. A coinage from *line*. It is also a Russian surname (Линева).
- **Registries**: npm ✅, PyPI ✅, crates.io ✅. GitHub: 95 repos match, all noise.
- **Domains**: `lineva.dev` ✅, `lineva.ai` ✅. `lineva.app` ❌ (a Spanish medical weight-loss platform). `lineva.com` ❌.
- **Trademark (US)**: LINOVA (class 9 and 42 software), LINEA (class 42 AI SaaS) and LINEV (class 9 and 42) are all one edit away. **Linea Sketch** (The Iconfactory) is an established drawing app one letter away.
- **Why eliminated**: it sits in a crowded "line" space with a same-category drawing app.

### 6. Calamo (eliminated)

- **Say it and etymology**: KAH-lah-moh. Italian and Spanish *cálamo*, the reed pen. It is #1's Latin form.
- **Registries**: npm ✅, PyPI ✅, crates.io ✅.
- **Domains**: `calamo.dev`, `.app`, `.ai` and `.com` are **all ❌**. `calamo.dev` serves a Next.js app titled "Calamo".
- **Trademark (US)**: CALUMO (class 9 and 42 analytics software) and CALAMU (class 9 and 42 security software) are one edit away. **Calaméo** (calameo.com, live) is a digital-publishing platform one letter away.
- **Why eliminated**: every useful domain is taken, and two software marks and a publishing platform are one letter off.

### 7. Kresba (eliminated)

- **Say it and etymology**: KRES-bah. Czech and Slovak *kresba*, "a drawing". The *-sb-* cluster is hard outside Slavic languages.
- **Registries**: npm ✅, PyPI ✅, crates.io ✅. The GitHub login `kresba` is free, and only 6 repos match.
- **Domains**: `kresba.dev` ✅, `.app` ✅, `.ai` ✅. `kresba.com` ❌.
- **Trademark (US)**: no live marks nearby.
- **Why eliminated**: **KRESKA.art** (Polish *kreska*, "a line") is a free browser-based drawing and painting app launched in 2025. It is one letter away in exactly our category, and the name is hard to say for most of the audience.

## Eliminated at the screen (not fully evaluated)

| Name | Reason |
|---|---|
| Fude (Japanese 筆, brush) | Near Portuguese *fode*, a vulgar verb form. |
| Kaku (描く, draw) | Starts with Afrikaans and Dutch *kak*, "shit". |
| Pinsel (German, brush) | *Einfaltspinsel* means "simpleton" in German. |
| Pluma (Spanish, pen) | Spanish slang for effeminate, used as a slur. |
| Tuska | Finnish for "agony". |
| Bimo (笔墨) | The Yi priesthood's title, which carries religious weight. |
| Trazio | Near Italian *strazio*, "torment". The domains are taken, and TRAZZO and TRAZI marks exist. |
| Sumi (墨, ink) | npm, PyPI, crates.io and .dev are all taken. 21k GitHub repos. 2,533 US marks match fuzzily. |
| Sumie (墨絵) | `google-deepmind/sumie` is in the AI space. |
| Grapho (Greek, "I draw/write") | `grapho.dev` is "The visual workspace before your AI codes", a direct conflict. |
| Kurbo (Esperanto, curve) | `linebender/kurbo` is a Rust 2D curves library, the same field. |
| Inko (Esperanto, ink) | `inko-lang/inko` is a programming language with 1.3k★. |
| Trazo, Tratto, Traza | .dev and .com are taken, and TRAZO ARCHITECTURE is a class 42 mark. |
| Senga (線画) | `senga.dev` is taken, and it is a Luganda kinship term with a sex-education role. |
| Penna, Qalam, Ductus, Burin, Grafo, Plumo, Nibra, Nibo | npm and/or .dev are taken, or there are active same-name AI or dev products (for example PlumoAI). |
| Curvo | `mattatz/curvo` is a NURBS library with 214★. crates.io and .dev are taken. |
| Penvo, Veklo, Lineo, Stylar, Scriva, Kalamu | No meaning to carry the brand, or npm is taken, or there are near marks (CALAMU). |

## Evidence limits

- **EUIPO, WIPO and CNIPA** were not searched. TMview's API returned empty, bot-blocked responses. WIPO Brand Database and the EU and Chinese registers render only in a browser. The US search is fuzzy by one edit and covers live marks in classes 9 and 42 only, so it is a screen, not clearance.
- **Domains**: `.com` availability of 5- and 6-letter names is essentially nil (every candidate's `.com` is registered). `.io` could not be checked, because rdap.org returns 404 for every `.io`. `duktus.app` could not be checked (rate-limited).
- **Social handles**: X, Bluesky and Instagram handles were not checked, because they need a logged-in browser.
- **Meanings**: the screen covered Arabic, Hebrew, Chinese, Japanese, Korean, Hindi and Urdu, Russian and West and South Slavic, German, Dutch and Afrikaans, Romance languages, Finnish, Turkish, Swahili and Tagalog, as far as dictionaries and web search reach. No native-speaker panel was used.
- **Before M1**, whichever name is chosen still needs a manual EUIPO, WIPO and CNIPA search in classes 9 and 42, done by the owner.

