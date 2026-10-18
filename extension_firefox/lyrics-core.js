// lyrics-core.js - Recherche de paroles partagée (PiP, popup et télécommande passent tous par ici)
//
// Les titres YouTube Music sont souvent bruités, surtout pour les clips mis en ligne par des
// chaînes tierces : « A-Ha - Take On Me - Live MTV Unplugged (Letra e Tradução) » publié par
// « Lyrics Brasil », guillemets typographiques, artistes multiples… On génère plusieurs
// interprétations (titre, artiste) et on interroge lrclib en s'arrêtant au premier résultat
// synchronisé dont la durée correspond.
(function (root) {
  'use strict';

  // Mots qui signalent un segment entre parenthèses/crochets à retirer du titre
  const NOISE = /\b(official|officiel|video|vid[ée]o|audio|lyrics?|paroles|letra|legendado|tradu[cç][aã]o|traducci[oó]n|subtitulado|sub|hd|hq|4k|8k|mv|m\/v|visuali[sz]er|remaster(ed)?|version|edit|mix|radio|from|soundtrack|ost|explicit|clean|live|unplugged|session|prod\.?|feat\.?|ft\.?|featuring|with|color coded|performance|clip|karaoke|\d{4})\b/i;

  function normalizeQuotes(s) {
    return String(s || '').replace(/[“”„«»]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
  }

  // Retire les segments bruités et les mentions d'invités d'un titre
  function cleanTitle(t) {
    let s = normalizeQuotes(t);
    s = s.replace(/\s*[(\[]([^)\]]*)[)\]]/g, (m, inner) => (NOISE.test(inner) ? '' : m));
    s = s.replace(/\s*[|｜].*$/, '');
    s = s.replace(/\s+(feat\.?|ft\.?|featuring)\s.*$/i, '');
    // Mentions en fin de titre, hors parenthèses : « … live 2017 », « … official video »
    s = s.replace(/(\s+(live|ao vivo|en vivo|official|video|audio|clip|lyrics?|hd|4k|remaster(ed)?|(19|20)\d{2}))+$/i, '');
    s = s.replace(/^["'\s]+|["'\s]+$/g, '');
    return s.trim();
  }

  // Artiste principal : premier nom, sans invités ni compteur de vues
  function primaryArtist(a) {
    let s = normalizeQuotes(a).split(/\s*[•·]\s*/)[0];
    s = s.replace(/\s*[(\[]?\s*(feat\.?|ft\.?|featuring)\b.*$/i, '');
    // Chaînes YouTube : « The Beatles - Topic », « RickAstleyVEVO », « … Official »
    s = s.replace(/\s*-\s*topic$/i, '').replace(/^(\S+?)vevo$/i, (m, name) => name.replace(/([a-z])([A-Z])/g, '$1 $2')).replace(/\s+official$/i, '');
    return s.split(/\s*(?:,|&|\/|\s(?:et|and|x|y|with)\s)\s*/i)[0].trim();
  }

  // Interprétations possibles du couple (titre, artiste), de la plus probable à la moins probable
  function candidates(rawTitle, rawArtist) {
    const out = [];
    const seen = new Set();
    const add = (title, artist) => {
      title = cleanTitle(title);
      artist = (artist || '').trim();
      const key = (title + '|' + artist).toLowerCase();
      if (title && !seen.has(key)) { seen.add(key); out.push({ title, artist, raw: rawTitle }); }
    };
    const title = normalizeQuotes(rawTitle);
    const ytArtist = primaryArtist(rawArtist);

    // « A-ha Take On Me » : le titre commence par le nom de l'artiste
    if (ytArtist) {
      const words = title.split(' ');
      for (let n = 1; n < words.length; n++) {
        if (simplify(words.slice(0, n).join(' ')) === simplify(ytArtist)) {
          add(words.slice(n).join(' ').replace(/^[-–—:|\s]+/, ''), ytArtist);
          break;
        }
      }
    }

    // « Artiste - Titre [- mention] » : très courant pour les clips de chaînes tierces
    const parts = title.split(/\s+[-–—]\s+/);
    if (parts.length >= 2) {
      add(parts[1], primaryArtist(parts[0]));
      add(parts.slice(1).join(' - '), primaryArtist(parts[0]));
    }
    // Titre entre guillemets : « Earth Wind & Fire "September" »
    const quoted = /"([^"]{2,})"/.exec(title);
    if (quoted) {
      const outside = title.replace(quoted[0], ' ').replace(/\s+/g, ' ').trim();
      add(quoted[1], primaryArtist(outside) || ytArtist);
      add(quoted[1], ytArtist);
    }
    add(title, ytArtist);
    const fullArtist = normalizeQuotes(rawArtist).split(/\s*[•·]\s*/)[0];
    if (fullArtist && fullArtist !== ytArtist) add(title, fullArtist);
    return out;
  }

  const simplify = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '');

  // Choisit le meilleur résultat lrclib : durée proche, synchronisé de préférence, artiste ressemblant
  // opts.anyDuration : ignore la durée (autre version du titre)
  // opts.requireArtist : l'artiste doit correspondre (recherches libres, sans filtre côté lrclib)
  function pickBest(list, cand, duration, opts = {}) {
    const { anyDuration = false, requireArtist = false } = opts;
    if (!Array.isArray(list)) return null;
    const a = simplify(cand.artist);
    const t = simplify(cand.title);
    const raw = simplify(cand.raw);
    let best = null;
    let bestScore = -Infinity;
    for (const it of list) {
      if (!it || (!it.syncedLyrics && !it.plainLyrics) || it.instrumental) continue;
      const diff = duration ? Math.abs((it.duration || 0) - duration) : 0;
      if (duration && diff > 8 && !anyDuration) continue;
      const ia = simplify(it.artistName);
      const it2 = simplify(it.trackName);
      const titleMatch = !!(t && it2 && (it2.includes(t) || t.includes(it2)));
      // Artiste du résultat = artiste supposé, ou bien nommé dans le titre YouTube
      // (chaînes tierces : « A-ha Take On Me live », publié par une chaîne quelconque)
      const artistMatch = !!(ia && ((a && (ia.includes(a) || a.includes(ia))) || (ia.length >= 3 && raw.includes(ia))));
      // Sans correspondance de titre, ce n'est pas le même morceau (ex. un autre « Yesterday »)
      if (!titleMatch) continue;
      if (requireArtist && a && !artistMatch) continue;
      // Aucune preuve d'artiste : uniquement le même titre exact, à la même durée (± 3 s),
      // et jamais une « autre version » (trop de morceaux différents partagent un titre)
      if (!artistMatch && (anyDuration || t !== it2 || (duration && diff > 3))) continue;
      let score = 0;
      if (it.syncedLyrics) score += 50;
      if (artistMatch) score += 30;
      if (titleMatch) score += 20;
      score -= diff * 2;
      if (score > bestScore) { bestScore = score; best = it; }
    }
    return best;
  }

  // Recherche principale. fetchJson(url) -> objet JSON ou null.
  // opts.nativeLyrics() -> Promise<texte> : paroles de YouTube Music, en recours.
  // Renvoie { synced, plain, source } ou null.
  async function findLyrics(rawTitle, rawArtist, duration, fetchJson, opts = {}) {
    let otherVersion = null; // même titre, durée différente (version live, edit…)
    const d = Math.round(duration || 0);
    const qs = (p) => new URLSearchParams(p).toString();
    const result = (it) => it && { synced: it.syncedLyrics || '', plain: it.plainLyrics || '', source: 'lrclib' };
    let plainFallback = null;
    const consider = (it) => {
      if (!it) return null;
      if (it.syncedLyrics) return result(it);
      if (it.plainLyrics && !plainFallback) plainFallback = result(it);
      return null;
    };

    const cands = candidates(rawTitle, rawArtist).slice(0, 4);
    for (const c of cands) {
      // 1. Correspondance exacte (titre, artiste, durée) : la plus fiable et la plus rapide
      if (c.artist && d) {
        const exact = await fetchJson('https://lrclib.net/api/get?' + qs({ track_name: c.title, artist_name: c.artist, duration: d }));
        const r = consider(exact && !exact.instrumental ? exact : null);
        if (r) return r;
      }
      // 2. Recherche par champs
      if (c.artist) {
        const list = await fetchJson('https://lrclib.net/api/search?' + qs({ track_name: c.title, artist_name: c.artist }));
        const r = consider(pickBest(list, c, d));
        if (r) return r;
      }
    }
    // 3. Recherche libre sur le titre le plus probable, filtrée par durée
    const top = cands[0];
    if (top) {
      const list = await fetchJson('https://lrclib.net/api/search?' + qs({ q: (top.artist ? top.artist + ' ' : '') + top.title }));
      const r = consider(pickBest(list, top, d, { requireArtist: true }));
      if (r) return r;
      if (top.artist) otherVersion = pickBest(list, top, d, { anyDuration: true, requireArtist: true });
      if (d) {
        const list2 = await fetchJson('https://lrclib.net/api/search?' + qs({ q: top.title }));
        const r2 = consider(pickBest(list2, top, d, { requireArtist: true }));
        if (!otherVersion) otherVersion = pickBest(list2, top, d, { anyDuration: true, requireArtist: true });
        if (r2) return r2;
      }
    }
    // 4. Paroles de YouTube Music (non synchronisées mais rattachées à la vidéo exacte)
    if (opts.nativeLyrics) {
      const text = await opts.nativeLyrics().catch(() => '');
      if (text && text.trim()) return { synced: '', plain: text.replace(/\r/g, ''), source: 'youtube-music' };
    }
    if (plainFallback) return plainFallback;
    // 5. Autre version du même titre (live, edit…) : le texte est bon mais pas le minutage,
    // on ne garde donc que les paroles non synchronisées.
    if (otherVersion) {
      const plain = otherVersion.plainLyrics || parseLrc(otherVersion.syncedLyrics).map(l => l.text).join('\n');
      if (plain.trim()) return { synced: '', plain, source: 'lrclib-other-version' };
    }
    return null;
  }

  // Analyse d'un fichier LRC -> [{ time, text }] trié
  function parseLrc(lrc) {
    const out = [];
    let offset = 0;
    const om = /\[offset:\s*([+-]?\d+)\s*\]/i.exec(lrc);
    if (om) offset = parseInt(om[1], 10) / 1000;
    for (const raw of String(lrc).split('\n')) {
      let work = raw.trim();
      const stamps = [];
      let m;
      while ((m = /^\[(\d+):(\d+)(?:[.:](\d+))?\]/.exec(work))) {
        const ff = m[3] ? parseInt(m[3].padEnd(3, '0').slice(0, 3), 10) / 1000 : 0;
        stamps.push(parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + ff + offset);
        work = work.slice(m[0].length);
      }
      const text = work.trim();
      for (const t of stamps) out.push({ time: Math.max(0, t), text });
    }
    return out.sort((a, b) => a.time - b.time);
  }

  const api = { findLyrics, parseLrc, candidates, cleanTitle, primaryArtist };
  root.YTMLyrics = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
