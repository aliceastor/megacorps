'use client';
import { useEffect, useMemo, useState } from 'react';
import { Copy, MailPlus, Save, ShieldCheck, UserCog } from 'lucide-react';
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

  const activeAdmins = useMemo(() => accounts.filter((account) => account.role === 'admin' && account.status === 'active').length, [accounts]);

  function patchAccount(id: string, patch: Partial<Account>) {
    setAccounts((current) => current.map((account) => account.id === id ? { ...account, ...patch } : account));
  }

  async function saveSettings() {
    if (!settings) return;
    setBusy(true);
    setError('');
    try {
      const saved = await api<AdminSettings>('/api/admin/settings', { method: 'PUT', body: JSON.stringify(settings) });
      setSettings(saved);
      setToast('Settings saved');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Settings update failed');
    } finally {
      setBusy(false);
    }
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

    <div className="data-grid">
      <section className="card section-card">
        <div className="panel-title"><h2>Signup control</h2><ShieldCheck size={18} /></div>
        <label className="check-row">
          <input type="checkbox" checked={settings?.signupEnabled ?? true} onChange={(event) => setSettings({ signupEnabled: event.target.checked })} />
          Signup enabled
        </label>
        <p className="auth-note">Signup defaults to enabled in the DB. If no active admin exists, the next signup becomes global admin and default-company admin.</p>
        <button className="btn btn-primary" onClick={saveSettings} disabled={busy || !settings}><Save size={15} /> Save settings</button>
      </section>

      <section className="card section-card">
        <div className="panel-title"><h2>Account summary</h2><UserCog size={18} /></div>
        <div className="meta-grid">
          <span>Total accounts <b>{accounts.length}</b></span>
          <span>Active admins <b>{activeAdmins}</b></span>
          <span>Signup <b>{settings?.signupEnabled ? 'enabled' : 'disabled'}</b></span>
        </div>
      </section>
    </div>

    <section className="card section-card">
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
    </section>

    <section className="card section-card">
      <div className="panel-title"><h2>Accounts</h2><span className="status-pill">{accounts.length} users</span></div>
      <div className="table-list">
        {accounts.map((account) => <div className="list-row admin-account-row" key={account.id}>
          <div className="admin-account-main">
            <div>
              <b>{account.email}</b>
              <p>{account.id}</p>
            </div>
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
          </div>
          <div className="action-row"><button className="btn btn-primary" disabled={busy} onClick={() => saveAccount(account)}><Save size={15} /> Save account</button></div>
        </div>)}
        {accounts.length === 0 && <p style={{ color: 'var(--muted)' }}>No accounts yet.</p>}
      </div>
    </section>
  </div>;
}
