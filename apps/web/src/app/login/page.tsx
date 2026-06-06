'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { LogIn } from 'lucide-react';
import { api } from '@/lib/api';

type AuthStatus = {
  signupEnabled: boolean;
  firstAccountWillBeAdmin: boolean;
};

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<AuthStatus | null | undefined>(undefined);

  useEffect(() => {
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
      await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      const next = new URLSearchParams(window.location.search).get('next') ?? '/dashboard';
      window.location.href = next.startsWith('/') ? next : '/dashboard';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  }

  return <main className="auth-screen">
    <form className="card auth-card" onSubmit={submit}>
      <div>
        <p className="eyebrow">MegaCorps Control</p>
        <h1>Login</h1>
      </div>
      <label className="field-label">Email
        <input className="input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required />
      </label>
      <label className="field-label">Password
        <input className="input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
      </label>
      {error && <p className="form-error">{error}</p>}
      <button className="btn btn-primary" disabled={busy}><LogIn size={16} /> {busy ? 'Logging in...' : 'Login'}</button>
      {status === undefined && <p className="auth-note">Checking onboarding status...</p>}
      {status === null && <p className="auth-note">Onboarding status is unavailable. Check that the API is reachable from this browser.</p>}
      {status && (status.signupEnabled
        ? <Link className="muted-link" href="/signup">{status.firstAccountWillBeAdmin ? 'Create the first admin account' : 'Do not have an account? Sign up'}</Link>
        : <p className="auth-note">Signup is disabled by an admin. Use an invite link or ask an admin to re-enable signup.</p>)}
    </form>
  </main>;
}
