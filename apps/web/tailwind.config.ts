import type { Config } from 'tailwindcss';
const config: Config = { darkMode: ['selector', '[data-theme="dark"]'], content: ['./src/**/*.{ts,tsx}'], theme: { extend: { colors: { background: 'var(--background)', foreground: 'var(--foreground)', card: 'var(--card)', border: 'var(--border)', primary: 'var(--primary)' } } } };
export default config;
