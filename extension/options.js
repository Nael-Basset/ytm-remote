var browser = globalThis.browser || globalThis.chrome;

const DEFAULTS = {
  notificationsEnabled: true,
  blurEnabled: true,
  hotkeysEnabled: true
};

const fields = {
  notificationsEnabled: 'notifications-enabled',
  blurEnabled: 'blur-enabled',
  hotkeysEnabled: 'hotkeys-enabled'
};

const COMMAND_LABELS = {
  '_execute_action': 'Ouvrir le menu popup de l\'extension',
  'play-pause': 'Lecture / Pause',
  'next-track': 'Morceau suivant',
  'previous-track': 'Morceau précédent',
  'toggle-pip': 'Mini-Lecteur PiP Always on Top (Au-dessus de toute app)',
  'volume-up': 'Augmenter le volume (+5%)',
  'volume-down': 'Diminuer le volume (-5%)',
  'mute-toggle': 'Couper / Rétablir le son',
  'toggle-shuffle': 'Lecture aléatoire',
  'toggle-repeat': 'Répétition (Désactivé / Playlist / Titre)',
  'toggle-like': 'J\'aime',
  'toggle-dislike': 'Je n\'aime pas',
  'sleep-timer': 'Minuteur de veille'
};

function applyTheme(theme) {
  document.body.classList.toggle('light', theme === 'light');
}

async function loadShortcuts() {
  const list = document.getElementById('shortcuts-list');
  if (!list || !browser.commands || !browser.commands.getAll) return;

  try {
    const commands = await browser.commands.getAll();
    list.innerHTML = '';

    commands.forEach((cmd) => {
      const item = document.createElement('div');
      item.className = 'shortcut-item';

      const label = document.createElement('div');
      label.className = 'shortcut-label';
      label.textContent = COMMAND_LABELS[cmd.name] || cmd.description || cmd.name;

      const badge = document.createElement('kbd');
      badge.className = 'shortcut-badge';
      if (cmd.shortcut && cmd.shortcut.trim()) {
        badge.textContent = cmd.shortcut;
      } else {
        badge.textContent = 'Non assigné';
        badge.classList.add('empty');
      }

      item.appendChild(label);
      item.appendChild(badge);
      list.appendChild(item);
    });
  } catch (e) {
    console.warn('Could not load commands:', e);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const status = document.getElementById('status');
  let statusTimer = null;

  function flashSaved() {
    status.hidden = false;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { status.hidden = true; }, 1500);
  }

  const stored = await browser.storage.local.get([...Object.keys(DEFAULTS), 'theme']);
  applyTheme(stored.theme);
  for (const [key, id] of Object.entries(fields)) {
    const value = stored[key] === undefined ? DEFAULTS[key] : stored[key];
    const el = document.getElementById(id);
    if (el) el.checked = value;
  }
  const lightEl = document.getElementById('light-theme');
  if (lightEl) lightEl.checked = stored.theme === 'light';

  for (const [key, id] of Object.entries(fields)) {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', (e) => {
        browser.storage.local.set({ [key]: e.target.checked });
        flashSaved();
      });
    }
  }

  if (lightEl) {
    lightEl.addEventListener('change', (e) => {
      const theme = e.target.checked ? 'light' : 'dark';
      browser.storage.local.set({ theme });
      applyTheme(theme);
      flashSaved();
    });
  }

  // Bouton vers chrome://extensions/shortcuts
  const openShortcutsBtn = document.getElementById('open-shortcuts-btn');
  if (openShortcutsBtn) {
    openShortcutsBtn.addEventListener('click', () => {
      browser.tabs.create({ url: 'chrome://extensions/shortcuts' });
    });
  }

  // Chargement des raccourcis
  loadShortcuts();
});
