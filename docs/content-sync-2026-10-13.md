# Bar-social content sync — 2026-10-13

Adds the 32 approved short, natural phrases for adult bar conversation, with
Chinese meanings and approximate Chinese pronunciation hints. Existing speech
is retained; no AI provider, audio generation or new public API is introduced.

| New category | Added | New seed keys |
| --- | ---: | --- |
| 酒吧社交：开场与轻松夸赞 | 8 | sentence-0239–0246 |
| 酒吧社交：点酒与碰杯 | 8 | sentence-0247–0254 |
| 酒吧社交：闲聊与邀请 | 8 | sentence-0255–0262 |
| 酒吧社交：交换联系方式与礼貌结束 | 8 | sentence-0263–0270 |

The source corpus contains 850 words, 270 sentences and 26 categories. The
preceding 238 sentences, 18 sentence categories, meanings, hints, identities and
ordering remain unchanged. Street photography remains 70 phrases.

## Independent publishing paths

- `docs/bar-social-extra-32.md` is the standard three-column administrator import
  file. Its four explicit sentence headings identify the intended categories.
- The canonical sentence corpus retains numbered headings 19–22 and the existing
  `English / 中文谐音 | 中文 | Stable ID` layout supported by both standalone HTML
  entrypoints. The 32 seed keys only identify new installations.
- Existing account databases are not re-seeded. Publish the approved source using
  the current administrator preview/commit workflow, with its normal Origin,
  CSRF, permissions and atomicity checks. Keep actual imported IDs and keys; do
  not replace them with the repository's seed identities.
- Category matching uses the importer's NFKC normalization. A normalized ASCII
  colon in an imported category name is equivalent to the source's full-width
  colon; compare normalized names rather than constructing a duplicate category.
- No new database migration or v3 automatic content patch is added, and the
  account server does not need to be redeployed to publish these content items.
- GitHub Pages continues to publish from `codex/static-pages:/`. Only the public
  sentence corpus changes there; both HTML files, no-login notice, account-site
  link, word corpus and `.nojekyll` marker stay intact.
- Source and tests are hosted on `main`. Credentials, production databases,
  private batch IDs and learning records must not enter the public repository.

## Acceptance and failure handling

Verify the original 238-item fingerprint, category preservation, 32-source
equivalence, four groups of eight, unique normalized English, complete hints,
fresh-installation seed counts and existing-database/retry protection. Keep
historical fixtures scoped to their original content instead of treating new bar
phrases as street-photography additions. Run server, frontend, browser/mobile,
standalone-parser and deployment regression tests.

For the account site, require an actual successful commit and compare the new
published IDs, category membership, file order, old content and learning summary.
For Pages, require a successful deployment associated with the new commit and
verify the ordinary served URLs against the committed content. If authorized
administrator access is unavailable, report the account site as pending rather
than claiming that source changes alone synchronized it.
