'use client';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { formatTemplate } from './format';
import { type Locale, t as translate } from './i18n';

type TemplateVars = Record<string, string | number>;
type LocaleCtx = {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: string) => string;
  /** `t` plus `{name}` interpolation; each locale owns its own word order. */
  tf: (key: string, vars?: TemplateVars) => string;
};
const Ctx = createContext<LocaleCtx>({ locale: 'zh-TW', setLocale: () => {}, t: (k) => k, tf: (k, vars) => formatTemplate(k, vars ?? {}) });

export const localeNames: Record<Locale, string> = { 'zh-TW': '繁體中文', en: 'English', ja: '日本語' };
export const localeList: Locale[] = ['zh-TW', 'en', 'ja'];

function detectBrowserLocale(): Locale {
  const language = navigator.language?.toLowerCase() ?? '';
  if (language.startsWith('zh')) return 'zh-TW';
  if (language.startsWith('ja')) return 'ja';
  return 'en';
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('zh-TW');
  useEffect(() => {
    const saved = localStorage.getItem('locale') as Locale | null;
    if (saved && localeList.includes(saved)) setLocaleState(saved);
    else setLocaleState(detectBrowserLocale());
  }, []);

  function setLocale(l: Locale) {
    setLocaleState(l);
    localStorage.setItem('locale', l);
  }

  function t(key: string) {
    return translate(locale, key);
  }

  function tf(key: string, vars?: TemplateVars) {
    return formatTemplate(translate(locale, key), vars ?? {});
  }

  return <Ctx.Provider value={{ locale, setLocale, t, tf }}>{children}</Ctx.Provider>;
}

export function useLocale() {
  return useContext(Ctx);
}
