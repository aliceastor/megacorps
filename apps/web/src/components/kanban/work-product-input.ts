import type { WorkProductType } from './card-types';

// This is a display/input convenience, never proof that a provider verified a result.
// The server's existing candidate normalization accepts PRs through `url`.
export function inferWorkProductType(value: string): WorkProductType {
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol)) return 'external';
    if (/\/(?:pull|pulls|merge_requests)\/\d+\/?$/.test(url.pathname)) return 'pull_request';
    if (/\/commit\/[a-f\d]{7,64}\/?$/i.test(url.pathname)) return 'commit';
  } catch { /* Non-URL references remain manual/external evidence. */ }
  return 'external';
}
