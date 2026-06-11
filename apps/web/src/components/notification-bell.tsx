'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { useLocale } from '@/lib/locale-context';

type NotificationRow = {
  id: string;
  companyId: string;
  type: string;
  title: string;
  body?: string | null;
  cardId?: string | null;
  readAt?: string | null;
  createdAt?: string | null;
};

type NotificationResponse = { notifications: NotificationRow[]; unreadCount: number };

function shortTime(value?: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const queryClient = useQueryClient();
  const { t } = useLocale();
  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api<NotificationResponse>('/api/notifications?limit=30'),
    refetchInterval: 60_000,
  });
  const unread = data?.unreadCount ?? 0;
  const rows = data?.notifications ?? [];

  async function openNotification(row: NotificationRow) {
    setOpen(false);
    if (!row.readAt) {
      try { await api(`/api/notifications/${row.id}/read`, { method: 'POST' }); } catch { /* best effort */ }
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    }
    if (row.cardId) router.push('/kanban');
    else if (row.type.startsWith('budget')) router.push('/budget');
    else if (row.type === 'approval_pending') router.push('/budget');
  }

  async function markAllRead() {
    try { await api('/api/notifications/read-all', { method: 'POST' }); } catch { /* best effort */ }
    void queryClient.invalidateQueries({ queryKey: ['notifications'] });
  }

  return <div style={{ position: 'relative' }}>
    <button className="btn icon-btn notification-bell" aria-label={t('notifications.title')} onClick={() => setOpen(!open)}>
      <Bell size={16} />
      {unread > 0 && <span className="notification-badge">{unread > 99 ? '99+' : unread}</span>}
    </button>
    {open && <div className="notification-panel">
      <div className="notification-panel-head">
        <b>{t('notifications.title')}</b>
        <button className="btn" onClick={() => void markAllRead()} disabled={unread === 0}>
          <CheckCheck size={13} /> {t('notifications.markAllRead')}
        </button>
      </div>
      <div className="notification-panel-list">
        {rows.map((row) => <button key={row.id} className={`notification-item ${row.readAt ? 'read' : 'unread'}`} onClick={() => void openNotification(row)}>
          <b>{row.title}</b>
          {row.body && <span className="notification-body">{row.body}</span>}
          <span className="notification-meta">{row.type} / {shortTime(row.createdAt)}</span>
        </button>)}
        {!rows.length && <p className="notification-empty">{t('notifications.empty')}</p>}
      </div>
    </div>}
    {open && <div className="notification-backdrop" onClick={() => setOpen(false)} />}
  </div>;
}
