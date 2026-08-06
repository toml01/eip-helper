import { getSettings, setSettings } from '../../core/settings';
import type { Settings } from '../../core/types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const enabled = $<HTMLInputElement>('enabled');
const bareNumbers = $<HTMLInputElement>('bareNumbers');
const includeUnmerged = $<HTMLInputElement>('includeUnmerged');
const lookupOnSelection = $<HTMLInputElement>('lookupOnSelection');
const debugMode = $<HTMLInputElement>('debugMode');
const highlightStyle = $<HTMLSelectElement>('highlightStyle');
const disabledSites = $<HTMLTextAreaElement>('disabledSites');
const saved = $<HTMLParagraphElement>('saved');

let flashTimer: number | undefined;
function flash() {
  saved.hidden = false;
  window.clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => {
    saved.hidden = true;
  }, 1200);
}

async function save(patch: Partial<Settings>) {
  await setSettings(patch);
  flash();
}

const settings = await getSettings();
enabled.checked = settings.enabled;
bareNumbers.checked = settings.bareNumbers;
includeUnmerged.checked = settings.includeUnmerged;
lookupOnSelection.checked = settings.lookupOnSelection;
debugMode.checked = settings.debugMode;
highlightStyle.value = settings.highlightStyle;
disabledSites.value = settings.disabledSites.join('\n');

enabled.addEventListener('change', () => void save({ enabled: enabled.checked }));
bareNumbers.addEventListener('change', () => void save({ bareNumbers: bareNumbers.checked }));
includeUnmerged.addEventListener('change', () => void save({ includeUnmerged: includeUnmerged.checked }));
lookupOnSelection.addEventListener('change', () => void save({ lookupOnSelection: lookupOnSelection.checked }));
debugMode.addEventListener('change', () => void save({ debugMode: debugMode.checked }));
highlightStyle.addEventListener(
  'change',
  () => void save({ highlightStyle: highlightStyle.value as Settings['highlightStyle'] }),
);
disabledSites.addEventListener('change', () =>
  void save({
    disabledSites: disabledSites.value
      .split('\n')
      .map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
      .filter(Boolean),
  }),
);
