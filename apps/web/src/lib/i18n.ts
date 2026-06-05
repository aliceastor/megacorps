export type Locale = 'zh-TW' | 'en' | 'ja';

export const messages: Record<Locale, Record<string, string>> = {
  'zh-TW': {
    dashboard: '儀表板',
    kanban: '任務看板',
    agents: '代理人',
    newCard: '新增卡片',
    login: '登入',
    signup: '註冊',
    logout: '登出',
  },
  en: {
    dashboard: 'Dashboard',
    kanban: 'Kanban',
    agents: 'Agents',
    newCard: 'New Card',
    login: 'Login',
    signup: 'Sign up',
    logout: 'Logout',
  },
  ja: {
    dashboard: 'ダッシュボード',
    kanban: 'カンバン',
    agents: 'エージェント',
    newCard: '新規カード',
    login: 'ログイン',
    signup: '登録',
    logout: 'ログアウト',
  },
};

export function t(locale: Locale, key: string): string {
  return messages[locale]?.[key] ?? messages.en[key] ?? key;
}
