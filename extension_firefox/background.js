// background.js - Chrome MV3 Service Worker

const browser = globalThis.browser || globalThis.chrome;

const SETTINGS_DEFAULTS = {
  notificationsEnabled: true,
  blurEnabled: true,
  hotkeysEnabled: true
};

async function getSetting(key) {
  const data = await browser.storage.local.get(key);
  return data[key] === undefined ? SETTINGS_DEFAULTS[key] : data[key];
}

// Minuteur de mise en veille utilisant chrome.alarms (résistant à l'endormissement du Service Worker)
function setSleepTimer(durationMs) {
  browser.alarms.clear('ytmp-sleep-timer', () => {
    const endsAt = Date.now() + durationMs;
    browser.storage.local.set({ sleepTimerEndsAt: endsAt });
    browser.alarms.create('ytmp-sleep-timer', { when: endsAt });
  });
}

function clearSleepTimer() {
  browser.alarms.clear('ytmp-sleep-timer');
  browser.storage.local.remove('sleepTimerEndsAt');
}

// Alarme pour le Sleep Timer
browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'ytmp-sleep-timer') {
    await browser.storage.local.remove('sleepTimerEndsAt');
    sendMessageToContentScripts({ action: 'pause' });
    browser.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: browser.i18n.getMessage('sleepTimerTitle') || 'Sleep Timer',
      message: browser.i18n.getMessage('sleepTimerMessage') || 'Playback paused by sleep timer.'
    });
  }
});

// Écoute des messages venant du popup ou des content scripts
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case 'set-sleep-timer':
      setSleepTimer(message.duration);
      break;
    case 'clear-sleep-timer':
      clearSleepTimer();
      break;
    case 'show-notification':
      getSetting('notificationsEnabled').then((enabled) => {
        if (!enabled) return;
        browser.notifications.create('ytmp-current-track', {
          type: 'basic',
          iconUrl: message.iconUrl || 'icons/icon128.png',
          title: message.title || '',
          message: message.message || ''
        });
      });
      break;
    default:
      break;
  }
});

// Raccourcis clavier (chrome.commands)
browser.commands.onCommand.addListener(async (command) => {
  if (!(await getSetting('hotkeysEnabled'))) {
    return;
  }
  switch (command) {
    case 'play-pause':
      sendMessageToContentScripts({ action: 'play-pause' });
      break;
    case 'next-track':
      sendMessageToContentScripts({ action: 'next' });
      break;
    case 'previous-track':
      sendMessageToContentScripts({ action: 'prev' });
      break;
    case 'volume-up':
      adjustVolume(10);
      break;
    case 'volume-down':
      adjustVolume(-10);
      break;
    case 'mute-toggle':
      sendMessageToContentScripts({ action: 'mute-toggle' });
      break;
    case 'toggle-shuffle':
      sendMessageToContentScripts({ action: 'toggle-shuffle' });
      break;
    case 'toggle-repeat':
      sendMessageToContentScripts({ action: 'toggle-repeat' });
      break;
    case 'toggle-like':
      sendMessageToContentScripts({ action: 'like' });
      break;
    case 'toggle-dislike':
      sendMessageToContentScripts({ action: 'dislike' });
      break;
    case 'toggle-pip':
      sendMessageToContentScripts({ action: 'pip' });
      break;
    case 'sleep-timer':
      setSleepTimer(15 * 60 * 1000);
      browser.storage.local.set({ sleepTimerDuration: '15' });
      break;
    default:
      break;
  }
});

// Envoi de messages à tous les onglets YouTube Music
function sendMessageToContentScripts(message) {
  browser.tabs.query({ url: '*://music.youtube.com/*' }).then((tabs) => {
    tabs.forEach((tab) => {
      browser.tabs.sendMessage(tab.id, message).catch((err) => {
        // Onglet pas encore prêt ou fermé
      });
    });
  });
}

// Ajustement du volume
function adjustVolume(amount) {
  browser.tabs.query({ url: '*://music.youtube.com/*' }).then((tabs) => {
    tabs.forEach((tab) => {
      browser.tabs.sendMessage(tab.id, { action: 'get-volume' }).then((currentVolume) => {
        let newVolume = (typeof currentVolume === 'number' ? currentVolume : 100) + amount;
        if (newVolume > 100) newVolume = 100;
        if (newVolume < 0) newVolume = 0;
        browser.tabs.sendMessage(tab.id, { action: 'volume', value: newVolume });
      }).catch(() => {});
    });
  });
}
