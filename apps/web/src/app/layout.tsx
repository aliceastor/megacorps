import './globals.css';
import type { ReactNode } from 'react';
import { ThemeScript } from '@/components/theme-script';
export default function RootLayout({ children }: { children: ReactNode }) { return <html lang="zh-TW" data-theme="dark"><head><ThemeScript /></head><body>{children}</body></html>; }
