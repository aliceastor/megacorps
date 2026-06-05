'use client';
import Link from 'next/link';
import { useState } from 'react';
import { motion } from 'framer-motion';
import { LayoutDashboard, Kanban, Network, Menu, Moon, Languages, User } from 'lucide-react';
const nav = [{ href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard }, { href: '/kanban', label: 'Kanban', icon: Kanban }, { href: '/agents', label: 'Agents', icon: Network }];
export function AppShell({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  function toggleTheme() { const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = next; localStorage.setItem('theme', next); }
  return <div style={{ minHeight: '100vh', display: 'grid', gridTemplateColumns: open ? '240px 1fr' : '72px 1fr', transition: 'grid-template-columns 200ms ease-in-out' }}>
    <aside style={{ borderRight: '1px solid var(--border)', padding: 16 }}><b>{open ? 'MegaCorps' : 'MC'}</b><nav style={{ marginTop: 24, display: 'grid', gap: 8 }}>{nav.map((item) => <Link className="btn" href={item.href} key={item.href}><item.icon size={16} /> {open && item.label}</Link>)}</nav></aside>
    <main><header style={{ height: 64, display: 'flex', alignItems: 'center', gap: 12, borderBottom: '1px solid var(--border)', padding: '0 20px' }}><button className="btn" onClick={() => setOpen(!open)}><Menu size={16} /></button><strong>{title}</strong><span style={{ flex: 1 }} /><button className="btn" onClick={toggleTheme}><Moon size={16} /></button><button className="btn"><Languages size={16} /></button><button className="btn"><User size={16} /></button></header><motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }} style={{ padding: 24 }}>{children}</motion.div></main>
  </div>;
}
