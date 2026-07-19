/**
 * RT-1, live: create a doc from markdown containing every block type,
 * re-push the identical markdown, assert zero write requests. The
 * single most valuable test in the catalog — it catches
 * canonicalization drift between the doc side and the AST side for
 * every block type at once. Run: npm run rt1
 */
import { getAccessToken } from '../src/auth.ts';
import { identity } from '../src/blocks.ts';
import { HttpDocsClient } from '../src/gdoc.ts';
import { docToBlocks } from '../src/reader.ts';
import { createFromMarkdown, mdToCanonical, updateFromMarkdown } from '../src/sync.ts';

const CORPUS = `# RT-1 Corpus
## Section one
### Deeper still
Plain paragraph with **bold**, *italic*, and a [link](https://example.com/docs).

Second paragraph so KEEP runs exist between block types.

- alpha
- beta
  - nested one
  - nested two

1. first
2. second

- [ ] an open task
- [x] a finished task

| Name | Qty |
| --- | --- |
| apple | 3 |
| watermelon | 12 |

\`\`\`js
const x = 1;
console.log(x);
\`\`\`

> A quoted line of wisdom.
`;

const token = await getAccessToken();
if (!token) {
  console.error('No usable token — run `npm run auth` first.');
  process.exit(2);
}
const client = new HttpDocsClient(async () => token);

let docId: string | null = null;
let failed = false;
try {
  const created = await createFromMarkdown(client, `gdocs-sync RT-1 ${new Date().toISOString()}`, CORPUS);
  docId = created.documentId;
  console.log(`created ${docId} with ${created.requestsSent} write requests`);

  const plan = await updateFromMarkdown(client, docId, CORPUS);
  console.log(`re-push of identical markdown: regions=${plan.regions} requestsSent=${plan.requestsSent}`);

  if (plan.regions === 0 && plan.requestsSent === 0) {
    console.log('\nRT-1 PASS — noop re-push planned zero writes.');
  } else {
    failed = true;
    console.error('\nRT-1 FAIL — canonicalization drift. Side-by-side identities:');
    const docBlocks = docToBlocks(await client.getDocument(docId)).map((r) => identity(r.block));
    const mdBlocks = mdToCanonical(CORPUS).map(identity);
    const rows = Math.max(docBlocks.length, mdBlocks.length);
    for (let i = 0; i < rows; i++) {
      const match = docBlocks[i] === mdBlocks[i] ? ' ' : '≠';
      console.error(`${match} doc: ${JSON.stringify(docBlocks[i] ?? '∅')}`);
      if (match === '≠') console.error(`   md: ${JSON.stringify(mdBlocks[i] ?? '∅')}`);
    }
  }
} finally {
  if (docId && !failed) {
    await fetch(`https://www.googleapis.com/drive/v3/files/${docId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    }).then(
      (r) => console.log(r.ok ? 'scratch doc deleted' : `cleanup: delete returned ${r.status}`),
      (err) => console.warn(`cleanup failed: ${err}`),
    );
  } else if (docId) {
    console.error(`leaving doc for inspection: https://docs.google.com/document/d/${docId}/edit`);
  }
}
process.exit(failed ? 1 : 0);
