/*
  One small translation layer for extension UI text.

  Chrome's native `_locales` + `chrome.i18n.getMessage` was the obvious choice
  and is deliberately not used: it locks the UI to the browser's own UI language
  with no way for the user to override it, and a Russian trader running an
  English Chrome (or the reverse) is the common case here, not the exception.
  So detection uses the same signals Chrome would — the browser UI language,
  then the accept-language list — and a stored preference wins over both.

  Only `ru` is mapped from a non-English prefix. Cyrillic is not a language:
  Ukrainian and Kazakh users get English until someone writes those dictionaries,
  because guessing Russian for them is a worse answer than the fallback.
*/

import { en, type MessageKey } from './locales/en';
import { ru } from './locales/ru';

export const SUPPORTED_LOCALES = ['en', 'ru'] as const;
export type Locale = typeof SUPPORTED_LOCALES[number];

/** `auto` re-reads the browser every time the popup opens; a locale pins it. */
export type LocalePreference = 'auto' | Locale;

export const LOCALE_STORAGE_KEY = 'csboard_ui_language';

const DICTIONARIES: Readonly<Record<Locale, Readonly<Record<MessageKey, string>>>> = {
  en,
  ru,
};

const FALLBACK_LOCALE: Locale = 'en';

let activeLocale: Locale = FALLBACK_LOCALE;

function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/** `ru-RU`, `RU`, `ru_RU` all mean the same dictionary. */
function localeFromTag(tag: unknown): Locale | null {
  if (typeof tag !== 'string' || tag.length === 0) return null;
  const primary = tag.toLowerCase().replace('_', '-').split('-')[0] ?? '';
  return isLocale(primary) ? primary : null;
}

function browserLanguageTags(): string[] {
  const tags: string[] = [];
  try {
    const uiLanguage = globalThis.chrome?.i18n?.getUILanguage?.();
    if (uiLanguage) tags.push(uiLanguage);
  } catch {
    // The i18n API is missing outside an extension context (tests, page world).
  }
  if (typeof navigator !== 'undefined') {
    if (Array.isArray(navigator.languages)) tags.push(...navigator.languages);
    if (navigator.language) tags.push(navigator.language);
  }
  return tags;
}

/** The locale the browser and OS ask for, with no stored preference applied. */
export function detectLocale(): Locale {
  for (const tag of browserLanguageTags()) {
    const locale = localeFromTag(tag);
    if (locale) return locale;
  }
  return FALLBACK_LOCALE;
}

export function normalizeLocalePreference(value: unknown): LocalePreference {
  return isLocale(value) ? value : 'auto';
}

export function resolveLocale(preference: LocalePreference): Locale {
  return preference === 'auto' ? detectLocale() : preference;
}

export async function loadLocalePreference(): Promise<LocalePreference> {
  try {
    const stored = await chrome.storage.local.get(LOCALE_STORAGE_KEY);
    return normalizeLocalePreference(stored[LOCALE_STORAGE_KEY]);
  } catch {
    return 'auto';
  }
}

export async function saveLocalePreference(preference: LocalePreference): Promise<void> {
  try {
    await chrome.storage.local.set({ [LOCALE_STORAGE_KEY]: preference });
  } catch {
    // A popup that cannot persist the choice still honours it for this session.
  }
}

export function getLocale(): Locale {
  return activeLocale;
}

export function activateLocale(locale: Locale): void {
  activeLocale = locale;
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale;
  }
}

/** Reads the stored preference, applies it, and returns the resolved locale. */
export async function initI18n(): Promise<Locale> {
  const locale = resolveLocale(await loadLocalePreference());
  activateLocale(locale);
  return locale;
}

function interpolate(template: string, vars?: Readonly<Record<string, string | number>>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
}

export function t(
  key: MessageKey,
  vars?: Readonly<Record<string, string | number>>,
): string {
  const dictionary = DICTIONARIES[activeLocale] ?? DICTIONARIES[FALLBACK_LOCALE];
  const template = dictionary[key] ?? DICTIONARIES[FALLBACK_LOCALE][key] ?? key;
  return interpolate(template, vars);
}

/** True for keys that exist; used where the key comes from runtime data. */
export function isMessageKey(key: string): key is MessageKey {
  return Object.prototype.hasOwnProperty.call(en, key);
}

/**
 * Fills every `data-i18n*` node under `root`.
 *
 * The markup keeps its English text inline rather than empty placeholders, so a
 * popup whose script fails to run is still a readable English panel instead of
 * a blank one.
 */
export function applyTranslations(root: ParentNode = document): void {
  for (const node of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = node.dataset['i18n'];
    if (key && isMessageKey(key)) node.textContent = t(key);
  }
  for (const node of root.querySelectorAll<HTMLElement>('[data-i18n-label]')) {
    const key = node.dataset['i18nLabel'];
    if (key && isMessageKey(key)) node.setAttribute('aria-label', t(key));
  }
  for (const node of root.querySelectorAll<HTMLElement>('[data-i18n-title]')) {
    const key = node.dataset['i18nTitle'];
    if (key && isMessageKey(key)) node.title = t(key);
  }
}

export type { MessageKey };
