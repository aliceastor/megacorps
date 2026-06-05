'use client';
import Link from 'next/link';
import { useState } from 'react';
import { UserPlus } from 'lucide-react';
import { api } from '@/lib/api';

export default function SignupPage() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/signup', { method: 'POST', body: JSON.stringify({ name, email, password }) });
      window.location.href = '/dashboard';
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
        <h1>Sign up</h1>
      </div>
      <label className="field-label">Name
        <input className="input" value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" required />
      </label>
      <label className="field-label">Email
        <input className="input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required />
      </label>
      <label className="field-label">Password
        <input className="input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" required />
      </label>
      {error && <p className="form-error">{error}</p>}
      <button className="btn btn-primary" disabled={busy}><UserPlus size={16} /> {busy ? 'Creating...' : 'Create account'}</button>
      <Link className="muted-link" href="/login">Already have an account? Login</Link>
    </form>
  </main>;
}
