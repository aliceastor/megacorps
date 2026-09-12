import type { Locale } from './i18n.ts';
import { chatWorkItemsSchema } from '@megacorps/shared';

export type ChatMessageProjection = { text: string; receipt: string | null; raw: string | null };

const labels = {
  en: { requested: (count: number) => `Requested ${count} Kanban update${count === 1 ? '' : 's'}`, outcomes: 'Kanban updates', created: 'created', updated: 'updated', notes: 'notes saved' },
  'zh-TW': { requested: (count: number) => `已請求 ${count} 項看板更新`, outcomes: '看板更新', created: '已建立', updated: '已更新', notes: '已儲存' },
  ja: { requested: (count: number) => `カンバン更新を ${count} 件依頼`, outcomes: 'カンバン更新', created: '作成', updated: '更新', notes: 'メモ保存' },
} satisfies Record<Locale, Record<string, unknown>>;

function actionReceipt(body: string, locale: Locale): ChatMessageProjection | null {
  const fence = /```(?:json|megacorps-chat-actions)?\s*\r?\n([\s\S]*?)\r?\n```/gi;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(body))) {
    try {
      const value = chatWorkItemsSchema.safeParse(JSON.parse(match[1]!));
      if (!value.success || body.slice(match.index + match[0].length).trim()) continue;
      const text = `${body.slice(0, match.index)}${body.slice(match.index + match[0].length)}`.trim();
      return { text, receipt: labels[locale].requested(value.data.actions.length), raw: body };
    } catch {
      // An invalid or ordinary JSON example remains visible verbatim.
    }
  }
  return null;
}

function outcomeReceipt(body: string, locale: Locale): ChatMessageProjection | null {
  if (!body.startsWith('Kanban updates from this conversation:\n')) return null;
  const lines = body.split(/\r?\n/).slice(1);
  const successful = lines.filter((line) => line.startsWith('✓ '));
  const created = successful.filter((line) => /Created card/.test(line)).length;
  const updated = successful.filter((line) => /Updated card/.test(line)).length;
  const notes = successful.filter((line) => /Self-note/.test(line)).length;
  const failed = lines.filter((line) => line.startsWith('✗ ')).length;
  if (!created && !updated && !notes && !failed) return null;
  const l = labels[locale];
  const parts = locale === 'en'
    ? [created && `${created} ${l.created}`, updated && `${updated} ${l.updated}`, notes && `${notes} ${l.notes}`, failed && `${failed} failed`]
    : locale === 'zh-TW'
      ? [created && `${l.created} ${created} 張卡片`, updated && `${l.updated} ${updated} 張卡片`, notes && `${l.notes} ${notes} 則備註`, failed && `${failed} 項失敗`]
      : [created && `${created} 件${l.created}`, updated && `${updated} 件${l.updated}`, notes && `${notes} 件${l.notes}`, failed && `${failed} 件失敗`];
  return { text: '', receipt: `${l.outcomes}：${parts.filter(Boolean).join(locale === 'en' ? ', ' : '、')}`, raw: body };
}

export function projectChatMessage(body: string, authorType: 'user' | 'agent' | 'system', locale: Locale): ChatMessageProjection {
  if (authorType === 'agent') return actionReceipt(body, locale) ?? { text: body, receipt: null, raw: null };
  if (authorType === 'system') return outcomeReceipt(body, locale) ?? { text: body, receipt: null, raw: null };
  return { text: body, receipt: null, raw: null };
}
