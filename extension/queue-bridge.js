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

  // ==========================================
  // Recherche Intelligente YouTube Music (Innertube API)
  // ==========================================
  function parseSearchItem(r) {
    try {
      let title = '';
      let artist = '';
      let duration = '';
      let videoId = r.playlistItemData?.videoId || '';

      const flexCols = r.flexColumns || [];
      if (flexCols.length > 0) {
        const col0 = flexCols[0]?.musicResponsiveListItemFlexColumnRenderer?.text;
        if (col0 && col0.runs) {
          title = col0.runs.map(x => x.text || '').join('');
          if (!videoId) {
            videoId = col0.runs[0]?.navigationEndpoint?.watchEndpoint?.videoId || '';
          }
        }
      }

      if (flexCols.length > 1) {
        const col1 = flexCols[1]?.musicResponsiveListItemFlexColumnRenderer?.text;
        if (col1 && col1.runs) {
          const runs = col1.runs;
          const parts = [];
          for (const run of runs) {
            const t = (run.text || '').trim();
            if (t === '•' || t === '·') continue;
            if (/^\d+:\d+$/.test(t)) {
              duration = t;
            } else if (t.toLowerCase() !== 'morceau' && t.toLowerCase() !== 'song') {
              parts.push(t);
            }
          }
          artist = parts.join(' • ');
        }
      }

      if (!duration && r.fixedColumns && r.fixedColumns.length > 0) {
        const fix = r.fixedColumns[0]?.musicResponsiveListItemFixedColumnRenderer?.text;
        if (fix && fix.runs) {
          duration = fix.runs.map(x => x.text || '').join('').trim();
        }
      }

      if (!videoId) {
        videoId = r.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId || '';
      }
      if (!videoId && r.navigationEndpoint?.watchEndpoint?.videoId) {
        videoId = r.navigationEndpoint.watchEndpoint.videoId;
      }

      const thumbs = r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
      let thumbnail = '';
      if (thumbs.length > 0) {
        thumbnail = cleanUrl(thumbs[thumbs.length - 1].url);
      }
      if (!thumbnail && videoId) {
        thumbnail = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
      }

      if (title && videoId) {
        return {
          title,
          artist: artist || 'Artiste inconnu',
          duration,
          videoId,
          thumbnail
        };
      }
    } catch (e) {}
    return null;
  }

  function extractSearchResults(data) {
    const results = [];
    const seenIds = new Set();

    function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (node.musicResponsiveListItemRenderer) {
        const parsed = parseSearchItem(node.musicResponsiveListItemRenderer);
        if (parsed && !seenIds.has(parsed.videoId)) {
          seenIds.add(parsed.videoId);
          results.push(parsed);
        }
        return;
      }
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) {
          walk(node[i]);
        }
      } else {
        const keys = Object.keys(node);
        for (let i = 0; i < keys.length; i++) {
          walk(node[keys[i]]);
        }
      }
    }

    walk(data);
    return results.slice(0, 25);
  }

  // Écouteur pour la recherche distante
  window.addEventListener('ytm-remote-search-request', async (e) => {
    const { query, requestId } = e.detail || {};
    if (!query) return;

    try {
      const apiKey = window.ytcfg?.get('INNERTUBE_API_KEY');
      const context = window.ytcfg?.get('INNERTUBE_CONTEXT');
      if (!apiKey || !context) {
        window.dispatchEvent(new CustomEvent('ytm-remote-search-response', {
          detail: { query, requestId, results: [] }
        }));
        return;
      }

      const res = await fetch(`https://music.youtube.com/youtubei/v1/search?key=${apiKey}&prettyPrint=false`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context: context,
          query: query,
          params: 'Eg-KAQwIABAAGAAgACgAMABqChAEEAMQCRAFEAo%3D' // Filtrer "Titres" (Songs)
        })
      });

      if (!res.ok) throw new Error('Search HTTP ' + res.status);
      const data = await res.json();
      const results = extractSearchResults(data);

      window.dispatchEvent(new CustomEvent('ytm-remote-search-response', {
        detail: { query, requestId, results }
      }));
    } catch (err) {
      console.warn('[YTM Bridge] Erreur recherche:', err);
      window.dispatchEvent(new CustomEvent('ytm-remote-search-response', {
        detail: { query, requestId, results: [] }
      }));
    }
  });

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
    const videoId = typeof e.detail === 'string' ? e.detail : e.detail?.videoId;
    if (!videoId) return;

    let added = false;
    try {
      const apiKey = window.ytcfg?.get('INNERTUBE_API_KEY');
      const context = window.ytcfg?.get('INNERTUBE_CONTEXT');
      if (apiKey && context) {
        const resp = await fetch(`/youtubei/v1/queue/add?key=${apiKey}&prettyPrint=false`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            context: context,
            videoIds: [videoId]
          })
        });
        if (resp.ok) added = true;
      }
    } catch (err) {}

    if (!added) {
      try {
        const queueEl = document.querySelector('ytmusic-player-queue');
        if (queueEl && typeof queueEl.addTracks === 'function') {
          queueEl.addTracks([videoId]);
          added = true;
        }
      } catch (err) {}
    }

    if (!added) {
      try {
        const playerApi = document.querySelector('ytmusic-player-page')?.playerApi_ || document.querySelector('ytmusic-app')?.playerUiState_?.player;
        if (playerApi && typeof playerApi.cueVideoById === 'function') {
          playerApi.cueVideoById(videoId);
          added = true;
        }
      } catch (err) {}
    }

    setTimeout(runSync, 500);
    setTimeout(runSync, 1500);
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
