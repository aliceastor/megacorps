'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { LayoutDashboard, Kanban, Network, Menu, Moon, Sun, Languages, User, LogOut, Check } from 'lucide-react';
import { useLocale, localeList, localeNames } from '@/lib/locale-context';
import { api } from '@/lib/api';

const nav = [
  { href: '/dashboard', label: 'dashboard', icon: LayoutDashboard },
  { href: '/kanban', label: 'kanban', icon: Kanban },
  { href: '/agents', label: 'agents', icon: Network },
];

function Dropdown({ open, onClose, children, style }: { open: boolean; onClose: () => void; children: React.ReactNode; style?: React.CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, onClose]);
  return <AnimatePresence>{open && (
    <motion.div ref={ref} initial={{ opacity: 0, y: -8, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -8, scale: 0.95 }} transition={{ duration: 0.15 }}
      style={{ position: 'absolute', top: '100%', right: 0, marginTop: 8, background: 'var(--card-bg, #1e1e2e)', border: '1px solid var(--border)', borderRadius: 12, padding: 6, minWidth: 180, zIndex: 100, boxShadow: '0 8px 32px rgba(0,0,0,0.3)', ...style }>
      {children}
    </motion.div>
  )}</AnimatePresence>;
}

function DropdownItem({ onClick, children, active }: { onClick: () => void; children: React.ReactNode; active?: boolean }) {
  return <button onClick={onClick} className="btn" style={{ width: '100%', justifyContent: 'flex-start', gap: 8, padding: '8px 12px', borderRadius: 8, fontSize: 14, background: active ? 'var(--primary-alpha, rgba(99,102,241,0.15))' : 'transparent' }}>
    {children}
    {active && <Check size={14} style={{ marginLeft: 'auto' }} />}
  </button>;
}

export function AppShell({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  const [userOpen, setUserOpen] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const [isDark, setIsDark] = useState(true);
  const { locale, setLocale, t } = useLocale();

  useEffect(() => { setIsDark(document.documentElement.dataset.theme === 'dark'); }, []);

  function toggleTheme() {
    const next = isDark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('theme', next);
    setIsDark(!isDark);
  }

  async function handleLogout() {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
    window.location.href = '/login';
  }

  return <div style={{ minHeight: '100vh', display: 'grid', gridTemplateColumns: open ? '240px 1fr' : '72px 1fr', transition: 'grid-template-columns 200ms ease-in-out' }}>
    <aside style={{ borderRight: '1px solid var(--border)', padding: 16 }}>
      <b>{open ? 'MegaCorps' : 'MC'}</b>
      <nav style={{ marginTop: 24, display: 'grid', gap: 8 }}>
        {nav.map((item) => <Link className="btn" href={item.href} key={item.href}><item.icon size={16} /> {open && t(item.label)}</Link>)}
      </nav>
    </aside>
    <main>
      <header style={{ height: 64, display: 'flex', alignItems: 'center', gap: 12, borderBottom: '1px solid var(--border)', padding: '0 20px' }}>
        <button className="btn" onClick={() => setOpen(!open)}><Menu size={16} /></button>
        <strong>{title}</strong>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={toggleTheme}>{isDark ? <Moon size={16} /> : <Sun size={16} />}</button>

        {/* Language Dropdown */}
        <div style={{ position: 'relative' }}>
          <button className="btn" onClick={() => { setLangOpen(!langOpen); setUserOpen(false); }}><Languages size={16} /></button>
          <Dropdown open={langOpen} onClose={() => setLangOpen(false)}>
            {localeList.map((l) => <DropdownItem key={l} active={locale === l} onClick={() => { setLocale(l); setLangOpen(false); }}>{localeNames[l]}</DropdownItem>)}
          </Dropdown>
        </div>

        {/* User Dropdown */}
        <div style={{ position: 'relative' }}>
          <button className="btn" onClick={() => { setUserOpen(!userOpen); setLangOpen(false); }}><User size={16} /></button>
          <Dropdown open={userOpen} onClose={() => setUserOpen(false)}>
            <DropdownItem onClick={handleLogout}><LogOut size={14} /> {t('logout')}</DropdownItem>
          </Dropdown>
        </div>
      </header>
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }} style={{ padding: 24 }}>{children}</motion.div>
    </main>
  </div>;
}
