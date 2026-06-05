import { AppShell } from '@/components/shell';
import { OrgChart } from '@/components/org-chart';

export default function CompaniesPage() {
  return <AppShell title="Companies"><OrgChart surface="companies" /></AppShell>;
}
