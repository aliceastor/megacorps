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
  return [
    `Project shared file space: ${root}/`,
    `Project deliverables path: ${deliverables}`,
    project?.workspacePathHint ? `Runtime-local workspace hint: ${project.workspacePathHint}` : '',
    'Use this project shared file space for durable reports, exports, handoff docs, and non-code deliverables.',
    'Runtime-local scratch paths such as /tmp are temporary only. Final deliverables must be attached as workProducts with a URL/path that points to the project shared file space or another durable location.',
  ].filter(Boolean);
}
