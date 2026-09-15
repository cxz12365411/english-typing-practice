# Street-photography content sync — 2026-09-15

Source: the user's `street-photography-english-phrases.md` document. English text,
Chinese meanings, and pronunciation hints are preserved verbatim. The original
850 words and 168 sentences remain unchanged, including their keys and order.

| New sentence category | Items | Stable keys |
| --- | ---: | --- |
| 街头摄影：开场与征求同意 | 4 | sentence-0169–0172 |
| 街头摄影：拍摄时引导动作 | 5 | sentence-0173–0177 |
| 街头摄影：看图和发送照片 | 3 | sentence-0178–0180 |
| 街头摄影：礼貌结束 | 2 | sentence-0181–0182 |

The four categories append to the existing sentence categories as `sentences-15`
through `sentences-18`. Totals: 850 words, 182 sentences, 22 categories.

## Publication

- The account-based Aliyun application receives an explicit one-time transactional
  content update during migration. It does not reset or reseed existing content.
- The update records item revisions, an audit event, a content version change,
  and a completion marker. Re-running migration must not duplicate content or
  undo later edits/unpublishing by administrators.
- Conflicting category slugs or item keys abort the update instead of overwriting
  existing rows. A failed transaction leaves no partial content or marker.
- GitHub Pages uses the same expanded sentence Markdown on `codex/static-pages`;
  it remains a standalone, browser-local practice site without account sync.

## Verification and recovery

Run the server, frontend, browser and deployment test suites before publication.
Check the four categories, counts, pronunciation, punctuation/apostrophe input,
answer persistence and mobile layout. Compare the old parsed corpus and the
14 new entries against their source documents.

Deployment takes a consistent pre-migration database snapshot after stopping API
writes. The snapshot path is recorded in
`/var/lib/english-typing-practice-deployments/<release-id>/database-before`.
The normal protected rollback restores the release and that database snapshot:

```bash
sudo /usr/local/libexec/english-typing-practice/rollback-release.sh <release-id> --restore-database
```

Use the runbook in `deploy/README.md` before a later rollback, because restoring
the pre-deployment snapshot also reverts learning activity after that snapshot.
The GitHub Pages sentence-file change can be reverted independently without
changing the Aliyun database or the robot website.
