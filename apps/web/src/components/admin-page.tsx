'use client';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { Clock, Copy, KeyRound, MailPlus, RefreshCw, Save, ShieldCheck, Trash2, UserCog } from 'lucide-react';
import { api } from '@/lib/api';

type Membership = {
  id: string;
  companyId: string;
  companyName: string;
  role: string;
  status: string;
};

type Account = {
  id: string;
  email: string;
  name: string;
  role: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  memberships: Membership[];
};

type AdminSettings = {
  signupEnabled: boolean;
  kanbanTaskTimeoutSeconds: number;
  apiTokenConfigured: boolean;
  apiTokenPreview?: string | null;
  apiTokenUpdatedAt?: string | null;
  apiTokenOwnerEmail?: string | null;
  apiToken?: string;
};
type Company = { id: string; name: string };
type InviteResponse = {
  token: string;
  acceptUrl: string;
  invite: { id: string; email: string; name?: string | null; role: string; status: string; expiresAt?: string | null };
};

const roles = ['viewer', 'operator', 'admin'];
const statuses = ['active', 'disabled'];

export function AdminPage() {
  const [tab, setTab] = useState<'general' | 'accounts' | 'invites'>('general');
  const [expandedAccountId, setExpandedAccountId] = useState('');
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [passwords, setPasswords] = useState<Record<string, string>>({});
  const [inviteCompanyId, setInviteCompanyId] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [inviteRole, setInviteRole] = useState('viewer');
  const [inviteExpiresDays, setInviteExpiresDays] = useState('7');
  const [lastInvite, setLastInvite] = useState<InviteResponse | null>(null);
  const [lastApiToken, setLastApiToken] = useState('');
  const [apiUrl, setApiUrl] = useState('/api/proxy');
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setError('');
    const [nextSettings, nextAccounts, nextCompanies] = await Promise.all([
      api<AdminSettings>('/api/admin/settings'),
      api<Account[]>('/api/admin/users'),
      api<Company[]>('/api/companies'),
    ]);
    setSettings(nextSettings);
    setAccounts(nextAccounts);
    setCompanies(nextCompanies);
    if (!inviteCompanyId && nextCompanies[0]) setInviteCompanyId(nextCompanies[0].id);
  }

  useEffect(() => { void refresh().catch((err) => setError(err instanceof Error ? err.message : 'Unable to load admin data')); }, []);
  useEffect(() => { setApiUrl(`${window.location.origin}/api/proxy`); }, []);

  const activeAdmins = useMemo(() => accounts.filter((account) => account.role === 'admin' && account.status === 'active').length, [accounts]);

  function patchAccount(id: string, patch: Partial<Account>) {
    setAccounts((current) => current.map((account) => account.id === id ? { ...account, ...patch } : account));
  }

  async function saveSettings() {
    if (!settings) return;
    setBusy(true);
    setError('');
    try {
      const saved = await api<AdminSettings>('/api/admin/settings', { method: 'PUT', body: JSON.stringify({
        signupEnabled: settings.signupEnabled,
        kanbanTaskTimeoutSeconds: settings.kanbanTaskTimeoutSeconds,
      }) });
      setSettings(saved);
      setToast('Settings saved');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Settings update failed');
    } finally {
      setBusy(false);
    }
  }

  async function rotateApiToken() {
    setBusy(true);
    setError('');
    try {
      const saved = await api<AdminSettings>('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ apiTokenAction: 'rotate' }) });
      setSettings(saved);
      setLastApiToken(saved.apiToken ?? '');
      setToast('API token rotated');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'API token update failed');
    } finally {
      setBusy(false);
    }
  }

  async function revokeApiToken() {
    if (!window.confirm('Revoke the current API token? Existing API clients using it will stop working.')) return;
    setBusy(true);
    setError('');
    try {
      const saved = await api<AdminSettings>('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ apiTokenAction: 'revoke' }) });
      setSettings(saved);
      setLastApiToken('');
      setToast('API token revoked');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'API token update failed');
    } finally {
      setBusy(false);
    }
  }

  async function copyText(value: string, label: string) {
    await navigator.clipboard.writeText(value);
    setToast(`${label} copied`);
  }

  async function saveAccount(account: Account) {
    setBusy(true);
    setError('');
    try {
      const password = passwords[account.id]?.trim();
      await api(`/api/admin/users/${account.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: account.name,
          role: account.role,
          status: account.status,
          ...(password ? { password } : {}),
        }),
      });
      setPasswords((current) => ({ ...current, [account.id]: '' }));
      setToast('Account saved');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Account update failed');
    } finally {
      setBusy(false);
    }
  }

  async function createInvite() {
    if (!inviteCompanyId || !inviteEmail.trim()) return;
    setBusy(true);
    setError('');
    try {
      const response = await api<InviteResponse>('/api/auth/invites', {
        method: 'POST',
        body: JSON.stringify({
          companyId: inviteCompanyId,
          email: inviteEmail.trim(),
          name: inviteName.trim() || undefined,
          role: inviteRole,
          expiresInDays: Number(inviteExpiresDays || 7),
        }),
      });
      setLastInvite(response);
      setToast('Invite created');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invite creation failed');
    } finally {
      setBusy(false);
    }
  }

  async function copyInviteUrl() {
    if (!lastInvite?.acceptUrl) return;
    await navigator.clipboard.writeText(lastInvite.acceptUrl);
    setToast('Invite URL copied');
  }

  return <div style={{ display: 'grid', gap: 16 }}>
    <div className="page-head">
      <div><h1>Admin</h1><p>Manage global accounts, signup access, roles, and account status.</p></div>
    </div>
    {toast && <p className="status-pill">{toast}</p>}
    {error && <p className="form-error">{error}</p>}

    <div className="tab-row page-tabs">
      {(['general', 'accounts', 'invites'] as const).map((next) => <button key={next} className={`tab ${tab === next ? 'active' : ''}`} onClick={() => setTab(next)}>{next}</button>)}
    </div>

    {tab === 'general' && <div className="data-grid">
      <section className="card section-card">
        <div className="panel-title"><h2>Signup control</h2><ShieldCheck size={18} /></div>
        <label className="check-row">
          <input type="checkbox" checked={settings?.signupEnabled ?? true} onChange={(event) => setSettings((current) => ({ ...(current ?? { signupEnabled: true, kanbanTaskTimeoutSeconds: 300, apiTokenConfigured: false }), signupEnabled: event.target.checked }))} />
          Signup enabled
        </label>
        <p className="auth-note">Signup defaults to enabled in the DB. If no active admin exists, the next signup becomes global admin and default-company admin.</p>
        <button className="btn btn-primary" onClick={saveSettings} disabled={busy || !settings}><Save size={15} /> Save settings</button>
      </section>

      <section className="card section-card">
        <div className="panel-title"><h2>Kanban runtime</h2><Clock size={18} /></div>
        <label className="field-label">Task timeout seconds
          <input
            className="input"
            type="number"
            min={30}
            max={14400}
            step={30}
            value={settings?.kanbanTaskTimeoutSeconds ?? 300}
            onChange={(event) => setSettings((current) => ({ ...(current ?? { signupEnabled: true, apiTokenConfigured: false, kanbanTaskTimeoutSeconds: 300 }), kanbanTaskTimeoutSeconds: Number(event.target.value || 300) }))}
          />
        </label>
        <p className="auth-note">Used by Kanban dispatch, Message Board delegation, and review when a card has no per-card timeout override.</p>
        <button className="btn btn-primary" onClick={saveSettings} disabled={busy || !settings}><Save size={15} /> Save settings</button>
      </section>

      <section className="card section-card">
        <div className="panel-title"><h2>Direct API token</h2><KeyRound size={18} /></div>
        <div className="meta-grid">
          <span>API URL <b>{apiUrl}</b></span>
          <span>Status <b>{settings?.apiTokenConfigured ? 'configured' : 'not configured'}</b></span>
          <span>Token <b>{settings?.apiTokenPreview ?? 'none'}</b></span>
          <span>Owner <b>{settings?.apiTokenOwnerEmail ?? 'none'}</b></span>
          <span>Updated <b>{settings?.apiTokenUpdatedAt ? new Date(settings.apiTokenUpdatedAt).toLocaleString() : 'never'}</b></span>
        </div>
        {lastApiToken && <label className="field-label">New token
          <div className="action-row">
            <input className="input" readOnly value={lastApiToken} />
            <button className="btn" onClick={() => copyText(lastApiToken, 'API token')}><Copy size={15} /> Copy</button>
          </div>
        </label>}
        <div className="action-row">
          <button className="btn" onClick={() => copyText(apiUrl, 'API URL')}><Copy size={15} /> Copy URL</button>
          <button className="btn btn-primary" onClick={rotateApiToken} disabled={busy}><RefreshCw size={15} /> Rotate token</button>
          <button className="btn" style={{ color: 'var(--danger)' }} onClick={revokeApiToken} disabled={busy || !settings?.apiTokenConfigured}><Trash2 size={15} /> Revoke</button>
        </div>
      </section>

      <section className="card section-card">
        <div className="panel-title"><h2>Account summary</h2><UserCog size={18} /></div>
        <div className="meta-grid">
          <span>Total accounts <b>{accounts.length}</b></span>
          <span>Active admins <b>{activeAdmins}</b></span>
          <span>Signup <b>{settings?.signupEnabled ? 'enabled' : 'disabled'}</b></span>
        </div>
      </section>
    </div>}

    {tab === 'invites' && <section className="card section-card">
      <div className="panel-title"><h2>Company Invite</h2><MailPlus size={18} /></div>
      <div className="form-grid">
        <label className="field-label">Company<select className="input" value={inviteCompanyId} onChange={(event) => setInviteCompanyId(event.target.value)}>{companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}</select></label>
        <label className="field-label">Email<input className="input" type="email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} /></label>
        <label className="field-label">Name<input className="input" value={inviteName} onChange={(event) => setInviteName(event.target.value)} /></label>
        <label className="field-label">Company role<select className="input" value={inviteRole} onChange={(event) => setInviteRole(event.target.value)}>{roles.map((role) => <option key={role} value={role}>{role}</option>)}</select></label>
        <label className="field-label">Expires in days<input className="input" type="number" min={1} max={30} value={inviteExpiresDays} onChange={(event) => setInviteExpiresDays(event.target.value)} /></label>
      </div>
      <div className="action-row">
        <button className="btn btn-primary" onClick={createInvite} disabled={busy || !inviteCompanyId || !inviteEmail.trim()}><MailPlus size={15} /> Create invite</button>
        {lastInvite && <button className="btn" onClick={copyInviteUrl}><Copy size={15} /> Copy accept URL</button>}
      </div>
      {lastInvite && <div className="meta-grid">
        <span>Email <b>{lastInvite.invite.email}</b></span>
        <span>Role <b>{lastInvite.invite.role}</b></span>
        <span>Status <b>{lastInvite.invite.status}</b></span>
        <span>Expires <b>{lastInvite.invite.expiresAt ? new Date(lastInvite.invite.expiresAt).toLocaleString() : 'none'}</b></span>
        <span>Accept URL <b>{lastInvite.acceptUrl}</b></span>
        <span>Raw token <b>{lastInvite.token}</b></span>
      </div>}
    </section>}

    {tab === 'accounts' && <section className="card section-card">
      <div className="panel-title"><h2>Accounts</h2><span className="status-pill">{accounts.length} users</span></div>
      <div className="table-wrap">
        <table className="data-table">
          <thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Status</th><th>Memberships</th><th>Actions</th></tr></thead>
          <tbody>
            {accounts.map((account) => (
              <Fragment key={account.id}>
                <tr key={account.id}>
                  <td><b>{account.email}</b><small>{account.id}</small></td>
                  <td>{account.name}</td>
                  <td><span className="badge">{account.role}</span></td>
                  <td><span className="badge">{account.status}</span></td>
                  <td>{account.memberships.length ? `${account.memberships.length} companies` : 'none'}</td>
                  <td><button className="btn" onClick={() => setExpandedAccountId(expandedAccountId === account.id ? '' : account.id)}>{expandedAccountId === account.id ? 'Close' : 'Edit'}</button></td>
                </tr>
                {expandedAccountId === account.id && <tr key={`${account.id}-edit`} className="expanded-row">
                  <td colSpan={6}>
                    <div className="form-grid">
                      <label className="field-label">Name<input className="input" value={account.name} onChange={(event) => patchAccount(account.id, { name: event.target.value })} /></label>
                      <label className="field-label">Global role<select className="input" value={account.role} onChange={(event) => patchAccount(account.id, { role: event.target.value })}>{roles.map((role) => <option key={role} value={role}>{role}</option>)}</select></label>
                      <label className="field-label">Status<select className="input" value={account.status} onChange={(event) => patchAccount(account.id, { status: event.target.value })}>{statuses.map((status) => <option key={status} value={status}>{status}</option>)}</select></label>
                      <label className="field-label">Reset password<input className="input" type="password" minLength={8} value={passwords[account.id] ?? ''} onChange={(event) => setPasswords((current) => ({ ...current, [account.id]: event.target.value }))} placeholder="Leave blank to keep current" /></label>
                    </div>
                    <div className="account-memberships">
                      {account.memberships.map((membership) => <span className="badge" key={membership.id}>{membership.companyName}: {membership.role} / {membership.status}</span>)}
                      {account.memberships.length === 0 && <span className="badge">No company membership</span>}
                    </div>
                    <div className="action-row"><button className="btn btn-primary" disabled={busy} onClick={() => saveAccount(account)}><Save size={15} /> Save account</button></div>
                  </td>
                </tr>}
              </Fragment>
            ))}
          </tbody>
        </table>
        {accounts.length === 0 && <p style={{ color: 'var(--muted)' }}>No accounts yet.</p>}
      </div>
    </section>}
  </div>;
}
