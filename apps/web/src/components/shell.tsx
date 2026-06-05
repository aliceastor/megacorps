'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { BookOpen, BriefcaseBusiness, Building2, ChartNoAxesColumnIncreasing, FileClock, Kanban, LayoutDashboard, Languages, LogOut, Menu, MessageSquare, Moon, Network, Settings, Sun, User, Check } from 'lucide-react';
import { useLocale, localeList, localeNames } from '@/lib/locale-context';
import { api } from '@/lib/api';

const nav = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/companies', label: 'Companies', icon: Building2 },
  { href: '/chat', label: 'Direct Chat', icon: MessageSquare },
  { href: '/kanban', label: 'Kanban', icon: Kanban },
  { href: '/agents', label: 'Agents', icon: Network },
  { href: '/budget', label: 'Budget', icon: ChartNoAxesColumnIncreasing },
  { href: '/logs', label: 'Logs', icon: FileClock },
  { href: '/knowledge', label: 'Knowledge', icon: BookOpen },
  { href: '/workspaces', label: 'Workspaces', icon: BriefcaseBusiness },
  { href: '/settings', label: 'Settings', icon: Settings },
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
      style={{ position: 'absolute', top: '100%', right: 0, marginTop: 8, background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, padding: 6, minWidth: 180, zIndex: 100, boxShadow: 'var(--shadow)', ...style }}>
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
  const [userEmail, setUserEmail] = useState('');
  const pathname = usePathname();
  const { locale, setLocale, t } = useLocale();

  useEffect(() => { setIsDark(document.documentElement.dataset.theme === 'dark'); }, []);
  useEffect(() => {
    api<{ user: { email: string } }>('/api/me')
      .then((result) => setUserEmail(result.user.email))
      .catch(() => undefined);
  }, []);

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

  return <div className={`app-frame ${open ? 'sidebar-open' : 'sidebar-compact'}`}>
    <aside className="sidebar">
      <div className="brand-lockup">
        <span className="brand-mark">MC</span>
        {open && <div><b>MegaCorps</b><span>Agent Company OS</span></div>}
      </div>
      <nav className="nav-list" aria-label="Primary">
        {nav.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return <Link className={`nav-link ${active ? 'active' : ''}`} href={item.href} key={item.href} title={item.label}>
            <item.icon size={18} />
            {open && <span>{item.label}</span>}
          </Link>;
        })}
      </nav>
      {open && <div className="sidebar-status">
        <span>Heartbeat</span>
        <b>10s / company override</b>
      </div>}
    </aside>
    <main>
      <header className="topbar">
        <button className="btn icon-btn" aria-label="Toggle sidebar" onClick={() => setOpen(!open)}><Menu size={16} /></button>
        <div>
          <p className="eyebrow">Workspace</p>
          <strong>{title}</strong>
        </div>
        <span style={{ flex: 1 }} />
        <button className="btn icon-btn" aria-label="Toggle theme" onClick={toggleTheme}>{isDark ? <Moon size={16} /> : <Sun size={16} />}</button>

        {/* Language Dropdown */}
        <div style={{ position: 'relative' }}>
          <button className="btn icon-btn" aria-label="Change language" onClick={() => { setLangOpen(!langOpen); setUserOpen(false); }}><Languages size={16} /></button>
          <Dropdown open={langOpen} onClose={() => setLangOpen(false)}>
            {localeList.map((l) => <DropdownItem key={l} active={locale === l} onClick={() => { setLocale(l); setLangOpen(false); }}>{localeNames[l]}</DropdownItem>)}
          </Dropdown>
        </div>

        {/* User Dropdown */}
        <div style={{ position: 'relative' }}>
          <button className="btn user-btn" onClick={() => { setUserOpen(!userOpen); setLangOpen(false); }}><User size={16} /><span>{userEmail || 'Account'}</span></button>
          <Dropdown open={userOpen} onClose={() => setUserOpen(false)}>
            <DropdownItem onClick={handleLogout}><LogOut size={14} /> {t('logout')}</DropdownItem>
          </Dropdown>
        </div>
      </header>
      <motion.div className="content-area" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }}>{children}</motion.div>
    </main>
  </div>;
}
