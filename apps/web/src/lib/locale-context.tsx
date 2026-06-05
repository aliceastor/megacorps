'use client';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { type Locale, t as translate } from './i18n';

type LocaleCtx = { locale: Locale; setLocale: (l: Locale) => void; t: (key: string) => string };
const Ctx = createContext<LocaleCtx>({ locale: 'zh-TW', setLocale: () => {}, t: (k) => k });

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('zh-TW');
  useEffect(() => {
    const saved = localStorage.getItem('locale') as Locale | null;
    if (saved && localeList.includes(saved)) setLocaleState(saved);
  }, []);
  function setLocale(l: Locale) {
    setLocaleState(l);
    localStorage.setItem('locale', l);
  }
  function t(key: string) {
    return translate(locale, key);
  }
  return <Ctx.Provider value={{ locale, setLocale, t }}>{children}</Ctx.Provider>;
}

export function useLocale() {
  return useContext(Ctx);
}

export const localeNames: Record<Locale, string> = { 'zh-TW': '繁體中文', en: 'English', ja: '日本語' };
export const localeList: Locale[] = ['zh-TW', 'en', 'ja'];
