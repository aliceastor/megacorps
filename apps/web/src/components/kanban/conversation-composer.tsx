'use client';
import { useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { AtSign, Send } from 'lucide-react';
import { mentionCandidates } from '@/lib/card-conversation';
import { useLocale } from '@/lib/locale-context';
import { insertMention, insertText, mentionQueryAtCaret } from '@/lib/mention-input';
import type { Agent, Card, CommentActionMode, ReviewerScope } from './card-types';

// The composer under the tab row. Controlled: the seven state hooks and
// addComment stay on the board (kanban-board.tsx) exactly as before, so the
// POST body, the reviewer default and the close guard are untouched. It sits
// collapsed on one line (你 ▾ │ 留言 ▾ │ 寫給這張卡…) until the textarea is
// focused or a non-comment action is preselected (留言並暫停 / 帶留言繼續 from
// the overview). @mention autocomplete is dependency-free: the caret token
// comes from mentionQueryAtCaret, the candidates from mentionCandidates.

const CLIENT_SLUG = 'client';
const MODES: CommentActionMode[] = ['comment', 'agent_note', 'delegate_to_agent', 'pause_agent', 'escalate_to_reviewer', 'send_to_agent', 'continue_run'];
const MODE_LABEL_KEY: Record<CommentActionMode, string> = {
  comment: 'kanban.commentOnly',
  agent_note: 'kanban.agentNote',
  delegate_to_agent: 'kanban.delegateToAgent',
  pause_agent: 'kanban.stopAgentBlock',
  escalate_to_reviewer: 'kanban.escalateReviewer',
  send_to_agent: 'kanban.sendToAgent',
  continue_run: 'kanban.continueWithComment',
};

type MentionOption = { slug: string; name: string; role?: string };

export type ConversationComposerProps = {
  selected: Card;
  agents: Agent[];
  busy: boolean;
  commentBody: string;
  setCommentBody: (value: string) => void;
  commentAction: CommentActionMode;
  setCommentAction: (value: CommentActionMode) => void;
  commentAgentId: string;
  setCommentAgentId: (value: string) => void;
  commentDelegateAssigneeId: string;
  setCommentDelegateAssigneeId: (value: string) => void;
  commentDelegateReviewerId: string;
  setCommentDelegateReviewerId: (value: string) => void;
  commentDelegateScope: ReviewerScope;
  setCommentDelegateScope: (value: ReviewerScope) => void;
  addComment: () => void | Promise<void>;
};

export function ConversationComposer({
  selected,
  agents,
  busy,
  commentBody,
  setCommentBody,
  commentAction,
  setCommentAction,
  commentAgentId,
  setCommentAgentId,
  commentDelegateAssigneeId,
  setCommentDelegateAssigneeId,
  commentDelegateReviewerId,
  setCommentDelegateReviewerId,
  commentDelegateScope,
  setCommentDelegateScope,
  addComment,
}: ConversationComposerProps) {
  const { t } = useLocale();
  const rootRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingCaretRef = useRef<number | null>(null);
  const listboxId = useId();
  const [expanded, setExpanded] = useState(false);
  const [focused, setFocused] = useState(false);
  const [caret, setCaret] = useState(0);
  /** Token start the reader escaped from; the popover stays closed for that token. */
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [active, setActive] = useState(0);

  const mode: CommentActionMode = commentAgentId ? 'agent_note' : commentAction;
  const forcedOpen = commentAction !== 'comment' || Boolean(commentAgentId) || commentBody.trim().length > 0;
  const isExpanded = expanded || forcedOpen;
  const canSend = !busy && commentBody.trim().length > 0;
  const companyAgents = agents.filter((agent) => !selected.companyId || agent.companyId === selected.companyId);

  // A preselected non-comment action (overview CTA, 留言並暫停) opens and focuses
  // the editor. A change made from inside the composer — the action or author
  // select — leaves the focus where the reader has it, so arrowing through the
  // select is not cut short by a jump into the textarea.
  useEffect(() => {
    if (commentAction === 'comment') return;
    setExpanded(true);
    const root = rootRef.current;
    const activeInside = Boolean(root && document.activeElement && root.contains(document.activeElement));
    if (!activeInside) textareaRef.current?.focus();
  }, [commentAction]);

  // React moves the caret to the end after a programmatic value change; put it back.
  useEffect(() => {
    const position = pendingCaretRef.current;
    if (position === null) return;
    pendingCaretRef.current = null;
    const element = textareaRef.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(position, position);
  }, [commentBody]);

  const query = mentionQueryAtCaret(commentBody, caret);
  const options: MentionOption[] = query && dismissedAt !== query.start
    ? [
      ...mentionCandidates(query.query, companyAgents.flatMap((agent) => (agent.slug ? [{ slug: agent.slug, name: agent.name, role: agent.role }] : []))),
      ...(CLIENT_SLUG.startsWith(query.query.toLowerCase()) ? [{ slug: CLIENT_SLUG, name: t('common.you') }] : []),
    ]
    : [];
  const popoverOpen = focused && options.length > 0;
  const queryKey = query ? `${query.start}:${query.query}` : '';
  useEffect(() => { setActive(0); }, [queryKey]);

  function applyEdit(edit: { text: string; caret: number }) {
    pendingCaretRef.current = edit.caret;
    setCaret(edit.caret);
    setCommentBody(edit.text);
  }
  function pick(option: MentionOption) {
    applyEdit(insertMention(commentBody, caret, option.slug));
    setDismissedAt(null);
  }
  function insertAtSign() {
    // The button click already blurred the textarea; `caret` holds its last position.
    const element = textareaRef.current;
    const position = element && document.activeElement === element ? element.selectionStart : caret;
    setExpanded(true);
    setDismissedAt(null);
    applyEdit(insertText(commentBody, position, '@'));
  }
  function syncCaret() {
    const element = textareaRef.current;
    if (element) setCaret(element.selectionStart);
  }
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (canSend) void addComment();
      return;
    }
    if (!popoverOpen) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => (index + 1) % options.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => (index - 1 + options.length) % options.length);
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      const option = options[active] ?? options[0];
      if (option) pick(option);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (query) setDismissedAt(query.start);
    }
  }
  function onRootBlur(event: FocusEvent<HTMLDivElement>) {
    const next = event.relatedTarget as Node | null;
    if (next && event.currentTarget.contains(next)) return;
    setFocused(false);
    if (!forcedOpen) setExpanded(false);
  }

  const agentOptions = companyAgents.map((agent) => <option value={agent.id} key={agent.id}>{agent.name}{agent.role ? ` / ${agent.role}` : ''}</option>);

  return <div ref={rootRef} className={`conv-composer ${isExpanded ? '' : 'collapsed'}`} onBlur={onRootBlur}>
    <div className="conv-composer-strip">
      <select className="input compact" aria-label={t('kanban.author')} value={commentAgentId} onChange={(event) => {
        setCommentAgentId(event.target.value);
        if (event.target.value) setCommentAction('agent_note');
      }}>
        <option value="">{t('common.you')}</option>
        {agentOptions}
      </select>
      <select className="input compact" aria-label={t('kanban.action')} value={mode} disabled={Boolean(commentAgentId)} onChange={(event) => {
        const next = event.target.value as CommentActionMode;
        setCommentAction(next);
        if (next === 'delegate_to_agent') setCommentAgentId('');
      }}>
        {MODES.map((value) => <option key={value} value={value}>{t(MODE_LABEL_KEY[value])}</option>)}
      </select>
    </div>
    <div className="conv-composer-editor">
      <textarea
        ref={textareaRef}
        className="input conv-composer-input"
        rows={isExpanded ? 5 : 1}
        value={commentBody}
        placeholder={t('kanban.convComposerHint')}
        aria-label={t('kanban.message')}
        aria-autocomplete="list"
        aria-expanded={popoverOpen}
        aria-controls={popoverOpen ? listboxId : undefined}
        aria-activedescendant={popoverOpen ? `${listboxId}-${active}` : undefined}
        onFocus={() => { setFocused(true); setExpanded(true); syncCaret(); }}
        onChange={(event) => { setCommentBody(event.target.value); setCaret(event.target.selectionStart); }}
        onKeyDown={onKeyDown}
        onKeyUp={syncCaret}
        onClick={syncCaret}
        onSelect={syncCaret}
      />
      {popoverOpen && <ul className="conv-mention-popover" role="listbox" id={listboxId} aria-label={t('kanban.convMentionButton')}>
        {options.map((option, index) => <li
          key={`${option.slug}-${index}`}
          id={`${listboxId}-${index}`}
          role="option"
          aria-selected={index === active}
          className={index === active ? 'active' : ''}
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => setActive(index)}
          onClick={() => pick(option)}
        >
          <b>@{option.slug}</b><span>{option.name}{option.role ? ` · ${option.role}` : ''}</span>
        </li>)}
      </ul>}
    </div>
    {isExpanded && <>
      {commentAction === 'delegate_to_agent' && !commentAgentId && <div className="form-grid conv-composer-subform">
        <label className="field-label">{t('kanban.delegateAssignee')}
          <select className="input" value={commentDelegateAssigneeId} onChange={(event) => setCommentDelegateAssigneeId(event.target.value)}>
            <option value="">{t('kanban.delegateAssignee')}</option>
            {agentOptions}
          </select>
        </label>
        <label className="field-label">{t('kanban.reviewScope')}
          <select className="input" value={commentDelegateScope} onChange={(event) => setCommentDelegateScope(event.target.value as ReviewerScope)}>
            <option value="phase">{t('kanban.phaseReviewer')}</option>
            <option value="final">{t('kanban.finalReviewer')}</option>
          </select>
        </label>
        <label className="field-label">{commentDelegateScope === 'final' ? t('kanban.finalReviewer') : t('kanban.phaseReviewer')}
          <select className="input" value={commentDelegateReviewerId} onChange={(event) => setCommentDelegateReviewerId(event.target.value)}>
            <option value="">{t('kanban.reviewer')}</option>
            {agentOptions}
          </select>
        </label>
      </div>}
      {mode === 'pause_agent' && <p className="field-hint danger conv-composer-hint-row">{t('kanban.convPauseHint')}</p>}
      <div className="conv-composer-actions">
        <button type="button" className="btn" title={t('kanban.convMentionButton')} aria-label={t('kanban.convMentionButton')} disabled={busy} onClick={insertAtSign}><AtSign size={14} /></button>
        <span className="field-hint conv-composer-hint">{t('kanban.convMentionHint')} · {t('kanban.convSendShortcut')}</span>
        <button type="button" className={`btn btn-primary ${mode === 'pause_agent' ? 'danger' : ''}`} disabled={!canSend} onClick={() => void addComment()}><Send size={14} /> {t(`kanban.convSend.${mode}`)}</button>
      </div>
    </>}
  </div>;
}
