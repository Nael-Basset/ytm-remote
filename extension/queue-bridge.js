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



  // Lancer directement un morceau par videoId
  window.addEventListener('ytm-play-track', (e) => {
    const videoId = typeof e.detail === 'string' ? e.detail : e.detail?.videoId;
    if (!videoId) return;

    try {
      // 1. movie_player (API HTML5 standard YouTube Music)
      const mp = document.getElementById('movie_player');
      if (mp && typeof mp.loadVideoById === 'function') {
        mp.loadVideoById(videoId);
        setTimeout(runSync, 400);
        return;
      }

      // 2. Fallbacks internes Polymer / app
      const app = document.querySelector('ytmusic-app');
      const playerApi = document.querySelector('ytmusic-player-page')?.playerApi_ || app?.playerUiState_?.player;
      if (playerApi && typeof playerApi.loadVideoById === 'function') {
        playerApi.loadVideoById(videoId);
        setTimeout(runSync, 400);
        return;
      }
      if (app && typeof app.navigate_ === 'function') {
        app.navigate_('/watch?v=' + videoId);
        setTimeout(runSync, 500);
        return;
      }
    } catch (err) {}

    window.location.href = 'https://music.youtube.com/watch?v=' + videoId;
  });

  // Ajouter un morceau à la file d'attente
  window.addEventListener('ytm-queue-track', async (e) => {
    const trackData = typeof e.detail === 'object' ? e.detail : { videoId: e.detail };
    const videoId = trackData.videoId;
    if (!videoId) return;

    // Déclencher les actions natives YouTube Music (queueAddEndpoint)
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

    // Essayer de résoudre le command handler sur ytmusic-app si exposé
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
