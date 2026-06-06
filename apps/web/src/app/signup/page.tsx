'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { UserPlus } from 'lucide-react';
import { api } from '@/lib/api';

type AuthStatus = {
  signupEnabled: boolean;
  canBootstrap: boolean;
};

type InviteAcceptResponse = {
  loginRequired?: boolean;
};

export default function SignupPage() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [inviteToken, setInviteToken] = useState('');
  const [status, setStatus] = useState<AuthStatus | null>(null);

  useEffect(() => {
    setInviteToken(new URLSearchParams(window.location.search).get('invite') ?? '');
    let active = true;
    api<AuthStatus>('/api/auth/status').then((value) => {
      if (active) setStatus(value);
    }).catch(() => {
      if (active) setStatus(null);
    });
    return () => { active = false; };
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (inviteToken) {
        const result = await api<InviteAcceptResponse>('/api/auth/accept-invite', { method: 'POST', body: JSON.stringify({ token: inviteToken, name, password }) });
        window.location.href = result.loginRequired ? '/login' : '/dashboard';
      } else {
        await api('/api/auth/signup', { method: 'POST', body: JSON.stringify({ name, email, password }) });
        window.location.href = '/dashboard';
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Signup failed');
    } finally {
      setBusy(false);
    }
  }

  return <main className="auth-screen">
    <form className="card auth-card" onSubmit={submit}>
      <div>
        <p className="eyebrow">MegaCorps Control</p>
        <h1>{inviteToken ? 'Accept invite' : 'Sign up'}</h1>
      </div>
      {inviteToken && <p className="auth-note">Invite token detected. Set your name and password to join the company.</p>}
      <label className="field-label">Name
        <input className="input" value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" required />
      </label>
      {!inviteToken && <label className="field-label">Email
        <input className="input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required />
      </label>}
      <label className="field-label">Password
        <input className="input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" minLength={inviteToken ? 12 : 8} required />
      </label>
      {!inviteToken && status && !status.signupEnabled && <p className="auth-note">Public signup is disabled. Use an invite link or run first-admin setup if this is a new deployment.</p>}
      {error && <p className="form-error">{error}</p>}
      <button className="btn btn-primary" disabled={busy || (!inviteToken && status !== null && !status.signupEnabled)}><UserPlus size={16} /> {busy ? 'Creating...' : inviteToken ? 'Accept invite' : 'Create account'}</button>
      {!inviteToken && status?.canBootstrap && <Link className="muted-link" href="/setup">Run first-admin setup</Link>}
      <Link className="muted-link" href="/login">Already have an account? Login</Link>
    </form>
  </main>;
}
