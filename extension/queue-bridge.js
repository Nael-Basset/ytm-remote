// queue-bridge.js - Pont d'accès au monde de la page YouTube Music (MAIN world)
// Permet d'extraire 100% des vignettes, métadonnées de la file d'attente et d'effectuer la recherche/ajout de morceaux
(function () {
  'use strict';

  try {
    const oldTag = document.getElementById('ytm-queue-cache-data');
    if (oldTag) oldTag.remove();
  } catch (e) {}

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

  function runSync() {
    syncDomQueueItems();
    syncGlobalQueue();
  }



  // Cloner un renderer natif et insérer dans le modèle Polymer de YouTube Music
  function insertTrackIntoNativeQueue(trackData) {
    const videoId = trackData.videoId;
    if (!videoId) return false;

    const title = trackData.title || 'Titre inconnu';
    const artist = trackData.artist || 'Artiste inconnu';
    const duration = trackData.duration || '';
    const thumbnail = trackData.thumbnail || `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;

    try {
      const queueEl = document.querySelector('ytmusic-player-queue');
      if (!queueEl) return false;

      const qData = queueEl.data || queueEl.queueData || queueEl.__data?.data || queueEl.__data?.queueData;
      const items = qData?.items || qData?.contents || queueEl.items || queueEl.__data?.items;

      if (!Array.isArray(items) || items.length === 0) return false;

      // 1. Trouver l'index du morceau en cours
      let curIdx = items.findIndex(it => {
        const r = it?.playlistPanelVideoRenderer || it;
        return r && (r.selected || r.isSelected);
      });
      if (curIdx === -1) {
        const barTitle = document.querySelector('ytmusic-player-bar .title')?.textContent?.trim()?.toLowerCase();
        if (barTitle) {
          curIdx = items.findIndex(it => {
            const r = it?.playlistPanelVideoRenderer || it;
            const t = (r?.title?.runs?.[0]?.text || (typeof r?.title === 'string' ? r.title : ''))?.trim()?.toLowerCase();
            return t === barTitle;
          });
        }
      }
      const insertIdx = (curIdx !== -1) ? curIdx + 1 : items.length;

      // 2. Cloner un vrai renderer existant pour conserver 100% du schéma Polymer interne
      const templateItem = items[curIdx !== -1 ? curIdx : 0];
      const templateRenderer = templateItem?.playlistPanelVideoRenderer || templateItem;
      const clonedRenderer = JSON.parse(JSON.stringify(templateRenderer));

      // 3. Injecter nos informations de morceau
      clonedRenderer.videoId = videoId;
      clonedRenderer.selected = false;
      if (clonedRenderer.isSelected !== undefined) clonedRenderer.isSelected = false;
      delete clonedRenderer.playlistSetVideoId;

      // Titre
      if (clonedRenderer.title && Array.isArray(clonedRenderer.title.runs)) {
        clonedRenderer.title.runs = [{ text: title }];
      } else {
        clonedRenderer.title = { runs: [{ text: title }] };
      }

      // Artiste
      if (clonedRenderer.shortBylineText && Array.isArray(clonedRenderer.shortBylineText.runs)) {
        clonedRenderer.shortBylineText.runs = [{ text: artist }];
      } else {
        clonedRenderer.shortBylineText = { runs: [{ text: artist }] };
      }
      if (clonedRenderer.longBylineText) {
        clonedRenderer.longBylineText = { runs: [{ text: artist }] };
      }

      // Durée
      if (duration) {
        if (clonedRenderer.lengthText && Array.isArray(clonedRenderer.lengthText.runs)) {
          clonedRenderer.lengthText.runs = [{ text: duration }];
        } else {
          clonedRenderer.lengthText = { runs: [{ text: duration }] };
        }
      }

      // Vignette
      if (thumbnail) {
        clonedRenderer.thumbnail = {
          thumbnails: [
            { url: thumbnail, width: 120, height: 120 },
            { url: thumbnail, width: 226, height: 226 }
          ]
        };
      }

      // WatchEndpoint
      if (clonedRenderer.navigationEndpoint?.watchEndpoint) {
        clonedRenderer.navigationEndpoint.watchEndpoint.videoId = videoId;
        delete clonedRenderer.navigationEndpoint.watchEndpoint.playlistId;
        delete clonedRenderer.navigationEndpoint.watchEndpoint.index;
      }

      const newItem = templateItem.playlistPanelVideoRenderer
        ? { playlistPanelVideoRenderer: clonedRenderer }
        : clonedRenderer;

      // 4. Insérer dans le modèle Polymer
      items.splice(insertIdx, 0, newItem);

      // Notifier Polymer pour forcer la création du nœud DOM dans la file d'attente du PC
      if (typeof queueEl.notifySplices === 'function') {
        try {
          queueEl.notifySplices('data.items', [{
            index: insertIdx,
            removed: [],
            addedCount: 1,
            object: items,
            type: 'splice'
          }]);
        } catch (e) {}
      }
      if (typeof queueEl.notifyPath === 'function') {
        try { queueEl.notifyPath('data.items'); } catch (e) {}
        try { queueEl.notifyPath('items'); } catch (e) {}
      }

      return true;
    } catch (err) {
      console.warn('[YTM Bridge] Erreur insertion queue native:', err);
      return false;
    }
  }

  // Lancer directement un morceau par videoId
  window.addEventListener('ytm-play-track', (e) => {
    let videoId = typeof e.detail === 'string' ? e.detail : e.detail?.videoId;
    if (typeof videoId === 'string' && videoId.startsWith('{')) {
      try { videoId = JSON.parse(videoId)?.videoId || videoId; } catch (err) {}
    }
    if (!videoId) return;

    // 1. Priorité ABSOLUE : movie_player.loadVideoById (zéro déchargement de page, garde WebRTC actif)
    const mp = document.getElementById('movie_player');
    if (mp && typeof mp.loadVideoById === 'function') {
      try {
        mp.loadVideoById(videoId);
        if (typeof mp.playVideo === 'function') {
          mp.playVideo();
          setTimeout(() => { try { mp.playVideo(); } catch (e) {} }, 80);
          setTimeout(() => { try { mp.playVideo(); } catch (e) {} }, 250);
        }
        runSync();
        setTimeout(runSync, 400);
        return;
      } catch (err) {
        console.warn('[YTM Bridge] loadVideoById error:', err);
      }
    }

    try {
      // 2. Navigation SPA native YouTube Music (fallback)
      const app = document.querySelector('ytmusic-app');
      if (app && typeof app.navigate_ === 'function') {
        app.navigate_('/watch?v=' + videoId);
        setTimeout(runSync, 400);
        return;
      }

      // 3. Clic sur un lien avec href watch intercepté par Polymer
      const link = document.createElement('a');
      link.href = '/watch?v=' + videoId;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      link.remove();
      setTimeout(runSync, 400);
      return;
    } catch (err) {}

    window.location.href = 'https://music.youtube.com/watch?v=' + videoId;
  });

  // Ajouter un morceau à la file d'attente
  window.addEventListener('ytm-queue-track', async (e) => {
    const trackData = typeof e.detail === 'object' ? e.detail : { videoId: e.detail };
    const videoId = trackData.videoId;
    if (!videoId) return;

    // 1. Insertion directe dans le modèle Polymer de YouTube Music
    insertTrackIntoNativeQueue(trackData);

    // 2. Déclencher les actions natives YouTube Music (queueAddEndpoint)
    const nativeEndpoint = {
      queueAddEndpoint: {
        queueTarget: {
          videoId: videoId,
          onEmptyQueue: {
            watchEndpoint: { videoId: videoId }
          }
        },
        queueInsertPosition: 'INSERT_AFTER_CURRENT_VIDEO'
      }
    };

    const actionTargets = [
      document.querySelector('ytmusic-app'),
      document.querySelector('ytmusic-player-bar'),
      document.querySelector('ytmusic-player-queue'),
      document,
      window
    ].filter(Boolean);

    for (const t of actionTargets) {
      try {
        t.dispatchEvent(new CustomEvent('yt-action', {
          bubbles: true,
          composed: true,
          detail: {
            actionName: 'yt-service-endpoint',
            args: [nativeEndpoint]
          }
        }));
      } catch (e) {}

      try {
        t.dispatchEvent(new CustomEvent('yt-service-endpoint', {
          bubbles: true,
          composed: true,
          detail: nativeEndpoint
        }));
      } catch (e) {}
    }

    try {
      const app = document.querySelector('ytmusic-app');
      if (app && typeof app.resolveServiceEndpoint_ === 'function') {
        app.resolveServiceEndpoint_(nativeEndpoint);
      }
    } catch (e) {}

    runSync();
    setTimeout(runSync, 400);
  });

  // Écouteur pour sauter directement à un index de file d'attente
  window.addEventListener('ytm-play-index', (e) => {
    const idx = e.detail;
    if (typeof idx !== 'number') return;
    try {
      const queueEl = document.querySelector('ytmusic-player-queue');
      if (queueEl && typeof queueEl.playVideoIndex === 'function') {
        queueEl.playVideoIndex(idx);
        return;
      }
      const playerApi = document.querySelector('ytmusic-player-page')?.playerApi_ || document.querySelector('ytmusic-app')?.playerUiState_?.player;
      if (playerApi && typeof playerApi.playVideoAt === 'function') {
        playerApi.playVideoAt(idx);
        return;
      }
    } catch (err) {}

    const domItems = document.querySelectorAll('ytmusic-player-queue-item');
    if (domItems[idx]) {
      const btn = domItems[idx].querySelector('.play-button, ytmusic-play-button-renderer, .song-title') || domItems[idx];
      btn.click();
    }
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
          btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view: window }));
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
          const vId = typeof value === 'string' ? value : value?.videoId;
          if (vId && mp && typeof mp.loadVideoById === 'function') {
            try {
              mp.loadVideoById(vId);
              if (typeof mp.playVideo === 'function') {
                mp.playVideo();
                setTimeout(() => { try { mp.playVideo(); } catch (e) {} }, 80);
                setTimeout(() => { try { mp.playVideo(); } catch (e) {} }, 250);
              }
              runSync();
            } catch (err) {}
          }
          break;
        }
        case 'play-queue-index': {
          if (typeof value === 'number' && mp && typeof mp.playVideoAt === 'function') {
            try {
              mp.playVideoAt(value);
              runSync();
            } catch (err) {}
          }
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

  const observer = new MutationObserver(() => {
    runSync();
  });
  const queueContainer = document.querySelector('ytmusic-player-queue') || document.body;
  if (queueContainer) {
    observer.observe(queueContainer, { childList: true, subtree: true });
  }
})();
