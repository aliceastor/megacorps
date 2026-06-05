import { AppShell } from '@/components/shell';
import { ChatPage } from '@/components/chat-page';

export default function Page() {
  return <AppShell title="Direct Chat"><ChatPage /></AppShell>;
}
