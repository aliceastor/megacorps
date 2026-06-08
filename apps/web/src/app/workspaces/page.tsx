import { AppShell } from '@/components/shell';
import { WorkspacesPage } from '@/components/workspaces-page';

export default function WorkspacesRoute() {
  return <AppShell title="Workspace"><WorkspacesPage /></AppShell>;
}
