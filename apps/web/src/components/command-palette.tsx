'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Building2, FileText, FolderGit2, Kanban, MessageSquare, Network, Search } from 'lucide-react';
import { api } from '@/lib/api';
import { useLocale } from '@/lib/locale-context';

type SearchResponse = {
  query: string;
  cards: Array<{ id: string; title: string; columnStatus?: string | null }>;
  agents: Array<{ id: string; name: string; role?: string | null }>;
  projects: Array<{ id: string; name: string }>;
  companies: Array<{ id: string; name: string }>;
  chatSessions: Array<{ id: string; title: string }>;
  knowledgeDocs: Array<{ id: string; title: string }>;
};

type ResultItem = { key: string; label: string; hint?: string; href: string; icon: typeof Kanban };

function buildItems(data: SearchResponse | undefined): ResultItem[] {
  if (!data) return [];
  return [
    ...data.cards.map((row) => ({ key: `card-${row.id}`, label: row.title, hint: row.columnStatus ?? 'card', href: '/kanban', icon: Kanban })),
    ...data.agents.map((row) => ({ key: `agent-${row.id}`, label: row.name, hint: row.role ?? 'agent', href: '/agents', icon: Network })),
    ...data.projects.map((row) => ({ key: `project-${row.id}`, label: row.name, hint: 'project', href: '/projects', icon: FolderGit2 })),
    ...data.companies.map((row) => ({ key: `company-${row.id}`, label: row.name, hint: 'company', href: '/companies', icon: Building2 })),
    ...data.chatSessions.map((row) => ({ key: `chat-${row.id}`, label: row.title, hint: 'chat', href: '/chat', icon: MessageSquare })),
    ...data.knowledgeDocs.map((row) => ({ key: `doc-${row.id}`, label: row.title, hint: 'knowledge', href: '/knowledge', icon: FileText })),
  ];
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const { t } = useLocale();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((current) => !current);
      }
      if (event.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (open) {
      setQuery('');
      setDebounced('');
      setActiveIndex(0);
      window.setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const { data, isFetching } = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => api<SearchResponse>(`/api/search?q=${encodeURIComponent(debounced)}`),
    enabled: open && debounced.length >= 2,
    staleTime: 15_000,
  });

  const items = buildItems(debounced.length >= 2 ? data : undefined);

  function go(item: ResultItem | undefined) {
    if (!item) return;
    setOpen(false);
    router.push(item.href);
  }

  if (!open) return null;
  return <div className="overlay command-palette-overlay" onClick={() => setOpen(false)}>
    <div className="command-palette" role="dialog" aria-modal="true" aria-label={t('search.title')} onClick={(event) => event.stopPropagation()}>
      <div className="command-palette-input">
        <Search size={16} />
        <input
          ref={inputRef}
          className="input"
          value={query}
          placeholder={t('search.placeholder')}
          onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') { event.preventDefault(); setActiveIndex((index) => Math.min(index + 1, items.length - 1)); }
            if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex((index) => Math.max(index - 1, 0)); }
            if (event.key === 'Enter') { event.preventDefault(); go(items[activeIndex]); }
          }}
        />
      </div>
      <div className="command-palette-results">
        {items.map((item, index) => <button
          key={item.key}
          className={`command-palette-item ${index === activeIndex ? 'active' : ''}`}
          onMouseEnter={() => setActiveIndex(index)}
          onClick={() => go(item)}
        >
          <item.icon size={14} />
          <span className="command-palette-label">{item.label}</span>
          {item.hint && <span className="command-palette-hint">{item.hint}</span>}
        </button>)}
        {debounced.length >= 2 && !isFetching && items.length === 0 && <p className="command-palette-empty">{t('search.noResults')}</p>}
        {debounced.length < 2 && <p className="command-palette-empty">{t('search.hint')}</p>}
      </div>
    </div>
  </div>;
}
