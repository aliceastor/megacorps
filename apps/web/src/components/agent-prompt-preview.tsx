'use client';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '@/lib/api';
import { useLocale } from '@/lib/locale-context';

type Preview = { prompt: string; runtimeContextNotice: string; adapterEnvelope: { adapterType: string } };
export function AgentPromptPreview({ agentId, agentName, projects }: { agentId: string; agentName: string; projects: { id: string; name: string }[] }) {
  const { locale } = useLocale();
  const label = (en: string, zh: string, ja: string) => locale === 'zh-TW' ? zh : locale === 'ja' ? ja : en;
  const dialog = useRef<HTMLDialogElement>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const generation = useRef(0);
  const [kind, setKind] = useState<'task' | 'chat'>('task');
  const [projectId, setProjectId] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  function invalidate() { generation.current++; setPreview(null); setBusy(false); setError(''); setCopied(false); }
  async function generate() {
    invalidate(); const current = generation.current; setBusy(true);
    try {
      const result = await api<Preview>(`/api/agents/${agentId}/prompt-preview`, { method: 'POST', body: JSON.stringify({ kind, projectId: projectId || null, ...(kind === 'task' ? { title } : {}), body }) });
      if (current === generation.current) setPreview(result);
    } catch (error) { if (current === generation.current) setError(error instanceof Error ? error.message : 'Preview failed'); }
    finally { if (current === generation.current) setBusy(false); }
  }
  const heading = label('Full prompt preview', '完整提示詞預覽', '完全なプロンプトのプレビュー');
  return <>
    <button type="button" className="btn secondary" onClick={() => { invalidate(); dialog.current?.showModal(); }}>{heading}</button>
    {mounted && createPortal(<dialog ref={dialog} aria-label={`${heading} — ${agentName}`} onClose={invalidate} style={{ width: 'min(960px, 94vw)', maxHeight: '90vh', padding: 24, boxSizing: 'border-box', borderRadius: 16, border: '1px solid var(--border)', overflow: 'auto', whiteSpace: 'normal', background: 'var(--background)', color: 'var(--foreground)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: 16 }}><h2 style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{heading} — {agentName}</h2><button type="button" className="btn secondary" style={{ flexShrink: 0 }} onClick={() => dialog.current?.close()}>{label('Close', '關閉', '閉じる')}</button></div>
      <p>{label('Fresh invocation with current saved settings. No task, chat, or model call is created. Credentials are redacted. Hermes/runtime system context is outside this preview.', '使用目前已儲存設定預覽全新呼叫。不建立任務、聊天或模型呼叫。憑證會遮蔽；Hermes／執行環境的系統內容不在預覽範圍。', '保存済み設定による新規呼び出しのプレビューです。タスク・チャット・モデル呼び出しは作成しません。認証情報は非表示です。Hermes のシステム情報は含まれません。')}</p>
      <label className="field-label" style={{ display: 'block', minWidth: 0, marginBlock: 12 }}>{label('Mode', '模式', 'モード')}<select className="input" style={{ width: '100%', minWidth: 0 }} value={kind} onChange={e => { invalidate(); setKind(e.target.value as 'task' | 'chat'); }}><option value="task">{label('New task', '新任務', '新規タスク')}</option><option value="chat">Direct Chat</option></select></label>
      <label className="field-label" style={{ display: 'block', minWidth: 0, marginBlock: 12 }}>{label('Project', '專案', 'プロジェクト')}<select className="input" style={{ width: '100%', minWidth: 0 }} value={projectId} onChange={e => { invalidate(); setProjectId(e.target.value); }}><option value="">{label('No project', '無專案', 'プロジェクトなし')}</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      {kind === 'task' && <label className="field-label" style={{ display: 'block', minWidth: 0, marginBlock: 12 }}>{label('Task title', '任務標題', 'タスク名')}<input className="input" style={{ width: '100%', minWidth: 0 }} value={title} maxLength={1000} onChange={e => { invalidate(); setTitle(e.target.value); }} /></label>}
      <label className="field-label" style={{ display: 'block', minWidth: 0, marginBlock: 12 }}>{kind === 'task' ? label('Task body', '任務內容', 'タスク本文') : label('Chat message', '聊天訊息', 'チャットメッセージ')}<textarea className="input" rows={5} value={body} maxLength={100000} onChange={e => { invalidate(); setBody(e.target.value); }} style={{ width: '100%' }} /></label>
      <button type="button" className="btn" disabled={busy || !body.trim()} onClick={generate}>{busy ? label('Generating…', '產生中…', '生成中…') : label('Generate preview', '產生預覽', 'プレビューを生成')}</button>
      {error && <p role="alert">{error}</p>}
      {preview && <><p>{preview.adapterEnvelope.adapterType} · {preview.runtimeContextNotice}</p><label className="field-label" style={{ display: 'block', minWidth: 0, marginBlock: 12 }}>{label('Full prompt', '完整提示詞', '完全なプロンプト')}<textarea className="input" readOnly value={preview.prompt} rows={20} style={{ width: '100%', fontFamily: 'monospace', whiteSpace: 'pre', overflow: 'auto' }} /></label><button type="button" className="btn secondary" onClick={async () => { try { await navigator.clipboard.writeText(preview.prompt); setCopied(true); } catch { setError(label('Copy failed; select and copy the text above.', '複製失敗，請選取上方文字複製。', 'コピーできません。上のテキストを選択してコピーしてください。')); } }}>{copied ? label('Copied', '已複製', 'コピー済み') : label('Copy full prompt', '複製完整提示詞', '完全なプロンプトをコピー')}</button></>}
    </dialog>, document.body)}
  </>;
}
