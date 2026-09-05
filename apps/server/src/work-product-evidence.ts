import { mergeRepositoryMatches, sameCommit, type MergeWorkProduct } from './merge-gate.ts';

/** Extract identity, never verification, from unambiguous full-SHA browse URLs. */
function commitIdentity(value: string | null | undefined): { repoUrl: string; commitSha: string } | null {
  try {
    const url = new URL(value ?? '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    const match = /^(.*)\/commit\/([a-f\d]{40})\/?$/i.exec(url.pathname);
    if (!match) return null;
    // GitLab uses /group[/subgroup]/repo/-/commit/SHA; Gitea/GitHub omit /-.
    const path = match[1]!.replace(/\/-$/, '');
    const segments = path.slice(1).split('/');
    if (segments.length < 2 || segments.some(segment => !/^[\w.-]+$/.test(segment) || ['.', '..', '-'].includes(segment))) return null;
    return { repoUrl: `${url.origin}${path}`, commitSha: match[2]!.toLowerCase() };
  } catch { return null; }
}

function sameRepository(left: string, right: string): boolean {
  if (!mergeRepositoryMatches(left, right)) return false;
  // The existing provider alias check also applies here. Compare the whole
  // clone path so GitLab repositories in one subgroup cannot alias each other.
  const path = (value: string) => new URL(value).pathname.replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();
  return path(left) === path(right);
}

/** Null means conflicting identity. Explicit consistent Advanced values survive. */
export function normalizeCommitWorkProduct<T extends MergeWorkProduct>(product: T, projectRepoUrl?: string | null): T | null {
  if (product.type !== 'commit') return product;
  const identity = commitIdentity(product.url);
  if (!identity) return product;
  if ((product.repoUrl && !sameRepository(identity.repoUrl, product.repoUrl))
    || (product.commitSha && !sameCommit(identity.commitSha, product.commitSha))
    || (projectRepoUrl && !sameRepository(identity.repoUrl, projectRepoUrl))) return null;
  return { ...product, repoUrl: product.repoUrl || identity.repoUrl, commitSha: product.commitSha || identity.commitSha };
}
