// content-script.js - YouTube Music Player (Chrome Manifest V3)

(function () {
  'use strict';

  // Les messages P2P transitent en texte JSON brut sur le RTCDataChannel natif (le canal JSON de
  // PeerJS refuse tout message > 16 Ko, or l'état avec la file d'attente dépasse souvent cette taille).
  // PeerJS écoute le même canal et appelle TextDecoder.decode() sur ces chaînes : ce patch lui évite
  // de lever une exception à chaque message.
  if (typeof TextDecoder !== 'undefined') {
    const origDecode = TextDecoder.prototype.decode;
    TextDecoder.prototype.decode = function (input, options) {
      if (typeof input === 'string') return input;
      if (!input) return '';
      return origDecode.call(this, input, options);
    };
  }

  const browser = globalThis.browser || globalThis.chrome;

  // ==========================================
  // Assainissement des données (URL d'images, pistes reçues de la télécommande)
  // ==========================================
  // URL https normalisée (guillemets percent-encodés) : sûre dans src= et dans url("…") CSS
  function safeHttpsUrl(u) {
    try {
      const url = new URL(String(u || ''));
      return url.protocol === 'https:' ? url.href.replace(/"/g, '%22') : '';
    } catch (e) {
      return '';
    }
  }

  // Vignettes venant de la télécommande : uniquement les domaines d'images de YouTube,
  // pour qu'un appareil ne puisse pas faire charger une image arbitraire (pistage, fuite d'IP).
  const THUMB_HOSTS = ['ytimg.com', 'ggpht.com', 'googleusercontent.com'];
  function safeThumbUrl(u, videoId) {
    const href = safeHttpsUrl(u);
    if (href) {
      const host = new URL(href).hostname;
      if (THUMB_HOSTS.some(h => host === h || host.endsWith('.' + h))) return href;
    }
    return videoId ? `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg` : '';
  }

  const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
  function cleanText(v, max = 200) {
    return typeof v === 'string' ? v.slice(0, max) : '';
  }

  // Piste reçue du réseau : on ne garde que des champs typés et bornés
  function sanitizeTrack(v) {
    const item = (typeof v === 'object' && v) ? v : { videoId: v };
    const videoId = VIDEO_ID_RE.test(item.videoId) ? item.videoId : '';
    const out = {
      videoId,
      title: cleanText(item.title),
      artist: cleanText(item.artist),
      duration: cleanText(item.duration, 12),
      thumbnail: safeThumbUrl(item.thumbnail, videoId)
    };
    if (Number.isInteger(item.index) && item.index >= 0 && item.index < 5000) out.index = item.index;
    return out;
  }

  const ALLOWED_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  // Actions acceptées depuis la télécommande, avec validation de la valeur.
  // Renvoie undefined si la commande doit être ignorée.
  function sanitizeRemoteCommand(action, value) {
    const num = (x, min, max) => (typeof x === 'number' && isFinite(x) ? Math.min(max, Math.max(min, x)) : undefined);
    switch (action) {
      case 'play': case 'pause': case 'play-pause': case 'next': case 'prev':
      case 'mute-toggle': case 'like': case 'dislike': case 'toggle-shuffle': case 'toggle-repeat':
        return { action, value: null };
      case 'seek': { const v = num(value, 0, 100); return v === undefined ? undefined : { action, value: v }; }
      case 'seek-relative': { const v = num(value, -600, 600); return v === undefined ? undefined : { action, value: v }; }
      case 'seek-absolute': { const v = num(value, 0, 86400); return v === undefined ? undefined : { action, value: v }; }
      case 'volume': { const v = num(value, 0, 100); return v === undefined ? undefined : { action, value: Math.round(v) }; }
      case 'set-rate': return ALLOWED_RATES.includes(value) ? { action, value } : undefined;
      case 'play-track': case 'queue-track': {
        const t = sanitizeTrack(value);
        return t.videoId ? { action, value: t } : undefined;
      }
      case 'play-queue-index': {
        if (Number.isInteger(value)) return value >= 0 && value < 5000 ? { action, value } : undefined;
        const t = sanitizeTrack(value);
        return (t.videoId || t.index !== undefined) ? { action, value: t } : undefined;
      }
      default:
        return undefined;
    }
  }

  // ==========================================
  // Pochettes : la meilleure image disponible pour chaque piste
  // ==========================================
  // - Titres audio : pochette carrée googleusercontent, demandée en 544 px.
  // - Clips vidéo : YouTube Music ne fournit que sddefault/hqdefault, des images 4:3 avec des
  //   bandes noires intégrées. On prend à la place l'image 16:9 sans bandes (hq720 si elle existe,
  //   sinon mqdefault) ; les interfaces l'affichent en entier sur un fond flouté.
  function ytThumbVideoId(u) {
    const m = /^https:\/\/i\d?\.ytimg\.com\/vi(?:_webp)?\/([a-zA-Z0-9_-]{11})\//.exec(String(u || ''));
    return m ? m[1] : '';
  }

  const bestVideoThumbCache = new Map();
  function bestVideoThumb(videoId) {
    if (bestVideoThumbCache.has(videoId)) return bestVideoThumbCache.get(videoId);
    const fallback = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
    bestVideoThumbCache.set(videoId, fallback);
    const probe = new Image();
    probe.onload = () => {
      // Une image absente renvoie un petit visuel de remplacement 120x90
      if (probe.naturalWidth >= 640) {
        bestVideoThumbCache.set(videoId, probe.src);
        setTimeout(broadcastP2PState, 0);
      }
    };
    probe.src = `https://i.ytimg.com/vi/${videoId}/hq720.jpg`;
    return fallback;
  }

  // Grande pochette (lecteur, PiP, popup, télécommande)
  function bigArt(u, videoId) {
    const href = safeHttpsUrl(u);
    const id = ytThumbVideoId(href) || (!href && videoId) || '';
    if (id) return bestVideoThumb(id);
    if (/\.(googleusercontent|ggpht)\.com\//.test(href)) return href.replace(/=w\d+-h\d+/, '=w544-h544');
    return href;
  }

  // Petite vignette (file d'attente, recherche) : 16:9 sans bandes, recadrée en carré par l'interface
  function smallArt(u) {
    const href = safeHttpsUrl(u);
    const id = ytThumbVideoId(href);
    return id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : href;
  }

  // ==========================================
  // 1. Thème et Effet de Flou d'Arrière-Plan
  // ==========================================
  const pageBlurStyles = `
    body:has(#layout[player-ui-state="PLAYER_PAGE_OPEN"])::before {
      content: "";
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background-image: var(--blyrics-background-img);
      background-position: center;
      background-repeat: no-repeat;
      background-size: cover;
      filter: blur(var(--blyrics-background-blur, 100px)) saturate(var(--blyrics-background-saturate, 2));
      z-index: -1;
    }

    body:has(#layout[player-ui-state="PLAYER_PAGE_OPEN"])::after {
      content: "";
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background-color: var(--blyrics-background-color, rgba(0, 0, 0, 0.75));
      z-index: -1;
    }

    ytmusic-player-page::before {
      content: "";
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: linear-gradient(to right, var(--blyrics-background-color), var(--blyrics-background-color)),
                  var(--blyrics-background-img);
      background-position: 50% !important;
      background-repeat: no-repeat;
      background-size: cover;
      filter: blur(var(--blyrics-background-blur, 100px)) saturate(var(--blyrics-background-saturate, 2));
      transform: scale(1.2);
      z-index: -100;
    }
  `;

  const themeStyle = document.createElement('style');
  themeStyle.id = 'ytmp-theme-styles';
  themeStyle.textContent = `
    :root {
      --blyrics-text-color: #fff;
      --blyrics-background-color: rgba(0, 0, 0, 0.75);
      --blyrics-highlight-color: rgba(255, 255, 255, 0.5);
      --blyrics-blur-amount: 30px;
      --blyrics-background-blur: 100px;
      --blyrics-background-saturate: 2;
      --player-background: rgba(0, 0, 0, 0.6);
    }

    ytmusic-app {
      background: transparent !important;
    }

    ytmusic-nav-bar {
      background: rgba(0, 0, 0, 0.5) !important;
      backdrop-filter: blur(var(--blyrics-blur-amount));
    }

    ytmusic-player-bar,
    #player-bar-background,
    ytmusic-player {
      background-color: var(--player-background) !important;
      backdrop-filter: blur(var(--blyrics-blur-amount));
    }

    #layout[player-ui-state="PLAYER_PAGE_OPEN"] ytmusic-player-bar,
    #layout[player-ui-state="PLAYER_PAGE_OPEN"] #player-bar-background {
      background: linear-gradient(0deg, var(--player-background), var(--player-background)) !important;
      backdrop-filter: blur(var(--blyrics-blur-amount));
    }

    #layout[player-ui-state="PLAYER_PAGE_OPEN"] #mini-guide-background,
    #layout[player-ui-state="PLAYER_PAGE_OPEN"] #nav-bar-background,
    #layout[player-ui-state="PLAYER_PAGE_OPEN"] #guide-wrapper {
      background-color: transparent !important;
      border-color: transparent !important;
    }

    /* Bouton PiP injecté dans YouTube Music */
    .ytmp-pip-button {
      background: transparent;
      border: none;
      color: rgba(255, 255, 255, 0.7);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 40px;
      height: 40px;
      border-radius: 50%;
      margin: 0 4px;
      transition: all 0.2s ease;
      vertical-align: middle;
      position: relative;
    }

    .ytmp-pip-button:hover {
      color: #fff;
      background: rgba(255, 255, 255, 0.15);
      transform: scale(1.08);
    }

    .ytmp-pip-button.active {
      color: #ff0055;
    }

    .ytmp-pip-button svg {
      width: 22px;
      height: 22px;
      fill: currentColor;
    }
  `;

  function setBlurEnabled(enabled) {
    const existingTheme = document.getElementById('ytmp-theme-styles');
    const existingBlur = document.getElementById('page-blur-styles');
    if (enabled) {
      if (!existingTheme) document.head.appendChild(themeStyle);
      if (!existingBlur) {
        const blurStyle = document.createElement('style');
        blurStyle.id = 'page-blur-styles';
        blurStyle.textContent = pageBlurStyles;
        document.head.appendChild(blurStyle);
      }
    } else {
      existingTheme?.remove();
      existingBlur?.remove();
    }
  }

  function updateBackgroundImage() {
    const albumArt = document.querySelector('#song-image img') || document.querySelector('.image.ytmusic-player-bar img');
    const safe = albumArt ? safeHttpsUrl(albumArt.src) : '';
    if (safe) {
      document.documentElement.style.setProperty('--blyrics-background-img', `url("${safe}")`);
    }
  }

  const observer = new MutationObserver(updateBackgroundImage);
  function startObserver() {
    const albumArt = document.querySelector('#song-image img') || document.querySelector('.image.ytmusic-player-bar img');
    if (albumArt) {
      observer.observe(albumArt, { attributes: true, attributeFilter: ['src'] });
      updateBackgroundImage();
    } else {
      setTimeout(startObserver, 1000);
    }
  }
  startObserver();

  browser.storage.local.get('blurEnabled').then(({ blurEnabled }) => {
    setBlurEnabled(blurEnabled !== false);
  });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.blurEnabled) {
      setBlurEnabled(changes.blurEnabled.newValue !== false);
    }
  });

  // queue-bridge.js est déclaré dans le manifest comme content script du monde de la page
  // ("world": "MAIN") : plus d'injection par balise <script src="chrome-extension://…">, qui
  // échouait si le navigateur refusait momentanément l'accès à la ressource.
  // Il signale sa présence par l'attribut data-ytm-bridge sur <html>.
  function bridgeReady() {
    return document.documentElement.getAttribute('data-ytm-bridge') === '1';
  }

  // ==========================================
  // 2. Contrôle de YouTube Music (DOM & Fallbacks)
  // ==========================================
  function clickFirst(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        const btn = el.shadowRoot?.querySelector('button') || el.querySelector('button') || el;
        // Un seul clic : click() émet déjà un événement composé qui traverse le shadow DOM.
        // (Envoyer aussi un MouseEvent faisait basculer like/shuffle/repeat deux fois.)
        try { btn.click(); } catch (e) {}
        return true;
      }
    }
    return false;
  }

  function dispatchHotkey({ key, code, keyCode, shiftKey = false }) {
    const target = document.querySelector('ytmusic-app') || document.body;
    for (const type of ['keydown', 'keypress', 'keyup']) {
      target.dispatchEvent(new KeyboardEvent(type, {
        key, code, keyCode, which: keyCode,
        shiftKey, bubbles: true, cancelable: true
      }));
    }
  }

  let latestSyncedQueue = [];
  window.addEventListener('ytm-queue-synced-data', (e) => {
    if (Array.isArray(e.detail) && e.detail.length > 0) {
      latestSyncedQueue = e.detail;
    }
  });

  const queuedNextTracks = [];
  let currentTrackOverride = null;

  function updateDOMPlayerBar(title, artist, thumbnail) {
    try {
      const playerBar = document.querySelector('ytmusic-player-bar');
      if (playerBar) {
        if (title) {
          const titleEls = playerBar.querySelectorAll('.title.ytmusic-player-bar, .title');
          titleEls.forEach(el => {
            el.textContent = title;
            el.setAttribute('title', title);
          });
        }
        if (artist) {
          const artistEls = playerBar.querySelectorAll('.subtitle.ytmusic-player-bar yt-formatted-string, .byline.ytmusic-player-bar, .subtitle yt-formatted-string');
          artistEls.forEach(el => {
            el.textContent = artist;
            el.setAttribute('title', artist);
          });
        }
      }

      const safeThumb = safeHttpsUrl(thumbnail);
      if (safeThumb) {
        const albumArtImgs = document.querySelectorAll('#song-image img, .image.ytmusic-player-bar img');
        albumArtImgs.forEach(img => {
          img.src = safeThumb;
        });
        document.documentElement.style.setProperty('--blyrics-background-img', `url("${safeThumb}")`);
      }

      if (title) {
        document.title = artist ? `${title} • ${artist} - YouTube Music` : `${title} - YouTube Music`;
      }
    } catch (e) {}
  }

  // Pont page pour playerApi si accessible
  function callPlayerAction(action, value) {
    const video = document.querySelector('video');
    // Le pont pilote movie_player directement ; sans lui, on passe par les boutons de la page
    const hasMoviePlayer = bridgeReady() && !!document.getElementById('movie_player');

    // 1. Toujours notifier le MAIN-world (queue-bridge) qui a accès direct à movie_player sans restriction Firefox
    try {
      window.dispatchEvent(new CustomEvent('ytm-player-control', { detail: JSON.stringify({ action, value }) }));
    } catch (e) {}

    // Si movie_player existe, queue-bridge le contrôle de manière native et fiable (évite les conflits d'inversion)
    if (hasMoviePlayer && ['play', 'pause', 'play-pause', 'next', 'prev', 'seek', 'volume', 'mute-toggle', 'play-track'].includes(action)) {
      if (action === 'play-track') {
        const item = (typeof value === 'object' && value) ? value : { videoId: value };
        if (item.title) {
          currentTrackOverride = {
            videoId: item.videoId || '',
            title: item.title,
            artist: item.artist || '',
            thumbnail: item.thumbnail || (item.videoId ? `https://i.ytimg.com/vi/${item.videoId}/mqdefault.jpg` : ''),
            timestamp: Date.now()
          };
          updateDOMPlayerBar(item.title, item.artist, item.thumbnail);
        }
        setTimeout(broadcastP2PState, 100);
        setTimeout(broadcastP2PState, 500);
      }
      return;
    }

    switch (action) {
      case 'play':
      case 'pause':
      case 'play-pause':
        if (!clickFirst([
          '#play-pause-button',
          '.play-pause-button',
          'ytmusic-player-bar #play-pause-button'
        ])) {
          if (video) {
            if (video.paused) video.play().catch(() => {}); else video.pause();
          } else {
            dispatchHotkey({ key: 'k', code: 'KeyK', keyCode: 75 });
          }
        }
        break;
      case 'next':
        if (!clickFirst([
          'tp-yt-paper-icon-button.next-button',
          '.next-button',
          '#next-button',
          'ytmusic-player-bar .next-button'
        ])) {
          dispatchHotkey({ key: 'J', code: 'KeyJ', keyCode: 74, shiftKey: true });
        }
        break;
      case 'prev':
        if (!clickFirst([
          'tp-yt-paper-icon-button.previous-button',
          '.previous-button',
          '#previous-button',
          'ytmusic-player-bar .previous-button'
        ])) {
          dispatchHotkey({ key: 'P', code: 'KeyP', keyCode: 80, shiftKey: true });
        }
        break;
      case 'seek':
        if (video && video.duration) {
          video.currentTime = (value / 100) * video.duration;
        }
        break;
      case 'seek-relative':
        if (video && video.duration) {
          video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + value));
        }
        break;
      case 'seek-absolute':
        if (video && video.duration) {
          video.currentTime = Math.min(video.duration, Math.max(0, value));
        }
        break;
      case 'volume':
        if (video) {
          const v = Math.max(0, Math.min(100, value));
          video.volume = v / 100;
          if (video.muted && v > 0) video.muted = false;
        }
        break;
      case 'mute-toggle':
        if (video) video.muted = !video.muted;
        break;
      case 'set-rate':
        if (video && typeof value === 'number') video.playbackRate = value;
        break;
      case 'like':
        if (!clickFirst(LIKE_SELECTORS)) {
          dispatchHotkey({ key: '+', code: 'Equal', keyCode: 187, shiftKey: true });
        }
        break;
      case 'dislike':
        if (!clickFirst(DISLIKE_SELECTORS)) {
          dispatchHotkey({ key: '_', code: 'Minus', keyCode: 189, shiftKey: true });
        }
        break;
      case 'toggle-shuffle':
        if (!clickFirst([
          'tp-yt-paper-icon-button.shuffle.ytmusic-player-bar',
          '.shuffle.ytmusic-player-bar',
          'ytmusic-player-bar tp-yt-paper-icon-button[aria-label*="Shuffle" i]',
          'ytmusic-player-bar tp-yt-paper-icon-button[aria-label*="перемешать" i]',
          'ytmusic-player-bar tp-yt-paper-icon-button[aria-label*="aléatoire" i]'
        ])) {
          dispatchHotkey({ key: 's', code: 'KeyS', keyCode: 83 });
        }
        break;
      case 'toggle-repeat':
        if (!clickFirst([
          'tp-yt-paper-icon-button.repeat.ytmusic-player-bar',
          '.repeat.ytmusic-player-bar',
          'ytmusic-player-bar tp-yt-paper-icon-button[aria-label*="Repeat" i]',
          'ytmusic-player-bar tp-yt-paper-icon-button[aria-label*="répéter" i]',
          'ytmusic-player-bar tp-yt-paper-icon-button[aria-label*="Повтор" i]'
        ])) {
          dispatchHotkey({ key: 'r', code: 'KeyR', keyCode: 82 });
        }
        break;
      case 'play-queue-index': {
        const fullQueue = readUpcomingQueue();
        const rawIdx = (typeof value === 'object' && value) ? value.index : value;
        const targetItem = (typeof value === 'object' && value && value.videoId) ? value : (fullQueue && fullQueue[rawIdx]);
        if (targetItem && targetItem.videoId) {
          callPlayerAction('play-track', targetItem);
          break;
        }
        try {
          window.dispatchEvent(new CustomEvent('ytm-play-index', { detail: rawIdx }));
        } catch (e) {}
        const queueItems = Array.from(document.querySelectorAll('ytmusic-player-queue-item'));
        if (queueItems && queueItems[rawIdx]) {
          const target = queueItems[rawIdx];
          const btn = target.querySelector('.play-button, ytmusic-play-button-renderer, .song-title') || target;
          btn.click();
        } else {
          const listItems = Array.from(document.querySelectorAll('ytmusic-responsive-list-item-renderer'));
          if (listItems && listItems[rawIdx]) {
            const btn = listItems[rawIdx].querySelector('.play-button, ytmusic-play-button-renderer, .title') || listItems[rawIdx];
            btn.click();
          }
        }
        break;
      }
      case 'play-track': {
        const item = (typeof value === 'object' && value) ? value : { videoId: value };
        const vId = item.videoId;
        if (vId) {
          if (item.title) {
            currentTrackOverride = {
              videoId: vId,
              title: item.title,
              artist: item.artist || '',
              thumbnail: item.thumbnail || `https://i.ytimg.com/vi/${vId}/mqdefault.jpg`,
              timestamp: Date.now()
            };
          }
          window.dispatchEvent(new CustomEvent('ytm-play-track', { detail: vId }));
          broadcastP2PState();
          setTimeout(broadcastP2PState, 150);
          setTimeout(broadcastP2PState, 500);
          setTimeout(broadcastP2PState, 1200);
        }
        break;
      }
      case 'queue-track': {
        const vId = typeof value === 'string' ? value : value?.videoId;
        if (vId) {
          const item = typeof value === 'object' ? value : { videoId: vId };
          queuedNextTracks.push({
            videoId: vId,
            title: item.title || 'Titre',
            artist: item.artist || '',
            duration: item.duration || '',
            thumbnail: item.thumbnail || `https://i.ytimg.com/vi/${vId}/mqdefault.jpg`
          });
          window.dispatchEvent(new CustomEvent('ytm-queue-track', { detail: value }));
          setTimeout(broadcastP2PState, 150);
          setTimeout(broadcastP2PState, 500);
          setTimeout(broadcastP2PState, 1200);
        }
        break;
      }
    }
  }

  const LIKE_SELECTORS = [
    '#like-button-renderer #button-shape-like.like button',
    'ytmusic-player-bar #like-button-renderer #button-shape-like button',
    'ytmusic-player-bar #button-shape-like button',
    'ytmusic-like-button-renderer #button-shape-like button',
    '#button-shape-like > button',
    'ytmusic-like-button-renderer[like-status] button[aria-label*="Like" i]',
    'ytmusic-like-button-renderer[like-status] button[aria-label*="J\'aime" i]'
  ];

  const DISLIKE_SELECTORS = [
    '#like-button-renderer #button-shape-dislike.dislike button',
    'ytmusic-player-bar #like-button-renderer #button-shape-dislike button',
    'ytmusic-player-bar #button-shape-dislike button',
    'ytmusic-like-button-renderer #button-shape-dislike button',
    '#button-shape-dislike > button',
    'ytmusic-like-button-renderer[like-status] button[aria-label*="Dislike" i]',
    'ytmusic-like-button-renderer[like-status] button[aria-label*="Je n\'aime pas" i]'
  ];

  function readToggleStates() {
    const out = { liked: false, disliked: false, shuffled: false, repeatMode: 0 };
    const likeBtn = document.querySelector(LIKE_SELECTORS.join(', '));
    if (likeBtn && likeBtn.getAttribute('aria-pressed') === 'true') out.liked = true;

    const dislikeBtn = document.querySelector(DISLIKE_SELECTORS.join(', '));
    if (dislikeBtn && dislikeBtn.getAttribute('aria-pressed') === 'true') out.disliked = true;

    const likeRenderer = document.querySelector('#like-button-renderer[like-status], ytmusic-like-button-renderer[like-status]');
    if (likeRenderer) {
      const status = likeRenderer.getAttribute('like-status');
      if (status === 'LIKE') out.liked = true;
      else if (status === 'DISLIKE') out.disliked = true;
    }

    const shuffleBtn = document.querySelector('tp-yt-paper-icon-button.shuffle.ytmusic-player-bar, .shuffle.ytmusic-player-bar');
    if (shuffleBtn && (shuffleBtn.getAttribute('aria-pressed') === 'true' || shuffleBtn.hasAttribute('active'))) {
      out.shuffled = true;
    }

    // Source fiable et indépendante de la langue : l'attribut repeat-mode de la barre de lecture
    const barRepeatMode = document.querySelector('ytmusic-player-bar')?.getAttribute('repeat-mode');
    const REPEAT_MODES = { NONE: 0, ALL: 1, ONE: 2 };
    const repeatBtn = barRepeatMode in REPEAT_MODES ? null : document.querySelector('tp-yt-paper-icon-button.repeat.ytmusic-player-bar, .repeat.ytmusic-player-bar, ytmusic-player-bar tp-yt-paper-icon-button[aria-label*="repeat" i], ytmusic-player-bar tp-yt-paper-icon-button[aria-label*="répét" i]');
    if (barRepeatMode in REPEAT_MODES) {
      out.repeatMode = REPEAT_MODES[barRepeatMode];
    } else if (repeatBtn) {
      const aria = (repeatBtn.getAttribute('aria-label') || '').toLowerCase();
      const title = (repeatBtn.getAttribute('title') || '').toLowerCase();
      const iconAttr = (repeatBtn.getAttribute('icon') || '').toLowerCase();
      const inner = repeatBtn.innerHTML.toLowerCase();
      const ironIcon = repeatBtn.querySelector('yt-icon, iron-icon');
      const ironIconAttr = (ironIcon ? ironIcon.getAttribute('icon') || '' : '').toLowerCase();

      const ariaPressed = repeatBtn.getAttribute('aria-pressed');
      const hasActiveAttr = repeatBtn.hasAttribute('active');
      const isActive = hasActiveAttr || ariaPressed === 'true';

      const isOff = (!isActive) || ariaPressed === 'false' || aria.includes('activer') || aria.includes('enable');

      if (isOff) {
        out.repeatMode = 0; // 0. Pas de répétition
      } else {
        // En mode 2 (Répéter le titre), l'action suivante est "Désactiver la répétition" / "Repeat off",
        // OU l'icône est explicitement repeat-one / repeat_one
        const isRepeatOne = (
          iconAttr.includes('repeat-one') ||
          iconAttr.includes('repeat_one') ||
          ironIconAttr.includes('repeat-one') ||
          ironIconAttr.includes('repeat_one') ||
          inner.includes('repeat-one') ||
          inner.includes('repeat_one') ||
          aria.includes('désactiv') ||
          aria.includes('desactiv') ||
          aria.includes('disable') ||
          aria.includes('repeat off') ||
          aria.includes('turn off') ||
          title.includes('désactiv') ||
          title.includes('desactiv') ||
          title.includes('disable') ||
          title.includes('repeat off')
        );

        if (isRepeatOne) {
          out.repeatMode = 2; // 2. Répétition du titre (1)
        } else {
          out.repeatMode = 1; // 1. Répétition de la playlist
        }
      }
    }
    return out;
  }

  function readTrackMeta() {
    // 1. Priorité aux métadonnées forcées récentes lors du lancement d'un titre depuis la télécommande
    if (currentTrackOverride && (Date.now() - currentTrackOverride.timestamp < 10000) && currentTrackOverride.title) {
      return { title: currentTrackOverride.title, artist: currentTrackOverride.artist || '' };
    }

    // 2. Attributs synchronisés depuis movie_player.getVideoData() (temps réel natif)
    const syncTitle = document.documentElement.getAttribute('data-ytm-current-title');
    const syncArtist = document.documentElement.getAttribute('data-ytm-current-artist');
    if (syncTitle) {
      return { title: syncTitle, artist: syncArtist || '' };
    }

    // 3. MediaSession API native
    if (navigator.mediaSession?.metadata?.title) {
      return {
        title: navigator.mediaSession.metadata.title,
        artist: navigator.mediaSession.metadata.artist || ''
      };
    }

    // 4. ytmusic-player-bar DOM
    const playerBar = document.querySelector('ytmusic-player-bar');
    let title = '', artist = '';
    if (playerBar) {
      const titleEl = playerBar.querySelector('.title.ytmusic-player-bar, .title');
      const artistEl = playerBar.querySelector('.subtitle.ytmusic-player-bar yt-formatted-string, .byline.ytmusic-player-bar, .subtitle yt-formatted-string');
      if (titleEl) title = titleEl.textContent.trim();
      if (artistEl) artist = artistEl.textContent.trim();
    }
    return { title, artist };
  }

  const queueThumbCache = new Map();

  function extractQueueThumbnail(el, title, artist) {
    // 1. Attribut directement extrait par le bridge MAIN-world
    const directThumb = el.getAttribute('data-extracted-thumb');
    if (directThumb && directThumb.startsWith('http')) {
      return directThumb;
    }

    const directVideoId = el.getAttribute('data-video-id');
    if (directVideoId) {
      const ytThumb = `https://i.ytimg.com/vi/${directVideoId}/mqdefault.jpg`;
      return ytThumb;
    }

    // 2. Image native si déjà chargée dans le DOM
    let thumb = '';
    const imgEl = el.querySelector('img');
    if (imgEl) {
      thumb = imgEl.currentSrc || imgEl.src || imgEl.getAttribute('src') || imgEl.getAttribute('data-src') || '';
      if (thumb.startsWith('//')) thumb = 'https:' + thumb;
      if (thumb.startsWith('data:image') || thumb.includes('transparent')) thumb = '';
    }

    if (!thumb) {
      const shadow = el.querySelector('yt-img-shadow');
      if (shadow) {
        thumb = shadow.getAttribute('src') || shadow.getAttribute('data-src') || '';
        if (thumb.startsWith('//')) thumb = 'https:' + thumb;
        if (thumb.startsWith('data:image') || thumb.includes('transparent')) thumb = '';
      }
    }

    // 3. Extraction du videoId depuis les liens ou data-video-id
    let videoId = '';
    const linkEl = el.querySelector('a[href*="watch?v="], a[href*="watch\\?v="]') || el.querySelector('a[href*="v="]');
    if (linkEl && linkEl.href) {
      const m = linkEl.href.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
      if (m) videoId = m[1];
    }
    if (!videoId) {
      const anyWithHref = el.querySelector('[href*="v="], [data-video-id]');
      if (anyWithHref) {
        const href = anyWithHref.getAttribute('href') || anyWithHref.getAttribute('data-video-id') || '';
        const m = href.match(/(?:[?&]v=|^)([a-zA-Z0-9_-]{11})/);
        if (m) videoId = m[1];
      }
    }

    const key = (title || '') + '|' + (artist || '');
    if (thumb && thumb.startsWith('http')) {
      if (videoId) queueThumbCache.set(videoId, thumb);
      if (key !== '|') queueThumbCache.set(key, thumb);
      return thumb;
    }

    if (videoId && queueThumbCache.has(videoId)) {
      return queueThumbCache.get(videoId);
    }
    if (key !== '|' && queueThumbCache.has(key)) {
      return queueThumbCache.get(key);
    }

    if (videoId) {
      const ytThumb = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
      queueThumbCache.set(videoId, ytThumb);
      return ytThumb;
    }

    return '';
  }

  function mergeQueuedIntoList(baseList) {
    if (!Array.isArray(baseList) || baseList.length === 0) {
      if (queuedNextTracks.length > 0) {
        return queuedNextTracks.map((it, idx) => ({ ...it, index: idx, isCurrent: false }));
      }
      return [];
    }
    if (queuedNextTracks.length === 0) return baseList;

    const existingVideoIds = new Set(baseList.map(it => it.videoId).filter(Boolean));
    const pendingToInsert = queuedNextTracks.filter(it => !existingVideoIds.has(it.videoId));
    if (pendingToInsert.length === 0) return baseList;

    let curIdx = baseList.findIndex(it => it.isCurrent);
    const insertIdx = (curIdx !== -1) ? curIdx + 1 : baseList.length;

    const result = baseList.map(it => ({ ...it }));
    const itemsToInsert = pendingToInsert.map(it => ({
      videoId: it.videoId,
      title: it.title || 'Titre',
      artist: it.artist || '',
      duration: it.duration || '',
      thumbnail: it.thumbnail || `https://i.ytimg.com/vi/${it.videoId}/mqdefault.jpg`,
      isCurrent: false,
      isQueuedNext: true
    }));

    result.splice(insertIdx, 0, ...itemsToInsert);
    result.forEach((item, idx) => { item.index = idx; });
    return result;
  }

  function readUpcomingQueue() {
    // 1. Priorité aux données synchronisées en mémoire depuis queue-bridge.js
    if (Array.isArray(latestSyncedQueue) && latestSyncedQueue.length > 0) {
      const listCopy = latestSyncedQueue.map(item => ({ ...item }));
      const domItems = Array.from(document.querySelectorAll('ytmusic-player-queue-item'));
      let selectedIdx = domItems.findIndex(el => el.hasAttribute('selected') || el.classList.contains('selected') || el.getAttribute('play-button-state') === 'playing');

      if (selectedIdx === -1) {
        const currentTitle = readTrackMeta().title;
        if (currentTitle) {
          selectedIdx = listCopy.findIndex(item => item.title && item.title.toLowerCase() === currentTitle.toLowerCase());
        }
      }

      if (selectedIdx !== -1) {
        listCopy.forEach((it, idx) => {
          it.isCurrent = (idx === selectedIdx);
        });
      }
      return mergeQueuedIntoList(listCopy);
    }

    // 2. Fallback lecture du DOM
    const queueItems = Array.from(document.querySelectorAll('ytmusic-player-queue-item'));
    if (queueItems.length > 0) {
      let currentIndex = queueItems.findIndex(el => el.hasAttribute('selected') || el.classList.contains('selected'));
      if (currentIndex === -1) currentIndex = 0;

      const list = [];
      queueItems.forEach((el, idx) => {
        const titleEl = el.querySelector('.song-title, .title, yt-formatted-string.title');
        const bylineEl = el.querySelector('.byline, .author, yt-formatted-string.byline');
        const durEl = el.querySelector('.duration, .time-info');

        const title = titleEl ? titleEl.textContent.trim() : '';
        const artist = bylineEl ? bylineEl.textContent.trim() : '';
        const duration = durEl ? durEl.textContent.trim() : '';
        const thumbnail = extractQueueThumbnail(el, title, artist);

        if (title) {
          list.push({
            index: idx,
            title,
            artist,
            duration,
            thumbnail,
            isCurrent: idx === currentIndex
          });
        }
      });
      return mergeQueuedIntoList(list);
    }

    const playlistItems = Array.from(document.querySelectorAll('ytmusic-responsive-list-item-renderer'));
    if (playlistItems.length > 0) {
      const list = [];
      playlistItems.forEach((el, idx) => {
        const titleEl = el.querySelector('.title-column .title, .title yt-formatted-string');
        const bylineEl = el.querySelector('.secondary-flex-columns yt-formatted-string, .byline yt-formatted-string');
        const durEl = el.querySelector('.fixed-columns .duration, yt-formatted-string.duration');

        const title = titleEl ? titleEl.textContent.trim() : '';
        const artist = bylineEl ? bylineEl.textContent.trim() : '';
        const duration = durEl ? durEl.textContent.trim() : '';
        const thumbnail = extractQueueThumbnail(el, title, artist);
        const isCurrent = el.hasAttribute('play-button-state') && el.getAttribute('play-button-state') === 'playing';

        if (title) {
          list.push({
            index: idx,
            title,
            artist,
            duration,
            thumbnail,
            isCurrent: !!isCurrent
          });
        }
      });
      return mergeQueuedIntoList(list);
    }

    return mergeQueuedIntoList([]);
  }

  function getTrackInfo() {
    const video = document.querySelector('video');
    const { title, artist } = readTrackMeta();

    let albumArt = '';
    if (currentTrackOverride && (Date.now() - currentTrackOverride.timestamp < 10000) && currentTrackOverride.thumbnail) {
      albumArt = currentTrackOverride.thumbnail;
    }
    if (!albumArt && navigator.mediaSession?.metadata?.artwork?.length) {
      const artworks = navigator.mediaSession.metadata.artwork;
      albumArt = artworks[artworks.length - 1].src;
    }
    if (!albumArt) {
      const albumArtImg = document.querySelector('#song-image img') || document.querySelector('.image.ytmusic-player-bar img');
      albumArt = albumArtImg ? safeHttpsUrl(albumArtImg.src) : '';
    }
    const currentVideoId = document.documentElement.getAttribute('data-ytm-current-videoid');
    albumArt = bigArt(albumArt, VIDEO_ID_RE.test(currentVideoId || '') ? currentVideoId : '');

    const duration = video ? video.duration || 0 : 0;
    const currentTime = video ? video.currentTime || 0 : 0;
    const volume = video ? Math.round(video.volume * 100) : 100;
    const muted = video ? video.muted : false;
    const isPlaying = video ? !video.paused : false;
    const progress = duration ? (currentTime / duration) * 100 : 0;
    const playbackRate = video ? video.playbackRate : 1;
    const inPip = (video && document.pictureInPictureElement === video) || (activePipWindow && !activePipWindow.closed);

    return {
      title,
      artist,
      albumArt,
      duration,
      currentTime,
      progress,
      volume,
      muted,
      isPlaying,
      playbackRate,
      inPip: !!inPip,
      queue: readUpcomingQueue().map(it => ({ ...it, thumbnail: smallArt(it.thumbnail) })),
      ...readToggleStates()
    };
  }

  // ==========================================
  // Télécommande Universelle WebRTC P2P (Room ID)
  // ==========================================
  // ID de salle : 96 bits aléatoires cryptographiques (l'ancien format Math.random était devinable)
  function newRoomId() {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    return 'ytm-' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }
  let ytmRoomId = sessionStorage.getItem('ytmp_p2p_room');
  if (!ytmRoomId || !/^ytm-[a-f0-9]{24}$/.test(ytmRoomId)) {
    ytmRoomId = newRoomId();
    sessionStorage.setItem('ytmp_p2p_room', ytmRoomId);
  }
  function remoteUrl() {
    return 'https://nael-basset.github.io/ytm-remote/#' + ytmRoomId;
  }

  const PHONE_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M17 1.01L7 1c-1.1 0-2 .9-2 2v18c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V3c0-1.1-.9-1.99-2-1.99zM17 19H7V5h10v14z"/></svg>';

  // Copie le lien de la télécommande depuis le document du bouton (page ou fenêtre PiP)
  async function copyRemoteLink(btn) {
    const doc = btn.ownerDocument;
    const label = btn.textContent;
    let ok = false;
    try {
      await doc.defaultView.navigator.clipboard.writeText(remoteUrl());
      ok = true;
    } catch (e) {
      const ta = doc.createElement('textarea');
      ta.value = remoteUrl();
      ta.style.cssText = 'position: fixed; opacity: 0;';
      doc.body.appendChild(ta);
      ta.select();
      try { ok = doc.execCommand('copy'); } catch (err) {}
      ta.remove();
    }
    btn.textContent = ok ? 'Lien copié ✓' : 'Copie impossible';
    setTimeout(() => { btn.textContent = label; }, 1600);
  }

  // QR code généré localement (qrcode.min.js est chargé comme content script) :
  // l'URL contient l'ID de salle et ne doit jamais partir chez un service tiers.
  function renderQrCode(container, text, size) {
    container.textContent = '';
    if (typeof QRCode !== 'function') {
      container.textContent = 'QR code indisponible : ouvrez le lien ci-dessous.';
      return;
    }
    try {
      new QRCode(container, {
        text,
        width: size,
        height: size,
        colorDark: '#000000',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M
      });
    } catch (e) {
      container.textContent = 'QR code indisponible : ouvrez le lien ci-dessous.';
    }
  }

  // ==========================================
  // 3. Document Picture-in-Picture (ALWAYS ON TOP)
  // ==========================================
  let activePipWindow = null;
  let pipSyncTimer = null;
  let pipLyricsLines = [];
  let pipLastTrackKey = '';
  let pipVideoOriginalParent = null;

  async function toggleDocumentPip() {
    if (activePipWindow && !activePipWindow.closed) {
      activePipWindow.close();
      activePipWindow = null;
      return;
    }

    if (!('documentPictureInPicture' in window)) {
      toggleVideoPip();
      return;
    }

    try {
      // Ouverture de la fenêtre PiP Always-on-Top native de Chrome (sans bouton retour pour un rendu épuré)
      const pipWindow = await window.documentPictureInPicture.requestWindow({
        width: 280,
        height: 340,
        disallowReturnToOpener: true
      });

      activePipWindow = pipWindow;
      setupPipWindow(pipWindow);
      updatePipButtonState(true);

      pipWindow.addEventListener('pagehide', () => {
        if (pipSyncTimer) {
          clearInterval(pipSyncTimer);
          pipSyncTimer = null;
        }
        activePipWindow = null;
        updatePipButtonState(false);
      });
    } catch (err) {
      console.warn('Document PiP requestWindow failed, falling back to Video PiP:', err);
      toggleVideoPip();
    }
  }

  let audioPipCanvas = null;
  let audioPipVideo = null;

  async function toggleVideoPip() {
    const video = document.querySelector('video');
    if (!video || !document.pictureInPictureEnabled) {
      toggleDocumentPip();
      return;
    }

    if (document.pictureInPictureElement) {
      try {
        await document.exitPictureInPicture();
      } catch (e) {}
      return;
    }

    video.disablePictureInPicture = false;

    // Si c'est un clip vidéo réel avec image
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      try {
        await video.requestPictureInPicture();
        return;
      } catch (err) {
        console.warn('Native Video PiP failed, trying canvas fallback:', err);
      }
    }

    // Fallback pour pistes audio d'album (videoWidth === 0 provoque DOMException sur Chrome)
    try {
      const info = getTrackInfo();
      if (!audioPipCanvas) {
        audioPipCanvas = document.createElement('canvas');
        audioPipCanvas.width = 640;
        audioPipCanvas.height = 360;
      }
      const ctx = audioPipCanvas.getContext('2d');
      ctx.fillStyle = '#0a0a0f';
      ctx.fillRect(0, 0, 640, 360);

      const albumImg = document.querySelector('#song-image img, .image.ytmusic-player-bar img');
      if (albumImg && albumImg.complete && albumImg.naturalWidth > 0) {
        try {
          ctx.drawImage(albumImg, (640 - 240) / 2, 25, 240, 240);
        } catch (e) {
          ctx.fillStyle = '#222';
          ctx.fillRect((640 - 240) / 2, 25, 240, 240);
        }
      }

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 20px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(info.title || 'YouTube Music', 320, 295);

      ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.font = '15px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif';
      ctx.fillText(info.artist || '', 320, 325);

      if (!audioPipVideo) {
        audioPipVideo = document.createElement('video');
        audioPipVideo.muted = true;
        audioPipVideo.playsInline = true;
        audioPipVideo.style.position = 'fixed';
        audioPipVideo.style.top = '-9999px';
        audioPipVideo.style.left = '-9999px';
        audioPipVideo.style.width = '1px';
        audioPipVideo.style.height = '1px';
        document.body.appendChild(audioPipVideo);
      }

      const stream = audioPipCanvas.captureStream(2);
      audioPipVideo.srcObject = stream;
      await audioPipVideo.play();
      await audioPipVideo.requestPictureInPicture();
    } catch (fallbackErr) {
      console.warn('Video PiP fallback failed, switching to Document PiP:', fallbackErr);
      toggleDocumentPip();
    }
  }

  // Constantes SVG pour les 3 états de Repeat de YouTube Music
  const REPEAT_OFF_SVG = '<path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/>';
  const REPEAT_PLAYLIST_SVG = '<path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/><circle cx="12" cy="12" r="2.2" fill="currentColor"/>';
  const REPEAT_ONE_SVG = '<path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/><text x="12" y="15" text-anchor="middle" font-size="8.5" font-weight="900" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif" fill="currentColor">1</text>';

  function setupPipWindow(pipWin) {
    const doc = pipWin.document;

    // Feuille de style du PiP
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = browser.runtime.getURL('pip.css');
    doc.head.appendChild(link);

    doc.title = 'YouTube Music';

    // HTML épuré : Panneau lecteur à gauche + Panneau paroles à droite
    doc.body.innerHTML = `
      <div class="pip-app" id="pip-app">
        <div class="bg-ambient" id="pip-bg-ambient"></div>
        <div class="bg-overlay"></div>

        <!-- Panneau Lecteur -->
        <main class="player-pane">
          <!-- Actions discrètes : QR Code Télécommande + Mode Micro + PiP Vidéo + Paroles -->
          <div class="header-discreet-actions">
            <button id="pip-qr-toggle" class="discreet-btn" title="Télécommande smartphone (QR Code)">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
                <path d="M17 1.01L7 1c-1.1 0-2 .9-2 2v18c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V3c0-1.1-.9-1.99-2-1.99zM17 19H7V5h10v14z"/>
              </svg>
            </button>
            <button id="pip-compact-toggle" class="discreet-btn" title="Mode Micro / Gaming (Ultra-compact)">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
                <path d="M4 19h16v2H4zM4 3h16v2H4zm4 8h8v2H8z"/>
              </svg>
            </button>
            <button id="pip-to-video-btn" class="discreet-btn" title="Passer en PiP Vidéo (100% sans bandeau)">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
                <path d="M19 11h-8v6h8v-6zm4 8V4.98C23 3.88 22.1 3 21 3H3c-1.1 0-2 .88-2 1.98V19c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2zm-2 .02H3V4.97h18v14.05z"/>
              </svg>
            </button>
            <button id="pip-lyrics-toggle" class="discreet-btn" title="Paroles (Lyrics)">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
                <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
              </svg>
            </button>
          </div>

          <!-- Pochette d'album -->
          <div class="album-art-wrap" id="pip-art-wrap">
            <img class="album-art-img" id="pip-album-art" src="${browser.runtime.getURL('icons/icon128.png')}" alt="">
          </div>

          <!-- Titre & Artiste -->
          <div class="track-info">
            <div class="track-title" id="pip-title">Track Title</div>
            <div class="track-artist" id="pip-artist">Artist</div>
          </div>

          <!-- Barre de progression -->
          <div class="progress-container">
            <div class="time-row">
              <span id="pip-current-time">0:00</span>
              <span id="pip-total-time">0:00</span>
            </div>
            <div class="progress-bar-wrap">
              <div class="progress-track">
                <div class="progress-fill" id="pip-progress-fill"></div>
              </div>
              <input type="range" class="progress-slider" id="pip-seek" min="0" max="1000" value="0">
            </div>
          </div>

          <!-- Commandes de lecture principales -->
          <div class="controls-main">
            <button id="pip-prev" class="ctrl-btn" title="Précédent">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
                <path d="M6 6h2v12H6zM9.5 12l8.5 6V6z"/>
              </svg>
            </button>
            <button id="pip-rewind" class="ctrl-btn" title="Recul 10s">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                <path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/>
                <text x="12" y="16" text-anchor="middle" font-size="7" font-weight="700" fill="currentColor">10</text>
              </svg>
            </button>
            <button id="pip-play-pause" class="ctrl-btn-hero" title="Lecture / Pause">
              <svg id="pip-play-icon" viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
                <path d="M8 5v14l11-7z"/>
              </svg>
            </button>
            <button id="pip-forward" class="ctrl-btn" title="Avance 10s">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                <path d="M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z"/>
                <text x="12" y="16" text-anchor="middle" font-size="7" font-weight="700" fill="currentColor">10</text>
              </svg>
            </button>
            <button id="pip-next" class="ctrl-btn" title="Suivant">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
                <path d="M6 18l8.5-6L6 6v12zM16 6h2v12h-2z"/>
              </svg>
            </button>
          </div>

          <!-- Commandes secondaires (Like, Dislike, Shuffle, Repeat) -->
          <div class="controls-secondary">
            <button id="pip-dislike" class="tgl-btn" title="Je n'aime pas">
              <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor">
                <path d="M15 3H6c-.83 0-1.54.5-1.84 1.22l-3.02 7.05c-.09.23-.14.47-.14.73v2c0 1.1.9 2 2 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L9.83 23l6.59-6.59c.36-.36.58-.86.58-1.41V5c0-1.1-.9-2-2-2zM21 3v12h-4V3h4z"/>
              </svg>
            </button>
            <button id="pip-like" class="tgl-btn" title="J'aime">
              <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor">
                <path d="M9 21h10c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2zM1 9h4v12H1V9z"/>
              </svg>
            </button>
            <button id="pip-shuffle" class="tgl-btn" title="Aléatoire">
              <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor">
                <path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/>
              </svg>
            </button>
            <button id="pip-repeat" class="tgl-btn" title="Répéter">
              <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor">
                ${REPEAT_OFF_SVG}
              </svg>
            </button>
          </div>

          <!-- Ligne volume & vitesse -->
          <div class="extra-row">
            <div class="volume-wrap">
              <button id="pip-mute" class="icon-btn" title="Muet">
                <svg id="pip-volume-icon" viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
                  <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 00-2.5-4.03v8.05A4.5 4.5 0 0016.5 12zM14 3.23v2.06a7 7 0 010 13.42v2.06A9 9 0 0014 3.23z"/>
                </svg>
              </button>
              <input type="range" class="volume-slider" id="pip-volume" min="0" max="100" value="100">
            </div>
            <select class="speed-select" id="pip-speed" title="Vitesse">
              <option value="0.75">0.75×</option>
              <option value="1" selected>1×</option>
              <option value="1.25">1.25×</option>
              <option value="1.5">1.5×</option>
            </select>
          </div>
        </main>

        <!-- Panneau des Paroles à Droite (masqué par défaut) -->
        <aside class="lyrics-pane closed" id="pip-lyrics-pane">
          <div class="lyrics-pane-header">
            <span>Paroles</span>
            <button class="lyrics-close-btn" id="pip-lyrics-close" title="Masquer">✕</button>
          </div>
          <div class="lyrics-scroll-body" id="pip-lyrics-scroll">
            <div id="pip-lyrics-content"></div>
            <div class="lyrics-status" id="pip-lyrics-status">Chargement des paroles…</div>
          </div>
        </aside>

        <!-- Modal Télécommande Smartphone QR Code -->
        <div class="qr-modal closed" id="pip-qr-modal">
          <div class="qr-modal-card">
            <div class="qr-modal-header">
              <span class="qr-title">${PHONE_ICON} Télécommande smartphone</span>
              <button class="qr-close-btn" id="pip-qr-close" title="Fermer">✕</button>
            </div>
            <div class="qr-code-box" id="pip-qr-box">
              <div id="pip-qr-container"></div>
            </div>
            <div class="qr-hint">Scannez ce QR Code avec votre téléphone. Chaque nouvel appareil doit être autorisé sur le PC.</div>
            <button class="qr-copy-btn" id="pip-qr-copy">Copier le lien</button>
          </div>
        </div>
      </div>
    `;

    const pel = {
      app: doc.getElementById('pip-app'),
      artWrap: doc.getElementById('pip-art-wrap'),
      bgAmbient: doc.getElementById('pip-bg-ambient'),
      albumArt: doc.getElementById('pip-album-art'),
      title: doc.getElementById('pip-title'),
      artist: doc.getElementById('pip-artist'),
      currentTime: doc.getElementById('pip-current-time'),
      totalTime: doc.getElementById('pip-total-time'),
      seek: doc.getElementById('pip-seek'),
      progressFill: doc.getElementById('pip-progress-fill'),
      prev: doc.getElementById('pip-prev'),
      rewind: doc.getElementById('pip-rewind'),
      playPause: doc.getElementById('pip-play-pause'),
      playIcon: doc.getElementById('pip-play-icon'),
      forward: doc.getElementById('pip-forward'),
      next: doc.getElementById('pip-next'),
      like: doc.getElementById('pip-like'),
      dislike: doc.getElementById('pip-dislike'),
      shuffle: doc.getElementById('pip-shuffle'),
      repeat: doc.getElementById('pip-repeat'),
      mute: doc.getElementById('pip-mute'),
      volume: doc.getElementById('pip-volume'),
      volumeIcon: doc.getElementById('pip-volume-icon'),
      speed: doc.getElementById('pip-speed'),
      compactToggle: doc.getElementById('pip-compact-toggle'),
      toVideoBtn: doc.getElementById('pip-to-video-btn'),
      lyricsToggle: doc.getElementById('pip-lyrics-toggle'),
      lyricsPane: doc.getElementById('pip-lyrics-pane'),
      lyricsClose: doc.getElementById('pip-lyrics-close'),
      lyricsScroll: doc.getElementById('pip-lyrics-scroll'),
      lyricsContent: doc.getElementById('pip-lyrics-content'),
      lyricsStatus: doc.getElementById('pip-lyrics-status'),
      qrToggle: doc.getElementById('pip-qr-toggle'),
      qrModal: doc.getElementById('pip-qr-modal'),
      qrClose: doc.getElementById('pip-qr-close'),
      qrContainer: doc.getElementById('pip-qr-container'),
      qrCopy: doc.getElementById('pip-qr-copy')
    };

    let userSeeking = false;

    // Attachement des écouteurs de transport
    pel.playPause.addEventListener('click', () => callPlayerAction('play-pause'));
    pel.prev.addEventListener('click', () => callPlayerAction('prev'));
    pel.next.addEventListener('click', () => callPlayerAction('next'));
    pel.rewind.addEventListener('click', () => callPlayerAction('seek-relative', -10));
    pel.forward.addEventListener('click', () => callPlayerAction('seek-relative', 10));
    pel.like.addEventListener('click', () => callPlayerAction('like'));
    pel.dislike.addEventListener('click', () => callPlayerAction('dislike'));
    pel.shuffle.addEventListener('click', () => callPlayerAction('toggle-shuffle'));
    let currentRepeatMode = 0;
    function renderRepeatBtn(mode) {
      currentRepeatMode = mode;
      if (mode === 2) {
        pel.repeat.innerHTML = `<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor">${REPEAT_ONE_SVG}</svg>`;
        pel.repeat.className = 'tgl-btn active repeat-track';
        pel.repeat.title = 'Répéter le titre en cours (1)';
      } else if (mode === 1) {
        pel.repeat.innerHTML = `<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor">${REPEAT_PLAYLIST_SVG}</svg>`;
        pel.repeat.className = 'tgl-btn active repeat-playlist';
        pel.repeat.title = 'Répéter la playlist (Tout)';
      } else {
        pel.repeat.innerHTML = `<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor">${REPEAT_OFF_SVG}</svg>`;
        pel.repeat.className = 'tgl-btn';
        pel.repeat.title = 'Répétition désactivée';
      }
    }

    pel.repeat.addEventListener('click', () => {
      callPlayerAction('toggle-repeat');
      const nextMode = (currentRepeatMode + 1) % 3;
      renderRepeatBtn(nextMode);
    });
    pel.mute.addEventListener('click', () => callPlayerAction('mute-toggle'));

    pel.seek.addEventListener('input', () => {
      userSeeking = true;
      const pct = pel.seek.value / 10;
      pel.progressFill.style.width = `${pct}%`;
    });

    pel.seek.addEventListener('change', () => {
      callPlayerAction('seek', pel.seek.value / 10);
      userSeeking = false;
    });

    pel.volume.addEventListener('input', () => {
      callPlayerAction('volume', parseInt(pel.volume.value, 10));
    });

    pel.speed.addEventListener('change', () => {
      callPlayerAction('set-rate', parseFloat(pel.speed.value));
    });

    // Bascule Mode Micro / Gaming (Ultra-compact)
    let isGamingMini = false;
    if (pel.compactToggle) {
      pel.compactToggle.addEventListener('click', () => {
        isGamingMini = !isGamingMini;
        pel.compactToggle.classList.toggle('active', isGamingMini);
        try {
          if (isGamingMini) {
            pipWin.resizeTo(260, 75);
          } else {
            pipWin.resizeTo(280, 340);
          }
        } catch (e) {}
      });
    }

    // Bascule rapide vers le PiP Vidéo pur (100% sans bandeau)
    if (pel.toVideoBtn) {
      pel.toVideoBtn.addEventListener('click', () => {
        pipWin.close();
        toggleVideoPip();
      });
    }

    // Basculement fluide du panneau des paroles (Zéro flicker de la barre OS)
    pel.lyricsToggle.addEventListener('click', () => {
      const isClosed = pel.lyricsPane.classList.toggle('closed');
      pel.lyricsToggle.classList.toggle('active', !isClosed);
      if (!isClosed && pipLyricsLines.length === 0) {
        loadPipLyrics(getTrackInfo(), pel);
      }
    });

    pel.lyricsClose.addEventListener('click', () => {
      pel.lyricsPane.classList.add('closed');
      pel.lyricsToggle.classList.remove('active');
    });

    // Gestion de la Télécommande Smartphone (QR Code)
    function showQrModal() {
      renderQrCode(pel.qrContainer, remoteUrl(), 140);
      pel.qrModal.classList.remove('closed');
    }

    if (pel.qrToggle) {
      pel.qrToggle.addEventListener('click', () => {
        if (pel.qrModal.classList.contains('closed')) {
          showQrModal();
        } else {
          pel.qrModal.classList.add('closed');
        }
      });
    }

    pel.qrCopy.addEventListener('click', () => copyRemoteLink(pel.qrCopy));

    if (pel.qrClose) {
      pel.qrClose.addEventListener('click', () => {
        pel.qrModal.classList.add('closed');
      });
    }

    // Raccourcis clavier directement dans la fenêtre PiP
    doc.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.code === 'Space') {
        e.preventDefault();
        callPlayerAction('play-pause');
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        callPlayerAction('seek-relative', 5);
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        callPlayerAction('seek-relative', -5);
      } else if (e.code === 'ArrowUp') {
        e.preventDefault();
        const video = document.querySelector('video');
        if (video) callPlayerAction('volume', Math.min(100, Math.round(video.volume * 100 + 5)));
      } else if (e.code === 'ArrowDown') {
        e.preventDefault();
        const video = document.querySelector('video');
        if (video) callPlayerAction('volume', Math.max(0, Math.round(video.volume * 100 - 5)));
      }
    });

    // Formatage du temps
    function formatTime(s) {
      if (!isFinite(s) || s < 0) return '0:00';
      const m = Math.floor(s / 60);
      const sec = Math.floor(s % 60).toString().padStart(2, '0');
      return `${m}:${sec}`;
    }

    // Boucle de synchronisation temps réel
    function syncPip() {
      if (!activePipWindow || activePipWindow.closed) return;
      const info = getTrackInfo();

      pel.title.textContent = info.title || 'YouTube Music';
      pel.artist.textContent = info.artist || '';

      const art = safeHttpsUrl(info.albumArt);
      if (art && pel.albumArt.src !== art) {
        pel.albumArt.src = art;
        pel.bgAmbient.style.backgroundImage = `url("${art}")`;
        pel.artWrap.style.setProperty('--art', `url("${art}")`);
      }

      pel.totalTime.textContent = formatTime(info.duration);
      if (!userSeeking) {
        pel.currentTime.textContent = formatTime(info.currentTime);
        pel.progressFill.style.width = `${info.progress}%`;
        pel.seek.value = Math.round(info.progress * 10);
      }

      pel.volume.value = info.volume;
      pel.volumeIcon.innerHTML = (info.muted || info.volume === 0)
        ? '<path d="M16.5 12A4.5 4.5 0 0014 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0a6.97 6.97 0 01-1.01 3.62l1.46 1.46A8.94 8.94 0 0021 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.17v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>'
        : '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 00-2.5-4.03v8.05A4.5 4.5 0 0016.5 12zM14 3.23v2.06a7 7 0 010 13.42v2.06A9 9 0 0014 3.23z"/>';

      pel.playIcon.innerHTML = info.isPlaying
        ? '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>'
        : '<path d="M8 5v14l11-7z"/>';

      pel.like.classList.toggle('active', !!info.liked);
      pel.dislike.classList.toggle('active', !!info.disliked);
      pel.shuffle.classList.toggle('active', !!info.shuffled);

      // Synchronisation du mode Repeat
      if (typeof info.repeatMode === 'number') {
        renderRepeatBtn(info.repeatMode);
      }

      // Paroles synchronisées
      if (!pel.lyricsPane.classList.contains('closed') && pipLyricsLines.length > 0) {
        updatePipActiveLyric(info.currentTime, pel);
      }

      const key = `${info.title}|${info.artist}`;
      if (key !== pipLastTrackKey) {
        pipLastTrackKey = key;
        if (!pel.lyricsPane.classList.contains('closed')) {
          loadPipLyrics(info, pel);
        } else {
          pipLyricsLines = [];
        }
      }

      // Verrouillage anti-défilement racine (empêche le clipping haut et la barre basse)
      if (doc.documentElement.scrollTop !== 0) doc.documentElement.scrollTop = 0;
      if (doc.body.scrollTop !== 0) doc.body.scrollTop = 0;
      if (pel.app && pel.app.scrollTop !== 0) pel.app.scrollTop = 0;
    }

    syncPip();
    pipSyncTimer = setInterval(syncPip, 250);
  }

  // Chargement des paroles lrclib
  async function loadPipLyrics(info, pel) {
    if (!info.title) {
      pel.lyricsStatus.textContent = 'Aucun titre en cours de lecture.';
      pel.lyricsStatus.hidden = false;
      pel.lyricsContent.innerHTML = '';
      return;
    }

    pel.lyricsStatus.textContent = 'Chargement des paroles…';
    pel.lyricsStatus.hidden = false;
    pel.lyricsContent.innerHTML = '';
    pipLyricsLines = [];

    const rawT = (info.title || '').replace(/\s*[\(\[][^\)\]]*(official|clip|video|audio|remaster|visualizer|live|prod\.|feat\.?|ft\.?)[^\)\]]*[\)\]]/gi, '').trim();
    const rawA = (info.artist || '').split(/\s*[•·]\s*/)[0].replace(/\s*[\(\[]?\s*(feat\.?|ft\.?)\b[^\)\]]*[\)\]]?/gi, '').trim();

    let cleanTitle = rawT;
    let cleanArtist = rawA;
    if (rawT.includes(' - ')) {
      const parts = rawT.split(' - ');
      if (parts.length === 2) {
        if (!rawA || rawA.toLowerCase() === parts[0].trim().toLowerCase() || parts[0].trim().toLowerCase().includes(rawA.toLowerCase())) {
          cleanArtist = parts[0].trim();
          cleanTitle = parts[1].trim();
        }
      }
    }

    try {
      let data = null;
      // 1. Essai avec durée exacte
      try {
        let res = await fetch(`https://lrclib.net/api/get?track_name=${encodeURIComponent(cleanTitle)}&artist_name=${encodeURIComponent(cleanArtist)}&duration=${Math.round(info.duration || 0)}`);
        if (res.ok) data = await res.json();
      } catch (e) {}

      // 2. Essai sans contrainte de durée
      if (!data || !data.syncedLyrics) {
        try {
          let res2 = await fetch(`https://lrclib.net/api/get?track_name=${encodeURIComponent(cleanTitle)}&artist_name=${encodeURIComponent(cleanArtist)}`);
          if (res2.ok) {
            const d2 = await res2.json();
            if (d2 && d2.syncedLyrics) data = d2;
          }
        } catch (e) {}
      }

      // 3. Recherche large et sélection du candidat avec les paroles synchronisées le plus proche de la durée réelle
      if (!data || !data.syncedLyrics) {
        try {
          let resSearch = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(cleanTitle + ' ' + cleanArtist)}`);
          if (resSearch.ok) {
            const list = await resSearch.json();
            if (Array.isArray(list) && list.length > 0) {
              const synced = list.filter(x => x && x.syncedLyrics);
              if (synced.length > 0) {
                synced.sort((a, b) => {
                  const diffA = Math.abs((a.duration || 0) - (info.duration || 0));
                  const diffB = Math.abs((b.duration || 0) - (info.duration || 0));
                  return diffA - diffB;
                });
                data = synced[0];
              } else if (!data) {
                data = list[0];
              }
            }
          }
        } catch (e) {}
      }

      // 4. Fallback si aucune parole : vérifier les paroles natives de YouTube Music sur la page
      if (!data || (!data.syncedLyrics && !data.plainLyrics)) {
        const ytmLyricsEl = document.querySelector('.description.ytmusic-description-shelf-renderer, ytmusic-lyrics-shelf-renderer .lyrics');
        if (ytmLyricsEl && ytmLyricsEl.textContent.trim()) {
          data = { plainLyrics: ytmLyricsEl.textContent.trim() };
        }
      }

      if (data && data.syncedLyrics) {
        pipLyricsLines = parseLrc(data.syncedLyrics);
      } else if (data && data.plainLyrics) {
        pipLyricsLines = data.plainLyrics.split('\n').map((text, i) => ({ time: -1 - i, text: text.trim() }));
      }

      if (pipLyricsLines.length === 0) {
        pel.lyricsStatus.textContent = 'Aucune parole trouvée pour ce titre.';
        pel.lyricsStatus.hidden = false;
      } else {
        pel.lyricsStatus.hidden = true;
        preparePipLyricsWords();
        renderPipLyrics(pel);
      }
    } catch (e) {
      pel.lyricsStatus.textContent = 'Impossible de charger les paroles.';
      pel.lyricsStatus.hidden = false;
    }
  }

  function parseLrc(lrc) {
    const out = [];
    let offsetSec = 0;
    const offsetMatch = lrc.match(/\[offset:\s*([+-]?\d+)\s*\]/i);
    if (offsetMatch) {
      offsetSec = parseInt(offsetMatch[1], 10) / 1000;
    }

    for (const raw of lrc.split('\n')) {
      const line = raw.trim();
      let work = line;
      const stamps = [];
      let m;
      while ((m = work.match(/^\[(\d+):(\d+)(?:[.:](\d+))?\]/))) {
        const mm = parseInt(m[1], 10);
        const ss = parseInt(m[2], 10);
        const ff = m[3] ? parseInt(m[3].padEnd(3, '0').slice(0, 3), 10) / 1000 : 0;
        stamps.push(mm * 60 + ss + ff + offsetSec);
        work = work.slice(m[0].length);
      }
      const text = work.trim();
      for (const t of stamps) out.push({ time: Math.max(0, t), text });
    }
    out.sort((a, b) => a.time - b.time);
    return out;
  }

  function preparePipLyricsWords() {
    for (let i = 0; i < pipLyricsLines.length; i++) {
      const item = pipLyricsLines[i];
      if (item.time < 0) {
        item.words = [{ text: item.text || '♪', start: -1, end: -1 }];
        continue;
      }

      let nextTime = (i + 1 < pipLyricsLines.length && pipLyricsLines[i + 1].time > item.time)
        ? pipLyricsLines[i + 1].time
        : item.time + 3.8;

      const rawDur = nextTime - item.time;
      const wordsRaw = (item.text || '♪').trim().split(/\s+/).filter(Boolean);
      const wordsList = wordsRaw.length ? wordsRaw : ['♪'];

      let effectiveDur = rawDur <= 5.5
        ? Math.max(0.8, rawDur - 0.12)
        : Math.min(rawDur - 0.4, Math.max(1.8, wordsList.length * 0.45));

      const weights = wordsList.map(w => Math.max(1, w.replace(/[^\p{L}\p{N}]/gu, '').length));
      const totalWeight = weights.reduce((acc, w) => acc + w, 0) || 1;

      let curWordStart = item.time;
      item.words = wordsList.map((word, wIdx) => {
        const wDur = (weights[wIdx] / totalWeight) * effectiveDur;
        const wStart = curWordStart;
        const wEnd = curWordStart + wDur;
        curWordStart = wEnd;
        return { text: word, start: wStart, end: wEnd };
      });
      item.endTime = item.time + effectiveDur;
    }
  }

  function renderPipLyrics(pel) {
    pel.lyricsContent.innerHTML = '';
    pipActiveLyricIdx = -1;

    pipLyricsLines.forEach((item, idx) => {
      const div = document.createElement('div');
      div.className = 'lyric-line';
      div.dataset.idx = idx;

      if (Array.isArray(item.words) && item.words.length > 0) {
        item.words.forEach((wObj, wIdx) => {
          const span = document.createElement('span');
          span.className = 'lyric-word future';
          span.dataset.wordIdx = wIdx;
          span.textContent = wObj.text;
          div.appendChild(span);
          if (wIdx < item.words.length - 1) {
            div.appendChild(document.createTextNode(' '));
          }
        });
      } else {
        div.textContent = item.text || '♪';
      }

      if (item.time >= 0) {
        div.addEventListener('click', () => callPlayerAction('seek-absolute', item.time));
      }
      pel.lyricsContent.appendChild(div);
    });
  }

  let pipActiveLyricIdx = -1;
  function updatePipActiveLyric(currentTime, pel) {
    let idx = -1;
    for (let i = 0; i < pipLyricsLines.length; i++) {
      if (pipLyricsLines[i].time >= 0 && pipLyricsLines[i].time <= currentTime + 0.15) {
        idx = i;
      } else if (pipLyricsLines[i].time > currentTime + 0.15) {
        break;
      }
    }

    const all = pel.lyricsContent.children;

    if (idx !== pipActiveLyricIdx) {
      pipActiveLyricIdx = idx;
      for (let i = 0; i < all.length; i++) {
        const isAct = (i === idx);
        const isPast = (idx >= 0 && i < idx);
        all[i].classList.toggle('active', isAct);
        all[i].classList.toggle('past-line', isPast);

        if (!isAct) {
          const spans = all[i].querySelectorAll('.lyric-word');
          for (const sp of spans) {
            sp.className = isPast ? 'lyric-word past' : 'lyric-word future';
            sp.style.removeProperty('--prog');
          }
        }
      }

      if (idx >= 0 && all[idx]) {
        const activeEl = all[idx];
        const scrollContainer = pel.lyricsScroll;
        if (scrollContainer) {
          const scrollRect = scrollContainer.getBoundingClientRect();
          const lineRect = activeEl.getBoundingClientRect();
          const offset = (lineRect.top - scrollRect.top) - (scrollRect.height / 2) + (lineRect.height / 2);
          scrollContainer.scrollBy({
            top: offset,
            behavior: 'smooth'
          });
        }
      }
    }

    // Animation progressive mot par mot sur la ligne active
    if (idx >= 0 && all[idx] && pipLyricsLines[idx] && pipLyricsLines[idx].words) {
      const lineItem = pipLyricsLines[idx];
      const lineEl = all[idx];
      const spans = lineEl.querySelectorAll('.lyric-word');

      for (let wIdx = 0; wIdx < lineItem.words.length; wIdx++) {
        const wObj = lineItem.words[wIdx];
        const span = spans[wIdx];
        if (!span) continue;

        if (currentTime >= wObj.end) {
          if (!span.classList.contains('past') || span.classList.contains('singing')) {
            span.className = 'lyric-word past';
            span.style.removeProperty('--prog');
          }
        } else if (currentTime < wObj.start) {
          if (!span.classList.contains('future')) {
            span.className = 'lyric-word future';
            span.style.removeProperty('--prog');
          }
        } else {
          span.className = 'lyric-word singing';
          const wordDur = Math.max(0.05, wObj.end - wObj.start);
          const p = Math.max(0, Math.min(1, (currentTime - wObj.start) / wordDur));
          span.style.setProperty('--prog', (p * 100).toFixed(1) + '%');
        }
      }
    }
  }

  // ==========================================
  // 4. Injection du Bouton PiP dans YouTube Music
  // ==========================================
  let pageQrModal = null;
  const BTN_STYLE = 'background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.15); color: #fff; font-size: 11.5px; padding: 6px 10px; border-radius: 8px; cursor: pointer;';

  function closePageQrModal() {
    pageQrModal?.remove();
    pageQrModal = null;
  }

  function refreshPageQrModal() {
    if (!pageQrModal) return;
    const targetUrl = remoteUrl();
    renderQrCode(pageQrModal.querySelector('#ytmp-page-qr-box'), targetUrl, 160);

    const list = pageQrModal.querySelector('#ytmp-page-devices');
    list.textContent = '';
    const approved = [...p2pClientInfo.entries()].filter(([, info]) => info.approved);
    if (approved.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color: rgba(255,255,255,0.5); font-size: 11.5px;';
      empty.textContent = 'Aucun appareil connecté';
      list.appendChild(empty);
    }
    for (const [conn, info] of approved) {
      const row = document.createElement('div');
      row.style.cssText = 'display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 12px; padding: 4px 0;';
      const name = document.createElement('span');
      name.style.cssText = 'display: flex; align-items: center; gap: 8px;';
      const dot = document.createElement('span');
      dot.style.cssText = 'width: 7px; height: 7px; border-radius: 50%; background: #00e676; box-shadow: 0 0 6px #00e676; flex-shrink: 0;';
      name.append(dot, info.name);
      const kick = document.createElement('button');
      kick.style.cssText = BTN_STYLE;
      kick.textContent = 'Déconnecter';
      kick.addEventListener('click', () => revokeClient(conn));
      row.append(name, kick);
      list.appendChild(row);
    }
  }

  function togglePageQrModal() {
    if (pageQrModal) {
      closePageQrModal();
      return;
    }

    pageQrModal = document.createElement('div');
    pageQrModal.id = 'ytmp-page-qr-modal';
    pageQrModal.style.cssText = 'position: fixed; inset: 0; z-index: 999999; background: rgba(10, 10, 14, 0.85); backdrop-filter: blur(20px); display: flex; align-items: center; justify-content: center;';
    // Gabarit statique uniquement : toutes les données dynamiques passent par textContent
    pageQrModal.innerHTML = `
      <div style="background: rgba(22, 24, 30, 0.98); border: 1px solid rgba(255,255,255,0.15); border-radius: 16px; padding: 22px; width: 320px; text-align: center; box-shadow: 0 16px 48px rgba(0,0,0,0.9); font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif; color: #fff;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px;">
          <span style="font-size: 14px; font-weight: 700; display:flex; align-items:center; gap:8px;">${PHONE_ICON} Télécommande smartphone</span>
          <button id="ytmp-page-qr-close" style="background: rgba(255,255,255,0.1); border: none; color: #fff; width: 26px; height: 26px; border-radius: 50%; cursor: pointer; font-size: 13px;">✕</button>
        </div>
        <div id="ytmp-page-qr-box" style="background: #fff; padding: 12px; border-radius: 12px; display: inline-block; box-shadow: 0 4px 12px rgba(0,0,0,0.2); color: #000; font-size: 11px;"></div>
        <div style="font-size: 11.5px; color: rgba(255,255,255,0.65); margin-top: 12px; line-height: 1.45;">Scannez ce QR Code avec votre téléphone. Chaque nouvel appareil doit être autorisé ici, sur le PC.</div>
        <button id="ytmp-page-copy-link" style="${BTN_STYLE} margin-top: 10px;">Copier le lien</button>
        <div style="text-align: left; margin-top: 14px; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 10px;">
          <div style="font-size: 11px; font-weight: 700; color: rgba(255,255,255,0.6); margin-bottom: 6px;">APPAREILS CONNECTÉS</div>
          <div id="ytmp-page-devices"></div>
        </div>
        <div style="display: flex; gap: 8px; justify-content: center; margin-top: 12px; flex-wrap: wrap;">
          <button id="ytmp-page-new-link" style="${BTN_STYLE}">Nouveau lien</button>
          <button id="ytmp-page-forget" style="${BTN_STYLE}">Oublier les appareils</button>
        </div>
      </div>
    `;

    document.body.appendChild(pageQrModal);
    pageQrModal.querySelector('#ytmp-page-qr-close').addEventListener('click', closePageQrModal);
    const copyBtn = pageQrModal.querySelector('#ytmp-page-copy-link');
    copyBtn.addEventListener('click', () => copyRemoteLink(copyBtn));
    pageQrModal.querySelector('#ytmp-page-new-link').addEventListener('click', () => regenerateRoom());
    pageQrModal.querySelector('#ytmp-page-forget').addEventListener('click', async () => {
      await browser.storage.local.remove(TRUSTED_KEY);
      regenerateRoom();
    });
    pageQrModal.addEventListener('click', (e) => {
      if (e.target === pageQrModal) closePageQrModal();
    });
    refreshPageQrModal();
  }

  function injectPipButton() {
    if (document.getElementById('ytmp-pip-button')) return;

    const rightControls = document.querySelector('ytmusic-player-bar .right-controls-buttons, #right-controls-buttons');
    if (!rightControls) {
      setTimeout(injectPipButton, 1000);
      return;
    }

    const pipBtn = document.createElement('button');
    pipBtn.id = 'ytmp-pip-button';
    pipBtn.className = 'ytmp-pip-button';
    pipBtn.setAttribute('title', 'Mini-Player PiP Always on Top (Clic droit ou Shift+Clic : PiP Vidéo 100% sans bandeau)');
    pipBtn.setAttribute('aria-label', 'Picture in Picture');
    pipBtn.innerHTML = `
      <svg viewBox="0 0 24 24">
        <path d="M19 11h-8v6h8v-6zm4 8V4.98C23 3.88 22.1 3 21 3H3c-1.1 0-2 .88-2 1.98V19c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2zm-2 .02H3V4.97h18v14.05z"/>
      </svg>
    `;

    pipBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.shiftKey) {
        toggleVideoPip();
      } else {
        toggleDocumentPip();
      }
    });

    pipBtn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleVideoPip();
    });

    // Bouton Télécommande QR Code directement dans la barre YouTube Music
    const qrPageBtn = document.createElement('button');
    qrPageBtn.id = 'ytmp-qr-page-btn';
    qrPageBtn.className = 'ytmp-pip-button';
    qrPageBtn.setAttribute('title', 'Télécommande smartphone (QR Code)');
    qrPageBtn.setAttribute('aria-label', 'QR Code Télécommande smartphone');
    qrPageBtn.innerHTML = `
      <svg viewBox="0 0 24 24" width="20" height="20">
        <path d="M17 1.01L7 1c-1.1 0-2 .9-2 2v18c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V3c0-1.1-.9-1.99-2-1.99zM17 19H7V5h10v14z"/>
      </svg>
    `;
    qrPageBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePageQrModal();
    });

    rightControls.prepend(pipBtn);
    rightControls.prepend(qrPageBtn);
  }

  function updatePipButtonState(isOpen) {
    const btn = document.getElementById('ytmp-pip-button');
    if (btn) btn.classList.toggle('active', isOpen);
  }

  injectPipButton();

  // Enregistrement MediaSession pour auto-PiP de Chrome
  if ('mediaSession' in navigator && 'setActionHandler' in navigator.mediaSession) {
    try {
      navigator.mediaSession.setActionHandler('enterpictureinpicture', () => {
        toggleDocumentPip();
      });
    } catch (e) {}
  }

  // ==========================================
  // 5. Notifications au Changement de Piste
  // ==========================================
  let lastNotifiedKey = '';
  let pendingKey = '';
  let pendingSince = 0;

  function checkForNewTrack() {
    const trackInfo = getTrackInfo();
    if (!trackInfo.title) return;

    const key = `${trackInfo.title} - ${trackInfo.artist}`;
    if (key === lastNotifiedKey) {
      pendingKey = '';
      return;
    }

    const now = Date.now();
    if (key !== pendingKey) {
      pendingKey = key;
      pendingSince = now;
      return;
    }

    if (now - pendingSince < 1200) return;

    lastNotifiedKey = key;
    pendingKey = '';

    browser.runtime.sendMessage({
      action: 'show-notification',
      title: trackInfo.title,
      message: trackInfo.artist,
      iconUrl: trackInfo.albumArt || undefined
    }).catch(() => {});
  }

  setInterval(checkForNewTrack, 800);

  // ==========================================
  // Recherche Native YouTube Music
  // ==========================================
  async function searchYouTubeMusic(query) {
    try {
      const postData = {
        context: {
          client: {
            clientName: 'WEB_REMIX',
            clientVersion: '1.20240101.01.00',
            hl: navigator.language || 'fr',
            gl: 'FR'
          }
        },
        query: query
      };

      const res = await fetch('https://music.youtube.com/youtubei/v1/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(postData)
      });

      if (!res.ok) {
        console.warn('[YTM Search] HTTP error:', res.status);
        return [];
      }

      const data = await res.json();

      function findRenderers(node) {
        if (!node || typeof node !== 'object') return [];
        let list = [];
        if (node.musicResponsiveListItemRenderer) {
          list.push(node.musicResponsiveListItemRenderer);
        }
        for (const k of Object.keys(node)) {
          list = list.concat(findRenderers(node[k]));
        }
        return list;
      }

      function parseItem(r) {
        try {
          let videoId = r.playlistItemData?.videoId ||
                        r.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId ||
                        r.navigationEndpoint?.watchEndpoint?.videoId || '';

          if (!videoId) {
            const s = JSON.stringify(r);
            const m = s.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
            if (m) videoId = m[1];
          }

          if (!videoId) return null;

          let title = '';
          const flexCols = r.flexColumns || [];
          if (flexCols.length > 0) {
            const runs = flexCols[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
            title = runs.map(x => x.text || '').join('');
          }

          let artist = '';
          let duration = '';
          if (flexCols.length > 1) {
            const runs = flexCols[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
            const texts = runs.map(x => (x.text || '').trim()).filter(x => x && x !== '•' && x !== '·');
            for (const t of texts) {
              if (/^\d+:\d+$/.test(t)) {
                duration = t;
              } else if (t.toLowerCase() !== 'titre' && t.toLowerCase() !== 'morceau' && t.toLowerCase() !== 'song') {
                artist = artist ? artist + ', ' + t : t;
              }
            }
          }

          const thumbs = r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
          let thumbnail = thumbs.length > 0 ? thumbs[thumbs.length - 1].url : '';
          if (thumbnail.startsWith('//')) thumbnail = 'https:' + thumbnail;
          thumbnail = smallArt(thumbnail) || `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;

          if (title && videoId) {
            return {
              title,
              artist: artist || query,
              duration,
              videoId,
              thumbnail
            };
          }
        } catch (e) {}
        return null;
      }

      const raw = findRenderers(data);
      const seen = new Set();
      const results = [];

      for (const it of raw) {
        const parsed = parseItem(it);
        if (parsed && !seen.has(parsed.videoId)) {
          seen.add(parsed.videoId);
          results.push(parsed);
          if (results.length >= 25) break;
        }
      }

      return results;
    } catch (err) {
      console.warn('[YTM Search] Erreur globale recherche:', err);
      return [];
    }
  }

  // ==========================================
  // 5b. Télécommande Universelle WebRTC P2P (Plug & Play, Zéro Python)
  // ==========================================
  let peerHost = null;
  // Connexions dont l'appareil a été autorisé : seules elles reçoivent l'état et peuvent agir
  const connectedP2PClients = new Set();
  // Toutes les connexions ouvertes : conn -> { name, deviceHash, approved, helloReceived }
  const p2pClientInfo = new Map();
  const TRUSTED_KEY = 'trustedRemoteDevices';
  const MAX_PENDING = 3;

  async function sha256Hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
  }

  async function getTrustedDevices() {
    const data = await browser.storage.local.get(TRUSTED_KEY);
    return data[TRUSTED_KEY] || {};
  }

  // Envoi unique en texte JSON sur le RTCDataChannel natif (voir le commentaire du patch TextDecoder)
  function sendTo(conn, obj) {
    const dc = conn.dataChannel;
    if (dc && dc.readyState === 'open') {
      try { dc.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
    }
    return false;
  }

  function dropClient(conn) {
    connectedP2PClients.delete(conn);
    p2pClientInfo.delete(conn);
    refreshPageQrModal();
  }

  function approveClient(conn) {
    const info = p2pClientInfo.get(conn);
    if (!info) return;
    info.approved = true;
    connectedP2PClients.add(conn);
    sendTo(conn, { type: 'auth', status: 'approved' });
    sendTo(conn, { type: 'state', data: getTrackInfo() });
    refreshPageQrModal();
  }

  function denyClient(conn, status = 'denied') {
    sendTo(conn, { type: 'auth', status });
    // Laisser le temps au message de partir avant de fermer
    setTimeout(() => { try { conn.close(); } catch (e) {} }, 300);
    dropClient(conn);
  }

  // Déconnecte un appareil et l'oublie : il devra être réautorisé
  async function revokeClient(conn) {
    const info = p2pClientInfo.get(conn);
    if (info?.deviceHash) {
      const trusted = await getTrustedDevices();
      delete trusted[info.deviceHash];
      await browser.storage.local.set({ [TRUSTED_KEY]: trusted });
    }
    denyClient(conn, 'revoked');
  }

  // Nouveau lien : ferme toutes les connexions et change d'ID de salle
  function regenerateRoom() {
    for (const conn of [...p2pClientInfo.keys()]) denyClient(conn, 'revoked');
    ytmRoomId = newRoomId();
    sessionStorage.setItem('ytmp_p2p_room', ytmRoomId);
    const old = peerHost;
    peerHost = null;
    try { old?.destroy(); } catch (e) {}
    initWebRTCHost();
    refreshPageQrModal();
  }

  // Demande d'autorisation affichée sur la page YouTube Music (et dans le PiP s'il est ouvert)
  function askApproval(deviceName) {
    return new Promise((resolve) => {
      const toasts = [];
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        toasts.forEach(t => t.remove());
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), 60000);

      const docs = [document];
      if (activePipWindow && !activePipWindow.closed) docs.push(activePipWindow.document);
      for (const doc of docs) {
        const toast = doc.createElement('div');
        toast.style.cssText = 'position: fixed; right: 16px; bottom: 96px; z-index: 1000000; width: 260px; background: rgba(22,24,30,0.98); border: 1px solid rgba(255,255,255,0.2); border-radius: 12px; padding: 14px; color: #fff; font: 13px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif; box-shadow: 0 12px 36px rgba(0,0,0,0.8);';
        const title = doc.createElement('div');
        title.style.cssText = 'font-weight: 700; margin-bottom: 6px; display: flex; align-items: center; gap: 8px;';
        title.innerHTML = PHONE_ICON; // icône statique
        title.append('Nouvelle télécommande');
        const msg = doc.createElement('div');
        msg.style.cssText = 'color: rgba(255,255,255,0.75); margin-bottom: 10px; line-height: 1.4;';
        msg.textContent = `« ${deviceName} » veut contrôler YouTube Music. Autoriser cet appareil ?`;
        const row = doc.createElement('div');
        row.style.cssText = 'display: flex; gap: 8px; justify-content: flex-end;';
        const no = doc.createElement('button');
        no.style.cssText = BTN_STYLE;
        no.textContent = 'Refuser';
        no.addEventListener('click', () => finish(false));
        const yes = doc.createElement('button');
        yes.style.cssText = BTN_STYLE + ' background: #ff0055; border-color: #ff0055; font-weight: 700;';
        yes.textContent = 'Autoriser';
        yes.addEventListener('click', () => finish(true));
        row.append(no, yes);
        toast.append(title, msg, row);
        doc.body.appendChild(toast);
        toasts.push(toast);
      }

      browser.runtime.sendMessage({
        action: 'show-notification',
        title: 'Nouvelle télécommande',
        message: `« ${deviceName} » demande l'accès. Validez dans l'onglet YouTube Music.`
      }).catch(() => {});
    });
  }

  async function handleHello(conn, payload) {
    const info = p2pClientInfo.get(conn);
    if (!info || info.helloReceived) return;
    info.helloReceived = true;
    clearTimeout(info.helloTimer);

    if (typeof payload.deviceId !== 'string' || !/^[a-f0-9]{32}$/.test(payload.deviceId)) {
      denyClient(conn);
      return;
    }
    info.name = cleanText(payload.deviceName, 40) || 'Appareil inconnu';
    info.deviceHash = await sha256Hex(payload.deviceId);

    const trusted = await getTrustedDevices();
    if (trusted[info.deviceHash]) {
      approveClient(conn);
      return;
    }

    const pending = [...p2pClientInfo.values()].filter(i => i.awaitingApproval).length;
    if (pending >= MAX_PENDING) {
      denyClient(conn);
      return;
    }
    info.awaitingApproval = true;
    sendTo(conn, { type: 'auth', status: 'pending' });
    const ok = await askApproval(info.name);
    info.awaitingApproval = false;
    if (!p2pClientInfo.has(conn)) return; // fermé entre-temps
    if (!ok) {
      denyClient(conn);
      return;
    }
    trusted[info.deviceHash] = { name: info.name, addedAt: Date.now() };
    await browser.storage.local.set({ [TRUSTED_KEY]: trusted });
    approveClient(conn);
  }

  function initWebRTCHost() {
    if (peerHost && !peerHost.destroyed) return;
    try {
      const PeerClass = window.Peer || (window.peerjs && window.peerjs.Peer);
      if (!PeerClass) {
        setTimeout(initWebRTCHost, 1000);
        return;
      }

      const host = new PeerClass(ytmRoomId, {
        debug: 0,
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
          ]
        }
      });
      peerHost = host;

      host.on('connection', (conn) => {
        try { conn.serialization = 'json'; } catch (e) {}
        const info = { name: 'Appareil inconnu', deviceHash: '', approved: false, helloReceived: false, awaitingApproval: false };
        p2pClientInfo.set(conn, info);

        async function processIncomingPayload(raw) {
          if (!raw) return;
          let payload = raw;
          if (typeof payload === 'string') {
            try { payload = JSON.parse(payload); } catch (e) { return; }
          }
          if (typeof payload !== 'object' || !payload) return;

          if (payload.type === 'hello') {
            handleHello(conn, payload);
            return;
          }
          // Rien n'est accepté tant que l'appareil n'a pas été autorisé sur le PC
          if (!info.approved) return;

          if (payload.action === 'search') {
            const query = cleanText(payload.query || payload.value, 150).trim();
            const reqId = cleanText(payload.requestId, 64);
            const results = query ? await searchYouTubeMusic(query).catch(() => []) : [];
            sendTo(conn, { type: 'search-results', requestId: reqId, query, results });
            return;
          }

          const cmd = sanitizeRemoteCommand(payload.action, payload.value);
          if (!cmd) return;
          try {
            callPlayerAction(cmd.action, cmd.value);
            sendTo(conn, { type: 'diag-log', message: `Action "${cmd.action}" exécutée` });
          } catch (err) {
            sendTo(conn, { type: 'diag-log', message: `Action "${cmd.action}" : erreur` });
          }
          setTimeout(broadcastP2PState, 60);
        }

        // Écoute unique sur le DataChannel natif (pas de handler conn.on('data'),
        // sinon chaque message serait traité deux fois).
        function bindNativeChannel(dc) {
          if (!dc || dc._ytmBound) return;
          dc._ytmBound = true;
          try { dc.binaryType = 'arraybuffer'; } catch (e) {}

          dc.addEventListener('message', async (evt) => {
            let data = evt.data;
            if (data instanceof Blob) {
              try { data = await data.text(); } catch (e) {}
            } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
              try { data = new TextDecoder().decode(data); } catch (e) {}
            }
            processIncomingPayload(data);
          });
        }

        if (conn.dataChannel) bindNativeChannel(conn.dataChannel);

        conn.on('open', () => {
          if (conn.dataChannel) bindNativeChannel(conn.dataChannel);
          // Sans « hello » valide sous 10 s, la connexion est fermée
          info.helloTimer = setTimeout(() => {
            if (!info.helloReceived) denyClient(conn);
          }, 10000);
        });

        conn.on('close', () => dropClient(conn));
        conn.on('error', () => dropClient(conn));
      });

      host.on('error', (err) => {
        if (peerHost !== host) return;
        if (err && err.type === 'unavailable-id') {
          ytmRoomId = newRoomId();
          sessionStorage.setItem('ytmp_p2p_room', ytmRoomId);
          peerHost = null;
          try { host.destroy(); } catch (e) {}
          setTimeout(initWebRTCHost, 1000);
          refreshPageQrModal();
        } else if (host.disconnected && !host.destroyed) {
          host.reconnect();
        }
      });

      host.on('disconnected', () => {
        if (peerHost === host && !host.destroyed) {
          host.reconnect();
        }
      });
    } catch (e) {
      console.warn('[YTM Remote P2P] PeerJS init error:', e);
    }
  }

  let lastBroadcastTime = 0;
  function broadcastP2PState() {
    if (!connectedP2PClients.size) return;
    try {
      const payload = { type: 'state', data: getTrackInfo() };
      for (const client of connectedP2PClients) {
        if (!sendTo(client, payload) && !client.open) dropClient(client);
      }
    } catch (e) {}
  }

  // Événements multimédias pour diffuser instantanément les changements
  function attachVideoP2PListeners() {
    const video = document.querySelector('video');
    if (!video || video.dataset.p2pAttached) return;
    video.dataset.p2pAttached = 'true';

    ['play', 'pause', 'volumechange', 'ratechange', 'seeked'].forEach(evt => {
      video.addEventListener(evt, () => setTimeout(broadcastP2PState, 50));
    });

    video.addEventListener('ended', () => {
      setTimeout(broadcastP2PState, 200);
    });

    video.addEventListener('timeupdate', () => {
      const now = Date.now();
      if (now - lastBroadcastTime > 800) {
        lastBroadcastTime = now;
        broadcastP2PState();
      }
    });
  }

  setInterval(attachVideoP2PListeners, 1500);
  setInterval(broadcastP2PState, 1500);

  // Initialisation du serveur P2P
  setTimeout(initWebRTCHost, 500);



  // ==========================================
  // 6. Gestionnaire de Messages
  // ==========================================
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.action) {
      case 'get-track-info':
        sendResponse(getTrackInfo());
        break;
      case 'get-volume': {
        const video = document.querySelector('video');
        sendResponse(video ? Math.round(video.volume * 100) : 100);
        break;
      }
      case 'play-pause':
      case 'play':
      case 'pause':
      case 'next':
      case 'prev':
      case 'like':
      case 'dislike':
      case 'toggle-shuffle':
      case 'toggle-repeat':
      case 'mute-toggle':
        callPlayerAction(message.action);
        break;
      case 'seek':
        callPlayerAction('seek', message.value);
        break;
      case 'seek-relative':
        callPlayerAction('seek-relative', message.delta);
        break;
      case 'seek-absolute':
        callPlayerAction('seek-absolute', message.value);
        break;
      case 'volume':
        callPlayerAction('volume', message.value);
        break;
      case 'set-rate':
        callPlayerAction('set-rate', message.value);
        break;
      case 'pip':
      case 'open-doc-pip':
        toggleDocumentPip();
        break;
      case 'toggle-page-qr':
        togglePageQrModal();
        sendResponse({ ok: true });
        break;
      default:
        break;
    }
    // Toutes les réponses sont synchrones : on répond toujours (un 2e appel est ignoré) et on ne
    // garde pas le canal ouvert, sinon l'appelant reçoit « message channel closed ».
    try { sendResponse({ ok: true }); } catch (e) {}
    return false;
  });
})();
