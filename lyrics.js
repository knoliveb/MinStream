/*
 * MinStream — lyrics.js
 *
 * Letra da música sincronizada (estilo Spotify) via LRCLIB
 * (https://lrclib.net — serviço aberto, gratuito e sem API key; as letras
 * sincronizadas usam o formato LRC, com timestamp por linha).
 *
 * Este módulo é 100% autocontido e NÃO altera a lógica de negócios do app:
 *  - apenas LÊ o estado global (state, isExpanded, expandedIsMobile, ytPlayer)
 *    exposto por app.js (carregado antes deste arquivo);
 *  - escreve somente nos dois containers de letra do HTML
 *    (#exp-lyrics no player expandido desktop e #mp-lyrics no player mobile),
 *    posicionados após os controles e antes de "Videoclipes relacionados";
 *  - a única função do app reutilizada é seekToTime() (clique numa linha
 *    sincronizada busca aquele instante), o mesmo caminho da barra de
 *    progresso — nenhuma lógica de reprodução nova.
 *
 * Apresentação:
 *  - o fundo do container é OPACO e a cor acompanha a cor de destaque da
 *    capa da faixa (amostragem da thumbnail via canvas; fallback escuro
 *    neutro quando a capa é acinzentada ou não pode ser lida);
 *  - a rolagem ACOMPANHA a letra: um seguidor contínuo (rAF) desliza o
 *    scroll suavemente até a linha ativa, com velocidade limitada — nada
 *    de saltos bruscos por linha; rolagem manual pausa o seguidor por ~4s;
 *  - no canto superior direito do container há um alternador
 *    "Sincronizada / Sem sincronia": exibe a letra acompanhando a música
 *    ou o texto completo estático (preferência persistida).
 *
 * Estados exibidos no container:
 *  - "Buscando letra…"          enquanto consulta o LRCLIB;
 *  - letra sincronizada          linha ativa destacada + rolagem contínua;
 *  - letra estática              sem timestamps ou com a sincronia desligada;
 *  - "Sem letra disponível"      quando nada foi encontrado (ou instrumental).
 *
 * A exibição pode ser ligada/desligada em Perfil > Configurações (como as
 * demais funcionalidades). Preferências persistidas (e incluídas no
 * Takeout pelo prefixo minstream_):
 *  - 'minstream_lyrics'       exibir/ocultar a seção ('1' padrão);
 *  - 'minstream_lyrics_sync'  modo sincronizado on/off ('1' padrão).
 */
