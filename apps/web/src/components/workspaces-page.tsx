'use client';
import { useEffect, useMemo, useState } from 'react';
import { Download, FileText, Folder, FolderPlus, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import { api } from '@/lib/api';

type Company = { id: string; name: string; slug: string };
type Project = { id: string; companyId: string; name: string; description?: string | null; workPath?: string | null; workspacePathHint?: string | null };
type WorkspaceNode = { id: string; projectId: string; name: string; kind: 'folder' | 'file'; path: string; body?: string };

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
}

function starterNodes(project: Project, company: Company): WorkspaceNode[] {
  const projectSlug = slugify(project.name);
  const base = `/workspaces/${company.slug}/${projectSlug}`;
  return [
    { id: `${project.id}-readme`, projectId: project.id, kind: 'file', name: 'README.md', path: `${base}/README.md`, body: `# ${project.name}\n\n${project.description || 'Project workspace documentation.'}\n\nAuthority path: ${base}/` },
    { id: `${project.id}-notes`, projectId: project.id, kind: 'folder', name: 'meeting-notes', path: `${base}/meeting-notes/` },
    { id: `${project.id}-deliverables`, projectId: project.id, kind: 'folder', name: 'deliverables', path: `${base}/deliverables/` },
  ];
}

export function WorkspacesPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [companyId, setCompanyId] = useState('');
  const [nodes, setNodes] = useState<WorkspaceNode[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState('');
  const [newName, setNewName] = useState('');
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');

  const selectedCompany = companies.find((company) => company.id === companyId) ?? companies[0] ?? null;
  const companyProjects = useMemo(() => projects.filter((project) => project.companyId === selectedCompany?.id), [projects, selectedCompany?.id]);
  const companyNodes = useMemo(() => nodes.filter((node) => companyProjects.some((project) => project.id === node.projectId)), [nodes, companyProjects]);
  const selectedNode = companyNodes.find((node) => node.id === selectedNodeId) ?? companyNodes[0] ?? null;
  const rootPath = selectedCompany ? `/workspaces/${selectedCompany.slug}/` : '/workspaces/';

  async function refresh(nextCompanyId = companyId) {
    setError('');
    try {
      const [companyRows, projectRows] = await Promise.all([api<Company[]>('/api/companies'), api<Project[]>('/api/projects')]);
      setCompanies(companyRows);
      setProjects(projectRows);
      const activeCompany = companyRows.find((company) => company.id === nextCompanyId) ?? companyRows[0] ?? null;
      setCompanyId(activeCompany?.id ?? '');
      if (activeCompany) {
        const seeded = projectRows.filter((project) => project.companyId === activeCompany.id).flatMap((project) => starterNodes(project, activeCompany));
        setNodes((current) => {
          const custom = current.filter((node) => !node.id.includes('-readme') && !node.id.includes('-notes') && !node.id.includes('-deliverables'));
          return [...seeded, ...custom];
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load workspace');
    }
  }

  useEffect(() => { void refresh(); }, []);

  function addNode(kind: 'folder' | 'file') {
    if (!selectedCompany || companyProjects.length === 0) {
      setError('Create a project before adding workspace files.');
      return;
    }
    const project = selectedNode ? companyProjects.find((item) => item.id === selectedNode.projectId) ?? companyProjects[0] : companyProjects[0];
    if (!project) return;
    const name = newName.trim() || (kind === 'folder' ? 'new-folder' : 'new-file.md');
    const projectSlug = slugify(project.name);
    const normalizedName = kind === 'folder' ? name.replace(/\/+$/, '') : name;
    const path = `/workspaces/${selectedCompany.slug}/${projectSlug}/${normalizedName}${kind === 'folder' ? '/' : ''}`;
    const node: WorkspaceNode = {
      id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      projectId: project.id,
      kind,
      name: normalizedName,
      path,
      body: kind === 'file' ? `# ${normalizedName}\n\nAuthority path: ${path}` : undefined,
    };
    setNodes((current) => [node, ...current]);
    setSelectedNodeId(node.id);
    setNewName('');
    setToast(kind === 'folder' ? 'Folder added locally' : 'File added locally');
  }

  function deleteSelected() {
    if (!selectedNode) return;
    setNodes((current) => current.filter((node) => node.id !== selectedNode.id));
    setSelectedNodeId('');
    setToast('Workspace item removed locally');
  }

  return <div className="page-stack workspace-page">
    <div className="page-head">
      <div><h1>Workspace</h1><p>Company folder manager and authoritative location path for non-coding project files.</p></div>
    </div>
    {toast && <p className="status-pill">{toast}</p>}
    {error && <p className="form-error">{error}</p>}

    <section className="card section-card">
      <div className="form-grid">
        <label className="field-label">Workspace company<select className="input" value={selectedCompany?.id ?? ''} onChange={(event) => { setCompanyId(event.target.value); void refresh(event.target.value); }}>
          {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
        </select></label>
        <label className="field-label">Authority root<input className="input" value={rootPath} readOnly /></label>
      </div>
      <div className="action-row">
        <input className="input compact" placeholder="folder-or-file-name" value={newName} onChange={(event) => setNewName(event.target.value)} />
        <button className="btn" onClick={() => addNode('folder')}><FolderPlus size={15} /> New Folder</button>
        <button className="btn" onClick={() => addNode('file')}><Plus size={15} /> New File</button>
        <button className="btn" disabled><Upload size={15} /> Upload</button>
      </div>
    </section>

    <div className="workspace-layout">
      <section className="card section-card workspace-tree">
        <div className="panel-title"><h2>Files</h2><span className="status-pill">{companyNodes.length} items</span></div>
        {companyProjects.map((project) => {
          const projectNodes = companyNodes.filter((node) => node.projectId === project.id);
          return <div className="workspace-project" key={project.id}>
            <h3><Folder size={15} /> {project.name}</h3>
            <div className="table-list">
              {projectNodes.map((node) => <button className="workspace-node" key={node.id} onClick={() => setSelectedNodeId(node.id)} style={{ borderColor: node.id === selectedNode?.id ? 'var(--primary)' : 'var(--border)' }}>
                {node.kind === 'folder' ? <Folder size={15} /> : <FileText size={15} />}
                <span>{node.name}</span>
                <small>{node.path}</small>
              </button>)}
            </div>
          </div>;
        })}
        {companyProjects.length === 0 && <p className="chat-empty">No projects yet. Create project records on the Projects page first.</p>}
      </section>

      <section className="card section-card">
        <div className="panel-title">
          <div><h2>{selectedNode?.name ?? 'No file selected'}</h2><span className="status-pill">{selectedNode?.kind ?? 'empty'}</span></div>
        </div>
        <div className="meta-grid">
          <span>Path <b>{selectedNode?.path ?? rootPath}</b></span>
          <span>Authority <b>{selectedCompany?.name ?? 'Company'}{selectedNode ? ` / ${projects.find((project) => project.id === selectedNode.projectId)?.name ?? 'Project'}` : ''}</b></span>
          <span>Root <b>{rootPath}</b></span>
          <span>Mode <b>local UI manager</b></span>
        </div>
        {selectedNode?.kind === 'file'
          ? <pre className="log-block workspace-preview">{selectedNode.body}</pre>
          : <div className="chat-empty-state"><Folder size={28} /><b>{selectedNode?.name ?? 'Workspace'}</b><span>{selectedNode?.path ?? rootPath}</span></div>}
        <div className="action-row">
          <button className="btn" disabled={!selectedNode || selectedNode.kind !== 'file'}><Pencil size={15} /> Edit</button>
          <button className="btn" disabled={!selectedNode || selectedNode.kind !== 'file'}><Download size={15} /> Download</button>
          <button className="btn" disabled={!selectedNode} onClick={deleteSelected} style={{ color: 'var(--danger)' }}><Trash2 size={15} /> Delete</button>
        </div>
      </section>
    </div>
  </div>;
}
