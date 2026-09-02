'use client';
import { RefreshCw } from 'lucide-react';
import { useLocale } from '@/lib/locale-context';
import type { ApiEvent, Card, CardAction, CardTabKey, TaskLog } from './card-types';

// The logs tab exactly as it rendered inside kanban-board.tsx: execution log,
// action timeline (with metadata JSON), task logs with "load older", and the
// API lifecycle. This tab is the safety net that shows every raw row.

export type CardHistoryTabProps = {
  selected: Card;
  logs: TaskLog[];
  actions: CardAction[];
  apiLogs: ApiEvent[];
  logsHasMore: boolean;
  tabLoading: Record<CardTabKey, boolean>;
  loadMoreCardLogs: (card: Card) => Promise<void>;
};

export function CardHistoryTab({ selected, logs, actions, apiLogs, logsHasMore, tabLoading, loadMoreCardLogs }: CardHistoryTabProps) {
  const { t } = useLocale();
  return <div style={{ display: 'grid', gap: 10 }}>
    {(tabLoading.logs || tabLoading.actions || tabLoading.apiLogs) && <p style={{ opacity: 0.6 }}>{t('kanban.refreshingLogs')}</p>}
    {selected.executionLog && <article className="log-item">
      <b>{t('kanban.latestExecution')}</b>
      <span>{selected.completedAt ? new Date(selected.completedAt).toLocaleString() : selected.updatedAt ? new Date(selected.updatedAt).toLocaleString() : ''}</span>
      <pre className="log-block">{selected.executionLog}</pre>
    </article>}
    <article className="log-item">
      <b>{t('kanban.actionTimeline')}</b>
      <span>{actions.length} {t('kanban.normalizedActions')}{tabLoading.actions ? ` / ${t('kanban.refreshing')}` : ''}</span>
      {tabLoading.actions && actions.length === 0 ? <p>{t('kanban.loadingActions')}</p> : actions.length === 0 ? <p>{t('kanban.noActions')}</p> : actions.map((action) => <div className="log-item" key={action.id} style={{ marginTop: 8 }}>
        <b>{action.action}</b>
        <span>{action.createdAt ? new Date(action.createdAt).toLocaleString() : ''} / {action.actorType}:{action.actorId} / {action.fromStatus ?? 'none'} {'->'} {action.toStatus ?? 'none'}</span>
        {action.detail && <p>{action.detail}</p>}
        {action.metadata != null && <pre className="log-block">{JSON.stringify(action.metadata, null, 2)}</pre>}
      </div>)}
    </article>
    {tabLoading.logs && logs.length === 0 ? <p style={{ opacity: 0.6 }}>{t('kanban.loadingLogs')}</p> : logs.length === 0 ? <p style={{ opacity: 0.6 }}>{t('kanban.noLogs')}</p> : logs.map((log) => <article className="log-item" key={log.id}>
      <b>{log.type} / {log.status}</b>
      <span>{log.createdAt ? new Date(log.createdAt).toLocaleString() : ''}</span>
      <p>{log.message}</p>
      <div className="log-meta">
        {log.costUsd && <span>cost ${log.costUsd}</span>}
        {log.durationSeconds !== undefined && <span>{log.durationSeconds}s</span>}
      </div>
      {log.output && <pre className="log-block">{log.output}</pre>}
    </article>)}
    {logsHasMore && <button className="btn" disabled={tabLoading.logs} onClick={() => selected && loadMoreCardLogs(selected)}><RefreshCw size={14} /> {t('kanban.loadOlderLogs')}</button>}
    <article className="log-item">
      <b>{t('logs.apiLifecycle')}</b>
      <span>{apiLogs.length} {t('kanban.relatedOperations')}{tabLoading.apiLogs ? ` / ${t('kanban.refreshing')}` : ''}</span>
      {tabLoading.apiLogs && apiLogs.length === 0 ? <p>{t('kanban.loadingApiEvents')}</p> : apiLogs.length === 0 ? <p>{t('kanban.noApiEvents')}</p> : apiLogs.map((event) => <div className="log-item" key={event.id} style={{ marginTop: 8 }}>
        <b>{event.method} {event.path}</b>
        <span>{event.createdAt ? new Date(event.createdAt).toLocaleString() : ''} / {event.statusCode ?? '-'} / {event.durationMs ?? 0}ms</span>
        {event.error && <p className="form-error">{event.error}</p>}
        <pre className="log-block">{JSON.stringify({ request: event.requestBody, response: event.responseBody }, null, 2)}</pre>
      </div>)}
    </article>
  </div>;
}
