'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { BookOpen, BriefcaseBusiness, Building2, ChartGantt, CircleHelp, Clock3, FileClock, FolderGit2, FolderOpen, Kanban, LayoutDashboard, Languages, LogOut, PanelLeftClose, PanelLeftOpen, MessageSquare, Moon, Network, Settings, ShieldCheck, Sun, User, Check, type LucideIcon } from 'lucide-react';
import { useLocale, localeList, localeNames } from '@/lib/locale-context';
import { api } from '@/lib/api';
import { AppMouseMotion } from '@/components/app-mouse-motion';
import { NotificationBell } from '@/components/notification-bell';
import { CommandPalette } from '@/components/command-palette';

type NavItem = { href: string; labelKey: string; fallback: string; icon: LucideIcon; level?: number; exact?: boolean };

const nav: NavItem[] = [
  { href: '/dashboard', labelKey: 'nav.dashboard', fallback: 'Dashboard', icon: LayoutDashboard },
  { href: '/companies', labelKey: 'nav.companies', fallback: 'Companies', icon: Building2 },
  { href: '/departments', labelKey: 'nav.departments', fallback: 'Departments', icon: Network, exact: true },
  { href: '/departments/o-chart', labelKey: 'nav.oChart', fallback: 'O-Chart', icon: ChartGantt, level: 1 },
  { href: '/positions', labelKey: 'nav.positions', fallback: 'Positions', icon: BriefcaseBusiness },
  { href: '/agents', labelKey: 'nav.agents', fallback: 'Agents', icon: Network },
  { href: '/projects', labelKey: 'nav.projects', fallback: 'Projects', icon: FolderGit2 },
  { href: '/workspaces', labelKey: 'nav.workspaces', fallback: 'Workspace', icon: FolderOpen },
  { href: '/knowledge', labelKey: 'nav.knowledge', fallback: 'Knowledge', icon: BookOpen },
  { href: '/kanban', labelKey: 'nav.kanban', fallback: 'Kanban', icon: Kanban },
  { href: '/chat', labelKey: 'nav.chat', fallback: 'Direct Chat', icon: MessageSquare },
  { href: '/cron', labelKey: 'nav.cron', fallback: 'Cron', icon: Clock3 },
  { href: '/logs', labelKey: 'nav.logs', fallback: 'Logs', icon: FileClock },
];

const utilityNav: NavItem[] = [
  { href: '/settings', labelKey: 'nav.settings', fallback: 'Settings', icon: Settings },
];

const adminNav = { href: '/admin', labelKey: 'nav.admin', fallback: 'Admin', icon: ShieldCheck };
const USER_EMAIL_STORAGE_KEY = 'megacorps.userEmail';
const USER_ROLE_STORAGE_KEY = 'megacorps.userRole';
const SIDEBAR_OPEN_STORAGE_KEY = 'megacorps.sidebarOpen';

function readBrowserStorage(key: string): string {
  if (typeof window === 'undefined') return '';
  return window.localStorage.getItem(key) ?? '';
}

function readSidebarOpen(): boolean {
  if (typeof window === 'undefined') return true;
  return window.localStorage.getItem(SIDEBAR_OPEN_STORAGE_KEY) !== 'false';
}

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

function SidebarLink({ item, label, open, pathname }: { item: NavItem; label: string; open: boolean; pathname: string }) {
  const active = item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);
  return <Link className={`nav-link ${item.level ? 'sub-nav-link' : ''} ${active ? 'active' : ''}`} href={item.href} title={label} aria-label={label}>
    <item.icon size={18} />
    {open && <span>{label}</span>}
  </Link>;
}

