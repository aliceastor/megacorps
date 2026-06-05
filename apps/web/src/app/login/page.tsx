'use client';
import Link from 'next/link';
import { useState } from 'react';
import { LogIn } from 'lucide-react';
import { api } from '@/lib/api';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

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
      <Link className="muted-link" href="/signup">Do not have an account? Sign up</Link>
    </form>
  </main>;
}
