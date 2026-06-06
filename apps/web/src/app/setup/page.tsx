'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { api } from '@/lib/api';

type AuthStatus = {
  bootstrapConfigured: boolean;
  canBootstrap: boolean;
  hasActiveCompanyAdmin: boolean;
};

export default function SetupPage() {
  const [bootstrapToken, setBootstrapToken] = useState('');
  const [name, setName] = useState('Admin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    api<AuthStatus>('/api/auth/status').then((value) => {
      if (active) setStatus(value);
    }).catch((err) => {
      if (active) setError(err instanceof Error ? err.message : 'Unable to read auth status');
    });
    return () => { active = false; };
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/bootstrap', { method: 'POST', body: JSON.stringify({ bootstrapToken, name, email, password }) });
      window.location.href = '/dashboard';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed');
    } finally {
      setBusy(false);
    }
  }

  const blocked = status !== null && !status.canBootstrap;

  return <main className="auth-screen">
    <form className="card auth-card" onSubmit={submit}>
      <div>
        <p className="eyebrow">MegaCorps Control</p>
        <h1>First-admin setup</h1>
      </div>
      {status && !status.bootstrapConfigured && <p className="auth-note">Set BOOTSTRAP_TOKEN in the server environment, restart the server, then return to this page.</p>}
      {status?.hasActiveCompanyAdmin && <p className="auth-note">Setup has already been completed. Log in or ask an admin to invite you.</p>}
      <label className="field-label">Bootstrap token
        <input className="input" type="password" value={bootstrapToken} onChange={(event) => setBootstrapToken(event.target.value)} autoComplete="one-time-code" minLength={16} required disabled={blocked} />
      </label>
      <label className="field-label">Admin name
        <input className="input" value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" required disabled={blocked} />
      </label>
      <label className="field-label">Admin email
        <input className="input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required disabled={blocked} />
      </label>
      <label className="field-label">Admin password
        <input className="input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" minLength={12} required disabled={blocked} />
      </label>
      {error && <p className="form-error">{error}</p>}
      <button className="btn btn-primary" disabled={busy || blocked}><ShieldCheck size={16} /> {busy ? 'Creating admin...' : 'Create first admin'}</button>
      <Link className="muted-link" href="/login">Back to login</Link>
    </form>
  </main>;
}
