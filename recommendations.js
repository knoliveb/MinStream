/* ============================================================
   minstream - Motor de recomendacao (client-side, sem API key)
   Reaproveita: searchYouTube, materializeYtTrack, state, Tastes,
   getTrack, escapeHtml, fmtTime, showToast, playTrack,
   createPlaylistCard/trackRow/attachTrackListeners, UserPlaylists,
   openPlaylistChooser.
   Carregue este arquivo ANTES de app.js:
     <script src="recommendations.js"></script>
     <script src="app.js"></script>
   (O IIFE apenas define; as chamadas acontecem em runtime.)
   ============================================================ */
const Reco = (function () {
  const LIKED_META_KEY = 'vibefm_liked_meta';
  const NEWS_CACHE_KEY = 'vibefm_news_cache';
  const NEWS_TTL = 6 * 60 * 60 * 1000;        // 6h
  const MIX_TTL = 30 * 60 * 1000;             // 30min (em memoria)
  const NEWS_MAX_AGE = 150 * 24 * 60 * 60 * 1000;

  // Palavras que nao ajudam a identificar artista/faixa
  const STOP = new Set(['official','video','audio','lyrics','lyric','hd','hq','mv',
    'ft','feat','remix','music','clipe','oficial','ao','vivo','full','album','song']);

  // ---------- utilitarios ----------
  const normArtist = a => (a || '').trim().toLowerCase();

  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // Semente estavel por dia (o mix muda a cada dia, nao a cada render)
  function daySeed(salt) {
    const d = new Date();
    const dayOfYear = Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000);
    return ((d.getFullYear() * 1000 + dayOfYear) ^ (salt || 0)) >>> 0;
  }

  // Executa promessas com concorrencia limitada (gentil com as instancias publicas)
  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let cursor = 0;
    async function worker() {
      while (cursor < items.length) {
        const i = cursor++;
        try { out[i] = await fn(items[i], i); } catch (_) { out[i] = null; }
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
  }

  // ---------- persistencia: metadados das curtidas ----------
  function loadLikedMeta() {
    try { return JSON.parse(localStorage.getItem(LIKED_META_KEY)) || {}; }
    catch (_) { return {}; }
  }
  function saveLikedMeta(m) {
    try { localStorage.setItem(LIKED_META_KEY, JSON.stringify(m)); } catch (_) {}
  }
  // Chamar dentro de toggleLike (depois de atualizar state.likedTracks)
  function recordLike(id, track) {
    const m = loadLikedMeta();
    if (state.likedTracks.has(id)) {
      const t = track || (typeof getTrack === 'function' && getTrack(id)) || {};
      const prev = m[id] || {};
      m[id] = {
        videoId: t.videoId || prev.videoId || (id.startsWith('yt_') ? id.slice(3) : ''),
        title: t.title || prev.title || '',
        artist: t.artist || prev.artist || '',
        srcGenre: t._srcGenre || prev.srcGenre || null,
        at: Date.now(),
      };
    } else {
      delete m[id];
    }
    saveLikedMeta(m);
  }
  // Recria as faixas curtidas em TRACKS no boot (corrige "Curtidas" vazia apos reload)
  function hydrateLikes() {
    const m = loadLikedMeta();
    Object.entries(m).forEach(([id, it]) => {
      if (typeof getTrack === 'function' && getTrack(id)) return;
      if (id.startsWith('yt_') && it.videoId) {
        materializeYtTrack(it.videoId, it.title, it.artist, 0);
      }
    });
  }

  // ---------- perfil de gosto ----------
  function buildProfile() {
    const artists = new Map();          // chave normalizada -> peso
    const genres = new Map();           // genero (lower) -> peso
    const displayName = new Map();      // chave -> nome exibivel
    const bump = (map, k, w) => map.set(k, (map.get(k) || 0) + w);

    // Generos explicitos (Perfil) — sinal forte
    (typeof Tastes !== 'undefined' ? Tastes.load() : []).forEach(g =>
      bump(genres, g.toLowerCase(), 3));

    // Curtidas — sinal mais forte
    Object.values(loadLikedMeta()).forEach(it => {
      const a = normArtist(it.artist);
      if (a) { bump(artists, a, 4); if (!displayName.has(a)) displayName.set(a, it.artist); }
      if (it.srcGenre) bump(genres, it.srcGenre.toLowerCase(), 2);
    });

    // Historico — com decaimento por recencia (~3 semanas de meia-vida)
    const now = Date.now();
    (state.history || []).forEach(h => {
      let artist = h.artist;
      if (!artist && typeof getTrack === 'function') {
        const t = getTrack(h.trackId); if (t) artist = t.artist;
      }
      const a = normArtist(artist);
      if (!a) return;
      const ageDays = (now - (h.at || now)) / 86400000;
      bump(artists, a, Math.max(0.2, 1.5 * Math.exp(-ageDays / 21)));
      if (!displayName.has(a)) displayName.set(a, artist);
    });

    const topArtists = [...artists.entries()].sort((x, y) => y[1] - x[1])
      .slice(0, 8).map(([key, score]) => ({ key, artist: displayName.get(key) || key, score }));
    const topGenres = [...genres.entries()].sort((x, y) => y[1] - x[1])
      .slice(0, 8).map(([genre, score]) => ({ genre, score }));

    return { artists, genres, topArtists, topGenres };
  }

  // ---------- geracao de candidatos ----------
  async function gatherCandidates(profile, opts) {
    opts = opts || {};
    const year = new Date().getFullYear();
    const queries = [];
    profile.topArtists.slice(0, opts.artistSeeds || 5).forEach(a => {
      queries.push(a.artist);
      if (opts.discover) queries.push('musicas parecidas com ' + a.artist);
    });
    profile.topGenres.slice(0, opts.genreSeeds || 4).forEach(g => {
      queries.push(g.genre + ' music');
      if (opts.fresh) queries.push('melhores ' + g.genre + ' ' + year);
    });

    const uniq = [...new Set(queries.map(q => q.trim()).filter(Boolean))];
    const lists = await mapLimit(uniq, 3, async q => {
      const r = await searchYouTube(q);
      return (r || []).map(x => ({ ...x, _q: q }));
    });

    const byId = new Map();
    lists.filter(Boolean).flat().forEach(item => {
      if (!item.videoId) return;
      const ex = byId.get(item.videoId);
      if (ex) ex._hits++;
      else byId.set(item.videoId, { ...item, _hits: 1 });
    });
    return [...byId.values()];
  }

  // ---------- ranqueamento: relevancia + novidade + diversidade ----------
  function score(cands, profile, mode) {
    const now = Date.now();
    const recent = new Map(); // videoId -> idade em dias
    (state.history || []).slice(0, 120).forEach(h => {
      const vid = h.videoId || (h.trackId || '').replace(/^yt_/, '');
      if (vid) recent.set(vid, (now - (h.at || now)) / 86400000);
    });
    const artistScore = a => profile.artists.get(normArtist(a)) || 0;

    cands.forEach(c => {
      let s = 1;
      s += Math.min(6, artistScore(c.author));   // relevancia: artista do gosto
      s += (c._hits - 1) * 0.6;                   // corroborado por varias sementes
      const id = 'yt_' + c.videoId;
      const liked = state.likedTracks.has(id);
      const age = recent.has(c.videoId) ? recent.get(c.videoId) : Infinity;
      if (mode === 'discover') {
        if (liked) s -= 5;                        // quero material novo
        if (age < 30) s -= 3 * Math.exp(-age / 15);
      } else {
        if (liked) s += 1.2;                      // um pouco de conforto no mix diario
        if (age < 14) s -= 2 * Math.exp(-age / 10); // evita repetir o muito recente
      }
      c._score = s;
      c._artistKey = normArtist(c.author) || ('vid:' + c.videoId);
    });
    return cands;
  }

  // Selecao gulosa com teto por artista + rodizio (garante diversidade)
  function diversify(cands, size, rng, perArtistCap) {
    perArtistCap = perArtistCap || 2;
    cands.forEach(c => { c._j = c._score + rng() * 1.5; }); // jitter estavel por dia
    const byArtist = new Map();
    cands.forEach(c => {
      if (!byArtist.has(c._artistKey)) byArtist.set(c._artistKey, []);
      byArtist.get(c._artistKey).push(c);
    });
    byArtist.forEach(list => list.sort((a, b) => b._j - a._j));
    const order = [...byArtist.entries()]
      .sort((a, b) => b[1][0]._j - a[1][0]._j).map(e => e[0]);

    const out = []; const used = new Map(); let progress = true;
    while (out.length < size && progress) {
      progress = false;
      for (const k of order) {
        if (out.length >= size) break;
        const cnt = used.get(k) || 0;
        if (cnt >= perArtistCap) continue;
        const next = byArtist.get(k)[cnt];
        if (!next) continue;
        out.push(next); used.set(k, cnt + 1); progress = true;
      }
    }
    return out;
  }

  // ---------- mixes ----------
  const mixCache = new Map(); // kind -> { at, tracks }
  async function buildMix(kind, force) {
    const cached = mixCache.get(kind);
    if (!force && cached && Date.now() - cached.at < MIX_TTL) return cached.tracks;

    const profile = buildProfile();
    if (!profile.topArtists.length && !profile.topGenres.length) return [];

    const discover = kind === 'discover';
    const cands = await gatherCandidates(profile, {
      discover, fresh: true,
      artistSeeds: discover ? 4 : 5, genreSeeds: 4,
    });
    score(cands, profile, discover ? 'discover' : 'mix');
    const rng = mulberry32(daySeed(discover ? 7 : 1) + (force ? (Date.now() & 1023) : 0));
    const chosen = diversify(cands, 25, rng, discover ? 1 : 2);
    const tracks = chosen.map(c => materializeYtTrack(c.videoId, c.title, c.author, c.duration));

    mixCache.set(kind, { at: Date.now(), tracks });
    return tracks;
  }

  function saveMixAsPlaylist(name, tracks) {
    if (!tracks || !tracks.length) { showToast('Mix vazio.'); return; }
    const pl = UserPlaylists.create(name);
    tracks.forEach(t => {
      const item = t.id && t.id.startsWith('yt_')
        ? { type: 'yt', videoId: t.videoId, title: t.title, artist: t.artist, duration: t.duration }
        : { type: 'local', trackId: t.id };
      UserPlaylists.addItem(pl.id, item);
    });
    showToast('Mix salvo em "' + pl.name + '"');
    return pl;
  }

  // ---------- novidades ----------
  async function loadNews(force) {
    if (!force) {
      try {
        const c = JSON.parse(localStorage.getItem(NEWS_CACHE_KEY) || 'null');
        if (c && Date.now() - c.at < NEWS_TTL && Array.isArray(c.items)) return c.items;
      } catch (_) {}
    }
    const profile = buildProfile();
    const year = new Date().getFullYear();
    const seeds = [];
    profile.topArtists.slice(0, 5).forEach(a => seeds.push(a.artist + ' ' + year));
    profile.topGenres.slice(0, 3).forEach(g => seeds.push(g.genre + ' new song ' + year));
    const uniq = [...new Set(seeds.map(s => s.trim()).filter(Boolean))];

    const lists = await mapLimit(uniq, 3, q => searchYouTube(q));
    const now = Date.now(); const byId = new Map();
    lists.filter(Boolean).flat().forEach(it => {
      if (!it.videoId || !it.published) return;             // sem data confiavel -> ignora
      const age = now - it.published;
      if (age < 0 || age > NEWS_MAX_AGE) return;
      if (state.likedTracks.has('yt_' + it.videoId)) return; // ja conhece
      if (!byId.has(it.videoId)) byId.set(it.videoId, it);
    });
    const items = [...byId.values()]
      .sort((a, b) => b.published - a.published)
      .slice(0, 16)
      .map(it => ({ videoId: it.videoId, title: it.title, author: it.author,
        duration: it.duration, published: it.published, publishedText: it.publishedText || '' }));

    try { localStorage.setItem(NEWS_CACHE_KEY, JSON.stringify({ at: Date.now(), items })); } catch (_) {}
    return items;
  }

  // ---------- render na Home ----------
  // Cria um card de mix (usa as classes de estilo ja existentes)
  function mixCard(cfg) {
    const card = document.createElement('div');
    card.className = 'album-card playlist-home-card';

    const wrap = document.createElement('div');
    wrap.className = 'album-cover-wrap';
    if (cfg.cover) {
      const img = document.createElement('img');
      img.src = cfg.cover; img.alt = ''; img.loading = 'lazy';
      wrap.appendChild(img);
    } else {
      const ph = document.createElement('div');
      ph.style.cssText = 'width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,rgba(10,228,72,0.15),rgba(0,0,0,0.5));color:var(--text-muted)';
      ph.innerHTML = '<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
      wrap.appendChild(ph);
    }

    const overlay = document.createElement('div');
    overlay.className = 'album-overlay';
    overlay.innerHTML = '<button class="album-play-btn"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>';
    wrap.appendChild(overlay);

    const save = document.createElement('button');
    save.className = 'gallery-del';
    save.title = 'Salvar como playlist';
    save.style.right = 'auto'; save.style.left = '8px';
    save.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19" stroke-linecap="round"/><line x1="5" y1="12" x2="19" y2="12" stroke-linecap="round"/></svg>';
    save.addEventListener('click', (e) => {
      e.stopPropagation();
      saveMixAsPlaylist(cfg.name + ' \u00B7 ' + new Date().toLocaleDateString('pt-BR'), cfg.tracks);
      if (typeof renderSidebarPlaylists === 'function') renderSidebarPlaylists();
    });
    wrap.appendChild(save);

    const info = document.createElement('div');
    info.className = 'album-info';
    const title = document.createElement('div');
    title.className = 'album-title'; title.textContent = cfg.name;
    const sub = document.createElement('div');
    sub.className = 'album-artist'; sub.textContent = cfg.subtitle;
    info.appendChild(title); info.appendChild(sub);

    card.appendChild(wrap); card.appendChild(info);

    overlay.querySelector('.album-play-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      if (cfg.tracks.length) playTrack(cfg.tracks[0], cfg.tracks);
    });
    card.addEventListener('click', (e) => {
      if (e.target.closest('.album-play-btn') || e.target.closest('.gallery-del')) return;
      if (cfg.tracks.length) playTrack(cfg.tracks[0], cfg.tracks);
    });
    return card;
  }

  // Monta a secao "Mixes para voce" dentro de um elemento carrossel ja existente
  async function renderMixes(carouselId) {
    const carousel = document.getElementById(carouselId);
    if (!carousel) return;
    const defs = [
      { kind: 'mix', name: 'Mix do dia', subtitle: 'baseado no seu gosto' },
      { kind: 'discover', name: 'Descobrir', subtitle: 'artistas novos para voce' },
    ];
    carousel.replaceChildren();
    for (const d of defs) {
      const tracks = await buildMix(d.kind);
      if (!tracks.length) continue;
      carousel.appendChild(mixCard({
        name: d.name,
        subtitle: tracks.length + ' faixas \u00B7 ' + d.subtitle,
        tracks,
        cover: tracks[0] && tracks[0].cover,
      }));
    }
    if (!carousel.children.length) {
      const p = document.createElement('p');
      p.style.cssText = 'font-size:12px;color:var(--text-muted)';
      p.textContent = 'Curta algumas faixas e adicione gostos no Perfil para gerar seus mixes.';
      carousel.appendChild(p);
    }
    if (typeof attachCarouselArrows === 'function') attachCarouselArrows(carouselId.replace('-carousel', ''));
  }

  // Monta a faixa "Novidades para voce"
  async function renderNews(rowId, sectionId) {
    const row = document.getElementById(rowId);
    const section = sectionId ? document.getElementById(sectionId) : null;
    if (!row) return;
    const items = await loadNews();
    if (!items.length) { if (section) section.style.display = 'none'; return; }
    if (section) section.style.display = '';

    row.replaceChildren();
    items.forEach(it => {
      const card = document.createElement('div');
      card.className = 'exp-related-card';
      const img = document.createElement('img');
      img.src = 'https://i.ytimg.com/vi/' + it.videoId + '/mqdefault.jpg';
      img.alt = ''; img.loading = 'lazy';
      const label = document.createElement('div');
      label.className = 'exp-related-label';
      label.textContent = it.title;
      const meta = document.createElement('div');
      meta.className = 'exp-related-label';
      meta.style.cssText = 'color:var(--text-muted);font-size:10.5px';
      meta.textContent = [it.author, it.publishedText].filter(Boolean).join(' \u00B7 ');
      card.appendChild(img); card.appendChild(label); card.appendChild(meta);
      card.addEventListener('click', () => {
        const queue = items.map(x => materializeYtTrack(x.videoId, x.title, x.author, x.duration));
        const track = materializeYtTrack(it.videoId, it.title, it.author, it.duration);
        playTrack(track, queue);
      });
      row.appendChild(card);
    });
  }

  async function refreshAll(carouselId, rowId, sectionId) {
    mixCache.clear();
    try { localStorage.removeItem(NEWS_CACHE_KEY); } catch (_) {}
    await renderMixes(carouselId);
    await renderNews(rowId, sectionId);
  }

  return {
    recordLike, hydrateLikes, buildProfile,
    buildMix, saveMixAsPlaylist, loadNews,
    renderMixes, renderNews, refreshAll,
  };
})();
