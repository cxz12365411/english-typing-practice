# Street-photography expansion — 2026-09-16

Publishes the 24 additional phrases approved in the conversation, preserving their
English and Chinese wording and adding approximate Chinese pronunciation hints.
The four existing street-photography categories each receive six new phrases.

| Category | Original | Added | Total | New stable keys |
| --- | ---: | ---: | ---: | --- |
| 开场与征求同意 | 4 | 6 | 10 | sentence-0183–0188 |
| 拍摄时引导动作 | 5 | 6 | 11 | sentence-0189–0194 |
| 看图和发送照片 | 3 | 6 | 9 | sentence-0195–0200 |
| 礼貌结束 | 2 | 6 | 8 | sentence-0201–0206 |

Corpus totals: 850 words, 206 sentences, 22 categories. Street photography: 38
phrases. The preceding 182 sentence keys, content, pronunciation, categories and
within-category ordering are unchanged.

## Stable identity and updates

The four expanded Markdown tables now have an optional third `Stable ID` column.
The backend validates IDs and rejects duplicates. Existing two-column tables
continue to parse as before. Both standalone HTML entry points accept the extra
column as non-visible metadata, retaining their English-text local mistake keys.
Do not renumber or reuse a previously published stable ID.

The `content_update:street-photography-v2` patch runs once, after v1, in the normal
migration transaction. It reuses existing categories and appends only the new
items, revisions and an audit event. Conflicts abort instead of overwriting
administrator content. Completed markers prevent re-imports and preserve later
administrator edits or unpublishing. A new installation seeds the same final
corpus; original 168-sentence installations can apply both updates in order.

The account-based Aliyun release and the `codex/static-pages` branch use the same
expanded Markdown. Accounts and cloud learning records are not copied to Pages.

## Verification and rollback

Verify parser compatibility, upgrade from 182 sentences, full rollback on a late
ID collision, repeated migration, administrator edit preservation, all four
expanded groups, persisted answers, and long sentences on mobile.

Production deployment records a consistent pre-migration database snapshot at
`/var/lib/english-typing-practice-deployments/<release-id>/database-before`.
For recovery, follow `deploy/README.md` and use the protected rollback command:

```bash
sudo /usr/local/libexec/english-typing-practice/rollback-release.sh <release-id> --restore-database
```

A database restore reverts activity after the snapshot; do not use it casually
after learners have resumed practice. GitHub Pages can be reverted independently.
