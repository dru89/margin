import { promises as fs } from 'fs';
import path from 'path';
import { emptyReview, type ReviewData } from '@shared/types';
import { reanchor } from '@shared/anchors';

export function sidecarPath(docPath: string): string {
  return `${docPath}.review.json`;
}

export async function loadReview(docPath: string, content: string): Promise<ReviewData> {
  const name = path.basename(docPath);
  try {
    const raw = await fs.readFile(sidecarPath(docPath), 'utf8');
    const data = JSON.parse(raw) as ReviewData;
    if (data.version !== 1) return emptyReview(name);
    // The file may have been edited outside the app since the sidecar was
    // written — re-anchor everything against the current content.
    for (const c of data.comments) c.anchor = reanchor(content, c.anchor);
    for (const s of data.suggestions) {
      if (s.status === 'pending') s.anchor = reanchor(content, s.anchor);
    }
    return data;
  } catch {
    return emptyReview(name);
  }
}

export async function saveReview(docPath: string, review: ReviewData): Promise<void> {
  await fs.writeFile(sidecarPath(docPath), JSON.stringify(review, null, 2) + '\n', 'utf8');
}
