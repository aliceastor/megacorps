'use client';

import Link from 'next/link';
import { RefreshCcw } from 'lucide-react';

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <main className="auth-screen">
    <section className="card auth-card">
      <div>
        <p className="eyebrow">Runtime error</p>
        <h1>Something stopped responding</h1>
        <p style={{ color: 'var(--muted)', marginBottom: 0 }}>{error.message || 'The page hit an unexpected error.'}</p>
      </div>
      <div className="action-row">
        <button className="btn btn-primary" onClick={reset}><RefreshCcw size={15} /> Retry</button>
        <Link className="btn" href="/dashboard">Dashboard</Link>
      </div>
    </section>
  </main>;
}
