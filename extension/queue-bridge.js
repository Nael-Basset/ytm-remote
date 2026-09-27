// queue-bridge.js - Pont d'accès au monde de la page YouTube Music (MAIN world)
// Permet d'extraire 100% des vignettes et métadonnées de la file d'attente (y compris au-delà des 8 premiers éléments)
(function () {
  'use strict';

  function cleanUrl(url) {
    if (!url) return '';
    if (url.startsWith('//')) return 'https:' + url;
    return url;
  }

  function getThumbnailFromRenderer(r) {
    if (!r) return '';
    const thumbs = r.thumbnail?.thumbnails;
    if (Array.isArray(thumbs) && thumbs.length > 0) {
      // Trouver la plus nette ou la dernière
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

            // Charger l'image directement dans le DOM pour YouTube Music
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

      // Si pas trouvé sur l'élément queue, chercher sur l'application ou le player
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
          let cacheTag = document.getElementById('ytm-queue-cache-data');
          if (!cacheTag) {
            cacheTag = document.createElement('script');
            cacheTag.id = 'ytm-queue-cache-data';
            cacheTag.type = 'application/json';
            cacheTag.style.display = 'none';
            (document.head || document.documentElement).appendChild(cacheTag);
          }
          cacheTag.textContent = JSON.stringify(fullList);
        }
      }
    } catch (e) {}
  }

  function runSync() {
    syncDomQueueItems();
    syncGlobalQueue();
  }

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

    // Fallback DOM si l'API directe échoue
    const domItems = document.querySelectorAll('ytmusic-player-queue-item');
    if (domItems[idx]) {
      const btn = domItems[idx].querySelector('.play-button, ytmusic-play-button-renderer, .song-title') || domItems[idx];
      btn.click();
    }
  });

  // Exécution immédiate et périodique
  runSync();
  setInterval(runSync, 800);

  // Événements natifs de YouTube Music
  ['yt-action', 'yt-page-data-updated', 'yt-navigate-finish'].forEach((ev) => {
    document.addEventListener(ev, () => {
      setTimeout(runSync, 100);
      setTimeout(runSync, 500);
    });
  });

  // Observer les changements du DOM sur le conteneur de queue
  const observer = new MutationObserver(() => {
    runSync();
  });
  const queueContainer = document.querySelector('ytmusic-player-queue') || document.body;
  if (queueContainer) {
    observer.observe(queueContainer, { childList: true, subtree: true });
  }
})();
