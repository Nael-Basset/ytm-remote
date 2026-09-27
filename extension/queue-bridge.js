// queue-bridge.js - Pont d'accès au monde de la page YouTube Music (MAIN world)
// Permet d'extraire 100% des vignettes, métadonnées de la file d'attente et d'effectuer la recherche/ajout de morceaux
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
          let cacheTag = document.getElementById('ytm-queue-cache-data');
          if (!cacheTag) {
            cacheTag = document.createElement('textarea');
            cacheTag.id = 'ytm-queue-cache-data';
            cacheTag.style.display = 'none';
            cacheTag.setAttribute('aria-hidden', 'true');
            (document.head || document.documentElement).appendChild(cacheTag);
          }
          cacheTag.value = JSON.stringify(fullList);
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
      const app = document.querySelector('ytmusic-app');
      const playerApi = document.querySelector('ytmusic-player-page')?.playerApi_ || app?.playerUiState_?.player;
      if (playerApi && typeof playerApi.loadVideoById === 'function') {
        playerApi.loadVideoById(videoId);
        setTimeout(runSync, 500);
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

    const title = trackData.title || 'Titre';
    const artist = trackData.artist || 'Artiste';
    const duration = trackData.duration || '';
    const thumbnail = trackData.thumbnail || `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;

    // 1. Récupérer le vrai playlistPanelVideoRenderer via /music/get_queue
    let serverRenderer = null;
    try {
      const res = await fetch('https://music.youtube.com/youtubei/v1/music/get_queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context: {
            client: {
              clientName: 'WEB_REMIX',
              clientVersion: '1.20240101.01.00',
              hl: navigator.language || 'fr',
              gl: 'FR'
            }
          },
          videoIds: [videoId]
        })
      });
      if (res.ok) {
        const qData = await res.json();
        serverRenderer = qData.queueDatas?.[0]?.content?.playlistPanelVideoRenderer;
      }
    } catch (netErr) {}

    const renderer = serverRenderer || {
      videoId: videoId,
      title: { runs: [{ text: title }] },
      shortBylineText: { runs: [{ text: artist }] },
      longBylineText: { runs: [{ text: artist }] },
      lengthText: { runs: [{ text: duration }] },
      thumbnail: {
        thumbnails: [
          { url: thumbnail, width: 120, height: 120 }
        ]
      },
      navigationEndpoint: {
        watchEndpoint: {
          videoId: videoId
        }
      },
      selected: false
    };

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

    // 3. Insérer dans le modèle Polymer de file d'attente juste APRÈS le morceau en cours
    const queueEl = document.querySelector('ytmusic-player-queue');
    if (queueEl) {
      const qData = queueEl.data || queueEl.queueData || queueEl.__data?.data || queueEl.__data?.queueData;
      if (qData) {
        if (!Array.isArray(qData.items)) qData.items = [];
        let curIdx = qData.items.findIndex(it => {
          const r = it?.playlistPanelVideoRenderer || it;
          return r?.selected;
        });
        const insertIdx = (curIdx !== -1) ? curIdx + 1 : qData.items.length;
        qData.items.splice(insertIdx, 0, { playlistPanelVideoRenderer: renderer });

        if (typeof queueEl.notifySplices === 'function') {
          try {
            queueEl.notifySplices('data.items', [{
              index: insertIdx,
              removed: [],
              addedCount: 1,
              object: qData.items,
              type: 'splice'
            }]);
          } catch (err) {}
        }
      }

      if (Array.isArray(queueEl.items)) {
        queueEl.items.push({ playlistPanelVideoRenderer: renderer });
      }
    }

    // 4. Mettre à jour immédiatement le cache JSON local de la queue
    try {
      let cacheTag = document.getElementById('ytm-queue-cache-data');
      if (cacheTag) {
        const raw = cacheTag.value || cacheTag.textContent;
        if (raw) {
          const list = JSON.parse(raw);
          if (Array.isArray(list)) {
            let curIdx = list.findIndex(it => it.isCurrent);
            const insertIdx = (curIdx !== -1) ? curIdx + 1 : list.length;
            list.splice(insertIdx, 0, {
              index: insertIdx,
              title: title,
              artist: artist,
              duration: duration,
              thumbnail: thumbnail,
              videoId: videoId,
              isCurrent: false
            });
            list.forEach((item, idx) => { item.index = idx; });
            cacheTag.value = JSON.stringify(list);
          }
        }
      }
    } catch (cErr) {}

    // 5. Informer le lecteur sous-jacent
    try {
      const playerApi = document.querySelector('ytmusic-player-page')?.playerApi_ || document.querySelector('ytmusic-app')?.playerUiState_?.player;
      if (playerApi && typeof playerApi.cueVideoById === 'function') {
        playerApi.cueVideoById(videoId);
      }
    } catch (pErr) {}

    runSync();
    setTimeout(runSync, 300);
    setTimeout(runSync, 1000);
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
