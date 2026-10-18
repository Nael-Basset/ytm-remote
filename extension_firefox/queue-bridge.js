// queue-bridge.js - Pont d'accès au monde de la page YouTube Music (MAIN world)
// Permet d'extraire 100% des vignettes, métadonnées de la file d'attente et d'effectuer la recherche/ajout de morceaux
(function () {
  'use strict';

  // Présence du pont, lue par content-script.js avant de lui déléguer le contrôle du lecteur
  document.documentElement.setAttribute('data-ytm-bridge', '1');

  try {
    const oldTag = document.getElementById('ytm-queue-cache-data');
    if (oldTag) oldTag.remove();
  } catch (e) {}

  // URL https normalisée (guillemets percent-encodés) : sûre dans src= et dans url("…") CSS
  function safeHttpsUrl(u) {
    try {
      const url = new URL(String(u || ''));
      return url.protocol === 'https:' ? url.href.replace(/"/g, '%22') : '';
    } catch (e) {
      return '';
    }
  }

  function cleanUrl(url) {
    if (!url) return '';
    if (url.startsWith('//')) return 'https:' + url;
    return url;
  }

  function getThumbnailFromRenderer(r) {
    if (!r) return '';
    const thumbs = r.thumbnail?.thumbnails;
    if (Array.isArray(thumbs) && thumbs.length > 0) {
      for (let i = thumbs.length - 1; i >= 0; i--) {
        const u = cleanUrl(thumbs[i]?.url);
        if (u && !u.startsWith('data:image') && !u.includes('transparent')) {
          return u;
        }
      }
    }
    const videoId = r.videoId || r.navigationEndpoint?.watchEndpoint?.videoId;
    if (videoId) {
      return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
    }
    return '';
  }

  function getTitleFromRenderer(r) {
    if (!r) return '';
    if (typeof r.title === 'string') return r.title;
    if (r.title?.runs && Array.isArray(r.title.runs)) {
      return r.title.runs.map(run => run.text || '').join('');
    }
    return '';
  }

  function getArtistFromRenderer(r) {
    if (!r) return '';
    const byline = r.shortBylineText || r.longBylineText || r.bylineText;
    if (byline?.runs && Array.isArray(byline.runs)) {
      return byline.runs.map(run => run.text || '').join('');
    }
    return '';
  }

  function getDurationFromRenderer(r) {
    if (!r) return '';
    if (typeof r.lengthText === 'string') return r.lengthText;
    if (r.lengthText?.runs && Array.isArray(r.lengthText.runs)) {
      return r.lengthText.runs.map(run => run.text || '').join('');
    }
    return '';
  }

  // 1. Synchronisation des éléments individuels actuellement dans le DOM
  function syncDomQueueItems() {
    try {
      const domItems = document.querySelectorAll('ytmusic-player-queue-item');
      if (!domItems || domItems.length === 0) return;

      domItems.forEach((el) => {
        try {
          const d = el.data || el.__data?.data || el.__data || (el.querySelector('ytmusic-play-button-renderer') && el.querySelector('ytmusic-play-button-renderer').data);
          const r = d?.playlistPanelVideoRenderer || d;
          if (!r) return;

          const videoId = r.videoId || r.navigationEndpoint?.watchEndpoint?.videoId;
          const thumbUrl = getThumbnailFromRenderer(r);

          if (videoId && el.getAttribute('data-video-id') !== videoId) {
            el.setAttribute('data-video-id', videoId);
          }
          if (thumbUrl && el.getAttribute('data-extracted-thumb') !== thumbUrl) {
            el.setAttribute('data-extracted-thumb', thumbUrl);

            const img = el.querySelector('img');
            if (img && (!img.src || img.src.startsWith('data:image') || img.src.includes('transparent'))) {
              img.src = thumbUrl;
            }
          }
        } catch (itemErr) {}
      });
    } catch (e) {}
  }

  // 2. Synchronisation de la liste complète de la queue (modèle Polymer global)
  function syncGlobalQueue() {
    try {
      const queueEl = document.querySelector('ytmusic-player-queue');
      let rawItems = null;

      if (queueEl) {
        const queueData = queueEl.data || queueEl.queueData || queueEl.__data?.data || queueEl.__data?.queueData;
        rawItems = queueData?.items || queueData?.contents || queueEl.items || queueEl.__data?.items;
      }

      if (!rawItems || !Array.isArray(rawItems) || rawItems.length === 0) {
        const playerPage = document.querySelector('ytmusic-player-page');
        if (playerPage) {
          const pData = playerPage.data || playerPage.__data?.data;
          rawItems = pData?.items || pData?.contents;
        }
      }

      if (Array.isArray(rawItems) && rawItems.length > 0) {
        const fullList = [];
        rawItems.forEach((entry, idx) => {
          const r = entry?.playlistPanelVideoRenderer || entry;
          if (!r) return;
          const title = getTitleFromRenderer(r);
          const artist = getArtistFromRenderer(r);
          const duration = getDurationFromRenderer(r);
          const videoId = r.videoId || r.navigationEndpoint?.watchEndpoint?.videoId || '';
          const thumbnail = getThumbnailFromRenderer(r);
          const isCurrent = !!r.selected;

          if (title) {
            fullList.push({
              index: idx,
              title,
              artist,
              duration,
              thumbnail,
              videoId,
              isCurrent
            });
          }
        });

        if (fullList.length > 0) {
          window.dispatchEvent(new CustomEvent('ytm-queue-synced-data', {
            detail: fullList
          }));
        }
      }
    } catch (e) {}
  }

  function syncCurrentTrackData() {
    try {
      const mp = document.getElementById('movie_player');
      if (mp && typeof mp.getVideoData === 'function') {
        const data = mp.getVideoData();
        if (data && (data.title || data.video_id)) {
          const videoId = data.video_id || '';
          const title = data.title || '';
          const artist = data.author || '';
          // Les trois valeurs décrivent la même piste : on les écrit toujours ensemble, même vides,
          // sinon l'artiste du morceau précédent restait affiché (et faussait la recherche de paroles).
          // Exception : un titre momentanément vide pour la même vidéo (chargement) est ignoré.
          const root = document.documentElement;
          if (!title && videoId && videoId === root.getAttribute('data-ytm-current-videoid')) return;
          document.documentElement.setAttribute('data-ytm-current-title', title);
          document.documentElement.setAttribute('data-ytm-current-artist', artist);
          document.documentElement.setAttribute('data-ytm-current-videoid', videoId);
        }
      }
    } catch (e) {}
  }

  function runSync() {
    syncCurrentTrackData();
    syncDomQueueItems();
    syncGlobalQueue();
  }



  // Lecture via la navigation native de YouTube Music (événement yt-navigate), comme un clic
  // dans l'interface : URL, file, barre de lecture et lecteur restent cohérents. (L'ancienne
  // méthode loadVideoById changeait le son sans prévenir YouTube Music, qui affichait encore
  // l'ancien morceau ; app.navigate_ n'existe plus.)
  function navigateTo(endpoint) {
    const app = document.querySelector('ytmusic-app');
    if (!app) return false;
    app.dispatchEvent(new CustomEvent('yt-navigate', { bubbles: true, composed: true, detail: { endpoint } }));
    setTimeout(runSync, 300);
    setTimeout(runSync, 1000);
    return true;
  }

  const rendererOf = (it) => it?.playlistPanelVideoRenderer || it?.playlistPanelVideoWrapperRenderer?.primaryRenderer?.playlistPanelVideoRenderer;
  // File affichée = morceaux en file (items) suivis de la suite automatique (automixItems)
  function queueItems() {
    const queueEl = document.querySelector('ytmusic-player-queue#queue') || document.querySelector('ytmusic-player-queue');
    const q = queueEl?.queue?.store?.store?.getState?.()?.queue;
    return [...(q?.items || []), ...(q?.automixItems || [])];
  }

  // Nouveau morceau : YouTube Music lance la lecture et génère sa radio
  function playTrackNow(videoId) {
    if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId || '')) return;
    navigateTo({ watchEndpoint: { videoId } });
  }

  // Morceau déjà dans la file : on utilise son propre lien, pour rester dans la file actuelle
  function playQueueItem(index, videoId) {
    const items = queueItems();
    // L'identifiant de la vidéo prime : les index du mobile et du store peuvent différer
    let i = videoId ? items.findIndex(it => rendererOf(it)?.videoId === videoId) : -1;
    if (i < 0 && Number.isInteger(index)) i = index;
    const endpoint = rendererOf(items[i])?.navigationEndpoint;
    if (endpoint && navigateTo(endpoint)) return;
    const mp = document.getElementById('movie_player');
    if (Number.isInteger(index) && typeof mp?.playVideoAt === 'function') {
      mp.playVideoAt(index);
      runSync();
    } else if (videoId) {
      playTrackNow(videoId);
    }
  }

  window.addEventListener('ytm-play-track', (e) => {
    const raw = e.detail;
    playTrackNow(typeof raw === 'string' ? raw : raw?.videoId);
  });

  // Ajouter un morceau juste après le titre en cours, comme « Lire ensuite » de YouTube Music :
  // on demande à YouTube Music la vraie entrée de file (endpoint music/get_queue), puis on
  // l'ajoute via le store de la file. La file du PC, le lecteur et la barre de lecture restent
  // ainsi cohérents. (L'ancienne méthode modifiait les données Polymer à la main : le morceau
  // était joué mais n'apparaissait pas dans la file et la barre affichait le mauvais titre.)
  async function addToQueueNext(videoId) {
    const queueEl = document.querySelector('ytmusic-player-queue#queue') || document.querySelector('ytmusic-player-queue');
    const store = queueEl?.queue?.store?.store;
    const app = document.querySelector('ytmusic-app');
    if (!store || typeof queueEl.dispatch !== 'function' || typeof app?.networkManager?.fetch !== 'function') {
      throw new Error('API de file YouTube Music introuvable');
    }
    const state = store.getState().queue;
    const res = await app.networkManager.fetch('/music/get_queue', {
      queueContextParams: state.queueContextParams,
      queueInsertPosition: 'INSERT_AFTER_CURRENT_VIDEO',
      videoIds: [videoId]
    });
    const items = (res?.queueDatas || []).map(d => d.content).filter(Boolean);
    if (items.length === 0) throw new Error('Aucune entrée renvoyée pour ' + videoId);

    // État relu après l'appel réseau : la file a pu bouger entre-temps
    const fresh = store.getState().queue;
    const rendererOf = (it) => it?.playlistPanelVideoRenderer || it?.playlistPanelVideoWrapperRenderer?.primaryRenderer?.playlistPanelVideoRenderer;
    const current = fresh.items.findIndex(it => rendererOf(it)?.selected);
    queueEl.dispatch({
      type: 'ADD_ITEMS',
      payload: {
        nextQueueItemId: fresh.nextQueueItemId,
        index: current >= 0 ? current + 1 : fresh.items.length,
        items,
        shuffleEnabled: false,
        shouldAssignIds: true
      }
    });
  }

  window.addEventListener('ytm-queue-track', async (e) => {
    const trackData = typeof e.detail === 'object' ? e.detail : { videoId: e.detail };
    const videoId = trackData?.videoId;
    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) return;
    try {
      await addToQueueNext(videoId);
    } catch (err) {
      console.warn('[YTM Bridge] Ajout à la file impossible :', err);
    }
    runSync();
    setTimeout(runSync, 400);
  });

  // Paroles de YouTube Music (onglet « Paroles ») pour une vidéo donnée, via ses propres endpoints :
  // /next donne l'identifiant de l'onglet Paroles, /browse son contenu. Réponse renvoyée au
  // content script par l'événement ytm-native-lyrics-response.
  function findKey(node, key, out = []) {
    if (!node || typeof node !== 'object') return out;
    if (key in node) out.push(node[key]);
    for (const k of Object.keys(node)) findKey(node[k], key, out);
    return out;
  }

  async function fetchNativeLyrics(videoId) {
    const app = document.querySelector('ytmusic-app');
    if (typeof app?.networkManager?.fetch !== 'function') return '';
    const next = await app.networkManager.fetch('/next', { videoId });
    const browseId = findKey(next, 'browseEndpoint').map(e => e && e.browseId).find(id => /^MPLY/.test(id || ''));
    if (!browseId) return '';
    const page = await app.networkManager.fetch('/browse', { browseId });
    const shelf = findKey(page, 'musicDescriptionShelfRenderer')[0];
    return (shelf?.description?.runs || []).map(r => r.text || '').join('');
  }

  window.addEventListener('ytm-native-lyrics-request', async (e) => {
    let req = {};
    try { req = JSON.parse(e.detail); } catch (err) { return; }
    let text = '';
    if (/^[a-zA-Z0-9_-]{11}$/.test(req.videoId || '')) {
      try { text = await fetchNativeLyrics(req.videoId); } catch (err) {}
    }
    window.dispatchEvent(new CustomEvent('ytm-native-lyrics-response', { detail: JSON.stringify({ id: req.id, text }) }));
  });

  // Sauter à un élément de la file d'attente
  window.addEventListener('ytm-play-index', (e) => {
    const d = e.detail;
    if (typeof d === 'number') playQueueItem(d, '');
    else if (d && typeof d === 'object') playQueueItem(d.index, d.videoId);
  });

  // Contrôle direct du lecteur via movie_player (contourne les restrictions d'autoplay et de Shadow DOM de Firefox)
  window.addEventListener('ytm-player-control', (e) => {
    let detail = e.detail || {};
    if (typeof detail === 'string') {
      try { detail = JSON.parse(detail); } catch (err) {}
    }
    const action = (typeof detail === 'string') ? detail : detail?.action;
    const value = detail?.value;
    const mp = document.getElementById('movie_player');

    function clickFallback(selectors) {
      const list = Array.isArray(selectors) ? selectors : [selectors];
      for (const sel of list) {
        const el = document.querySelector(sel);
        if (el) {
          const btn = el.shadowRoot?.querySelector('button') || el.querySelector('button') || el;
          // Un seul clic (un MouseEvent en plus faisait basculer les boutons deux fois)
          try { btn.click(); } catch (err) {}
          return true;
        }
      }
      return false;
    }

    try {
      switch (action) {
        case 'play':
          if (mp && typeof mp.playVideo === 'function') mp.playVideo();
          else clickFallback(['#play-pause-button', '.play-pause-button']);
          break;
        case 'pause':
          if (mp && typeof mp.pauseVideo === 'function') mp.pauseVideo();
          else clickFallback(['#play-pause-button', '.play-pause-button']);
          break;
        case 'play-pause':
          if (mp && typeof mp.getPlayerState === 'function') {
            const state = mp.getPlayerState();
            if (state === 1 || state === 3) mp.pauseVideo();
            else mp.playVideo();
          } else {
            clickFallback(['#play-pause-button', '.play-pause-button']);
          }
          break;
        case 'next':
          if (mp && typeof mp.nextVideo === 'function') {
            mp.nextVideo();
          } else {
            clickFallback(['tp-yt-paper-icon-button.next-button', '.next-button', '#next-button']);
          }
          break;
        case 'prev':
          if (mp && typeof mp.previousVideo === 'function') {
            mp.previousVideo();
          } else {
            clickFallback(['tp-yt-paper-icon-button.previous-button', '.previous-button', '#previous-button']);
          }
          break;
        case 'seek':
          if (mp && typeof mp.seekTo === 'function') {
            const dur = mp.getDuration() || 0;
            if (dur > 0 && typeof value === 'number') {
              mp.seekTo((value / 100) * dur, true);
            }
          }
          break;
        case 'volume':
          if (mp && typeof mp.setVolume === 'function' && typeof value === 'number') {
            mp.setVolume(value);
            if (typeof mp.isMuted === 'function' && mp.isMuted() && value > 0) {
              mp.unMute();
            }
          }
          break;
        case 'mute-toggle':
          if (mp && typeof mp.isMuted === 'function') {
            if (mp.isMuted()) mp.unMute();
            else mp.mute();
          }
          break;
        case 'play-track': {
          const item = (typeof value === 'object' && value) ? value : { videoId: value };
          playTrackNow(item.videoId);
          break;
        }
        case 'play-queue-index': {
          const item = (typeof value === 'object' && value) ? value : { index: value };
          playQueueItem(item.index, item.videoId);
          break;
        }
      }
    } catch (err) {
      console.warn('[YTM Bridge] Erreur contrôle player:', err);
    }
  });

  // Exécution immédiate et périodique
  runSync();
  setInterval(runSync, 800);

  ['yt-action', 'yt-page-data-updated', 'yt-navigate-finish'].forEach((ev) => {
    document.addEventListener(ev, () => {
      setTimeout(runSync, 100);
      setTimeout(runSync, 500);
    });
  });

  // Synchronisation regroupée : au plus une passe toutes les 250 ms, quel que soit le nombre de
  // mutations (observer document.body déclenchait runSync à chaque changement du DOM).
  let syncScheduled = false;
  function scheduleSync() {
    if (syncScheduled) return;
    syncScheduled = true;
    setTimeout(() => {
      syncScheduled = false;
      runSync();
    }, 250);
  }

  const observer = new MutationObserver(scheduleSync);
  let observedQueue = null;
  function observeQueue() {
    const queueEl = document.querySelector('ytmusic-player-queue');
    if (queueEl && queueEl !== observedQueue) {
      observer.disconnect();
      observer.observe(queueEl, { childList: true, subtree: true });
      observedQueue = queueEl;
    }
  }
  observeQueue();
  // La file d'attente n'existe pas toujours au chargement : on la cherche jusqu'à la trouver
  if (!observedQueue) {
    const finder = setInterval(() => {
      observeQueue();
      if (observedQueue) clearInterval(finder);
    }, 1000);
  }
})();
