import { promises as fs } from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import type { FileProposal, ProposalsData } from '@shared/types';

/**
 * Agent file proposals are project-scoped, like the discussion: the index
 * lives at `.margin/proposals.json`, and each pending proposal's content is
 * staged at `.margin/proposed/<relative path>` until the author decides.
 * Both ride along with round checkpoints (the `.margin` pathspec).
 */

export function proposalsPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.margin', 'proposals.json');
}

export function stagedPath(workspaceRoot: string, relPath: string): string {
  return path.join(workspaceRoot, '.margin', 'proposed', relPath);
}

export async function loadProposals(workspaceRoot: string): Promise<ProposalsData> {
  try {
    const raw = await fs.readFile(proposalsPath(workspaceRoot), 'utf8');
    const data = JSON.parse(raw) as ProposalsData;
    if (data.version === 1) return data;
  } catch {
    /* no proposals yet */
  }
  return { version: 1, proposals: [] };
}

async function saveProposals(workspaceRoot: string, data: ProposalsData): Promise<void> {
  const p = proposalsPath(workspaceRoot);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/**
 * Validate an agent-supplied proposal path. Returns the normalized
 * workspace-relative path or an error string.
 */
export async function validateProposalPath(
  workspaceRoot: string,
  rawPath: string,
): Promise<{ rel: string } | { error: string }> {
  const rel = path.normalize(rawPath).replace(/^[/\\]+/, '');
  if (!rel || rel === '.') return { error: 'Path is empty.' };
  if (rel.split(/[/\\]/).some((seg) => seg === '..')) {
    return { error: 'Path must stay inside the workspace (no "..").' };
  }
  if (rel.split(/[/\\]/).some((seg) => seg.startsWith('.'))) {
    return { error: 'Path must not contain hidden segments (dotfiles/dotdirs).' };
  }
  const abs = path.resolve(workspaceRoot, rel);
  if (abs !== workspaceRoot && !abs.startsWith(workspaceRoot + path.sep)) {
    return { error: 'Path must stay inside the workspace.' };
  }
  try {
    await fs.access(abs);
    return { error: `A file already exists at ${rel}. Proposals are for new files only.` };
  } catch {
    return { rel };
  }
}

/**
 * Stage a proposal: write content under `.margin/proposed/` and record it.
 * Re-proposing a path with a pending proposal updates it in place.
 */
export async function addProposal(
  workspaceRoot: string,
  rel: string,
  content: string,
  note: string,
): Promise<FileProposal> {
  const staged = stagedPath(workspaceRoot, rel);
  await fs.mkdir(path.dirname(staged), { recursive: true });
  await fs.writeFile(staged, content.endsWith('\n') ? content : `${content}\n`, 'utf8');

  const data = await loadProposals(workspaceRoot);
  const existing = data.proposals.find((p) => p.path === rel && p.status === 'pending');
  if (existing) {
    existing.note = note;
    existing.createdAt = new Date().toISOString();
    await saveProposals(workspaceRoot, data);
    return existing;
  }
  const proposal: FileProposal = {
    id: nanoid(8),
    path: rel,
    note,
    createdAt: new Date().toISOString(),
    status: 'pending',
  };
  data.proposals.push(proposal);
  await saveProposals(workspaceRoot, data);
  return proposal;
}

export async function readProposalContent(
  workspaceRoot: string,
  proposal: FileProposal,
): Promise<string> {
  try {
    return await fs.readFile(stagedPath(workspaceRoot, proposal.path), 'utf8');
  } catch {
    return '';
  }
}

/** Materialize the file at its real path (creating folders) and clean up staging. */
export async function acceptProposal(
  workspaceRoot: string,
  id: string,
): Promise<{ absPath: string }> {
  const data = await loadProposals(workspaceRoot);
  const proposal = data.proposals.find((p) => p.id === id);
  if (!proposal || proposal.status !== 'pending') throw new Error('No pending proposal with that id');
  const abs = path.resolve(workspaceRoot, proposal.path);
  let exists = false;
  try {
    await fs.access(abs);
    exists = true;
  } catch {
    /* target is free, as expected */
  }
  if (exists) throw new Error(`A file now exists at ${proposal.path} — resolve that first.`);
  const content = await readProposalContent(workspaceRoot, proposal);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
  await removeStaged(workspaceRoot, proposal.path);
  proposal.status = 'accepted';
  proposal.decidedAt = new Date().toISOString();
  await saveProposals(workspaceRoot, data);
  return { absPath: abs };
}

/** Record the rejection (the agent reads it next round) and drop the staged content. */
export async function rejectProposal(
  workspaceRoot: string,
  id: string,
  comment?: string,
): Promise<void> {
  const data = await loadProposals(workspaceRoot);
  const proposal = data.proposals.find((p) => p.id === id);
  if (!proposal || proposal.status !== 'pending') throw new Error('No pending proposal with that id');
  await removeStaged(workspaceRoot, proposal.path);
  proposal.status = 'rejected';
  proposal.decidedAt = new Date().toISOString();
  if (comment?.trim()) proposal.decisionComment = comment.trim();
  await saveProposals(workspaceRoot, data);
}

async function removeStaged(workspaceRoot: string, rel: string): Promise<void> {
  try {
    await fs.rm(stagedPath(workspaceRoot, rel));
    // Prune now-empty directories up to .margin/proposed.
    const rootDir = path.join(workspaceRoot, '.margin', 'proposed');
    let dir = path.dirname(stagedPath(workspaceRoot, rel));
    while (dir.startsWith(rootDir) && dir !== rootDir) {
      if ((await fs.readdir(dir)).length > 0) break;
      await fs.rmdir(dir);
      dir = path.dirname(dir);
    }
  } catch {
    /* already gone */
  }
}
