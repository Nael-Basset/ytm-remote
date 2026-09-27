// popup.js - YouTube Music Player Popup for Chrome MV3

var browser = globalThis.browser || globalThis.chrome;

const SEEK_MAX = 1000;
const POLL_INTERVAL = 400;
const LYRICS_TICK_MS = 250;

const IS_FLOATING = new URLSearchParams(location.search).get('floating') === '1';

document.addEventListener('DOMContentLoaded', () => {
  if (IS_FLOATING) document.body.classList.add('floating');

  const el = {
    albumArt:    document.getElementById('album-art'),
    bgArt:       document.getElementById('bg-art'),
    bgAccent:    document.getElementById('bg-accent'),
    title:       document.getElementById('track-title'),
    artist:      document.getElementById('track-artist'),
    currentTime: document.getElementById('current-time'),
    totalTime:   document.getElementById('total-time'),
    seek:        document.getElementById('seek'),
    progress:    document.getElementById('progress'),
    progressFill:document.getElementById('progress-fill'),
    playPause:   document.getElementById('play-pause'),
    playPauseIcon: document.getElementById('play-pause-icon'),
    prev:        document.getElementById('prev-track'),
    next:        document.getElementById('next-track'),
    rewind:      document.getElementById('rewind-button'),
    forward:     document.getElementById('forward-button'),
    like:        document.getElementById('like-button'),
    dislike:     document.getElementById('dislike-button'),
    shuffle:     document.getElementById('shuffle-button'),
    repeat:      document.getElementById('repeat-button'),
    mute:        document.getElementById('mute-button'),
    volume:      document.getElementById('volume'),
    volumeIcon:  document.getElementById('volume-icon'),
    timerSelect: document.getElementById('timer-select'),
    timerCountdown: document.getElementById('timer-countdown'),
    speedSelect: document.getElementById('speed-select'),
    optionsBtn:  document.getElementById('options-button'),
    qrBtn:       document.getElementById('qr-button'),
    pipBtn:      document.getElementById('pip-button'),
    floatingBtn: document.getElementById('floating-button'),
    lyricsSection: document.getElementById('lyrics-section'),
    lyricsToggle: document.getElementById('lyrics-toggle'),
    lyricsBody:  document.getElementById('lyrics-body'),
    lyricsContent: document.getElementById('lyrics-content'),
    lyricsEmpty: document.getElementById('lyrics-empty'),
    lyricsLoading: document.getElementById('lyrics-loading')
  };

  const PLAY_SVG = '<path d="M8 5v14l11-7z"/>';
  const PAUSE_SVG = '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>';
  const VOLUME_FULL_SVG = '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 00-2.5-4.03v8.05A4.5 4.5 0 0016.5 12zM14 3.23v2.06a7 7 0 010 13.42v2.06A9 9 0 0014 3.23z"/>';
  const VOLUME_MUTE_SVG = '<path d="M16.5 12A4.5 4.5 0 0014 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0a6.97 6.97 0 01-1.01 3.62l1.46 1.46A8.94 8.94 0 0021 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.17v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>';
  const REPEAT_OFF_SVG = '<path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/>';
  const REPEAT_PLAYLIST_SVG = '<path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/><circle cx="12" cy="12" r="2.2" fill="currentColor"/>';
  const REPEAT_ONE_SVG = '<path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/><text x="12" y="15" text-anchor="middle" font-size="8.5" font-weight="900" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif" fill="currentColor">1</text>';

  let userSeeking = false;
  let userVolumeChanging = false;
  let lastVolumeSent = -1;
  let volumeThrottleTimer = null;
  let lastArtUrl = '';
  let lastAccent = '';
  let lastTrackKey = '';
  let lastCurrentTime = 0;

  function formatTime(t) {
    if (!isFinite(t) || t < 0) return '0:00';
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  // Helpers de synchronisation
  async function getMusicTab() {
    const tabs = await browser.tabs.query({ url: '*://music.youtube.com/*' });
    return tabs[0] || null;
  }

  async function send(action, extra = {}) {
    const tab = await getMusicTab();
    if (!tab) return null;
    try {
      return await browser.tabs.sendMessage(tab.id, { action, ...extra });
    } catch (e) {
      return null;
    }
  }

  async function refresh() {
    const tab = await getMusicTab();
    if (!tab) {
      el.title.textContent = browser.i18n.getMessage('openYouTubeMusicTab') || 'Open YouTube Music';
      el.artist.textContent = '';
      el.currentTime.textContent = '0:00';
      el.totalTime.textContent = '0:00';
      el.progressFill.style.width = '0%';
      return;
    }

    const info = await send('get-track-info');
    if (!info) return;
    applyTrackInfo(info);
  }

  function applyTrackInfo(info) {
    if (info.title && el.title.textContent !== info.title) {
      el.title.textContent = info.title;
    } else if (!info.title) {
      el.title.textContent = browser.i18n.getMessage('trackTitlePlaceholder') || 'Track Title';
    }
    if (info.artist && el.artist.textContent !== info.artist) {
      el.artist.textContent = info.artist;
    } else if (!info.artist) {
      el.artist.textContent = browser.i18n.getMessage('trackArtistPlaceholder') || 'Artist';
    }

    // Pochette & fond dynamique
    if (info.albumArt && info.albumArt !== lastArtUrl) {
      lastArtUrl = info.albumArt;
      el.albumArt.src = info.albumArt;
      el.bgArt.style.backgroundImage = `url("${info.albumArt}")`;
      extractAccent(info.albumArt);
    } else if (!info.albumArt && el.albumArt.src.indexOf('icon128.png') === -1) {
      el.albumArt.src = 'icons/icon128.png';
      el.bgArt.style.backgroundImage = '';
    }

    el.totalTime.textContent = formatTime(info.duration);
    lastCurrentTime = info.currentTime || 0;
    if (!userSeeking) {
      el.currentTime.textContent = formatTime(info.currentTime);
      const pct = info.duration ? (info.currentTime / info.duration) * 100 : 0;
      el.progressFill.style.width = `${pct}%`;
      el.seek.value = Math.round(pct * 10);
    }

    if (!userVolumeChanging && typeof info.volume === 'number') {
      const v = Math.round(info.volume);
      if (parseInt(el.volume.value, 10) !== v) el.volume.value = v;
      el.volumeIcon.innerHTML = (info.muted || v === 0) ? VOLUME_MUTE_SVG : VOLUME_FULL_SVG;
    }

    el.playPauseIcon.innerHTML = info.isPlaying ? PAUSE_SVG : PLAY_SVG;

    el.like.classList.toggle('active', !!info.liked);
    el.dislike.classList.toggle('active', !!info.disliked);
    el.shuffle.classList.toggle('active', !!info.shuffled);
    if (typeof info.repeatMode === 'number') {
      renderPopupRepeat(info.repeatMode);
    }
    el.pipBtn.classList.toggle('active', !!info.inPip);

    if (typeof info.playbackRate === 'number') {
      const rateStr = info.playbackRate.toString();
      if (el.speedSelect.value !== rateStr && [...el.speedSelect.options].some((o) => o.value === rateStr)) {
        el.speedSelect.value = rateStr;
      }
    }

    const key = (info.title || '') + '|' + (info.artist || '');
    if (key !== lastTrackKey) {
      lastTrackKey = key;
      if (el.lyricsSection.classList.contains('open')) loadLyrics(info);
      else { lyricsLines = []; renderLyrics(); }
    }
  }

  // Extraction de couleur d'accentuation
  const accentBlacklist = new Set();
  function extractAccent(url) {
    if (accentBlacklist.has(url)) return;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 16;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, 16, 16);
        const data = ctx.getImageData(0, 0, 16, 16).data;
        let r = 0, g = 0, b = 0, count = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 128) continue;
          const max = Math.max(data[i], data[i + 1], data[i + 2]);
          const min = Math.min(data[i], data[i + 1], data[i + 2]);
          if (max < 40 || min > 220) continue;
          r += data[i]; g += data[i + 1]; b += data[i + 2]; count++;
        }
        if (count === 0) return;
        r = Math.round(r / count);
        g = Math.round(g / count);
        b = Math.round(b / count);
        const accent = `rgb(${r}, ${g}, ${b})`;
        if (accent === lastAccent) return;
        lastAccent = accent;
        document.documentElement.style.setProperty('--accent', accent);
      } catch (e) {
        accentBlacklist.add(url);
      }
    };
    img.onerror = () => { accentBlacklist.add(url); };
    img.src = url;
  }

  // Boutons de transport
  el.prev.addEventListener('click', () => send('prev'));
  el.next.addEventListener('click', () => send('next'));
  el.playPause.addEventListener('click', () => send('play-pause'));
  el.rewind.addEventListener('click', () => send('seek-relative', { delta: -10 }));
  el.forward.addEventListener('click', () => send('seek-relative', { delta: 10 }));
  el.like.addEventListener('click', () => send('like'));
  el.dislike.addEventListener('click', () => send('dislike'));
  el.shuffle.addEventListener('click', () => send('toggle-shuffle'));

  let currentPopupRepeatMode = 0;
  function renderPopupRepeat(mode) {
    currentPopupRepeatMode = mode;
    if (mode === 2) {
      el.repeat.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">${REPEAT_ONE_SVG}</svg>`;
      el.repeat.className = 'player-btn active repeat-track';
      el.repeat.title = 'Répéter le titre (1)';
    } else if (mode === 1) {
      el.repeat.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">${REPEAT_PLAYLIST_SVG}</svg>`;
      el.repeat.className = 'player-btn active repeat-playlist';
      el.repeat.title = 'Répéter la playlist (Tout)';
    } else {
      el.repeat.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">${REPEAT_OFF_SVG}</svg>`;
      el.repeat.className = 'player-btn';
      el.repeat.title = 'Répétition désactivée';
    }
  }

  el.repeat.addEventListener('click', () => {
    send('toggle-repeat');
    const nextMode = (currentPopupRepeatMode + 1) % 3;
    renderPopupRepeat(nextMode);
  });
  el.mute.addEventListener('click', () => send('mute-toggle'));

  if (el.qrBtn) {
    el.qrBtn.addEventListener('click', async () => {
      const res = await send('toggle-page-qr');
      if (!res) {
        browser.tabs.create({ url: 'http://127.0.0.1:8085' });
      }
      window.close();
    });
  }

  // PiP Always-on-Top : bascule le Document PiP dans l'onglet YouTube Music
  el.pipBtn.addEventListener('click', async () => {
    const tab = await getMusicTab();
    if (!tab) {
      browser.tabs.create({ url: 'https://music.youtube.com' });
      return;
    }
    await send('open-doc-pip');
    window.close();
  });

  // Fenêtre flottante
  el.floatingBtn.addEventListener('click', async () => {
    await browser.windows.create({
      url: browser.runtime.getURL('popup.html?floating=1'),
      type: 'popup',
      width: 400,
      height: 620
    });
    if (!IS_FLOATING) window.close();
  });

  // Seek slider
  function seekFromSlider() {
    const pct = parseInt(el.seek.value, 10) / SEEK_MAX * 100;
    el.progressFill.style.width = `${pct}%`;
  }
  function startSeek() {
    userSeeking = true;
    el.progress.classList.add('seeking');
  }
  function commitSeek() {
    if (!userSeeking) return;
    const value = parseInt(el.seek.value, 10) / SEEK_MAX * 100;
    send('seek', { value });
    userSeeking = false;
    el.progress.classList.remove('seeking');
  }
  el.seek.addEventListener('pointerdown', startSeek);
  el.seek.addEventListener('keydown', startSeek);
  el.seek.addEventListener('input', () => {
    if (!userSeeking) startSeek();
    seekFromSlider();
  });
  el.seek.addEventListener('change', commitSeek);
  el.seek.addEventListener('pointerup', commitSeek);
  el.seek.addEventListener('pointercancel', () => { userSeeking = false; el.progress.classList.remove('seeking'); });
  el.seek.addEventListener('keyup', commitSeek);

  // Volume
  function sendVolumeNow() {
    const v = parseInt(el.volume.value, 10);
    if (v !== lastVolumeSent) { lastVolumeSent = v; send('volume', { value: v }); }
  }
  el.volume.addEventListener('pointerdown', () => { userVolumeChanging = true; });
  el.volume.addEventListener('input', () => {
    userVolumeChanging = true;
    const v = parseInt(el.volume.value, 10);
    el.volumeIcon.innerHTML = v === 0 ? VOLUME_MUTE_SVG : VOLUME_FULL_SVG;
    if (volumeThrottleTimer) return;
    volumeThrottleTimer = setTimeout(() => {
      volumeThrottleTimer = null;
      sendVolumeNow();
    }, 80);
  });
  el.volume.addEventListener('change', () => {
    if (volumeThrottleTimer) { clearTimeout(volumeThrottleTimer); volumeThrottleTimer = null; }
    sendVolumeNow();
    setTimeout(() => { userVolumeChanging = false; }, 200);
  });
  el.volume.addEventListener('pointerup', () => {
    setTimeout(() => { userVolumeChanging = false; }, 200);
  });

  // Vitesse de lecture
  el.speedSelect.addEventListener('change', () => {
    send('set-rate', { value: parseFloat(el.speedSelect.value) });
  });

  // Sleep timer
  el.timerSelect.addEventListener('change', () => {
    const v = el.timerSelect.value;
    if (v === 'none') {
      browser.runtime.sendMessage({ action: 'clear-sleep-timer' });
    } else {
      const ms = parseInt(v, 10) * 60 * 1000;
      if (ms > 0) browser.runtime.sendMessage({ action: 'set-sleep-timer', duration: ms });
    }
    browser.storage.local.set({ sleepTimerDuration: v });
  });

  function updateSleepCountdown() {
    browser.storage.local.get('sleepTimerEndsAt').then(({ sleepTimerEndsAt }) => {
      if (!sleepTimerEndsAt) {
        el.timerCountdown.hidden = true;
        return;
      }
      const remaining = sleepTimerEndsAt - Date.now();
      if (remaining <= 0) {
        el.timerCountdown.hidden = true;
        return;
      }
      el.timerCountdown.hidden = false;
      el.timerCountdown.textContent = formatTime(remaining / 1000);
    });
  }
  setInterval(updateSleepCountdown, 1000);
  updateSleepCountdown();

  // Page d'options
  el.optionsBtn.addEventListener('click', () => {
    browser.runtime.openOptionsPage().catch(() => {
      browser.tabs.create({ url: browser.runtime.getURL('options.html') });
    });
  });

  // Thème
  function applyTheme(theme) { document.body.classList.toggle('light', theme === 'light'); }
  browser.storage.local.get(['theme', 'sleepTimerDuration']).then((data) => {
    applyTheme(data.theme);
    if (data.sleepTimerDuration) el.timerSelect.value = data.sleepTimerDuration;
  });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.theme) applyTheme(changes.theme.newValue);
  });

  // Paroles (Lyrics)
  let lyricsLines = [];
  let lyricsActiveIdx = -1;

  function parseLrc(lrc) {
    const out = [];
    for (const raw of lrc.split('\n')) {
      const line = raw.trim();
      let work = line;
      const stamps = [];
      let m;
      while ((m = work.match(/^\[(\d+):(\d+)(?:[.:](\d+))?\]/))) {
        const mm = parseInt(m[1], 10);
        const ss = parseInt(m[2], 10);
        const ff = m[3] ? parseInt(m[3].padEnd(3, '0').slice(0, 3), 10) / 1000 : 0;
        stamps.push(mm * 60 + ss + ff);
        work = work.slice(m[0].length);
      }
      const text = work.trim();
      for (const t of stamps) out.push({ time: t, text });
    }
    out.sort((a, b) => a.time - b.time);
    return out;
  }

  function renderLyrics() {
    el.lyricsContent.innerHTML = '';
    if (lyricsLines.length === 0) return;
    for (let i = 0; i < lyricsLines.length; i++) {
      const line = lyricsLines[i];
      const div = document.createElement('div');
      div.className = 'lyric-line';
      div.textContent = line.text || '♪';
      div.dataset.idx = i;
      if (line.time >= 0) {
        div.addEventListener('click', () => send('seek-absolute', { value: line.time }));
      } else {
        div.classList.add('no-sync');
      }
      el.lyricsContent.appendChild(div);
    }
    lyricsActiveIdx = -1;
  }

  function updateActiveLyric() {
    if (lyricsLines.length === 0) return;
    let idx = -1;
    for (let i = 0; i < lyricsLines.length; i++) {
      if (lyricsLines[i].time <= lastCurrentTime + 0.2) idx = i;
      else break;
    }
    if (idx === lyricsActiveIdx) return;
    const prev = el.lyricsContent.querySelector('.lyric-line.active');
    if (prev) prev.classList.remove('active');
    if (idx >= 0) {
      const next = el.lyricsContent.querySelector(`.lyric-line[data-idx="${idx}"]`);
      if (next) {
        next.classList.add('active');
        next.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
    lyricsActiveIdx = idx;
  }

  function cleanTitle(t) {
    return (t || '')
      .replace(/\s*[\(\[][^\)\]]*(official|lyric|video|audio|mv|m\/v|hd|hq|remaster)[^\)\]]*[\)\]]/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function cleanArtist(a) {
    if (!a) return '';
    return a.split(/\s*[•·]\s*/)[0]
      .replace(/\s*[\(\[]?\s*(feat\.?|ft\.?|featuring)\b[^\)\]]*[\)\]]?/gi, '')
      .trim();
  }

  function lrcUrl(path, params) {
    const qs = new URLSearchParams(params);
    return `https://lrclib.net/api/${path}?${qs.toString()}`;
  }

  async function fetchLrclibGet(title, artist, duration) {
    const params = { track_name: title, artist_name: artist };
    if (duration) params.duration = String(Math.round(duration));
    const res = await fetch(lrcUrl('get', params));
    if (!res.ok) return null;
    return res.json();
  }

  async function fetchLrclibSearch(title, artist) {
    const res = await fetch(lrcUrl('search', { track_name: title, artist_name: artist }));
    if (!res.ok) return null;
    const arr = await res.json();
    return Array.isArray(arr) && arr.length > 0 ? arr[0] : null;
  }

  function applyLyricsData(data) {
    if (data && data.syncedLyrics) {
      lyricsLines = parseLrc(data.syncedLyrics);
    } else if (data && data.plainLyrics) {
      lyricsLines = data.plainLyrics.split('\n').map((t, i) => ({ time: -1 - i, text: t.trim() }));
    } else {
      lyricsLines = [];
    }
  }

  function showLyricsEmpty(query, err) {
    el.lyricsEmpty.hidden = false;
    el.lyricsEmpty.innerHTML = '';
    const label = browser.i18n.getMessage('lyricsNotFound') || 'No lyrics found.';
    const labelEl = document.createElement('div');
    labelEl.textContent = label;
    el.lyricsEmpty.appendChild(labelEl);
    if (err) {
      const errEl = document.createElement('div');
      errEl.className = 'lyrics-err';
      errEl.textContent = '⚠ ' + err;
      el.lyricsEmpty.appendChild(errEl);
      return;
    }
    if (query) {
      const meta = document.createElement('div');
      meta.className = 'lyrics-meta';
      meta.textContent = `${query.artist} — ${query.title}`;
      el.lyricsEmpty.appendChild(meta);

      const links = document.createElement('div');
      links.className = 'lyrics-links';
      const q = encodeURIComponent(`${query.artist} ${query.title}`);
      const addLink = document.createElement('a');
      addLink.href = `https://lrclib.net/?q=${q}`;
      addLink.target = '_blank';
      addLink.rel = 'noopener';
      addLink.textContent = browser.i18n.getMessage('lyricsAddToLrclib') || 'Add to lrclib';
      const googleLink = document.createElement('a');
      googleLink.href = `https://www.google.com/search?q=${q}+lyrics`;
      googleLink.target = '_blank';
      googleLink.rel = 'noopener';
      googleLink.textContent = browser.i18n.getMessage('lyricsSearchGoogle') || 'Google';
      links.appendChild(addLink);
      links.appendChild(document.createTextNode(' · '));
      links.appendChild(googleLink);
      el.lyricsEmpty.appendChild(links);
    }
  }

  async function loadLyrics(info) {
    if (!info || !info.title) {
      el.lyricsLoading.hidden = true;
      showLyricsEmpty(null, info ? 'Track title is empty' : 'No YT Music tab found');
      return;
    }
    el.lyricsEmpty.hidden = true;
    el.lyricsLoading.hidden = false;
    el.lyricsContent.innerHTML = '';
    lyricsLines = [];

    const title = cleanTitle(info.title);
    const artist = cleanArtist(info.artist);
    const query = { title, artist };

    try {
      let data = await fetchLrclibGet(title, artist, info.duration);
      if (!data) data = await fetchLrclibGet(title, artist, 0);
      if (!data) data = await fetchLrclibSearch(title, artist);

      applyLyricsData(data);
      el.lyricsLoading.hidden = true;
      if (lyricsLines.length === 0) {
        showLyricsEmpty(query);
      } else {
        el.lyricsEmpty.hidden = true;
        renderLyrics();
      }
    } catch (e) {
      el.lyricsLoading.hidden = true;
      showLyricsEmpty(query, e.message || 'Network error');
    }
  }

  el.lyricsToggle.addEventListener('click', async () => {
    const open = el.lyricsSection.classList.toggle('open');
    el.lyricsBody.hidden = !open;
    if (open && lyricsLines.length === 0) {
      const info = await send('get-track-info');
      if (info) loadLyrics(info);
    }
  });

  setInterval(() => {
    if (el.lyricsSection.classList.contains('open')) updateActiveLyric();
  }, LYRICS_TICK_MS);

  // Rafraîchissement initial + boucle de polling
  refresh();
  setInterval(refresh, POLL_INTERVAL);
});
