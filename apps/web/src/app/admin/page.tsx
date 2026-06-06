import { AppShell } from '@/components/shell';
import { AdminPage } from '@/components/admin-page';

export default function AdminRoute() {
  return <AppShell title="Admin"><AdminPage /></AppShell>;
}
