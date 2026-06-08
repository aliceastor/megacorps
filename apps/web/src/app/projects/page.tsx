import { ProjectsPage } from '@/components/projects-page';
import { AppShell } from '@/components/shell';

export default function ProjectsRoute() {
  return <AppShell title="Projects"><ProjectsPage /></AppShell>;
}
