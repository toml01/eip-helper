import { browser } from 'wxt/browser';
import { DEFAULT_SETTINGS, type Settings } from './types';

export async function getSettings(): Promise<Settings> {
  try {
    // Passing the defaults as the query fills in any key never written.
    const stored = await browser.storage.sync.get(
      DEFAULT_SETTINGS as unknown as Record<string, unknown>,
    );
    return { ...DEFAULT_SETTINGS, ...stored } as Settings;
  } catch {
    // Storage can be unavailable while the extension is reloading; the
    // defaults are the safe answer (bare numbers off).
    return DEFAULT_SETTINGS;
  }
}

export async function setSettings(patch: Partial<Settings>): Promise<void> {
  await browser.storage.sync.set(patch);
}

export function isSiteEnabled(s: Settings, hostname: string): boolean {
  if (!s.enabled) return false;
  const h = hostname.toLowerCase().replace(/^www\./, '');
  return !s.disabledSites.some((d) => h === d || h.endsWith(`.${d}`));
}

export function onSettingsChanged(fn: (s: Settings) => void): void {
  browser.storage.onChanged.addListener((_changes, area) => {
    if (area === 'sync') void getSettings().then(fn);
  });
}