function titleKey(title: string): string {
  return `title.${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
}

export function AppShell({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(readSidebarOpen);
  const [userOpen, setUserOpen] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const [isDark, setIsDark] = useState(true);
  const [userEmail, setUserEmail] = useState(() => readBrowserStorage(USER_EMAIL_STORAGE_KEY));
  const [userRole, setUserRole] = useState(() => readBrowserStorage(USER_ROLE_STORAGE_KEY));
  const pathname = usePathname();
  const { locale, setLocale, t } = useLocale();
  const translatedTitle = t(titleKey(title));
  const displayTitle = translatedTitle === titleKey(title) ? title : translatedTitle;

  useEffect(() => { setIsDark(document.documentElement.dataset.theme === 'dark'); }, []);
  useEffect(() => {
    api<{ user: { email: string; role?: string } }>('/api/me')
      .then((result) => {
        const nextRole = result.user.role ?? '';
        setUserEmail(result.user.email);
        setUserRole(nextRole);
        window.localStorage.setItem(USER_EMAIL_STORAGE_KEY, result.user.email);
        window.localStorage.setItem(USER_ROLE_STORAGE_KEY, nextRole);
      })
      .catch(() => undefined);
  }, []);

  function toggleTheme() {
    const next = isDark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('theme', next);
    setIsDark(!isDark);
  }

  function toggleSidebar() {
    setOpen((current) => {
      const next = !current;
      window.localStorage.setItem(SIDEBAR_OPEN_STORAGE_KEY, String(next));
      return next;
    });
  }

  async function handleLogout() {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
    localStorage.removeItem(USER_EMAIL_STORAGE_KEY);
    localStorage.removeItem(USER_ROLE_STORAGE_KEY);
    window.location.href = '/login';
  }

  return <div className={`app-frame ${open ? 'sidebar-open' : 'sidebar-compact'}`}>
    <AppMouseMotion />
    <CommandPalette />
    <aside className="sidebar">
      <div className="sidebar-head">
        <Link href="/dashboard" className="brand-lockup" title="MegaCorps Dashboard">
          <span className="brand-mark">MC</span>
          {open && <div><b>MegaCorps</b><span>Agent Company OS</span></div>}
        </Link>
        <button className="btn icon-btn sidebar-toggle" aria-label="Toggle sidebar" title={open ? 'Collapse sidebar' : 'Expand sidebar'} onClick={toggleSidebar}>{open ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}</button>
      </div>
      <div className="sidebar-body">
        <nav className="nav-list" aria-label="Primary">
          {nav.map((item) => <SidebarLink item={item} label={t(item.labelKey) === item.labelKey ? item.fallback : t(item.labelKey)} open={open} pathname={pathname} key={item.href} />)}
        </nav>
      </div>
      <div className="sidebar-footer">
        <nav className="nav-list nav-list-utility" aria-label="Utility">
          {utilityNav.map((item) => <SidebarLink item={item} label={t(item.labelKey) === item.labelKey ? item.fallback : t(item.labelKey)} open={open} pathname={pathname} key={item.href} />)}
          {userRole === 'admin' && <SidebarLink item={adminNav} label={t(adminNav.labelKey) === adminNav.labelKey ? adminNav.fallback : t(adminNav.labelKey)} open={open} pathname={pathname} />}
        </nav>
        {open && <div className="sidebar-status">
          <span>{t('common.heartbeat')}</span>
          <b>{t('common.companyOverride')}</b>
        </div>}
      </div>
    </aside>
    <main>
      <header className="topbar">
        <div>
          <p className="eyebrow">{t('common.workspace')}</p>
          <strong>{displayTitle}</strong>
        </div>
        <span style={{ flex: 1 }} />
        <NotificationBell />
        <Link className="btn icon-btn" href="/help" aria-label={t('common.help')} title={t('common.help')}><CircleHelp size={16} /></Link>
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
          <button className="btn user-btn" onClick={() => { setUserOpen(!userOpen); setLangOpen(false); }}><User size={16} /><span>{userEmail || t('common.account')}</span></button>
          <Dropdown open={userOpen} onClose={() => setUserOpen(false)}>
            <DropdownItem onClick={handleLogout}><LogOut size={14} /> {t('logout')}</DropdownItem>
          </Dropdown>
        </div>
      </header>
      <motion.div className="content-area" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }}>{children}</motion.div>
    </main>
  </div>;
}
