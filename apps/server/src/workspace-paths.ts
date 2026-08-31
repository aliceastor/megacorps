// The directory convention for the company NFS root share. One share, three
// tiers of directories — the company sets the share once, each runtime records
// where it mounted it, and every path below is derived:
//
//   {mount}/{companySlug}/shared/                          company-wide files
//   {mount}/{companySlug}/agents/{agentSlug}/              agent's private home
//   {mount}/{companySlug}/agents/{agentSlug}/project/{p}/  agent's clone of project p
//
// Every project is a git repo, so agent workspaces are clones: two agents on
// the same project have two independent clones and merge through git — that is
// the whole concurrency story. The shared directory is a plain file store with
// no versioning; prompts say so.

export type WorkspacePathContext = {
  companySlug: string;
  agentSlug: string;
  projectName?: string | null;
  mountRoot?: string | null;
};

export function workspacePathSlug(value: string | null | undefined, fallback: string): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || fallback;
}

function joinMount(mountRoot: string, ...parts: string[]): string {
  const separator = mountRoot.includes('\\') && !mountRoot.includes('/') ? '\\' : '/';
  const trimmed = mountRoot.replace(/[\\/]+$/, '');
  return [trimmed, ...parts].join(separator);
}

export function companySharedDir(context: WorkspacePathContext): string | null {
  if (!context.mountRoot) return null;
  return joinMount(context.mountRoot, workspacePathSlug(context.companySlug, 'company'), 'shared');
}

export function agentHomeDir(context: WorkspacePathContext): string | null {
  if (!context.mountRoot) return null;
  return joinMount(context.mountRoot, workspacePathSlug(context.companySlug, 'company'), 'agents', workspacePathSlug(context.agentSlug, 'agent'));
}

export function agentProjectCloneDir(context: WorkspacePathContext): string | null {
  if (!context.mountRoot || !context.projectName) return null;
  return joinMount(
    context.mountRoot,
    workspacePathSlug(context.companySlug, 'company'),
    'agents',
    workspacePathSlug(context.agentSlug, 'agent'),
    'project',
    workspacePathSlug(context.projectName, 'project'),
  );
}

// Prompt lines describing where to work. With a mount they are exact paths;
// without one they fall back to runtime-local roots plus git over HTTP, which
// works from anywhere that can reach the git server.
export function workspaceProtocolLines(context: WorkspacePathContext & { localWorkspaceRoot?: string | null; nfsShareUrl?: string | null }): string[] {
  const clone = agentProjectCloneDir(context);
  const home = agentHomeDir(context);
  const shared = companySharedDir(context);
  if (clone && home && shared) {
    return [
      `Your workspace (clone the project repo here): ${clone}`,
      `Your private agent home (notes, tools, anything persistent that is yours): ${home}`,
      `Company shared files (read-mostly reference material; no versioning and no locks, so think before overwriting): ${shared}`,
      'These paths live on the company shared mount, so your workspace follows you across runtimes. Concurrency between agents is handled entirely by git: you work in your own clone and merge through the repo, never by editing another agent\'s workspace.',
    ];
  }
  return [
    context.nfsShareUrl ? `Company shared mount is not configured on this runtime (share lives at ${context.nfsShareUrl}); using runtime-local storage instead.` : 'No company shared mount on this runtime; using runtime-local storage.',
    `Clone the project repo under ${context.localWorkspaceRoot ?? 'a safe runtime-local folder you own'} and work there; git over HTTP needs no shared filesystem.`,
  ];
}
