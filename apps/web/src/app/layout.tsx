import './globals.css';
import type { ReactNode } from 'react';
import { ThemeScript } from '@/components/theme-script';
import { LocaleProvider } from '@/lib/locale-context';
import { QueryProvider } from '@/lib/query-provider';
export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="zh-TW" data-theme="dark"><head><ThemeScript /></head><body><QueryProvider><LocaleProvider>{children}</LocaleProvider></QueryProvider></body></html>;
}
