# Street-photography sync — 2026-10-10

Synchronizes the same 32 approved short phrases, Chinese meanings and approximate
Chinese pronunciation hints to the public source corpus and no-login GitHub Pages.
The account site already received these phrases through its administrator Markdown
import; no server deployment or production database update is required here.

| Existing category | Before | Added | After | New seed keys |
| --- | ---: | ---: | ---: | --- |
| 街头摄影：开场与征求同意 | 10 | 8 | 18 | sentence-0207–0214 |
| 街头摄影：拍摄时引导动作 | 11 | 8 | 19 | sentence-0215–0222 |
| 街头摄影：看图和发送照片 | 9 | 8 | 17 | sentence-0223–0230 |
| 街头摄影：礼貌结束 | 8 | 8 | 16 | sentence-0231–0238 |

The source corpus now contains 850 words, 238 sentences and 22 categories, with
70 street-photography phrases. All preceding 206 sentence keys, wording,
pronunciation hints, category identities and within-category ordering remain
unchanged; new phrases append to each group's end.

## Formats and independent storage

- `daily-english-high-frequency-sentences.md` retains the standalone-compatible
  `English / 中文谐音 | 中文 | Stable ID` format and numbered section headings.
- `docs/street-photography-extra-32.md` is the reusable three-column import file,
  with explicit existing category headings and no database IDs.
- Seed keys identify new installations only. The existing account site's imported
  item IDs and keys are retained; they must not be replaced with seed keys.
- GitHub Pages is published from `codex/static-pages:/`. Only its public sentence
  corpus is updated; its standalone HTML, no-login notice, account-site link,
  word corpus and `.nojekyll` marker remain intact.
- Public practice source and application code are hosted on `main`. No production
  database, account credentials, private import-batch IDs or learning logs are
  included in the repository.

## Existing-database compatibility

The historical v1/v2 content patches still select only keys 169–206. No v3 patch
is introduced: already-seeded databases, including the live account database
whose 32 phrases were imported earlier, are not automatically changed or seeded
again. New installations seed the complete 850/238 corpus once. Historical
168/182/206 fixtures continue to verify the original additive upgrades.

## Acceptance

Verify original-content fingerprints, 32-import-file equivalence, unique keys and
normalized English, four-group counts 18/19/17/16, fresh seed 1088, and no-repeat
startup behavior. Run the existing server, frontend, browser and deployment tests.
After pushing the Pages branch, require a successful Pages deployment for its
actual commit and compare the served sentence file to the committed file; a Git
push alone is not evidence of a completed public-site update.
