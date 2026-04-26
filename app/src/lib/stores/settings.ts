import { writable } from 'svelte/store';
import { setLang } from '../i18n';

export type LangCode = 'en' | 'es';

const STORAGE_KEY = 'ariadne:lang';

function detectDefaultLang(): LangCode {
  if (typeof localStorage !== 'undefined') {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'es' || stored === 'en') return stored;
  }
  if (typeof navigator !== 'undefined') {
    const lang = navigator.language ?? '';
    if (lang.startsWith('es')) return 'es';
  }
  return 'en';
}

function createLangStore() {
  const { subscribe, set } = writable<LangCode>(detectDefaultLang());

  function change(lang: LangCode) {
    setLang(lang);
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, lang);
    if (typeof document !== 'undefined') document.documentElement.lang = lang;
    set(lang);
  }

  return { subscribe, change };
}

export const lang = createLangStore();
export const ttsEnabled = writable(true);
