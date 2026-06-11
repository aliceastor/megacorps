import './globals.css';
import type { ReactNode } from 'react';
import { ThemeScript } from '@/components/theme-script';
import { LocaleProvider } from '@/lib/locale-context';
import { QueryProvider } from '@/lib/query-provider';
import { ToastProvider } from '@/lib/toast-context';
import { RuntimeErrorGuard } from '@/components/runtime-error-guard';
export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="zh-TW" data-theme="dark"><head><ThemeScript /></head><body><RuntimeErrorGuard /><QueryProvider><LocaleProvider><ToastProvider>{children}</ToastProvider></LocaleProvider></QueryProvider></body></html>;
}