const Lyrics = (function () {
  'use strict';

  // ---------------------------------------------------------------
  // Preferências do usuário
  // ---------------------------------------------------------------
  const PREF_KEY = 'minstream_lyrics';      // seção visível: '1' (padrão) | '0'
  const SYNC_KEY = 'minstream_lyrics_sync'; // modo sincronizado: '1' (padrão) | '0'

  function enabled() {
    try { return localStorage.getItem(PREF_KEY) !== '0'; } catch (_) { return true; }
  }
  function setEnabled(on) {
    try { localStorage.setItem(PREF_KEY, on ? '1' : '0'); } catch (_) {}
    applyVisibility();
    // Desligou a letra com a tela cheia aberta: ela sai junto
    if (!on) closePage();
  }

  function syncOn() {
    try { return localStorage.getItem(SYNC_KEY) !== '0'; } catch (_) { return true; }
  }
  function setSyncOn(on) {
    try { localStorage.setItem(SYNC_KEY, on ? '1' : '0'); } catch (_) {}
  }

  // ---------------------------------------------------------------
  // Referências de DOM (os dois containers de letra)
  // ---------------------------------------------------------------
  const els = {
    exp: {
      root: document.getElementById('exp-lyrics'),
      box: document.getElementById('exp-lyrics-box'),
      scroll: document.getElementById('exp-lyrics-scroll'),
      sync: document.getElementById('exp-lyrics-sync'),
      translate: document.getElementById('exp-lyrics-translate'),
      share: document.getElementById('exp-lyrics-share'),
      expand: document.getElementById('exp-lyrics-expand'),
    },
    mp: {
      root: document.getElementById('mp-lyrics'),
      box: document.getElementById('mp-lyrics-box'),
      scroll: document.getElementById('mp-lyrics-scroll'),
      sync: document.getElementById('mp-lyrics-sync'),
      translate: document.getElementById('mp-lyrics-translate'),
      share: document.getElementById('mp-lyrics-share'),
      expand: document.getElementById('mp-lyrics-expand'),
    },
  };

  function eachSide(fn) { fn(els.exp); fn(els.mp); }

  function applyVisibility() {
    const on = enabled();
    eachSide(s => { if (s.root) s.root.classList.toggle('hidden', !on); });
  }

  // ---------------------------------------------------------------
  // Leitura segura do estado global do app (somente leitura)
  // ---------------------------------------------------------------
  function appState() {
    try { return (typeof state !== 'undefined') ? state : null; } catch (_) { return null; }
  }
  function playerOpen() {
    try { return (typeof isExpanded !== 'undefined') && !!isExpanded; } catch (_) { return false; }
  }
  function openIsMobile() {
    try { return (typeof expandedIsMobile !== 'undefined') && !!expandedIsMobile; } catch (_) { return false; }
  }
  // Tempo "ao vivo": lê direto do player do YouTube quando possível (mais
  // fluido que o poll de 500ms do app); senão, usa state.currentTime.
  function liveTime() {
    const st = appState();
    try {
      if (typeof ytPlayer !== 'undefined' && ytPlayer && st && st.apiReady) {
        const t = ytPlayer.getCurrentTime();
        if (typeof t === 'number' && isFinite(t)) return t;
      }
    } catch (_) {}
    return (st && st.currentTime) || 0;
  }

  // ---------------------------------------------------------------
  // Normalização / limpeza de metadados vindos do YouTube
  // ---------------------------------------------------------------
  function norm(s) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const PROMO_RE = /\b(off?icial|oficial|video\s*clipe|videoclipe|clipe|music\s*video|video|v[ií]deo|lyric(s)?|letra|audio|[áa]udio|visuali[sz]er|remaster(ed)?|legendad[oa]|subtitulad[oa]|color\s*coded|karaoke|hd|hq|4k|m\/?v|dvd|prod\.?|performance|vers[aã]o\s+estendida|extended|ao\s+vivo|live)\b/i;

  function cleanArtist(raw) {
    return String(raw || '')
      .replace(/\s*-\s*topic\s*$/i, '')
      .replace(/vevo\s*$/i, '')
      .replace(/\s*\((oficial|official)\)\s*$/i, '')
      .trim();
  }

  function cleanTitle(raw, artist) {
    let s = String(raw || '').trim();
    // Remove blocos entre (), [] e {} que contenham termos promocionais
    s = s.replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, seg => (PROMO_RE.test(seg) ? ' ' : seg));
    // Corta sufixos após "|" (geralmente nome de programa/canal)
    s = s.replace(/\s*\|.*$/, '');
    // Termos promocionais soltos no fim do título
    s = s.replace(/\b(official\s+(music\s+)?video|videoclipe\s+oficial|clipe\s+oficial|lyric\s+video|official\s+audio)\b/gi, ' ');
    // Remove o prefixo "Artista - " quando bate com o canal
    const a = cleanArtist(artist);
    if (a) {
      const parts = s.split(/\s*[-–—:]\s+/);
      if (parts.length > 1 && norm(parts[0]) && norm(parts[0]) === norm(a)) {
        s = parts.slice(1).join(' - ');
      }
    }
    s = s.replace(/["“”'’]/g, ' ').replace(/\s+/g, ' ').trim();
    return s;
  }

  // "Artista - Faixa" dentro do próprio título (muito comum no YouTube)
  function splitArtistTitle(raw) {
    const s = cleanTitle(raw, '');
    const m = s.split(/\s+[-–—]\s+/);
    if (m.length >= 2 && m[0].trim() && m.slice(1).join(' ').trim()) {
      return { artist: m[0].trim(), title: m.slice(1).join(' ').trim() };
    }
    return null;
  }

  // ---------------------------------------------------------------
  // LRCLIB — busca e escolha do melhor resultado
  // ---------------------------------------------------------------
  const API = 'https://lrclib.net/api/search';
  const FETCH_TIMEOUT = 8000;

  function apiSearch(params) {
    const url = API + '?' + new URLSearchParams(params).toString();
    const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, FETCH_TIMEOUT) : null;
    return fetch(url, ctrl ? { signal: ctrl.signal } : undefined)
      .then(res => {
        if (!res.ok) throw new Error('http ' + res.status);
        return res.json();
      })
      .then(json => (Array.isArray(json) ? json : []))
      .finally(() => { if (timer) clearTimeout(timer); });
  }

  function scoreResult(r, ctx) {
    const hasSync = !!(r.syncedLyrics && String(r.syncedLyrics).trim());
    const hasPlain = !!(r.plainLyrics && String(r.plainLyrics).trim());
    if (!hasSync && !hasPlain && !r.instrumental) return -Infinity;

    let s = hasSync ? 3 : 0;

    // Duração: forte sinal de que é a mesma gravação
    if (ctx.duration > 0 && typeof r.duration === 'number' && r.duration > 0) {
      const d = Math.abs(r.duration - ctx.duration);
      if (d <= 2) s += 4;
      else if (d <= 5) s += 3;
      else if (d <= 10) s += 1;
      else if (d > 25) s -= 3;
    }
    // Afinidade de artista
    const ra = norm(r.artistName), ca = norm(ctx.artist);
    if (ca && ra && (ra === ca || ra.includes(ca) || ca.includes(ra))) s += 2;
    // Afinidade de título
    const rt = norm(r.trackName), ct = norm(ctx.title);
    if (ct && rt) {
      if (rt === ct) s += 2;
      else if (rt.includes(ct) || ct.includes(rt)) s += 1;
    }
    return s;
  }

  function pickBest(results, ctx) {
    let best = null, bestScore = -Infinity;
    (results || []).forEach(r => {
      if (!r) return;
      const s = scoreResult(r, ctx);
      if (s > bestScore) { bestScore = s; best = r; }
    });
    return (best && bestScore > -Infinity) ? best : null;
  }

  // ---------------------------------------------------------------
  // Parser de LRC ([mm:ss.xx] linha) — suporta várias tags por linha
  // ---------------------------------------------------------------
  function parseLrc(text) {
    const out = [];
    const tag = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
    String(text || '').split(/\r?\n/).forEach(line => {
      tag.lastIndex = 0;
      let m, end = 0;
      const times = [];
      while ((m = tag.exec(line))) {
        const frac = (m[3] || '0').padEnd(3, '0').slice(0, 3);
        times.push((+m[1]) * 60 + (+m[2]) + (+frac) / 1000);
        end = tag.lastIndex;
      }
      if (!times.length) return; // linha de metadados ([ar:], [ti:], …) ou solta
      const txt = line.slice(end).trim();
      times.forEach(t => out.push({ t, text: txt }));
    });
    out.sort((a, b) => a.t - b.t);
    return out;
  }

  function linesToPlain(lines) {
    return lines.map(l => l.text).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // ---------------------------------------------------------------
  // Cor de destaque da capa -> fundo opaco do container
  // A thumbnail (mqdefault, 16:9 sem tarjas) é amostrada num canvas
  // pequeno; a cor mais "viva" (ponderada por saturação × brilho) vira o
  // fundo em tom escuro (contraste estável com o texto claro). Capas
  // acinzentadas ou ilegíveis (CORS) caem no fallback neutro do CSS.
  // ---------------------------------------------------------------
  const colorCache = new Map(); // url -> cor css (ou null p/ fallback)

  function coverUrlOf(t) {
    if (!t) return null;
    return t.videoId
      ? ('https://i.ytimg.com/vi/' + t.videoId + '/mqdefault.jpg')
      : (t.cover || null);
  }

  function setLyricsBg(color) {
    eachSide(s => {
      if (!s.root) return;
      if (color) s.root.style.setProperty('--lyrics-bg', color);
      else s.root.style.removeProperty('--lyrics-bg');
    });
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
    else if (max === g) h = ((b - r) / d + 2);
    else h = ((r - g) / d + 4);
    return { h: h * 60, s, l };
  }

  function computeAccentColor(img) {
    const canvas = document.createElement('canvas');
    const W = 32, H = 18;
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext && canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, W, H);
    const data = ctx.getImageData(0, 0, W, H).data; // lança se a imagem for "tainted"

    // Buckets por matiz (30° cada), ponderados por saturação × brilho
    const B = 12;
    const wSum = new Array(B).fill(0);
    const rSum = new Array(B).fill(0), gSum = new Array(B).fill(0), bSum = new Array(B).fill(0);
    let colored = 0;

    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const { h, s, l } = rgbToHsl(r, g, b);
      if (l < 0.1 || l > 0.92 || s < 0.15) continue; // sem cor útil
      const w = s * (0.4 + 0.6 * l);
      const k = Math.min(B - 1, Math.floor(h / (360 / B)));
      wSum[k] += w; rSum[k] += r * w; gSum[k] += g * w; bSum[k] += b * w;
      colored += w;
    }

    if (colored < 4) return null; // capa acinzentada: usa o fallback neutro

    let best = 0;
    for (let k = 1; k < B; k++) if (wSum[k] > wSum[best]) best = k;
    const w = wSum[best] || 1;
    const { h, s } = rgbToHsl(rSum[best] / w, gSum[best] / w, bSum[best] / w);
    // Tom escuro e opaco: matiz da capa, saturação moderada, luz baixa
    const s2 = Math.round(Math.min(0.62, Math.max(0.28, s)) * 100);
    return 'hsl(' + Math.round(h) + ', ' + s2 + '%, 24%)';
  }

  function applyAccent(key, track) {
    const url = coverUrlOf(track);
    if (!url) { setLyricsBg(null); return; }
    if (colorCache.has(url)) { setLyricsBg(colorCache.get(url)); return; }
    try {
      const img = document.createElement('img');
      img.crossOrigin = 'anonymous'; // i.ytimg.com envia CORS; permite ler pixels
      img.decoding = 'async';
      img.onload = () => {
        let color = null;
        try { color = computeAccentColor(img); } catch (_) { color = null; }
        colorCache.set(url, color);
        if (colorCache.size > 80) {
          const first = colorCache.keys().next().value;
          if (first !== undefined) colorCache.delete(first);
        }
        if (key === curKey) setLyricsBg(color);
      };
      img.onerror = () => { if (key === curKey) setLyricsBg(null); };
      img.src = url;
    } catch (_) { setLyricsBg(null); }
  }

  // ---------------------------------------------------------------
  // Busca por faixa, com cache em memória
  // ---------------------------------------------------------------
  const cache = new Map(); // key -> entry
  const CACHE_CAP = 60;
  const inflight = new Set();
  let fetchToken = 0;

  function cachePut(key, entry) {
    cache.set(key, entry);
    if (cache.size > CACHE_CAP) {
      const first = cache.keys().next().value;
      if (first !== undefined) cache.delete(first);
    }
  }

  function entryFrom(best) {
    if (!best) return { status: 'none' };
    const plain = (best.plainLyrics && String(best.plainLyrics).trim()) || '';
    const syncedRaw = (best.syncedLyrics && String(best.syncedLyrics).trim()) || '';
    if (syncedRaw) {
      const lines = parseLrc(syncedRaw);
      if (lines.length >= 2) {
        return { status: 'synced', lines, plain: plain || linesToPlain(lines) };
      }
    }
    if (plain) return { status: 'plain', plain };
    if (best.instrumental) return { status: 'instrumental' };
    return { status: 'none' };
  }

  async function fetchLyrics(key, track) {
    inflight.add(key);
    const token = ++fetchToken;
    const st = appState();
    const ctx = {
      artist: cleanArtist(track.artist),
      title: cleanTitle(track.title, track.artist),
      duration: (track.duration && track.duration > 0)
        ? track.duration
        : ((st && st.duration) || 0),
    };
    const split = splitArtistTitle(track.title);

    // Tentativas em ordem de precisão (para no primeiro resultado sincronizado)
    const attempts = [];
    if (ctx.title && ctx.artist) attempts.push({ track_name: ctx.title, artist_name: ctx.artist });
    if (split) attempts.push({ track_name: split.title, artist_name: split.artist });
    if (ctx.title) attempts.push({ q: (ctx.artist ? ctx.artist + ' ' : '') + ctx.title });
    if (split) attempts.push({ q: split.artist + ' ' + split.title });
    if (ctx.title) attempts.push({ q: ctx.title });

    const seen = new Set();
    let bestOverall = null, bestOverallScore = -Infinity, failed = 0, total = 0;

    for (const params of attempts) {
      const sig = JSON.stringify(params);
      if (seen.has(sig)) continue;
      seen.add(sig);
      total++;
      try {
        const results = await apiSearch(params);
        if (key !== curKey || token !== fetchToken) break; // faixa mudou, aborta
        const best = pickBest(results, ctx);
        if (best) {
          const s = scoreResult(best, ctx);
          if (s > bestOverallScore) { bestOverall = best; bestOverallScore = s; }
          if (best.syncedLyrics && String(best.syncedLyrics).trim()) break; // achamos sincronizada
        }
      } catch (_) { failed++; }
      if (seen.size >= 4) break; // teto de consultas por faixa
    }

    inflight.delete(key);
    const entry = entryFrom(bestOverall);
    // Falha de rede em todas as tentativas: não grava cache negativo
    // (uma reabertura do player tenta de novo)
    entry.transient = (entry.status === 'none' && total > 0 && failed === total);
    if (!entry.transient) cachePut(key, entry);
    if (key === curKey) { cur = entry; renderCurrent(); }
  }

  // ---------------------------------------------------------------
  // Render nos dois containers
  // ---------------------------------------------------------------
  let curKey = null;      // videoId/id da faixa corrente
  let cur = null;         // entry corrente ({status, ...}) ou null (não buscada)
  let activeIdx = -1;     // índice da linha ativa (modo sincronizado)
  let lineEls = { exp: [], mp: [] };
  let userScrollUntil = 0; // pausa o seguidor após rolagem manual
  let progScrollUntil = 0; // marca escritas de scroll do próprio módulo
  let wasOpen = false;
  let translated = false;  // exibindo a tradução da letra?
  let translatedText = ''; // texto traduzido em exibição (para as telas cheias)
  const translateCache = new Map(); // texto -> tradução (por sessão)

  const reducedMotion = (typeof matchMedia === 'function')
    ? matchMedia('(prefers-reduced-motion: reduce)')
    : { matches: false };

  // Altura do cabeçalho fixo (para o seguidor centralizar abaixo dele)
  function headerHeight(vk) {
    const box = els[vk] && els[vk].scroll;
    if (!box) return 0;
    const h = box.querySelector('.lyrics-header');
    return h ? h.offsetHeight : 0;
  }

  // ---------------------------------------------------------------
  // Superfícies de letra em TELA CHEIA
  // Duas telas mostram a MESMA letra fora do container padrão: o
  // overlay do desktop (botão expandir) e a página de letra do mobile
  // (toque no container). Em vez de duplicar o destaque da linha ativa
  // e o seguidor de rolagem, cada uma se registra aqui e o módulo cuida
  // das duas do mesmo jeito.
  //   cfg = { isOpen(), getScroll(), close(), onFill? }
  // ---------------------------------------------------------------
  const surfaces = [];

  function addSurface(cfg) {
    const s = Object.assign({ lines: [], activeIdx: -1 }, cfg);
    surfaces.push(s);
    return s;
  }

  function hasLyricsNow() {
    return !!cur && (cur.status === 'synced' || cur.status === 'plain');
  }

  function fillSurface(s) {
    const scroll = s.getScroll();
    if (!scroll) return;
    if (translated && translatedText) {
      // Exibindo a tradução: as telas cheias mostram o mesmo texto
      const d = document.createElement('div');
      d.className = 'lyrics-plain';
      d.textContent = translatedText;
      scroll.replaceChildren(d);
      s.lines = [];
    } else {
      scroll.replaceChildren(buildContent(cur));
      s.lines = Array.from(scroll.querySelectorAll('.lyrics-line'));
    }
    scroll.scrollTop = 0;
    s.activeIdx = -1;
    if (s.onFill) s.onFill();
  }

  // Copia o fundo adaptativo (cor da capa) do container visível para uma
  // tela cheia, que vive fora dele e não herdaria a variável.
  function inheritBg(el) {
    if (!el) return;
    const vk = visibleSide() || 'exp';
    const bg = els[vk] && els[vk].root && els[vk].root.style.getPropertyValue('--lyrics-bg');
    if (bg) el.style.setProperty('--lyrics-bg', bg);
    else el.style.removeProperty('--lyrics-bg');
  }

  // Faixa/letra mudou com uma tela cheia aberta: refaz o conteúdo — e
  // fecha a tela quando a nova faixa não tem letra para mostrar.
  function syncSurfaces() {
    surfaces.forEach(s => {
      if (!s.isOpen()) return;
      if (!hasLyricsNow()) { s.close(); return; }
      fillSurface(s);
    });
  }

  // ---------------------------------------------------------------
  // Overlay de tela cheia do DESKTOP (botão expandir): mostra a letra
  // em foco, com o mesmo fundo adaptativo e o acompanhamento da linha.
  // ---------------------------------------------------------------
  let overlayEl = null;
  let overlayScroll = null;

  function buildOverlay() {
    if (overlayEl) return overlayEl;
    const ov = document.createElement('div');
    ov.className = 'lyrics-overlay hidden';
    ov.innerHTML =
      '<div class="lyrics-overlay-inner">' +
      '  <div class="lyrics-overlay-head">' +
      '    <span class="lyrics-label">Letra</span>' +
      '    <button class="lyrics-act lyrics-overlay-close" title="Fechar">' +
      '      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>' +
      '    </button>' +
      '  </div>' +
      '  <div class="lyrics-overlay-scroll" id="lyrics-overlay-scroll"></div>' +
      '</div>';
    document.body.appendChild(ov);
    overlayScroll = ov.querySelector('.lyrics-overlay-scroll');
    ov.querySelector('.lyrics-overlay-close').addEventListener('click', closeOverlay);
    ov.addEventListener('click', e => { if (e.target === ov) closeOverlay(); });
    overlayScroll.addEventListener('click', e => {
      const line = e.target && e.target.closest ? e.target.closest('.lyrics-line') : null;
      if (!line || !line.dataset.t) return;
      const t = parseFloat(line.dataset.t);
      if (isFinite(t) && typeof seekToTime === 'function') { try { seekToTime(t); } catch (_) {} }
    });
    overlayEl = ov;
    return ov;
  }

  function overlayOpen() { return !!(overlayEl && !overlayEl.classList.contains('hidden')); }

  function closeOverlay() {
    if (overlayEl) overlayEl.classList.add('hidden');
    document.body.classList.remove('lyrics-overlay-open');
  }

  const overlaySurface = addSurface({
    isOpen: overlayOpen,
    getScroll: () => overlayScroll,
    close: closeOverlay,
    onFill: () => inheritBg(overlayEl),
  });

  function openOverlay() {
    if (!hasLyricsNow()) return;
    buildOverlay();
    fillSurface(overlaySurface);
    overlayEl.classList.remove('hidden');
    document.body.classList.add('lyrics-overlay-open');
  }

  // ---------------------------------------------------------------
  // Página de letra em TELA CHEIA do MOBILE
  // Tocar no container de Letra do #mobile-player abre esta tela; o
  // botão de fechar (ou Esc) volta para a tela anterior, com a mesma
  // animação ao contrário. SÓ abre quando há letra carregada — com
  // "Buscando letra…", "Sem letra disponível" ou faixa instrumental o
  // toque não faz nada. O transporte (progresso, tempos e play/pause)
  // é do app.js; aqui ficam a letra e os botões de traduzir/compartilhar.
  // ---------------------------------------------------------------
  const page = {
    root: document.getElementById('lyrics-page'),
    scroll: document.getElementById('lp-scroll'),
    close: document.getElementById('lp-close'),
    translate: document.getElementById('lp-translate'),
    share: document.getElementById('lp-share'),
  };

  function pageOpen() { return !!(page.root && page.root.classList.contains('open')); }

  // Condições para abrir: existe a tela, a letra está ligada nas
  // configurações, o player aberto é o mobile e há letra de fato.
  function canOpenPage() {
    return !!(page.root && enabled() && openIsMobile() && hasLyricsNow());
  }

  const pageSurface = addSurface({
    isOpen: pageOpen,
    getScroll: () => page.scroll,
    close: closePage,
    onFill: () => inheritBg(page.root),
  });

  function openPage() {
    if (!canOpenPage() || pageOpen()) return;
    fillSurface(pageSurface);
    page.root.classList.add('open');
    page.root.setAttribute('aria-hidden', 'false');
    document.body.classList.add('lyrics-page-open');
    // Título/artista, progresso e play/pause vêm do app.js
    try { if (typeof syncLyricsPage === 'function') syncLyricsPage(); } catch (_) {}
  }

  function closePage() {
    if (!page.root) return;
    page.root.classList.remove('open');
    page.root.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('lyrics-page-open');
  }

  function statusNode(text) {
    const d = document.createElement('div');
    d.className = 'lyrics-status';
    d.textContent = text;
    return d;
  }

  function showingSynced() {
    return !!(cur && cur.status === 'synced' && syncOn());
  }

  function creditNode() {
    // Crédito ao LRCLIB DENTRO do container, ao fim da letra. A distância
    // de ~5 linhas em relação à letra vem da classe .lyrics-credit (CSS).
    const d = document.createElement('div');
    d.className = 'lyrics-credit';
    d.textContent = 'Letras fornecidas por LRCLIB';
    return d;
  }

  function buildContent(entry) {
    const frag = document.createDocumentFragment();
    let hasLyrics = false;
    if (!entry || entry.status === 'loading' || entry.status === 'idle') {
      frag.appendChild(statusNode('Buscando letra\u2026'));
    } else if (entry.status === 'synced' && syncOn()) {
      entry.lines.forEach((l, i) => {
        const d = document.createElement('div');
        d.className = 'lyrics-line seekable';
        d.dataset.t = String(l.t);
        d.dataset.i = String(i);
        d.textContent = l.text || '\u266A'; // pausas instrumentais viram ♪
        frag.appendChild(d);
      });
      hasLyrics = true;
    } else if ((entry.status === 'synced' && !syncOn()) || entry.status === 'plain') {
      const d = document.createElement('div');
      d.className = 'lyrics-plain';
      d.textContent = entry.plain;
      frag.appendChild(d);
      hasLyrics = true;
    } else if (entry.status === 'instrumental') {
      frag.appendChild(statusNode('\u266A Faixa instrumental \u2014 sem letra dispon\u00EDvel'));
    } else {
      frag.appendChild(statusNode('Sem letra dispon\u00EDvel'));
    }
    if (hasLyrics) frag.appendChild(creditNode());
    return frag;
  }

  function renderCurrent() {
    activeIdx = -1;
    userScrollUntil = 0;
    translated = false; // nova faixa/estado: volta ao texto original
    translatedText = '';
    const entry = cur;
    const canSync = !!(entry && entry.status === 'synced');
    const sOn = syncOn();
    const hasLyrics = !!(entry && (entry.status === 'synced' || entry.status === 'plain'));

    // DESKTOP: quando a busca resolve e NAO ha letra para exibir
    // ("Sem letra disponivel" ou faixa instrumental), o container inteiro
    // some — o palco fica centralizado e a pagina nao mostra um cartao
    // vazio so com o aviso. A classe so vai no container desktop
    // (#exp-lyrics): o player mobile mantem o aviso visivel, como antes.
    // Se a proxima faixa tiver letra, a classe sai aqui mesmo e o
    // container reaparece sozinho. A preferencia do usuario
    // (Perfil > Configuracoes) continua mandando via .hidden.
    const noLyrics = !!entry && (entry.status === 'none' || entry.status === 'instrumental');

    // LAYOUT MODERNO: enquanto a busca ainda nao resolveu, o container
    // tambem fica fora da tela. A letra e carregada em segundo plano e o
    // painel so entra quando ha texto de verdade — nada de "Buscando
    // letra…" ocupando metade da largura ao lado do palco. No classico o
    // aviso continua aparecendo (ali a letra fica ABAIXO do palco e nao
    // rouba espaco de nada), e o mobile segue igual.
    const pending = !hasLyrics && !noLyrics;
    if (els.exp.root) {
      els.exp.root.classList.toggle('lyrics-none', noLyrics);
      els.exp.root.classList.toggle('lyrics-pending', pending);
    }

    eachSide(side => {
      if (!side.scroll) return;
      side.scroll.replaceChildren(buildContent(entry));
      side.scroll.scrollTop = 0;
      // Botão de sincronização (ícone): só quando há letra sincronizada
      if (side.sync) {
        side.sync.classList.toggle('hidden', !canSync);
        side.sync.classList.toggle('on', canSync && sOn);
        side.sync.setAttribute('aria-pressed', String(canSync && sOn));
        side.sync.title = sOn
          ? 'Letra sincronizada — tocar para ver o texto completo'
          : 'Texto completo — tocar para sincronizar com a música';
      }
      // Traduzir e compartilhar: aparecem sempre que há letra
      if (side.translate) {
        side.translate.classList.toggle('hidden', !hasLyrics);
        side.translate.classList.remove('on');
        side.translate.setAttribute('aria-pressed', 'false');
      }
      if (side.share) side.share.classList.toggle('hidden', !hasLyrics);
      // Expandir (só desktop; o botão nem existe no mobile)
      if (side.expand) side.expand.classList.toggle('hidden', !hasLyrics);
    });
    lineEls.exp = side2Lines(els.exp);
    lineEls.mp = side2Lines(els.mp);
    // Botões da página mobile em tela cheia (traduzir/compartilhar)
    if (page.translate) {
      page.translate.classList.remove('on', 'busy');
      page.translate.setAttribute('aria-pressed', 'false');
    }
    syncSurfaces();
  }

  function side2Lines(side) {
    return side.scroll ? Array.from(side.scroll.querySelectorAll('.lyrics-line')) : [];
  }

  // ---------------------------------------------------------------
  // Sincronização da linha ativa
  // ---------------------------------------------------------------
  const LEAD = 0.15; // antecipação leve, como players de letra costumam usar

  function findActiveIndex(lines, time) {
    // última linha com t <= time (busca binária)
    let lo = 0, hi = lines.length - 1, ans = -1;
    const t = time + LEAD;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].t <= t) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

  function visibleSide() {
    if (!playerOpen()) return null;
    return openIsMobile() ? 'mp' : 'exp';
  }

  function updateActive() {
    if (!showingSynced()) return;
    const idx = findActiveIndex(cur.lines, liveTime());
    if (idx === activeIdx) { ensureFollow(); return; }
    activeIdx = idx;

    ['exp', 'mp'].forEach(k => {
      const arr = lineEls[k];
      for (let i = 0; i < arr.length; i++) {
        arr[i].classList.toggle('active', i === idx);
        arr[i].classList.toggle('past', i < idx);
      }
    });
    // Espelha o destaque nas telas cheias abertas (overlay e página)
    surfaces.forEach(s => {
      if (!s.isOpen() || !s.lines.length) return;
      for (let i = 0; i < s.lines.length; i++) {
        s.lines[i].classList.toggle('active', i === idx);
        s.lines[i].classList.toggle('past', i < idx);
      }
      s.activeIdx = idx;
    });
    ensureFollow();
  }

  // ---------------------------------------------------------------
  // Seguidor de rolagem: o scroll ACOMPANHA a letra continuamente.
  // Em vez de "pular" a cada troca de linha, um loop rAF desliza o
  // scrollTop rumo ao centro da linha ativa com aproximação exponencial
  // (constante de tempo ~600ms) e velocidade máxima limitada — movimento
  // suave e constante, no ritmo da música. Rolagem manual pausa o
  // seguidor por ~4s; prefers-reduced-motion posiciona sem animar.
  // ---------------------------------------------------------------
  const FOLLOW_TAU = 600;      // ms — quanto maior, mais suave/lento
  const FOLLOW_MAX_V = 0.9;    // px por ms (teto de velocidade ~900px/s)
  let followRaf = null;
  let followLast = 0;

  function nowMs() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  function followConditions() {
    return enabled() && playerOpen() && showingSynced() && activeIdx >= 0;
  }

  function ensureFollow() {
    if (followRaf != null) return;
    if (typeof requestAnimationFrame !== 'function') return;
    if (!followConditions()) return;
    followLast = nowMs();
    followRaf = requestAnimationFrame(followStep);
  }

  function followStep(ts) {
    if (!followConditions()) { followRaf = null; return; }
    followRaf = requestAnimationFrame(followStep);

    const dt = Math.min(100, Math.max(1, ts - followLast));
    followLast = ts;

    if (Date.now() < userScrollUntil) return; // usuário está lendo/rolando
    progScrollUntil = Date.now() + 300;       // escritas nossas, não do usuário

    // Telas cheias abertas acompanham a linha ativa, centralizada. Vêm
    // primeiro porque são o que o usuário está vendo quando abertas — e
    // não dependem do container pequeno ter linhas.
    surfaces.forEach(s => {
      if (!s.isOpen() || s.activeIdx < 0) return;
      const sc = s.getScroll();
      const sline = s.lines[s.activeIdx];
      if (!sc || !sline) return;
      const smax = Math.max(0, sc.scrollHeight - sc.clientHeight);
      const starget = Math.max(0, Math.min(
        sline.offsetTop - sc.clientHeight / 2 + sline.clientHeight / 2, smax));
      const sdiff = starget - sc.scrollTop;
      if (Math.abs(sdiff) < 0.5) return;
      if (reducedMotion.matches) { sc.scrollTop = starget; return; }
      let sstep = sdiff * (1 - Math.exp(-dt / FOLLOW_TAU));
      const smaxStep = FOLLOW_MAX_V * dt;
      if (sstep > smaxStep) sstep = smaxStep;
      else if (sstep < -smaxStep) sstep = -smaxStep;
      sc.scrollTop += sstep;
    });

    const vk = visibleSide();
    if (!vk) return;
    const box = els[vk].scroll;
    const line = lineEls[vk][activeIdx];
    if (!box || !line) return;

    // Centraliza a linha ativa na área VISÍVEL (abaixo do cabeçalho fixo),
    // para que ela não fique escondida sob o header ao acompanhar.
    const headH = headerHeight(vk);
    const viewH = box.clientHeight - headH;
    const maxScroll = Math.max(0, box.scrollHeight - box.clientHeight);
    const target = Math.max(0, Math.min(
      line.offsetTop - headH - viewH / 2 + line.clientHeight / 2,
      maxScroll));
    const diff = target - box.scrollTop;
    if (Math.abs(diff) < 0.5) return;

    if (reducedMotion.matches) { box.scrollTop = target; return; }

    // Aproximação exponencial independente de frame-rate + teto de velocidade
    let step = diff * (1 - Math.exp(-dt / FOLLOW_TAU));
    const maxStep = FOLLOW_MAX_V * dt;
    if (step > maxStep) step = maxStep;
    else if (step < -maxStep) step = -maxStep;
    box.scrollTop += step;
  }

  // ---------------------------------------------------------------
  // Loop principal: observa a faixa corrente e o player aberto
  // ---------------------------------------------------------------
  function tick() {
    if (!enabled()) return;
    if (document.hidden) return;

    const st = appState();
    const t = st ? st.currentTrack : null;
    const key = t ? (t.videoId || t.id) : null;

    if (key !== curKey) {
      curKey = key;
      cur = key ? null : { status: 'none' };
      renderCurrent();
      applyAccent(key, t); // fundo acompanha a cor da capa
    }
    if (!key) return;

    const open = playerOpen();
    // A tela cheia da letra vive por cima do player mobile: se o player
    // fechou, virou desktop ou a letra foi desligada nas configurações,
    // ela se fecha sozinha (rede de segurança — o caminho normal é o
    // botão de fechar ou o closeExpanded do app.js).
    if (pageOpen() && (!open || !openIsMobile() || !enabled())) closePage();

    // Reabriu o player após uma falha de rede: tenta de novo
    if (open && !wasOpen && cur && cur.transient) cur = null;
    wasOpen = open;

    if (!cur) {
      const hit = cache.get(key);
      if (hit) {
        cur = hit;
        renderCurrent();
      } else if (open && !inflight.has(key)) {
        // Busca sob demanda: só consulta o LRCLIB com um player aberto
        fetchLyrics(key, t);
      }
    }

    if (open) updateActive();
  }

  // ---------------------------------------------------------------
  // Interações: alternador de sincronia, rolagem manual e
  // clique-para-buscar (linhas sincronizadas)
  // ---------------------------------------------------------------
  // ---------------------------------------------------------------
  // Interações: botões do cabeçalho (sincronia, traduzir, compartilhar,
  // expandir), rolagem manual e clique-para-buscar
  // ---------------------------------------------------------------
  function markUserScroll() {
    userScrollUntil = Date.now() + 4000;
  }

  // Texto simples da letra atual (para compartilhar / traduzir)
  function currentPlainText() {
    if (!cur) return '';
    if (cur.plain) return cur.plain;
    if (cur.lines) return linesToPlain(cur.lines);
    return '';
  }

  // Compartilhar a letra + link da faixa (usa a Web Share API; cai para
  // copiar ao clipboard quando indisponível)
  function shareLyrics() {
    const st = appState();
    const t = st && st.currentTrack;
    if (!t) return;
    const title = (t.title || 'MinStream');
    const url = t.videoId ? ('https://youtu.be/' + t.videoId) : '';
    const body = currentPlainText();
    const text = body ? (title + '\n\n' + body) : title;
    try {
      if (navigator.share) {
        navigator.share({ title: title, text: text, url: url || undefined }).catch(() => {});
        return;
      }
    } catch (_) {}
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text + (url ? ('\n' + url) : ''));
        if (typeof showToast === 'function') showToast('Letra copiada para a área de transferência');
        return;
      }
    } catch (_) {}
    if (typeof showToast === 'function') showToast('Não foi possível compartilhar agora');
  }

  // Traduzir a letra para o idioma do app/navegador. Alterna entre
  // original e tradução. Usa o endpoint público do Google Translate a
  // partir do navegador do usuário; se falhar, avisa e mantém o original.
  function uiLang() {
    try {
      const l = (navigator.language || 'pt').slice(0, 2).toLowerCase();
      return l || 'pt';
    } catch (_) { return 'pt'; }
  }

  async function translateText(text, target) {
    const key = target + '::' + text;
    if (translateCache.has(key)) return translateCache.get(key);
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl='
      + encodeURIComponent(target) + '&dt=t&q=' + encodeURIComponent(text);
    const res = await fetch(url);
    if (!res.ok) throw new Error('http ' + res.status);
    const data = await res.json();
    // data[0] é uma lista de segmentos [traduzido, original, ...]
    const out = (data && data[0] || []).map(seg => (seg && seg[0]) || '').join('');
    const clean = out.trim();
    if (!clean) throw new Error('vazio');
    translateCache.set(key, clean);
    return clean;
  }

  function setTranslateBusy(busy) {
    eachSide(side => {
      if (side.translate) side.translate.classList.toggle('busy', busy);
    });
    if (page.translate) page.translate.classList.toggle('busy', busy);
  }
  function setTranslateOn(on) {
    eachSide(side => {
      if (!side.translate) return;
      side.translate.classList.toggle('on', on);
      side.translate.setAttribute('aria-pressed', String(on));
    });
    if (page.translate) {
      page.translate.classList.toggle('on', on);
      page.translate.setAttribute('aria-pressed', String(on));
    }
  }

  function showPlain(text) {
    // Renderiza um texto estático (usado para exibir a tradução)
    eachSide(side => {
      if (!side.scroll) return;
      const d = document.createElement('div');
      d.className = 'lyrics-plain';
      d.textContent = text;
      side.scroll.replaceChildren(d);
      side.scroll.scrollTop = 0;
    });
    lineEls.exp = [];
    lineEls.mp = [];
    // As telas cheias abertas mostram a MESMA tradução (fillSurface lê
    // translated/translatedText, definidos antes da chamada)
    surfaces.forEach(s => { if (s.isOpen()) fillSurface(s); });
  }

  async function toggleTranslate() {
    if (translated) {
      // Volta ao original
      translated = false;
      translatedText = '';
      setTranslateOn(false);
      renderCurrent();
      return;
    }
    const text = currentPlainText();
    if (!text) return;
    setTranslateBusy(true);
    try {
      const tr = await translateText(text, uiLang());
      translated = true;
      translatedText = tr;
      setTranslateBusy(false);
      setTranslateOn(true);
      showPlain(tr);
      if (typeof showToast === 'function') showToast('Letra traduzida');
    } catch (_) {
      setTranslateBusy(false);
      if (typeof showToast === 'function') showToast('Não foi possível traduzir a letra agora');
    }
  }

  eachSide(side => {
    if (side.sync) {
      side.sync.addEventListener('click', () => {
        const next = !syncOn();
        setSyncOn(next);
        renderCurrent();
        try {
          if (typeof showToast === 'function') {
            showToast(next
              ? 'Letra sincronizada com a reprodução'
              : 'Exibindo a letra completa, sem sincronização');
          }
        } catch (_) {}
      });
    }
    if (side.translate) side.translate.addEventListener('click', toggleTranslate);
    if (side.share) side.share.addEventListener('click', shareLyrics);
    if (side.expand) side.expand.addEventListener('click', openOverlay);

    if (!side.scroll) return;

    // Intenção de rolagem do usuário: wheel (mouse) e toque (mobile).
    // O evento 'scroll' sozinho não serve aqui, pois o seguidor também
    // escreve scrollTop; a janela progScrollUntil filtra essas escritas.
    side.scroll.addEventListener('wheel', markUserScroll, { passive: true });
    side.scroll.addEventListener('touchstart', markUserScroll, { passive: true });
    side.scroll.addEventListener('touchmove', markUserScroll, { passive: true });
    side.scroll.addEventListener('mousedown', e => {
      if (e.offsetX >= side.scroll.clientWidth) markUserScroll();
    });
    side.scroll.addEventListener('scroll', () => {
      if (Date.now() > progScrollUntil) markUserScroll();
    }, { passive: true });

    side.scroll.addEventListener('click', e => {
      // MOBILE: o toque no container abre a letra em tela cheia (é lá que
      // se busca um trecho). Sem letra, o toque não faz nada.
      if (side === els.mp && canOpenPage()) return;
      const line = e.target && e.target.closest ? e.target.closest('.lyrics-line') : null;
      if (!line || !line.dataset.t) return;
      const t = parseFloat(line.dataset.t);
      if (!isFinite(t)) return;
      userScrollUntil = 0; // volta a acompanhar imediatamente
      try { if (typeof seekToTime === 'function') seekToTime(t); } catch (_) {}
    });
  });

  // ---------------------------------------------------------------
  // Interações da página de letra em tela cheia (mobile)
  // ---------------------------------------------------------------
  if (els.mp.box) {
    // Toque em qualquer ponto do container (menos nos botões do cabeçalho)
    els.mp.box.addEventListener('click', e => {
      if (e.target && e.target.closest && e.target.closest('.lyrics-act')) return;
      openPage();
    });
  }

  if (page.root) {
    if (page.close) page.close.addEventListener('click', closePage);
    if (page.translate) page.translate.addEventListener('click', toggleTranslate);
    if (page.share) page.share.addEventListener('click', shareLyrics);

    if (page.scroll) {
      page.scroll.addEventListener('wheel', markUserScroll, { passive: true });
      page.scroll.addEventListener('touchstart', markUserScroll, { passive: true });
      page.scroll.addEventListener('touchmove', markUserScroll, { passive: true });
      page.scroll.addEventListener('scroll', () => {
        if (Date.now() > progScrollUntil) markUserScroll();
      }, { passive: true });

      // Tocar numa linha busca aquele instante da faixa
      page.scroll.addEventListener('click', e => {
        const line = e.target && e.target.closest ? e.target.closest('.lyrics-line') : null;
        if (!line || !line.dataset.t) return;
        const t = parseFloat(line.dataset.t);
        if (!isFinite(t)) return;
        userScrollUntil = 0;
        try { if (typeof seekToTime === 'function') seekToTime(t); } catch (_) {}
      });
    }
  }

  // ---------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------
  applyVisibility();
  setInterval(tick, 350);

  return { enabled, setEnabled, applyVisibility, pageOpen, closePage };
})();
