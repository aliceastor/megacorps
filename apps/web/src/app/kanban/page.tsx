import { AppShell } from '@/components/shell';
import { KanbanBoard } from '@/components/kanban-board';
import { ClientCheckpoints } from '@/components/client-checkpoints';
export default function KanbanPage(){ return <AppShell title="Kanban"><ClientCheckpoints /><KanbanBoard /></AppShell> }
