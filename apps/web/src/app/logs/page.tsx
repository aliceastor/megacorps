import { Suspense } from 'react';
import { AppShell } from '@/components/shell';
import { LogsPage } from '@/components/logs-page';

export default function LogsRoute() {
  return <AppShell title="Logs"><Suspense fallback={<p className="field-hint">Loading logs…</p>}><LogsPage /></Suspense></AppShell>;
}
