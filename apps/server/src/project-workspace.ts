type CompanyWorkspaceRef = {
  name?: string | null;
  slug?: string | null;
};

type ProjectWorkspaceRef = {
  id?: string | null;
  name?: string | null;
  workspacePathHint?: string | null;
};

export function workspaceSlug(value: string | null | undefined, fallback: string): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || fallback;
}

export function projectSharedWorkspacePath(company: CompanyWorkspaceRef | null | undefined, project: ProjectWorkspaceRef | null | undefined): string | null {
  if (!project) return null;
  const companySlug = workspaceSlug(company?.slug ?? company?.name, 'company');
  const projectSlug = workspaceSlug(project.name ?? project.id, 'project');
  return `/workspaces/${companySlug}/${projectSlug}`;
}

export function projectDeliverablesPath(company: CompanyWorkspaceRef | null | undefined, project: ProjectWorkspaceRef | null | undefined, cardId?: string | null): string | null {
  const root = projectSharedWorkspacePath(company, project);
  if (!root) return null;
  return cardId ? `${root}/deliverables/${cardId}/` : `${root}/deliverables/`;
}

export function projectSharedFileSpaceLines(company: CompanyWorkspaceRef | null | undefined, project: ProjectWorkspaceRef | null | undefined, cardId?: string | null): string[] {
  const root = projectSharedWorkspacePath(company, project);
  const deliverables = projectDeliverablesPath(company, project, cardId);
  if (!root || !deliverables) return ['Project shared file space: none (no project selected).'];
  const projectId = project?.id ?? '<projectId>';
  return [
    `Project shared file space: ${root}/`,
    `Project deliverables path: ${deliverables}`,
    project?.workspacePathHint ? `Runtime-local workspace hint: ${project.workspacePathHint}` : '',
    'Cross-host agents must use the MegaCorps API with Authorization: Bearer <MEGACORPS_API_TOKEN>; do not assume this path is mounted on every Hermes host.',
    `Pull file API: GET /api/projects/${projectId}/workspace-files?path=${deliverables}<filename>`,
    `Push file API: PUT /api/projects/${projectId}/workspace-files with JSON { "path": "${deliverables}<filename>", "body": "...", "contentType": "text/markdown" }`,
    'Use this project shared file space for durable reports, exports, handoff docs, and non-code deliverables.',
    'Runtime-local scratch paths such as /tmp are temporary only. Final deliverables must be attached as workProducts with a URL/path that points to the project shared file space or another durable location.',
  ].filter(Boolean);
}

function normalizeWorkspaceInput(company: CompanyWorkspaceRef | null | undefined, project: ProjectWorkspaceRef, inputPath: string | null | undefined): { root: string; normalized: string } {
  const root = projectSharedWorkspacePath(company, project);
  if (!root) throw new Error('project_workspace_not_available');
  const raw = inputPath?.trim();
  const cleanedInput = (raw || root).replace(/\\/g, '/').replace(/\/+/g, '/');
  const absolute = cleanedInput.startsWith('/')
    ? cleanedInput
    : `${root}/${cleanedInput.replace(/^\/+/, '')}`;
  const normalized = absolute.replace(/\/+/g, '/');
  if (normalized !== root && !normalized.startsWith(`${root}/`)) {
    throw new Error(`workspace_path_outside_project: expected path under ${root}/`);
  }
  if (normalized.split('/').some((part) => part === '..')) throw new Error('workspace_path_must_not_contain_parent_segments');
  return { root, normalized };
}

export function normalizeProjectWorkspacePath(company: CompanyWorkspaceRef | null | undefined, project: ProjectWorkspaceRef, inputPath: string): string {
  if (!inputPath.trim()) throw new Error('workspace_path_required');
  const { normalized } = normalizeWorkspaceInput(company, project, inputPath);
  if (normalized.endsWith('/')) throw new Error('workspace_file_path_required');
  return normalized;
}

export function normalizeProjectWorkspacePrefix(company: CompanyWorkspaceRef | null | undefined, project: ProjectWorkspaceRef, inputPrefix?: string | null): string {
  const { normalized } = normalizeWorkspaceInput(company, project, inputPrefix);
  return normalized.endsWith('/') ? normalized : `${normalized}/`;
}
