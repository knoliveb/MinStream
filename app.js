/* ============================================
   minstream - JavaScript Vanilla
   ============================================ */

// ============================================
// DADOS
// ============================================
// Registro de faixas em tempo de execucao (populado dinamicamente pelas
// buscas, playlists dinamicas e playlists do usuario). Sem conteudo pre-carregado.
const TRACKS = [];

// Gostos padrao do usuario (editaveis no Perfil)
const DEFAULT_TASTES = ['Indie', 'Synthwave', 'Rock', 'Pop', 'Música Brasileira'];

// ============================================
// ESTADO GLOBAL
// ============================================
// Carrega curtidas e recentes do localStorage
function loadLikedTracks() {
  try {
    const raw = localStorage.getItem('vibefm_liked');
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch (_) { return new Set(); }
}
function loadHistory() {
  try {
    const raw = localStorage.getItem('vibefm_history');
    return raw ? JSON.parse(raw) : [];
  } catch (_) { return []; }
}
function saveLikedTracks() {
  try { localStorage.setItem('vibefm_liked', JSON.stringify([...state.likedTracks])); } catch (_) {}
}
function saveHistory() {
  try { localStorage.setItem('vibefm_history', JSON.stringify(state.history.slice(0, 100))); } catch (_) {}
}

const state = {
  view: 'home',
  prevView: null,
  playerMode: localStorage.getItem('vibefm_player_mode') || 'video', // 'video' | 'cover' | 'queue' 
  currentTrack: null,
  currentPlaylist: null,  // YouTube playlist ID
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  volume: 80,
  isMuted: false,
  isShuffled: false,
  repeatMode: 'off', // 'off' | 'all' | 'one'
  queue: [],
  queueIndex: 0,
  likedTracks: loadLikedTracks(),
  history: loadHistory(),
  apiReady: false,
};

// ============================================
// PERSISTENCIA DA ULTIMA MUSICA
// ============================================
const LAST_TRACK_KEY = 'minstream_last_track';

function saveLastTrack() {
  if (!state.currentTrack) return;
  try {
    const data = {
      track: state.currentTrack,
      queue: state.queue,
      queueIndex: state.queueIndex,
      currentPlaylist: state.currentPlaylist,
      currentTime: state.currentTime,
      savedAt: Date.now(),
    };
    localStorage.setItem(LAST_TRACK_KEY, JSON.stringify(data));
  } catch (_) {}
}

function loadLastTrack() {
  try {
    const raw = localStorage.getItem(LAST_TRACK_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) { return null; }
}

function clearLastTrack() {
  try { localStorage.removeItem(LAST_TRACK_KEY); } catch (_) {}
}

// ============================================
// TRANSICAO AUTO: CAPA -> VIDEO (7s)
// ============================================
let autoVideoTimer = null;

function startAutoVideoTimer() {
  // Cancela timer anterior se existir
  if (autoVideoTimer) {
    clearTimeout(autoVideoTimer);
    autoVideoTimer = null;
  }
  // Inicia sempre no modo capa
  setPlayerMode('cover');
  // Apos 7 segundos, transiciona para video
  autoVideoTimer = setTimeout(() => {
    autoVideoTimer = null;
    if (state.currentTrack && state.isPlaying) {
      setPlayerMode('video');
    }
  }, 7000);
}

function cancelAutoVideoTimer() {
  if (autoVideoTimer) {
    clearTimeout(autoVideoTimer);
    autoVideoTimer = null;
  }
}

// Detecta quando um NOVO video comeca a tocar (em playlist ou nao, incluindo
// o avanco automatico nativo do YouTube) e reaplica o padrao capa -> video.
// Assim o comportamento vale para todos os videos, e nao so o primeiro.
let autoTimerVideoId = null;
function checkAutoVideoOnTrackChange() {
  if (!ytPlayer || !state.apiReady) return;
  try {
    const vd = ytPlayer.getVideoData();
    const vid = vd && vd.video_id;
    if (vid && vid !== autoTimerVideoId) {
      autoTimerVideoId = vid;
      startAutoVideoTimer();
    }
  } catch (_) {}
}

function getTrack(id) { return TRACKS.find(t => t.id === id); }
function fmtTime(s) { return `${Math.floor(s/60)}:${Math.floor(s%60).toString().padStart(2,'0')}`; }

// ============================================
// YOUTUBE URL PARSING (from yt-utils.js)
// ============================================
function isValidId(id) { return typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id); }
function isValidPlaylistId(id) { return typeof id === 'string' && /^[A-Za-z0-9_-]{12,50}$/.test(id); }

function extractVideoId(raw) {
  if (!raw) return null;
  let u;
  try { u = new URL(raw, 'https://www.youtube.com'); } catch (e) { return isValidId(raw) ? raw : null; }
  const host = u.hostname.replace(/^www\./, '').replace(/^m\./, '');
  if (host === 'youtu.be') {
    const id = u.pathname.split('/').filter(Boolean)[0];
    return isValidId(id) ? id : null;
  }
  const m = u.pathname.match(/\/(embed|shorts|live|v)\/([^/?#]+)/);
  if (m && isValidId(m[2])) return m[2];
  const v = u.searchParams.get('v');
  if (v && isValidId(v)) return v;
  return null;
}

function extractPlaylistId(raw) {
  if (!raw) return null;
  let u;
  try { u = new URL(raw, 'https://www.youtube.com'); } catch (e) { return isValidPlaylistId(raw) ? raw : null; }
  const list = u.searchParams.get('list');
  return isValidPlaylistId(list) ? list : null;
}

function isYouTubeUrl(str) {
  return /^(https?:\/\/)?(www\.|m\.)?(youtube\.com|youtu\.be|youtube-nocookie\.com)/i.test(str);
}

// Play directly from a YouTube URL
async function playFromUrl(url) {
  const videoId = extractVideoId(url);
  const playlistId = extractPlaylistId(url);

  if (!videoId && !playlistId) {
    showToast('URL do YouTube inválida');
    return;
  }

  // Try to get metadata via oEmbed
  let title = videoId ? `YouTube Video (${videoId})` : 'YouTube Playlist';
  let author = 'YouTube';
  let thumbnail = videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 9%22%3E%3Crect width=%2216%22 height=%229%22 fill=%22%23111%22/%3E%3Cpath d=%22M6.5 2.5v3.2a1.3 1.3 0 101 1.26V4h2v-1z%22 fill=%22%230AE448%22/%3E%3C/svg%3E';

  if (videoId) {
    try {
      const resp = await fetch(`https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=${videoId}`);
      if (resp.ok) {
        const data = await resp.json();
        title = data.title || title;
        author = data.author_name || author;
      }
    } catch (_) { /* fallback */ }
  }

  // Create a virtual track
  const track = {
    id: 'yt_' + (videoId || playlistId),
    title: title,
    artist: author,
    album: 'YouTube',
    cover: thumbnail,
    duration: 0,
    videoId: videoId || '',
  };

  // Add to our collection temporarily
  if (!TRACKS.find(t => t.id === track.id)) {
    TRACKS.unshift(track);
  }

  state.currentTrack = track;
  state.currentPlaylist = playlistId || null;
  state.isPlaying = true;
  state.currentTime = 0;
  state.queue = [track];
  state.queueIndex = 0;
  state.history.unshift({ trackId: track.id, videoId: track.videoId || '', title: track.title || '', artist: track.artist || '', at: Date.now() });
  if (state.history.length > 100) state.history.pop();
  saveHistory();

  clearPlayerError();
  loadTrack(track);
  updatePlayerUI();
  saveLastTrack();
  startAutoVideoTimer();
  showToast(`Tocando: ${title}`);
}


let toastTimer = null;
function showToast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.style.cssText = 'position:fixed;top:20px;left:50%;background:var(--surface-2);color:var(--text);padding:12px 24px;border-radius:10px;border:1px solid var(--border);font-size:13px;font-weight:500;z-index:10000;opacity:0;transform:translateX(-50%) translateY(-8px);transition:opacity 0.35s cubic-bezier(0.25,0.46,0.45,0.94),transform 0.35s cubic-bezier(0.25,0.46,0.45,0.94);pointer-events:none;box-shadow:0 8px 32px rgba(0,0,0,0.4);';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  // Forca reflow para garantir que a transicao funcione
  void el.offsetHeight;
  el.style.opacity = '1';
  el.style.transform = 'translateX(-50%) translateY(0)';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateX(-50%) translateY(-8px)';
  }, 3000);
}

// ============================================
// YOUTUBE IFRAME PLAYER API (official) + Error handling from NoTube
// ============================================
const videoCover = document.getElementById('video-cover');
let ytPlayer = null;
let progressPoll = null;
let pendingTrack = null;
let errorTimer = null;
let errorShown = false;
let playbackStarted = false; // set true when the current video actually starts playing

// Erro 153 acontece quando o YouTube nao recebe o referrer da pagina.
// Isso e GARANTIDO quando o app e aberto via file:// (origin "null").
const isFileProtocol = window.location.protocol === 'file:';

const YT_ERROR_MESSAGES = {
  2:   'Parametro invalido (ID do video incorreto).',
  5:   'Erro no player HTML5.',
  100: 'Video nao encontrado ou privado.',
  101: 'O dono do video bloqueou a reproducao em sites externos.',
  150: 'O dono do video bloqueou a reproducao em sites externos.',
  152: 'O YouTube recusou o embed (erro 152). O video pode ter restricao de idade ou de embed.',
  153: 'O YouTube nao recebeu o referrer da pagina (erro 153). Sirva o app por http:// em vez de abrir o arquivo diretamente.',
};

/* ===== Error handling (100/101/150/152/153) ===== */
function showPlayerError(watchUrl, message) {
  if (errorShown) return;
  errorShown = true;
  stopPoll();

  // #yt-player-div permanece no DOM porque o player e criado no filho #yt-player-target
  const container = document.getElementById('yt-player-div');
  let overlay = document.getElementById('yt-error-overlay');
  if (overlay) overlay.remove();
  overlay = document.createElement('div');
  overlay.id = 'yt-error-overlay';
  overlay.innerHTML =
    '<p style="color:#E0E0E0;font-size:13px;font-weight:600;margin:0">Não foi possível reproduzir este conteúdo.</p>' +
    '<p style="color:#A3A3A3;font-size:11px;margin:0">' + (message || 'O YouTube pode ter recusado a reprodução externa.') + '</p>' +
    '<a href="' + watchUrl + '" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;gap:6px;padding:8px 16px;background:var(--green);color:var(--bg);text-decoration:none;border-radius:6px;font-size:12px;font-weight:600">' +
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M10 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V8a2 2 0 00-2-2h-8l-2-2z"/></svg>' +
    'Abrir no YouTube</a>' +
    '<button id="yt-error-dismiss" style="margin-top:4px;padding:6px 12px;background:transparent;color:var(--text-muted);border:1px solid var(--border);border-radius:6px;font-family:inherit;font-size:11px;cursor:pointer">Tentar novamente</button>';
  container.appendChild(overlay);

  document.getElementById('yt-error-dismiss').addEventListener('click', () => {
    overlay.remove();
    errorShown = false;
    // NAO derrubar state.apiReady aqui: onReady so dispara uma vez,
    // zerar a flag deixava o player morto para sempre.
    if (state.currentTrack) loadTrack(state.currentTrack);
  });
}

function clearPlayerError() {
  errorShown = false;
  const el = document.getElementById('yt-error-overlay');
  if (el) el.remove();
}

function startErrorTimer(videoId, playlistId) {
  if (errorTimer) clearTimeout(errorTimer);
  errorShown = false;
  playbackStarted = false;
  errorTimer = setTimeout(() => {
    // Se em 8s o video nao comecou a tocar nem a bufferizar, algo bloqueou o embed
    if (!playbackStarted && !errorShown) {
      const watchUrl = playlistId
        ? 'https://www.youtube.com/playlist?list=' + playlistId
        : 'https://www.youtube.com/watch?v=' + (videoId || '');
      const msg = isFileProtocol ? YT_ERROR_MESSAGES[153] : null;
      showPlayerError(watchUrl, msg);
    }
  }, 8000);
}

/* ===== YT.Player setup ===== */
window.onYouTubeIframeAPIReady = function() {
  if (ytPlayer) return;

  const playerVars = {
    enablejsapi: 1,
    autoplay: 0,          // autoplay real acontece via loadVideoById apos gesto do usuario
    playsinline: 1,
    rel: 0,               // AdShield: fim de video sem sugestoes promocionais de outros canais
    iv_load_policy: 3,    // AdShield: sem anotacoes/cartoes promocionais sobre o video
    controls: 0,          // controles nativos ocultos — controle via player customizado
    disablekb: 1,         // desabilita atalhos de teclado do YouTube
    modestbranding: 1,    // minimiza logo do YouTube
    cc_load_policy: 0,    // nao forca legendas; o desligamento efetivo (inclusive
                          // das automaticas) acontece em disableCaptions()
    fs: 0,
  };

  // Correcao dos erros 152/153: informar explicitamente a origem/referrer ao YouTube.
  // So e valido em http(s); com file:// a origem e "null" e o YouTube rejeita.
  if (!isFileProtocol) {
    playerVars.origin = window.location.origin;
    playerVars.widget_referrer = window.location.href;
  }

  ytPlayer = new YT.Player('yt-player-target', {
    width: '100%',
    height: '100%',
    // AdShield: modo de privacidade aprimorada oficial do YouTube.
    // Sem cookies de rastreamento => sem anuncios personalizados por perfil.
    host: 'https://www.youtube-nocookie.com',
    playerVars: playerVars,
    events: {
      onReady: onPlayerReady,
      onStateChange: onPlayerStateChange,
      onError: onPlayerError,
    },
  });
};
// Se o script da API ja tiver carregado antes deste arquivo, dispara manualmente
if (window.YT && window.YT.Player) window.onYouTubeIframeAPIReady();

if (isFileProtocol) {
  console.warn('[minstream] App aberto via file:// — o YouTube retornara erro 153. Sirva com um servidor local, ex: python -m http.server');
  // Mostra instrucoes imediatamente, sem esperar o usuario tentar tocar algo
  window.addEventListener('DOMContentLoaded', showFileProtocolNotice);
  if (document.readyState !== 'loading') showFileProtocolNotice();
}

function showFileProtocolNotice() {
  if (document.getElementById('file-protocol-notice')) return;
  const notice = document.createElement('div');
  notice.id = 'file-protocol-notice';
  notice.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
  notice.innerHTML =
    '<div style="max-width:520px;background:var(--surface,#141414);border:1px solid var(--border,#2a2a2a);border-radius:12px;padding:28px;text-align:left">' +
      '<h2 style="margin:0 0 12px;font-size:16px;color:#E0E0E0">O player do YouTube não funciona via file://</h2>' +
      '<p style="margin:0 0 8px;font-size:13px;color:#A3A3A3;line-height:1.6">Você abriu o <code>index.html</code> diretamente. Nesse modo, o navegador não envia o referrer e o YouTube bloqueia a reprodução (erro 153). Inicie um servidor local na pasta do projeto:</p>' +
      '<pre style="background:#000;border:1px solid #2a2a2a;border-radius:8px;padding:12px;font-size:12px;color:#0AE448;overflow:auto;margin:12px 0">python -m http.server 8000</pre>' +
      '<p style="margin:0 0 8px;font-size:13px;color:#A3A3A3;line-height:1.6">ou, se tiver Node.js:</p>' +
      '<pre style="background:#000;border:1px solid #2a2a2a;border-radius:8px;padding:12px;font-size:12px;color:#0AE448;overflow:auto;margin:12px 0">npx serve .</pre>' +
      '<p style="margin:0 0 16px;font-size:13px;color:#A3A3A3;line-height:1.6">Depois abra <strong style="color:#E0E0E0">http://localhost:8000</strong> no navegador. Também incluímos os atalhos <code>iniciar.bat</code> (Windows) e <code>iniciar.sh</code> (Mac/Linux) na pasta do projeto.</p>' +
      '<button id="file-notice-close" style="padding:8px 16px;background:var(--green,#0AE448);color:#000;border:none;border-radius:6px;font-family:inherit;font-size:12px;font-weight:600;cursor:pointer">Entendi, continuar mesmo assim</button>' +
    '</div>';
  document.body.appendChild(notice);
  document.getElementById('file-notice-close').addEventListener('click', () => notice.remove());
}

// Remove a legenda (inclusive a automatica) de todos os videos.
// O modulo de legendas e recarregado pelo YouTube a cada novo video,
// entao esta funcao e chamada no onReady E a cada inicio de reproducao.
// 'captions' e o modulo do player HTML5; 'cc' e o nome legado.
function disableCaptions() {
  if (!ytPlayer || !state.apiReady) return;
  try { ytPlayer.unloadModule('captions'); } catch (_) {}
  try { ytPlayer.unloadModule('cc'); } catch (_) {}
}

function onPlayerReady() {
  clearPlayerError();
  if (errorTimer) { clearTimeout(errorTimer); errorTimer = null; }
  state.apiReady = true;
  ytPlayer.setVolume(state.volume);
  if (state.isMuted) ytPlayer.mute();
  disableCaptions();
  if (pendingTrack) {
    doLoad(pendingTrack);
    pendingTrack = null;
  }
}

function onPlayerStateChange(event) {
  // States: -1=unstarted, 0=ended, 1=playing, 2=paused, 3=buffering, 5=cued
  if (event.data === 0) {
    cancelAutoVideoTimer();
    if (state.repeatMode === 'one') {
      // Em playlist, replay do item atual evita que o embed pule para o proximo
      if (state.currentPlaylist && ytQueueIndex >= 0) {
        try { ytPlayer.playVideoAt(ytQueueIndex); } catch (_) {}
      } else {
        ytPlayer.seekTo(0, true);
        ytPlayer.playVideo();
      }
      return;
    }
    // Em playlist do YouTube o player avanca sozinho; chamar nextTrack() causava pulo duplo
    if (state.currentPlaylist) return;
    state.isPlaying = false;
    nextTrack();
  } else if (event.data === 1 || event.data === 3) {
    playbackStarted = true;
    clearPlayerError();
    if (errorTimer) { clearTimeout(errorTimer); errorTimer = null; }
    if (event.data === 1) {
      // Cada video recarrega o modulo de legendas: desliga de novo
      disableCaptions();
      state.isPlaying = true;
      updatePlayerUI();
      startPoll();
    }
  } else if (event.data === 2) {
    state.isPlaying = false;
    updatePlayerUI();
  }
}

function onPlayerError(event) {
  if (errorTimer) { clearTimeout(errorTimer); errorTimer = null; }
  const code = event && event.data;
  let message = YT_ERROR_MESSAGES[code] || ('Erro do player (' + code + ').');
  // Erros de embed em file:// quase sempre sao a falta de referrer
  if ((code === 152 || code === 153 || code === 150 || code === 101) && isFileProtocol) {
    message = YT_ERROR_MESSAGES[153];
  }

  let watchUrl = 'https://www.youtube.com';
  if (state.currentTrack && state.currentTrack.videoId) {
    watchUrl = 'https://www.youtube.com/watch?v=' + state.currentTrack.videoId;
  } else if (state.currentPlaylist) {
    watchUrl = 'https://www.youtube.com/playlist?list=' + state.currentPlaylist;
  }
  showPlayerError(watchUrl, message);

  // Se o video foi bloqueado (embed negado / nao encontrado) e ha fila local, pula para o proximo
  if ((code === 100 || code === 101 || code === 150 || code === 152) && !isFileProtocol &&
      !state.currentPlaylist && state.queue.length > 1 && state.queueIndex < state.queue.length - 1) {
    showToast('Vídeo bloqueado para reprodução externa — pulando para a próxima faixa\u2026');
    setTimeout(() => {
      if (errorShown) { clearPlayerError(); nextTrack(); }
    }, 2500);
  }
}

function doLoad(track) {
  if (!ytPlayer || !state.apiReady) {
    pendingTrack = track;
    return;
  }
  clearPlayerError();
  startErrorTimer(track.videoId, state.currentPlaylist);
  lastSyncedVideoId = null;
  if (!state.currentPlaylist) clearQueue();
  try {
    if (state.currentPlaylist) {
      // Carrega a playlist inteira para que playVideoAt/nextVideo/setShuffle funcionem
      ytPlayer.loadPlaylist({ list: state.currentPlaylist, listType: 'playlist' });
    } else {
      ytPlayer.loadVideoById(track.videoId);
    }
    ytPlayer.setVolume(state.isMuted ? 0 : state.volume);
    videoCover.classList.add('has-video');
  } catch (e) {
    const watchUrl = state.currentPlaylist
      ? 'https://www.youtube.com/playlist?list=' + state.currentPlaylist
      : 'https://www.youtube.com/watch?v=' + track.videoId;
    showPlayerError(watchUrl);
  }
}

function cmd(func, args) {
  if (!ytPlayer || !state.apiReady) return;
  try {
    switch (func) {
      case 'playVideo': ytPlayer.playVideo(); break;
      case 'pauseVideo': ytPlayer.pauseVideo(); break;
      case 'mute': ytPlayer.mute(); break;
      case 'unMute': ytPlayer.unMute(); break;
      case 'setVolume': ytPlayer.setVolume(args && args[0] != null ? args[0] : state.volume); break;
    }
  } catch (_) {}
}

function ytCmd(func, args) {
  if (!ytPlayer || !state.apiReady) return;
  try {
    switch (func) {
      case 'seekTo': ytPlayer.seekTo(args[0], args[1]); break;
      case 'setShuffle': ytPlayer.setShuffle(args[0]); break;
      case 'setLoop': ytPlayer.setLoop(args[0]); break;
      case 'nextVideo': ytPlayer.nextVideo(); break;
      case 'previousVideo': ytPlayer.previousVideo(); break;
    }
  } catch (_) {}
}

function startPoll() {
  if (progressPoll) return;
  progressPoll = setInterval(() => {
    if (ytPlayer && state.apiReady) {
      try {
        state.currentTime = ytPlayer.getCurrentTime() || 0;
        state.duration = ytPlayer.getDuration() || 0;
        updatePlayerUI();
      } catch (_) {}
      checkAutoVideoOnTrackChange();
      pollPlaylistInfo();
    }
  }, 500);
}

function stopPoll() {
  if (progressPoll) { clearInterval(progressPoll); progressPoll = null; }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopPoll();
  } else {
    if (state.apiReady) startPoll();
    // Retoma animacoes de fundo pausadas enquanto a aba estava oculta
    ensureParticles();
    if (state.isPlaying) ensureVuMeter();
  }
});

// Mini player toggle
// ============================================
// MODO TEATRO (video expandido como capa gigante)
// O iframe NUNCA muda de lugar no DOM (mudar de pai recarrega o video);
// apenas classes CSS reposicionam o container.
// ============================================
const expandedPlayer = document.getElementById('expanded-player');
const expStage = document.getElementById('exp-stage');
let isExpanded = false;

// Modos de visualizacao do player expandido:
//  'video' -> exibe o video em execucao
//  'cover' -> capa estatica do video (o audio continua)
//  'queue' -> lista de reproducao
function setPlayerMode(mode) {
  // Se o usuario muda manualmente o modo, cancela o timer automatico
  if (autoVideoTimer && mode !== state.playerMode) {
    cancelAutoVideoTimer();
  }

  state.playerMode = mode;
  try { localStorage.setItem('vibefm_player_mode', mode); } catch (_) {}

  document.querySelectorAll('.exp-tab[data-mode]').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.mode === mode);
  });
  expandedPlayer.dataset.mode = mode;

  // No modo capa, a capa estatica cobre o video tambem no dock
  applyPlayerModeToDock();

  // Transicao suave: para o sync loop primeiro, depois resincroniza
  if (mode === 'video' && isExpanded) {
    syncVideoToStage();
    startSyncLoop();
  } else {
    stopSyncLoop();
    resetVideoOpacity();
    syncVideoToStage();
  }

  if (mode === 'cover') fillExpandedCover();
  if (mode === 'queue') buildExpandedQueue(true);
}

function applyPlayerModeToDock() {
  videoCover.classList.toggle('cover-mode', state.playerMode === 'cover');
}

// ============================================================
// VIDEO NO MODO EXPANDIDO (THEATER)
// O #video-cover e filho do <body> (fora do #app), posicionado
// via CSS com position: fixed. No modo dock, fica na area do
// player-dock. No modo theater, e reposicionado via JS sobre o
// .exp-stage do expanded-player.
// Essa estrutura evita mover o elemento no DOM, o que quebra o
// player do YouTube (o IFrame API perde referencias internas).
// ============================================================
let syncRafId = null;
let syncObserver = null;

function startSyncLoop() {
  stopSyncLoop();
  let lastTime = 0;
  const FRAME_INTERVAL = 33; // ~30fps (1000/30) - reduz reflows
  function loop(timestamp) {
    if (!isExpanded || state.playerMode !== 'video') {
      stopSyncLoop();
      return;
    }
    if (timestamp - lastTime >= FRAME_INTERVAL) {
      lastTime = timestamp;
      _doSync();
    }
    syncRafId = requestAnimationFrame(loop);
  }
  syncRafId = requestAnimationFrame(loop);
}

function stopSyncLoop() {
  if (syncRafId) {
    cancelAnimationFrame(syncRafId);
    syncRafId = null;
  }
}

function _doSync() {
  const r = expStage.getBoundingClientRect();
  videoCover.style.left = r.left + 'px';
  videoCover.style.top = r.top + 'px';
  videoCover.style.width = r.width + 'px';
  videoCover.style.height = r.height + 'px';
}

function syncVideoToStage() {
  if (isExpanded && state.playerMode === 'video') {
    videoCover.classList.add('theater');
    _doSync();
    startSyncLoop();
  } else {
    videoCover.classList.remove('theater');
    videoCover.style.left = '';
    videoCover.style.top = '';
    videoCover.style.width = '';
    videoCover.style.height = '';
    stopSyncLoop();
  }
}

// Opacidade do video no scroll: quanto mais scroll, mais transparente (min 10%)
const SCROLL_FADE_THRESHOLD = 150; // px de scroll para opacidade minima
function updateVideoOpacityOnScroll() {
  if (!isExpanded || state.playerMode !== 'video') return;
  const st = expandedPlayer.scrollTop;
  const opacity = Math.max(0, 1 - (st / SCROLL_FADE_THRESHOLD));
  videoCover.style.opacity = String(opacity);
}
function resetVideoOpacity() {
  videoCover.style.opacity = '';
}

// Debounced resize: evita múltiplas chamadas durante resize contínuo
let resizeDebounce;
window.addEventListener('resize', () => {
  clearTimeout(resizeDebounce);
  resizeDebounce = setTimeout(syncVideoToStage, 100);
});
// O loop de sincronizacao (rAF) ja reposiciona o video a cada frame no modo
// video; no scroll basta atualizar a opacidade. Evita re-toggle de classes e
// reinicios do loop a cada evento de rolagem.
expandedPlayer.addEventListener('scroll', () => {
  updateVideoOpacityOnScroll();
}, { passive: true });

// ResizeObserver no .exp-stage detecta mudancas de tamanho em tempo real
if (typeof ResizeObserver !== 'undefined') {
  syncObserver = new ResizeObserver(() => {
    if (isExpanded && state.playerMode === 'video') _doSync();
  });
  syncObserver.observe(expStage);
}

function fillExpandedCover() {
  const t = state.currentTrack;
  const img = document.getElementById('exp-cover-img');
  const infoTitle = document.getElementById('exp-cover-info-title');
  const infoArtist = document.getElementById('exp-cover-info-artist');
  if (!t) {
    img.src = '';
    infoTitle.textContent = 'Nada tocando';
    infoArtist.textContent = '';
    return;
  }
  img.src = t.videoId
    ? 'https://i.ytimg.com/vi/' + t.videoId + '/hqdefault.jpg'
    : (t.cover || '');
  infoTitle.textContent = t.title || '';
  infoArtist.textContent = t.artist || '';
}

// Toggle do painel de informacoes no modo capa
document.addEventListener('DOMContentLoaded', () => {
  const infoBtn = document.getElementById('exp-cover-info-btn');
  const infoPanel = document.getElementById('exp-cover-info-panel');
  if (infoBtn && infoPanel) {
    infoBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      infoBtn.classList.toggle('active');
      infoPanel.classList.toggle('hidden');
    });
    // Fecha ao clicar fora
    document.addEventListener('click', (e) => {
      if (!infoPanel.classList.contains('hidden') &&
          !infoPanel.contains(e.target) &&
          !infoBtn.contains(e.target)) {
        infoPanel.classList.add('hidden');
        infoBtn.classList.remove('active');
      }
    });
  }
});

let expQueueKey = '';
function buildExpandedQueue(force) {
  const ul = document.getElementById('exp-queue-items');
  const isYt = !!(state.currentPlaylist && ytQueue.length);
  const key = isYt
    ? 'yt:' + ytQueue.join(',') + '#' + ytQueueIndex
    : 'lc:' + state.queue.map(t => t.id).join(',') + '#' + state.queueIndex;
  if (!force && key === expQueueKey) return;
  expQueueKey = key;

  const frag = document.createDocumentFragment();
  if (isYt) {
    ytQueue.forEach((vid, i) => {
      frag.appendChild(makeQueueLi({
        cover: 'https://i.ytimg.com/vi/' + vid + '/mqdefault.jpg',
        title: titleCache.get(vid) || ('Faixa ' + (i + 1)),
        artist: channelCache.get(vid) || '',
        active: i === ytQueueIndex,
        onClick: () => { if (ytPlayer && state.apiReady) { try { ytPlayer.playVideoAt(i); } catch (_) {} } },
      }));
    });
  } else {
    state.queue.forEach((track, i) => {
      frag.appendChild(makeQueueLi({
        cover: track.videoId ? 'https://i.ytimg.com/vi/' + track.videoId + '/mqdefault.jpg' : track.cover,
        title: track.title,
        artist: track.artist,
        active: i === state.queueIndex,
        onClick: () => {
          state.queueIndex = i;
          state.currentTrack = state.queue[i];
          state.currentTime = 0;
          state.isPlaying = true;
          loadTrack(state.currentTrack);
          updatePlayerUI();
        },
      }));
    });
  }
  if (!frag.childNodes.length) {
    const p = document.createElement('p');
    p.className = 'pl-acc-empty';
    p.textContent = 'A fila está vazia. Toque algo para começar.';
    frag.appendChild(p);
  }
  ul.replaceChildren(frag);
  if (!isYt) enableQueueDrag(ul);
  const active = ul.querySelector('.queue-item.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function makeQueueLi(cfg) {
  const li = document.createElement('li');
  li.className = 'queue-item' + (cfg.active ? ' active' : '');
  const thumb = document.createElement('div');
  thumb.className = 'queue-thumb';
  if (cfg.cover) thumb.style.backgroundImage = 'url("' + cfg.cover + '")';
  const info = document.createElement('div');
  info.className = 'queue-item-info';
  const label = document.createElement('div');
  label.className = 'queue-item-label';
  label.textContent = cfg.title;
  const ch = document.createElement('div');
  ch.className = 'queue-item-channel';
  ch.textContent = cfg.artist;
  info.appendChild(label);
  info.appendChild(ch);
  li.appendChild(thumb);
  li.appendChild(info);
  li.addEventListener('click', cfg.onClick);
  return li;
}

function openExpanded() {
  isExpanded = true;
  document.body.classList.add('theater-open');
  expandedPlayer.classList.add('open');
  setPlayerMode(state.playerMode || 'video');
  updateExpandedContext();
  loadRelatedVideos();
  // Inicia o loop de sincronização do vídeo com o palco
  if (state.playerMode === 'video') startSyncLoop();
}

let lastRelatedArtist = null;
let relatedToken = 0;

function updateExpandedContext() {
  const ctx = document.getElementById('exp-context');
  const t = state.currentTrack;
  ctx.textContent = t ? (t.title || 'Tocando agora') : 'Tocando agora';
}

async function loadRelatedVideos() {
  const t = state.currentTrack;
  const row = document.getElementById('exp-related-row');
  const wrap = document.getElementById('exp-related');
  if (!t || !t.artist) { wrap.classList.add('hidden'); return; }
  if (t.artist === lastRelatedArtist && row.children.length) { wrap.classList.remove('hidden'); return; }
  lastRelatedArtist = t.artist;
  wrap.classList.remove('hidden');
  row.innerHTML = '<p class="yt-search-status">Carregando\u2026</p>';

  const token = ++relatedToken;
  const results = await searchYouTube(t.artist);
  if (token !== relatedToken) return;
  const filtered = results.filter(r => r.videoId !== t.videoId).slice(0, 10);
  if (!filtered.length) { wrap.classList.add('hidden'); return; }

  row.replaceChildren();
  filtered.forEach(r => {
    const card = document.createElement('div');
    card.className = 'exp-related-card';
    const img = document.createElement('img');
    img.src = 'https://i.ytimg.com/vi/' + r.videoId + '/mqdefault.jpg';
    img.alt = '';
    img.loading = 'lazy';
    const label = document.createElement('div');
    label.className = 'exp-related-label';
    label.textContent = r.title;
    card.appendChild(img);
    card.appendChild(label);
    card.addEventListener('click', () => playYouTubeResult(r, filtered));
    row.appendChild(card);
  });
}

function closeExpanded() {
  isExpanded = false;
  document.body.classList.remove('theater-open');
  expandedPlayer.classList.remove('open');
  stopSyncLoop();
  resetVideoOpacity();
  syncVideoToStage();
  // Restaura a transicao padrao apos a animacao de volta ao dock
  requestAnimationFrame(() => {
    videoCover.style.transition = '';
  });
}

function toggleExpanded() {
  if (isExpanded) {
    closeExpanded();
  } else {
    openExpanded();
  }

}


/* theater-backdrop removido no re-theme (display:none) - backdrop eh o proprio expanded-player */
document.getElementById('exp-close').addEventListener('click', closeExpanded);
document.querySelectorAll('.exp-tab[data-mode]').forEach(tab => {
  tab.addEventListener('click', () => setPlayerMode(tab.dataset.mode));
});
// Aplica a preferencia de modo (capa estatica x video) ja no dock
applyPlayerModeToDock();

// ============================================
// FILA DA PLAYLIST (logica portada do NoTube)
// - IDs vem de ytPlayer.getPlaylist() / getPlaylistIndex()
// - Titulos/canais via oEmbed com cache + concorrencia limitada
// - Clique em um item -> playVideoAt(i)
// ============================================
const queuePanel = document.getElementById('queue-panel');
const queueItemsEl = document.getElementById('queue-items');
const queueTitleEl = document.getElementById('queue-title');
const queueSubtitleEl = document.getElementById('queue-subtitle');

let ytQueue = [];          // array de videoIds da playlist ativa
let ytQueueKey = '';       // para evitar re-render identico
let ytQueueIndex = -1;
let lastActiveQueueIndex = -1;

const titleCache = new Map();
const channelCache = new Map();
let titlesRunToken = 0;
const OEMBED_CONCURRENCY = 4;

async function fetchOembed(videoId) {
  if (titleCache.has(videoId)) return;
  try {
    const url = 'https://www.youtube.com/oembed?format=json&url=' +
      encodeURIComponent('https://www.youtube.com/watch?v=' + videoId);
    const res = await fetch(url);
    if (!res.ok) throw new Error('http ' + res.status);
    const json = await res.json();
    titleCache.set(videoId, (json && json.title) || null);
    channelCache.set(videoId, (json && json.author_name) || null);
  } catch (_) {
    titleCache.set(videoId, null);
    channelCache.set(videoId, null);
  }
}

async function populateQueueMetadata() {
  const token = ++titlesRunToken;
  const snapshot = ytQueue.slice();
  let cursor = 0;
  async function worker() {
    while (cursor < snapshot.length) {
      const i = cursor++;
      const vid = snapshot[i];
      await fetchOembed(vid);
      if (token !== titlesRunToken) return;
      applyQueueMetadata(i, vid);
    }
  }
  const workers = [];
  for (let k = 0; k < OEMBED_CONCURRENCY; k++) workers.push(worker());
  await Promise.all(workers);
}

function applyQueueMetadata(i, vid) {
  const li = queueItemsEl.children[i];
  if (!li || li.dataset.vid !== vid) return;
  const t = titleCache.get(vid);
  const c = channelCache.get(vid);
  if (t) { const el = li.querySelector('.queue-item-label'); if (el) el.textContent = t; }
  if (c) { const el = li.querySelector('.queue-item-channel'); if (el) el.textContent = c; }
}

function renderQueue() {
  const key = ytQueue.join(',');
  if (key === ytQueueKey) { updateActiveQueueItem(); return; }
  ytQueueKey = key;

  const frag = document.createDocumentFragment();
  ytQueue.forEach((vid, i) => {
    const li = document.createElement('li');
    li.className = 'queue-item';
    li.dataset.index = String(i);
    li.dataset.vid = vid;

    const thumb = document.createElement('div');
    thumb.className = 'queue-thumb';
    thumb.style.backgroundImage = 'url("https://i.ytimg.com/vi/' + vid + '/mqdefault.jpg")';

    const info = document.createElement('div');
    info.className = 'queue-item-info';
    const label = document.createElement('div');
    label.className = 'queue-item-label';
    label.textContent = titleCache.get(vid) || ('Video ' + (i + 1));
    const channel = document.createElement('div');
    channel.className = 'queue-item-channel';
    channel.textContent = channelCache.get(vid) || '';
    info.appendChild(label);
    info.appendChild(channel);

    li.appendChild(thumb);
    li.appendChild(info);
    li.addEventListener('click', () => {
      if (ytPlayer && state.apiReady) { try { ytPlayer.playVideoAt(i); } catch (_) {} }
    });
    frag.appendChild(li);
  });
  queueItemsEl.replaceChildren(frag);
  lastActiveQueueIndex = -1;
  updateActiveQueueItem();
  populateQueueMetadata();
}

function updateActiveQueueItem() {
  if (ytQueueIndex === lastActiveQueueIndex) return;
  const children = queueItemsEl.children;
  if (lastActiveQueueIndex >= 0 && children[lastActiveQueueIndex]) {
    children[lastActiveQueueIndex].classList.remove('active');
  }
  const el = children[ytQueueIndex];
  if (el) {
    el.classList.add('active');
    el.scrollIntoView({ block: 'nearest' });
  }
  lastActiveQueueIndex = ytQueueIndex;
  queueSubtitleEl.textContent = ytQueue.length
    ? (ytQueueIndex + 1) + ' / ' + ytQueue.length
    : '';
}

function clearQueue() {
  ytQueue = [];
  ytQueueKey = '';
  ytQueueIndex = -1;
  lastActiveQueueIndex = -1;
  localQueueKey = '';
  queueItemsEl.replaceChildren();
}

// Sonda a playlist ativa dentro do poll de progresso
function pollPlaylistInfo() {
  if (!state.currentPlaylist || !ytPlayer || !state.apiReady) return;
  try {
    const list = ytPlayer.getPlaylist();
    if (Array.isArray(list) && list.length) {
      const joined = list.join(',');
      if (joined !== ytQueueKey) {
        ytQueue = list.slice();
        queuePanel.classList.remove('hidden');
        updateQueueBtn();
        renderQueue();
      }
      const idx = ytPlayer.getPlaylistIndex();
      if (typeof idx === 'number' && idx !== ytQueueIndex) {
        ytQueueIndex = idx;
        updateActiveQueueItem();
        syncTrackFromVideoData();
      }
    }
    // Titulo real do video em reproducao vem de graca pelo proprio embed
    syncTrackFromVideoData();
  } catch (_) {}
}

let lastSyncedVideoId = null;
function syncTrackFromVideoData() {
  if (!ytPlayer || !state.apiReady || !state.currentTrack) return;
  try {
    const vd = ytPlayer.getVideoData();
    if (vd && vd.video_id && vd.video_id !== lastSyncedVideoId) {
      lastSyncedVideoId = vd.video_id;
      state.currentTrack.videoId = vd.video_id;
      if (vd.title) state.currentTrack.title = vd.title;
      if (vd.author) state.currentTrack.artist = vd.author;
      state.currentTrack.cover = 'https://i.ytimg.com/vi/' + vd.video_id + '/hqdefault.jpg';
      updatePlayerUI();
    }
  } catch (_) {}
}

document.getElementById('queue-close').addEventListener('click', () => {
  queuePanel.classList.add('hidden');
  updateQueueBtn();
});

// ===== Fila local (quando NAO ha playlist do YouTube ativa) =====
let localQueueKey = '';

function renderLocalQueue() {
  const ids = state.queue.map(t => t.id);
  const key = ids.join(',') + '#' + state.queueIndex;
  if (key === localQueueKey) return;
  localQueueKey = key;

  queueTitleEl.textContent = 'Fila';
  queueSubtitleEl.textContent = state.queue.length
    ? (state.queueIndex + 1) + ' / ' + state.queue.length
    : '';

  const frag = document.createDocumentFragment();
  state.queue.forEach((track, i) => {
    const li = document.createElement('li');
    li.className = 'queue-item' + (i === state.queueIndex ? ' active' : '');

    const thumb = document.createElement('div');
    thumb.className = 'queue-thumb';
    const cover = track.videoId && track.id.startsWith('yt_')
      ? 'https://i.ytimg.com/vi/' + track.videoId + '/mqdefault.jpg'
      : track.cover;
    thumb.style.backgroundImage = 'url("' + cover + '")';

    const info = document.createElement('div');
    info.className = 'queue-item-info';
    const label = document.createElement('div');
    label.className = 'queue-item-label';
    label.textContent = track.title;
    const channel = document.createElement('div');
    channel.className = 'queue-item-channel';
    channel.textContent = track.artist;
    info.appendChild(label);
    info.appendChild(channel);

    li.appendChild(thumb);
    li.appendChild(info);
    li.addEventListener('click', () => {
      state.queueIndex = i;
      state.currentTrack = state.queue[i];
      state.currentTime = 0;
      state.isPlaying = true;
      loadTrack(state.currentTrack);
      updatePlayerUI();
    });
    frag.appendChild(li);
  });
  queueItemsEl.replaceChildren(frag);
  enableQueueDrag(queueItemsEl);
  const active = queueItemsEl.querySelector('.queue-item.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

// ============================================
// REORDENACAO DA FILA (drag and drop)
// Move uma faixa dentro de state.queue e ajusta o indice atual para
// que a faixa em reproducao continue a mesma — a ordem de reproducao
// (proxima/anterior) passa a seguir a nova disposicao.
// A fila de playlists do YouTube (ytQueue) e controlada pelo proprio
// player embutido e nao pode ser reordenada pela IFrame API.
// ============================================
function reorderLocalQueue(fromIndex, toIndex) {
  if (fromIndex === toIndex) return;
  if (fromIndex < 0 || fromIndex >= state.queue.length) return;
  const [moved] = state.queue.splice(fromIndex, 1);
  state.queue.splice(toIndex, 0, moved);

  // Mantem o ponteiro na mesma faixa em reproducao
  if (state.queueIndex === fromIndex) state.queueIndex = toIndex;
  else if (fromIndex < state.queueIndex && toIndex >= state.queueIndex) state.queueIndex--;
  else if (fromIndex > state.queueIndex && toIndex <= state.queueIndex) state.queueIndex++;

  // Invalida os caches e re-renderiza as duas visoes da fila
  localQueueKey = '';
  expQueueKey = '';
  if (!queuePanel.classList.contains('hidden')) renderLocalQueue();
  if (typeof isExpanded !== 'undefined' && isExpanded) buildExpandedQueue(true);
}

// Adiciona alcas de arrastar aos itens de uma lista de fila local.
function enableQueueDrag(list) {
  if (state.currentPlaylist) return; // fila do YT: ordem gerida pelo player
  Array.from(list.children).forEach(li => {
    if (!li.classList.contains('queue-item')) return;
    if (li.querySelector('.queue-drag-handle')) return;
    const handle = document.createElement('button');
    handle.className = 'queue-drag-handle';
    handle.title = 'Arrastar para reordenar';
    handle.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>';
    handle.addEventListener('click', (e) => e.stopPropagation());
    handle.addEventListener('pointerdown', (e) => startRowDrag(e, li, list, reorderLocalQueue));
    li.appendChild(handle);
  });
}

function refreshQueuePanel() {
  if (queuePanel.classList.contains('hidden')) return;
  if (state.currentPlaylist) return; // fila do YT e mantida pelo pollPlaylistInfo
  renderLocalQueue();
}

function toggleQueuePanel() {
  const willShow = queuePanel.classList.contains('hidden');
  queuePanel.classList.toggle('hidden', !willShow);
  if (willShow && !state.currentPlaylist) {
    localQueueKey = ''; // forca re-render
    renderLocalQueue();
  }
  updateQueueBtn();
}

function updateQueueBtn() {
  const btn = document.getElementById('btn-queue');
  if (btn) btn.classList.toggle('active', !queuePanel.classList.contains('hidden'));
}

document.getElementById('btn-queue').addEventListener('click', toggleQueuePanel);

// ============================================
// PLAYER ACTIONS
// ============================================
function loadTrack(track) {
  if (!track) return;
  // Acuracia local: conta a reproducao (nao conta a restauracao de
  // sessao, que carrega pausada com isPlaying = false)
  if (state.isPlaying && typeof PlayStats !== 'undefined') PlayStats.record(track);
  doLoad(track);
}

function playTrack(track, tracks) {
  if (!track) return;
  state.currentTrack = track;
  state.currentPlaylist = null;  // local track, not a YT playlist
  state.isPlaying = true;
  state.currentTime = 0;

  const all = tracks || TRACKS;
  state.queue = state.isShuffled ? shuffle([...all]) : [...all];
  state.queueIndex = state.queue.findIndex(t => t.id === track.id);
  if (state.queueIndex < 0) state.queueIndex = 0;

  state.history.unshift({ trackId: track.id, videoId: track.videoId || '', title: track.title || '', artist: track.artist || '', at: Date.now() });
  if (state.history.length > 100) state.history.pop();
  saveHistory();

  loadTrack(track);
  updatePlayerUI();
  saveLastTrack();
  startAutoVideoTimer();
}

function togglePlay() {
  state.isPlaying = !state.isPlaying;
  if (state.apiReady) cmd(state.isPlaying ? 'playVideo' : 'pauseVideo');
  updatePlayerUI();
}

function nextTrack() {
  if (!state.currentTrack) return;

  // If playing a YouTube playlist, use native navigation
  if (state.currentPlaylist && state.apiReady) {
    ytCmd('nextVideo');
    return;
  }

  const next = state.queueIndex + 1;
  if (next < state.queue.length) {
    state.queueIndex = next;
    state.currentTrack = state.queue[next];
    state.currentTime = 0;
    state.isPlaying = true;
    loadTrack(state.currentTrack);
  } else if (state.repeatMode === 'all') {
    state.queueIndex = 0;
    state.currentTrack = state.queue[0];
    state.currentTime = 0;
    state.isPlaying = true;
    loadTrack(state.currentTrack);
  } else if (typeof Reco !== 'undefined' && Reco.extendQueue && !radioExtending) {
    // RADIO CONTINUO: a fila acabou e o repeat esta desligado.
    // Em vez de parar, estende a fila com sugestoes parecidas
    // (perfil + faixa atual) e segue tocando.
    radioExtending = true;
    Reco.extendQueue(10).then(added => {
      radioExtending = false;
      if (added > 0 && state.queueIndex + 1 < state.queue.length) {
        state.queueIndex++;
        state.currentTrack = state.queue[state.queueIndex];
        state.currentTime = 0;
        state.isPlaying = true;
        loadTrack(state.currentTrack);
        updatePlayerUI();
        refreshQueuePanel();
        showToast('Rádio: continuando com faixas parecidas');
      } else {
        state.isPlaying = false;
        updatePlayerUI();
      }
    }).catch(() => { radioExtending = false; state.isPlaying = false; updatePlayerUI(); });
    return;
  } else {
    state.isPlaying = false;
  }
  updatePlayerUI();
}

// Trava contra chamadas simultaneas do radio continuo
let radioExtending = false;

function prevTrack() {
  if (!state.currentTrack) return;

  // If playing a YouTube playlist, use native navigation
  if (state.currentPlaylist && state.apiReady) {
    ytCmd('previousVideo');
    return;
  }

  if (state.currentTime > 3) {
    state.currentTime = 0;
    if (state.apiReady) ytCmd('seekTo', [0, true]);
    updatePlayerUI();
    return;
  }
  const prev = state.queueIndex - 1;
  if (prev >= 0) {
    state.queueIndex = prev;
    state.currentTrack = state.queue[prev];
    state.currentTime = 0;
    state.isPlaying = true;
    loadTrack(state.currentTrack);
  }
  updatePlayerUI();
}

function seekToTime(time) {
  state.currentTime = time;
  if (state.apiReady) ytCmd('seekTo', [time, true]);
  updatePlayerUI();
}

function toggleShuffle() {
  state.isShuffled = !state.isShuffled;

  // If playing a YouTube playlist, use native shuffle
  if (state.currentPlaylist && state.apiReady) {
    ytCmd('setShuffle', [state.isShuffled]);
    return;
  }

  if (state.isShuffled && state.currentTrack) {
    state.queue = shuffle([...state.queue]);
    state.queueIndex = state.queue.findIndex(t => t.id === state.currentTrack.id);
  }
  updatePlayerUI();
}

function cycleRepeat() {
  // With YouTube playlist: off -> all -> one -> off
  // Single video: off -> one -> off
  if (state.currentPlaylist) {
    state.repeatMode = state.repeatMode === 'off' ? 'all' : state.repeatMode === 'all' ? 'one' : 'off';
    if (state.apiReady) ytCmd('setLoop', [state.repeatMode === 'all']);
  } else {
    state.repeatMode = state.repeatMode === 'off' ? 'one' : 'off';
  }
  updatePlayerUI();
}

function toggleMute() {
  state.isMuted = !state.isMuted;
  if (state.apiReady) {
    cmd(state.isMuted ? 'mute' : 'unMute');
    if (!state.isMuted) cmd('setVolume', [state.volume]);
  }
  updatePlayerUI();
}

function setVolume(v) {
  state.volume = v;
  const wasMuted = state.isMuted;
  state.isMuted = v === 0;
  if (state.apiReady) {
    cmd('setVolume', [v]);
    if (wasMuted && v > 0) cmd('unMute');
  }
  updatePlayerUI();
}

function toggleLike(id) {
  if (state.likedTracks.has(id)) state.likedTracks.delete(id);
  else state.likedTracks.add(id);
  saveLikedTracks();
  if (typeof Reco !== 'undefined') Reco.recordLike(id, getTrack(id));
  updatePlayerUI();
  if (state.view === 'home') renderHome();
  else if (state.view === 'library') renderLibrary();
  else if (state.view === 'liked') renderLiked();
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ============================================
// GALERIA DE LINKS SALVOS (logica portada do NoTube)
// Guarda videos e playlists do YouTube para ouvir depois.
// localStorage: 'vibefm_gallery', max 60 itens, sem duplicados (chave id|list)
// ============================================
const Gallery = (function () {
  const STORAGE_KEY = 'vibefm_gallery';
  const MAX_ITEMS = 60;

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const items = raw ? JSON.parse(raw) : [];
      return Array.isArray(items) ? items : [];
    } catch (_) { return []; }
  }

  function persist(items) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(items)); } catch (_) {}
  }

  function keyOf(item) { return (item.id || '') + '|' + (item.list || ''); }

  function watchUrlOf(item) {
    if (item.id && item.list) return 'https://www.youtube.com/watch?v=' + item.id + '&list=' + item.list;
    if (item.list) return 'https://www.youtube.com/playlist?list=' + item.list;
    return 'https://www.youtube.com/watch?v=' + item.id;
  }

  function save(data) {
    const items = load();
    const key = keyOf(data);
    if (items.some((it) => keyOf(it) === key)) {
      showToast('Este link já está salvo.');
      return false;
    }
    items.unshift({
      id: data.id || null,
      list: data.list || null,
      title: data.title || null,
      addedAt: Date.now(),
    });
    if (items.length > MAX_ITEMS) items.length = MAX_ITEMS;
    persist(items);
    showToast('Salvo! Veja em "Links Salvos", no Início ou na Biblioteca.');
    return true;
  }

  function remove(key) {
    persist(load().filter((it) => keyOf(it) !== key));
    const set = loadPinned();
    if (set.delete(key)) persistPinned(set);
  }

  function updateTitle(key, title) {
    const items = load();
    const it = items.find((i) => keyOf(i) === key);
    if (it && !it.title) { it.title = title; persist(items); }
  }

  // ----- Fixar (pin) itens escolhidos pelo usuario -----
  const PINNED_KEY = 'vibefm_gallery_pinned';
  function loadPinned() {
    try {
      const raw = localStorage.getItem(PINNED_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(arr) ? arr : []);
    } catch (_) { return new Set(); }
  }
  function persistPinned(set) {
    try { localStorage.setItem(PINNED_KEY, JSON.stringify([...set])); } catch (_) {}
  }
  function isPinned(key) { return loadPinned().has(key); }
  function togglePin(key) {
    const set = loadPinned();
    if (set.has(key)) set.delete(key); else set.add(key);
    persistPinned(set);
    return set.has(key);
  }
  // Itens com os fixados primeiro (mantendo a ordem original dentro de cada grupo)
  function loadSorted() {
    const pinned = loadPinned();
    const all = load();
    const top = all.filter((it) => pinned.has(keyOf(it)));
    const rest = all.filter((it) => !pinned.has(keyOf(it)));
    return top.concat(rest);
  }


  // ----- Ocultar da Home (secao "Links Salvos" do Inicio) -----
  const HOME_HIDDEN_KEY = 'vibefm_gallery_home_hidden';
  function loadHomeHidden() {
    try {
      const raw = localStorage.getItem(HOME_HIDDEN_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(arr) ? arr : []);
    } catch (_) { return new Set(); }
  }
  function persistHomeHidden(set) {
    try { localStorage.setItem(HOME_HIDDEN_KEY, JSON.stringify([...set])); } catch (_) {}
  }
  function isHiddenFromHome(key) { return loadHomeHidden().has(key); }
  function hideFromHome(key) {
    const set = loadHomeHidden();
    set.add(key);
    persistHomeHidden(set);
  }
  function unhideFromHome(key) {
    const set = loadHomeHidden();
    set.delete(key);
    persistHomeHidden(set);
  }
  function loadSortedForHome() {
    const hidden = loadHomeHidden();
    return loadSorted().filter((it) => !hidden.has(keyOf(it)));
  }

  return { load, save, remove, keyOf, watchUrlOf, updateTitle, isPinned, togglePin, loadSorted, hideFromHome, unhideFromHome, isHiddenFromHome, loadHomeHidden, loadSortedForHome };
})();

// ============================================
// BUSCA NO YOUTUBE (sem chave de API)
// Tenta instancias publicas Piped e Invidious em ordem, com timeout,
// e normaliza os resultados para { videoId, title, author, duration }.
// ============================================
const YT_SEARCH_SOURCES = [
  { kind: 'piped', base: 'https://pipedapi.kavin.rocks' },
  { kind: 'piped', base: 'https://api.piped.private.coffee' },
  { kind: 'invidious', base: 'https://inv.nadeko.net' },
  { kind: 'invidious', base: 'https://yewtu.be' },
  { kind: 'invidious', base: 'https://invidious.nerdvpn.de' },
];
const ytSearchCache = new Map();

// ============================================
// ADSHIELD — MECANISMO SEM ANUNCIOS E PROMOCOES
// Camada unica de protecao do app, em tres frentes:
//   1. FILTRO DE CONTEUDO: todo resultado vindo do YouTube passa por
//      AdShield.filter() dentro de searchYouTube — o unico ponto de
//      entrada de conteudo externo. Isso cobre automaticamente a Busca,
//      os "Videoclipes relacionados", os "Mixes para Você" e as
//      "Novidades" (recommendations.js reusa searchYouTube).
//   2. PLAYER PRIVADO: o player usa o dominio oficial youtube-nocookie
//      (modo de privacidade aprimorada do proprio YouTube): sem cookies
//      de rastreamento, sem personalizacao de anuncios por historico.
//      Junto com rel=0, iv_load_policy=3 e modestbranding, tambem
//      remove cartoes promocionais, anotacoes e sugestoes de fim de video.
//   3. TRANSPARENCIA: conta o que foi filtrado e mostra no Perfil, com
//      um controle para ligar/desligar (padrao: ligado).
// Nao altera a logica de negocio: e um filtro puro sobre listas ja
// existentes + configuracao de player.
// ============================================
const AdShield = (function () {
  const ENABLED_KEY = 'vibefm_adshield';
  const STATS_KEY = 'vibefm_adshield_stats';

  function enabled() {
    try { return localStorage.getItem(ENABLED_KEY) !== 'off'; } catch (_) { return true; }
  }

  function setEnabled(on) {
    try { localStorage.setItem(ENABLED_KEY, on ? 'on' : 'off'); } catch (_) {}
    ytSearchCache.clear(); // resultados em cache foram filtrados com a config antiga
  }

  function blockedCount() {
    try { return parseInt(localStorage.getItem(STATS_KEY) || '0', 10) || 0; } catch (_) { return 0; }
  }

  function addBlocked(n) {
    if (!n) return;
    try { localStorage.setItem(STATS_KEY, String(blockedCount() + n)); } catch (_) {}
  }

  // Marcadores conservadores de conteudo promocional/patrocinado.
  // Regras focadas para nao gerar falsos positivos em titulos de musica.
  const PROMO_PATTERNS = [
    /#(ad|ads|publi|publicidade|patrocinado|sponsored)\b/i,
    /\b(video|conteudo|conte\u00fado|post)\s+patrocinad[oa]\b/i,
    /\bpaid\s+promotion\b/i,
    /\bsponsored\s+(content|video)\b/i,
    /\bpublicidade\s+paga\b/i,
    /\bcomercial\s+oficial\b/i,
    /\bpropaganda\s+(de|da|do)\b/i,
    /\bcupom\s+de\s+desconto\b/i,
    /\buse\s+o\s+cupom\b/i,
    /\blink\s+na\s+bio\b/i,
  ];

  function isPromo(item) {
    if (!item) return true;
    const text = ((item.title || '') + ' ' + (item.author || ''));
    if (PROMO_PATTERNS.some(rx => rx.test(text))) return true;
    // "Bumpers": clipes de poucos segundos sao vinhetas/anuncios, nao musica
    if (typeof item.duration === 'number' && item.duration > 0 && item.duration < 10) return true;
    return false;
  }

  // Filtro puro: recebe uma lista de resultados e devolve so o conteudo real
  function filter(list) {
    if (!enabled() || !Array.isArray(list)) return list;
    const clean = list.filter(it => !isPromo(it));
    addBlocked(list.length - clean.length);
    return clean;
  }

  return { enabled, setEnabled, blockedCount, isPromo, filter };
})();

let ytSearchToken = 0;

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function normalizePiped(items) {
  return (items || [])
    .filter(it => it && it.url && it.url.includes('watch?v='))
    .map(it => ({
      videoId: extractVideoId(it.url),
      title: it.title || '',
      author: it.uploaderName || '',
      duration: it.duration || 0,
      views: (typeof it.views === 'number' && it.views >= 0) ? it.views : 0,
      published: (typeof it.uploaded === 'number' && it.uploaded > 0) ? it.uploaded : null,
      publishedText: it.uploadedDate || it.uploadedText || '',
    }))
    .filter(it => isValidId(it.videoId));
}

function normalizeInvidious(items) {
  return (items || [])
    .filter(it => it && it.type === 'video' && it.videoId)
    .map(it => ({
      videoId: it.videoId,
      title: it.title || '',
      author: it.author || '',
      duration: it.lengthSeconds || 0,
      views: (typeof it.viewCount === 'number' && it.viewCount >= 0) ? it.viewCount : 0,
      published: (typeof it.published === 'number' && it.published > 0) ? it.published * 1000 : null,
      publishedText: it.publishedText || '',
    }))
    .filter(it => isValidId(it.videoId));
}

// ============================================
// ACURACIA POR QUANTIDADE DE REPRODUCAO
// Ranqueia qualquer lista de resultados do YouTube pela contagem de
// reproducoes (views): o conteudo mais reproduzido e considerado mais
// relevante e sobe; o menos reproduzido desce. Ordenacao estavel:
// empates preservam a ordem original da busca.
// Aplicado dentro de searchYouTube, o unico ponto de entrada de
// conteudo externo — cobre a Busca, as playlists dinamicas
// ("Feitas para Você"), os relacionados, os mixes e as novidades.
// ============================================
function rankByPlays(items) {
  if (!Array.isArray(items)) return items;
  return items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => ((b.it.views || 0) - (a.it.views || 0)) || (a.i - b.i))
    .map(x => x.it);
}

// Formata contagem de reproducoes de forma compacta (pt-BR): 1,2 mi, 340 mil...
function fmtViews(v) {
  if (!v || v <= 0) return '';
  try {
    return new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 }).format(v) + ' reproduções';
  } catch (_) {
    return String(v) + ' reproduções';
  }
}

async function searchYouTube(query) {
  const q = query.trim();
  if (ytSearchCache.has(q)) return ytSearchCache.get(q);

  for (const src of YT_SEARCH_SOURCES) {
    try {
      const url = src.kind === 'piped'
        ? src.base + '/search?q=' + encodeURIComponent(q) + '&filter=videos'
        : src.base + '/api/v1/search?q=' + encodeURIComponent(q) + '&type=video';
      const res = await fetchWithTimeout(url, 4500);
      if (!res.ok) continue;
      const data = await res.json();
      const raw = src.kind === 'piped'
        ? normalizePiped(data && data.items)
        : normalizeInvidious(data);
      // Mecanismo sem anuncios: filtra promocoes/patrocinados na origem.
      // Todos os consumidores (busca, relacionados, mixes, novidades)
      // recebem apenas conteudo real.
      const items = AdShield.filter(raw);
      if (items.length) {
        // Acuracia: os mais reproduzidos primeiro (relevancia por views)
        const top = rankByPlays(items).slice(0, 12);
        ytSearchCache.set(q, top);
        return top;
      }
    } catch (_) { /* tenta a proxima instancia */ }
  }
  ytSearchCache.set(q, []);
  return [];
}

// Garante que um video do YouTube existe como faixa virtual em TRACKS
// (necessario para trackRow/getTrack/fila funcionarem com itens do YT)
function materializeYtTrack(videoId, title, artist, duration) {
  const id = 'yt_' + videoId;
  let track = TRACKS.find(t => t.id === id);
  if (!track) {
    track = {
      id,
      title: title || 'Vídeo do YouTube',
      artist: artist || 'YouTube',
      album: 'YouTube',
      cover: 'https://i.ytimg.com/vi/' + videoId + '/mqdefault.jpg',
      duration: duration || 0,
      videoId,
    };
    TRACKS.push(track);
  } else {
    if (title) track.title = title;
    if (artist) track.artist = artist;
    if (duration && !track.duration) track.duration = duration;
  }
  return track;
}

function playYouTubeResult(result, results) {
  const track = materializeYtTrack(result.videoId, result.title, result.author, result.duration);
  const queue = (results || [result]).map(r => materializeYtTrack(r.videoId, r.title, r.author, r.duration));
  playTrack(track, queue);
  saveLastTrack();
  startAutoVideoTimer();
}

// ============================================
// PLAYSTATS — CONTAGEM LOCAL DE REPRODUCOES
// Registra quantas vezes cada faixa foi tocada nesta instalacao.
// E o sinal de longo prazo do algoritmo de sugestoes: faixas e
// artistas que o usuario mais reproduz sao mais relevantes
// (o historico guarda so os ultimos 100 eventos; isto persiste).
// ============================================
const PlayStats = (function () {
  const STORAGE_KEY = 'vibefm_play_stats';
  const MAX_ENTRIES = 600;

  function load() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
    catch (_) { return {}; }
  }
  function persist(m) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(m)); } catch (_) {}
  }

  function record(track) {
    if (!track || !track.id) return;
    const m = load();
    const prev = m[track.id] || { plays: 0 };
    m[track.id] = {
      plays: prev.plays + 1,
      title: track.title || prev.title || '',
      artist: track.artist || prev.artist || '',
      videoId: track.videoId || prev.videoId || '',
      last: Date.now(),
    };
    // Poda: mantem as mais tocadas/recentes para nao crescer sem limite
    const keys = Object.keys(m);
    if (keys.length > MAX_ENTRIES) {
      keys.sort((a, b) => (m[a].plays - m[b].plays) || (m[a].last - m[b].last));
      keys.slice(0, keys.length - MAX_ENTRIES).forEach(k => delete m[k]);
    }
    persist(m);
  }

  function playsOf(trackId) {
    const e = load()[trackId];
    return e ? e.plays : 0;
  }
  function playsOfVideo(videoId) {
    return playsOf('yt_' + videoId);
  }

  // Total de reproducoes por artista (chave normalizada em minusculas)
  function artistPlays() {
    const out = new Map();
    Object.values(load()).forEach(e => {
      const a = (e.artist || '').trim().toLowerCase();
      if (!a) return;
      out.set(a, (out.get(a) || 0) + e.plays);
    });
    return out;
  }

  function top(n) {
    return Object.entries(load())
      .sort((a, b) => (b[1].plays - a[1].plays) || (b[1].last - a[1].last))
      .slice(0, n || 10)
      .map(([id, e]) => ({ id, ...e }));
  }

  return { record, playsOf, playsOfVideo, artistPlays, top };
})();

// ============================================
// BUSCA DE PLAYLISTS PRONTAS NO YOUTUBE
// Mesmas instancias Piped/Invidious da busca de videos, filtro
// "playlists". Normaliza para { playlistId, title, author, videos,
// thumbnail } e ranqueia pelo tamanho (nº de videos) como proxy de
// relevancia — as APIs publicas nao expõem views de playlists.
// ============================================
const ytPlaylistSearchCache = new Map();

function normalizePipedPlaylists(items) {
  return (items || [])
    .filter(it => it && it.type === 'playlist' && it.url && it.url.includes('list='))
    .map(it => ({
      playlistId: extractPlaylistId(it.url),
      title: it.name || '',
      author: it.uploaderName || '',
      videos: (typeof it.videos === 'number' && it.videos > 0) ? it.videos : 0,
      thumbnail: it.thumbnail || '',
    }))
    .filter(it => isValidPlaylistId(it.playlistId));
}

function normalizeInvidiousPlaylists(items) {
  return (items || [])
    .filter(it => it && it.type === 'playlist' && it.playlistId)
    .map(it => ({
      playlistId: it.playlistId,
      title: it.title || '',
      author: it.author || '',
      videos: (typeof it.videoCount === 'number' && it.videoCount > 0) ? it.videoCount : 0,
      thumbnail: it.playlistThumbnail || '',
    }))
    .filter(it => isValidPlaylistId(it.playlistId));
}

async function searchYouTubePlaylists(query) {
  const q = query.trim();
  if (ytPlaylistSearchCache.has(q)) return ytPlaylistSearchCache.get(q);

  for (const src of YT_SEARCH_SOURCES) {
    try {
      const url = src.kind === 'piped'
        ? src.base + '/search?q=' + encodeURIComponent(q) + '&filter=playlists'
        : src.base + '/api/v1/search?q=' + encodeURIComponent(q) + '&type=playlist';
      const res = await fetchWithTimeout(url, 4500);
      if (!res.ok) continue;
      const data = await res.json();
      const raw = src.kind === 'piped'
        ? normalizePipedPlaylists(data && data.items)
        : normalizeInvidiousPlaylists(data);
      const items = AdShield.filter(raw);
      if (items.length) {
        // Playlists maiores tendem a ser coletaneas consolidadas
        const top = items.sort((a, b) => (b.videos || 0) - (a.videos || 0)).slice(0, 8);
        ytPlaylistSearchCache.set(q, top);
        return top;
      }
    } catch (_) { /* tenta a proxima instancia */ }
  }
  ytPlaylistSearchCache.set(q, []);
  return [];
}

// ============================================
// TENDENCIAS — CONTEUDO MAIS VISTO BASEADO NOS GOSTOS DO USUARIO
// Busca por queries derivadas dos gostos do usuario (Tastes), combinando
// resultados de multiplas buscas e ordenando por visualizacoes (mais vistos primeiro).
// Assim as "Tendencias" refletem o que esta em alta DENTRO dos gostos do usuario.
// Cache de 30 min para acompanhar o dia sem martelar as instancias.
// ============================================
const TRENDING_CACHE_KEY = 'vibefm_trending_cache';
const TRENDING_TTL = 30 * 60 * 1000; // 30 min

async function fetchTrendingMusic() {
  try {
    const c = JSON.parse(localStorage.getItem(TRENDING_CACHE_KEY) || 'null');
    if (c && Date.now() - c.at < TRENDING_TTL && Array.isArray(c.items) && c.items.length) {
      return c.items;
    }
  } catch (_) {}

  // Constroi queries a partir dos gostos do usuario
  const tastes = Tastes.load();
  const year = new Date().getFullYear();
  const queries = [];
  tastes.forEach(g => {
    queries.push(g + ' music ' + year);
    queries.push(g + ' hits ' + year);
    queries.push('melhores ' + g + ' ' + year);
  });
  // Tambem busca por artistas mais ouvidos do usuario
  if (typeof PlayStats !== 'undefined') {
    PlayStats.top(5).forEach(e => {
      if (e.artist) queries.push(e.artist + ' ' + year);
    });
  }

  const uniq = [...new Set(queries.map(q => q.trim()).filter(Boolean))];
  if (!uniq.length) return [];

  // Executa as buscas com concorrencia limitada (max 3 simultaneas)
  const allResults = [];
  const concurrency = 3;
  for (let i = 0; i < uniq.length; i += concurrency) {
    const batch = uniq.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(q => searchYouTube(q).catch(() => [])));
    results.forEach(list => allResults.push(...list));
  }

  // Deduplica por videoId e soma views
  const byId = new Map();
  allResults.forEach(r => {
    if (!r.videoId) return;
    const existing = byId.get(r.videoId);
    if (existing) {
      existing.views = Math.max(existing.views || 0, r.views || 0);
      existing._hits = (existing._hits || 1) + 1;
    } else {
      byId.set(r.videoId, { ...r, _hits: 1 });
    }
  });

  // Ordena por visualizacoes (mais vistos primeiro) e pega os top 16
  const items = [...byId.values()]
    .sort((a, b) => (b.views || 0) - (a.views || 0))
    .slice(0, 16);

  if (items.length) {
    try { localStorage.setItem(TRENDING_CACHE_KEY, JSON.stringify({ at: Date.now(), items })); } catch (_) {}
  }

  return items;
}

// ============================================
// PLAYLISTS DO USUARIO (persistidas em JSON)
// localStorage 'vibefm_user_playlists' + exportar/importar arquivo .json
// Itens: { type:'local', trackId } | { type:'yt', videoId, title, artist, duration }
// ============================================
const UserPlaylists = (function () {
  const STORAGE_KEY = 'vibefm_user_playlists';

  // Remove itens com o mesmo ID (itemKey) dentro de uma mesma lista,
  // preservando a primeira ocorrencia. Usado como defesa em todos os
  // caminhos de escrita (usuario, sistema, importacao).
  function dedupeItems(items) {
    const seen = new Set();
    return (Array.isArray(items) ? items : []).filter(it => {
      if (!it) return false;
      const key = itemKey(it);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const pls = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(pls)) return [];
      // Saneia duplicatas por ID dentro de cada playlist (dados legados
      // ou gravados por qualquer outro caminho).
      let changed = false;
      pls.forEach(pl => {
        if (!pl || !Array.isArray(pl.items)) return;
        const unique = dedupeItems(pl.items);
        if (unique.length !== pl.items.length) changed = true;
        pl.items = unique;
      });
      if (changed) persist(pls);
      return pls;
    } catch (_) { return []; }
  }

  function persist(pls) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(pls)); } catch (_) {}
  }

  function create(name) {
    const pls = load();
    const pl = {
      id: 'u' + Date.now().toString(36),
      name: (name || 'Nova playlist').trim().slice(0, 60),
      createdAt: Date.now(),
      items: [],
    };
    pls.unshift(pl);
    persist(pls);
    return pl;
  }

  function remove(id) { persist(load().filter(p => p.id !== id)); }

  function itemKey(item) {
    return item.type === 'local' ? 'l:' + item.trackId : 'y:' + item.videoId;
  }

  function addItem(playlistId, item) {
    const pls = load();
    const pl = pls.find(p => p.id === playlistId);
    if (!pl) return false;
    const key = itemKey(item);
    if (pl.items.some(it => itemKey(it) === key)) {
      showToast('Esta faixa já está na playlist.');
      return false;
    }
    // Mais recente primeiro: novas faixas entram no topo da playlist
    item.addedAt = Date.now();
    pl.items.unshift(item);
    persist(pls);
    showToast('Adicionada à playlist "' + pl.name + '"');
    return true;
  }

  function removeItem(playlistId, key) {
    const pls = load();
    const pl = pls.find(p => p.id === playlistId);
    if (!pl) return;
    pl.items = pl.items.filter(it => itemKey(it) !== key);
    persist(pls);
  }

  // Reordena os itens da playlist para seguir a lista de chaves informada
  // (chaves ausentes mantem a posicao relativa ao final). Usado pelo
  // drag and drop das faixas.
  function setOrder(playlistId, keys) {
    const pls = load();
    const pl = pls.find(p => p.id === playlistId);
    if (!pl) return;
    const byKey = new Map(pl.items.map(it => [itemKey(it), it]));
    const ordered = [];
    (keys || []).forEach(k => {
      if (byKey.has(k)) { ordered.push(byKey.get(k)); byKey.delete(k); }
    });
    byKey.forEach(it => ordered.push(it));
    pl.items = ordered;
    persist(pls);
  }

  // Converte itens em objetos de faixa reproduziveis
  function tracksOf(pl) {
    return pl.items.map(it => {
      if (it.type === 'local') return getTrack(it.trackId);
      return materializeYtTrack(it.videoId, it.title, it.artist, it.duration);
    }).filter(Boolean);
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(load(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'vibefm-playlists.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    showToast('Playlists exportadas para vibefm-playlists.json');
  }

  function importJson(file, onDone) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = JSON.parse(reader.result);
        if (!Array.isArray(imported)) throw new Error('formato');
        const pls = load();
        const existing = new Set(pls.map(p => p.id));
        let added = 0;
        for (const p of imported) {
          if (!p || !p.name || !Array.isArray(p.items)) continue;
          if (existing.has(p.id)) continue;
          pls.push({ id: p.id || ('u' + Math.random().toString(36).slice(2)), name: String(p.name).slice(0, 60), createdAt: p.createdAt || Date.now(), items: dedupeItems(p.items) });
          added++;
        }
        persist(pls);
        showToast(added ? added + ' playlist(s) importada(s)' : 'Nenhuma playlist nova no arquivo');
        if (onDone) onDone();
      } catch (_) {
        showToast('Arquivo JSON inválido');
      }
    };
    reader.readAsText(file);
  }

  return { load, create, remove, addItem, removeItem, itemKey, setOrder, tracksOf, exportJson, importJson };
})();

// ============================================
// GOSTOS DO USUARIO + PLAYLISTS DINAMICAS
// Os generos definem playlists geradas dinamicamente na Home.
// Editaveis no Perfil; persistidos em 'vibefm_tastes'.
// ============================================
const Tastes = (function () {
  const STORAGE_KEY = 'vibefm_tastes';

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const t = raw ? JSON.parse(raw) : null;
      return Array.isArray(t) && t.length ? t : DEFAULT_TASTES.slice();
    } catch (_) { return DEFAULT_TASTES.slice(); }
  }

  function persist(t) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(t)); } catch (_) {}
  }

  function add(genre) {
    const g = (genre || '').trim().slice(0, 40);
    if (!g) return false;
    const t = load();
    if (t.some(x => x.toLowerCase() === g.toLowerCase())) {
      showToast('Este gênero já está nos seus gostos.');
      return false;
    }
    t.push(g);
    persist(t);
    invalidateDynamic();
    return true;
  }

  function remove(genre) {
    persist(load().filter(x => x !== genre));
    invalidateDynamic(genre);
  }

  return { load, add, remove };
})();

// Cache das playlists dinamicas: genero -> { tracks, at }
const dynamicPlaylistCache = new Map();
const DYNAMIC_TTL = 30 * 60 * 1000; // 30 min

function invalidateDynamic(genre) {
  if (genre) dynamicPlaylistCache.delete(genre);
  else dynamicPlaylistCache.clear();
}

function genreQuery(genre) {
  const g = genre.toLowerCase();
  if (g.includes('music') || g.includes('musica') || g.includes('m\u00fasica')) return genre;
  return genre + ' music';
}

async function loadDynamicPlaylist(genre) {
  const cached = dynamicPlaylistCache.get(genre);
  if (cached && Date.now() - cached.at < DYNAMIC_TTL) return cached.tracks;
  const results = await searchYouTube(genreQuery(genre));
  const tracks = results.map(r => {
    const t = materializeYtTrack(r.videoId, r.title, r.author, r.duration);
    t._srcGenre = genre; // permite inferir afinidade de genero quando o usuario curte/toca
    return t;
  });
  dynamicPlaylistCache.set(genre, { tracks, at: Date.now() });
  return tracks;
}

// ===== Seletor "Adicionar à playlist" =====
// Curte uma faixa a partir de um item {type, videoId/trackId,...} (usado no seletor)
function likeItem(item) {
  let track;
  if (item.type === 'local') track = getTrack(item.trackId);
  else track = materializeYtTrack(item.videoId, item.title, item.artist, item.duration);
  if (!track) return;
  if (state.likedTracks.has(track.id)) {
    showToast('Já está em "Curtidas".');
    return;
  }
  state.likedTracks.add(track.id);
  saveLikedTracks();
  if (typeof Reco !== 'undefined' && Reco.recordLike) Reco.recordLike(track.id, track);
  updatePlayerUI();
  showToast('Adicionada à playlist "Curtidas"');
}

// ============================================
// DRAG AND DROP DE FAIXAS (playlists do usuario)
// Adiciona uma alca de arrastar em cada linha e reordena a lista ao
// soltar. Usa Pointer Events (mouse e toque). Nao altera a logica de
// reproducao: apenas a ordem persistida via UserPlaylists.setOrder.
// ============================================
function enableTrackDrag(list, onReorder) {
  Array.from(list.children).forEach(row => {
    if (row.querySelector('.drag-handle')) return;
    const handle = document.createElement('button');
    handle.className = 'row-action-btn drag-handle';
    handle.title = 'Arrastar para reordenar';
    handle.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>';
    handle.addEventListener('click', (e) => e.stopPropagation());
    handle.addEventListener('pointerdown', (e) => startRowDrag(e, row, list, () => {
      if (typeof onReorder === 'function') onReorder();
    }));
    row.insertBefore(handle, row.firstChild);
  });
}

// Nucleo compartilhado do arrasto vertical de linhas (mouse e toque).
// Move a linha entre os irmaos enquanto arrasta e, ao soltar, chama
// onDrop(fromIndex, toIndex) se a posicao mudou.
function startRowDrag(e, row, list, onDrop) {
  e.preventDefault();
  e.stopPropagation();
  const fromIndex = Array.prototype.indexOf.call(list.children, row);
  row.classList.add('dragging');

  const onMove = (ev) => {
    ev.preventDefault();
    const y = ev.clientY;
    const siblings = Array.from(list.children).filter(c => c !== row);
    let next = null;
    for (const sib of siblings) {
      const r = sib.getBoundingClientRect();
      if (y < r.top + r.height / 2) { next = sib; break; }
    }
    if (next) list.insertBefore(row, next);
    else list.appendChild(row);
  };
  const onUp = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onUp);
    row.classList.remove('dragging');
    const toIndex = Array.prototype.indexOf.call(list.children, row);
    if (toIndex !== fromIndex && typeof onDrop === 'function') onDrop(fromIndex, toIndex);
  };
  document.addEventListener('pointermove', onMove, { passive: false });
  document.addEventListener('pointerup', onUp);
  document.addEventListener('pointercancel', onUp);
}

// ============================================
// MENU "..." POR FAIXA (mobile)
// Bottom sheet com as acoes que, no mobile, saem da linha
// ("Adicionar a playlist" e "Salvar link").
// ============================================
function openTrackMenu(title, actions) {
  const old = document.getElementById('track-menu');
  if (old) old.remove();

  const overlay = document.createElement('div');
  overlay.id = 'track-menu';
  overlay.innerHTML = '<div class="track-menu-backdrop"></div><div class="track-menu-sheet"><div class="track-menu-title"></div></div>';
  overlay.querySelector('.track-menu-title').textContent = title || '';
  const sheet = overlay.querySelector('.track-menu-sheet');

  actions.forEach(a => {
    const btn = document.createElement('button');
    btn.className = 'track-menu-item';
    btn.innerHTML = (a.icon || '') + '<span></span>';
    btn.querySelector('span').textContent = a.label;
    btn.addEventListener('click', () => { overlay.remove(); a.onClick(); });
    sheet.appendChild(btn);
  });

  overlay.querySelector('.track-menu-backdrop').addEventListener('click', () => overlay.remove());
  document.body.appendChild(overlay);
}

const MENU_ICON_ADD = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19" stroke-linecap="round"/><line x1="5" y1="12" x2="19" y2="12" stroke-linecap="round"/></svg>';
const MENU_ICON_SAVE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3H7a2 2 0 00-2 2v16l7-3 7 3V5a2 2 0 00-2-2z"/></svg>';
const MENU_ICON_DOTS = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';

function openPlaylistChooser(item) {
  const old = document.getElementById('pl-chooser');
  if (old) old.remove();

  const overlay = document.createElement('div');
  overlay.id = 'pl-chooser';
  overlay.innerHTML = `
    <div class="pl-chooser-backdrop"></div>
    <div class="pl-chooser-modal">
      <h3>Adicionar à playlist</h3>
      <div class="pl-chooser-list" id="pl-chooser-list"></div>
      <div class="pl-chooser-new">
        <input type="text" id="pl-chooser-input" placeholder="Nova playlist..." maxlength="60">
        <button id="pl-chooser-create">Criar</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const listEl = overlay.querySelector('#pl-chooser-list');
  const close = () => overlay.remove();
  overlay.querySelector('.pl-chooser-backdrop').addEventListener('click', close);

  function fillList() {
    const pls = UserPlaylists.load();
    listEl.replaceChildren();

    // "Curtidas" sempre como primeira opcao (adicionar = curtir)
    const likedBtn = document.createElement('button');
    likedBtn.className = 'pl-chooser-item';
    likedBtn.innerHTML = '<span>\u2665 Curtidas</span><small>' + state.likedTracks.size + ' faixas</small>';
    likedBtn.addEventListener('click', () => {
      likeItem(item);
      close();
      if (state.view === 'home') renderHome();
      else if (state.view === 'library') renderLibrary();
    });
    listEl.appendChild(likedBtn);

    if (!pls.length) {
      const p = document.createElement('p');
      p.className = 'pl-chooser-empty';
      p.textContent = 'Nenhuma outra playlist ainda. Crie uma abaixo.';
      listEl.appendChild(p);
      return;
    }
    pls.forEach(pl => {
      const btn = document.createElement('button');
      btn.className = 'pl-chooser-item';
      btn.innerHTML = `<span>${escapeHtml(pl.name)}</span><small>${pl.items.length} faixas</small>`;
      btn.addEventListener('click', () => {
        UserPlaylists.addItem(pl.id, item);
        close();
        if (state.view === 'home') renderHome();
      });
      listEl.appendChild(btn);
    });
  }
  fillList();

  const input = overlay.querySelector('#pl-chooser-input');
  overlay.querySelector('#pl-chooser-create').addEventListener('click', () => {
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    const pl = UserPlaylists.create(name);
    UserPlaylists.addItem(pl.id, item);
    close();
    renderSidebarPlaylists();
    if (state.view === 'home') renderHome();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') overlay.querySelector('#pl-chooser-create').click();
    e.stopPropagation();
  });
  input.focus();
}

// Cartao de link salvo reutilizavel (usado na Biblioteca e na secao da Home).
// onChange e chamado apos fixar/remover para atualizar a lista que o exibe.
function createGalleryCard(item, onChange, mode) {
  const key = Gallery.keyOf(item);
  const isPlaylist = !!item.list;
  const pinned = Gallery.isPinned(key);

  const card = document.createElement('div');
  card.className = 'album-card gallery-card' + (pinned ? ' pinned' : '');

  const coverWrap = document.createElement('div');
  coverWrap.className = 'album-cover-wrap';

  if (item.id) {
    const img = document.createElement('img');
    img.src = 'https://i.ytimg.com/vi/' + item.id + '/mqdefault.jpg';
    img.alt = '';
    img.loading = 'lazy';
    coverWrap.appendChild(img);
  } else {
    const ph = document.createElement('div');
    ph.className = 'gallery-thumb-list';
    ph.innerHTML = '<svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 6h11M4 11h11M4 16h7M17 11.5l5 3-5 3z"/></svg>';
    coverWrap.appendChild(ph);
  }

  if (isPlaylist) {
    const b = document.createElement('span');
    b.className = 'gallery-badge-list';
    b.textContent = 'LIST';
    coverWrap.appendChild(b);
  }

  const overlay = document.createElement('div');
  overlay.className = 'album-overlay';
  overlay.innerHTML = '<button class="album-play-btn"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>';
  coverWrap.appendChild(overlay);

  // Botao fixar/desafixar
  const pin = document.createElement('button');
  pin.className = 'gallery-pin' + (pinned ? ' pinned' : '');
  pin.title = pinned ? 'Desafixar' : 'Fixar no topo';
  pin.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="' + (pinned ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="2"><line x1="12" y1="17" x2="12" y2="22" stroke-linecap="round"/><path d="M9 3h6l-1 7 3 3H7l3-3-1-7z" stroke-linejoin="round"/></svg>';
  pin.addEventListener('click', (e) => {
    e.stopPropagation();
    Gallery.togglePin(key);
    if (onChange) onChange();
  });
  coverWrap.appendChild(pin);

  // Botao remover
  const del = document.createElement('button');
  del.className = 'gallery-del';
  del.title = mode === 'hideFromHome' ? 'Ocultar da Home' : 'Remover';
  del.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18" stroke-linecap="round"/><line x1="6" y1="6" x2="18" y2="18" stroke-linecap="round"/></svg>';
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    if (mode === 'hideFromHome') {
      Gallery.hideFromHome(key);
      showToast('Oculto da Home. Acesse "Links Salvos" na Biblioteca para ver todos.');
    } else {
      Gallery.remove(key);
    }
    if (onChange) onChange();
  });
  coverWrap.appendChild(del);

  const info = document.createElement('div');
  info.className = 'album-info';
  const titleEl = document.createElement('div');
  titleEl.className = 'album-title';
  titleEl.textContent = item.title || (isPlaylist ? 'Playlist' : 'Vídeo');
  const sub = document.createElement('div');
  sub.className = 'album-artist';
  sub.textContent = isPlaylist ? 'list=' + item.list.slice(0, 18) + (item.list.length > 18 ? '\u2026' : '') : 'youtu.be/' + item.id;
  info.appendChild(titleEl);
  info.appendChild(sub);

  card.appendChild(coverWrap);
  card.appendChild(info);
  card.addEventListener('click', () => playFromUrl(Gallery.watchUrlOf(item)));

  // Completa o titulo via oEmbed se ainda nao temos (so para videos)
  if (!item.title && item.id) {
    fetchOembed(item.id).then(() => {
      const t = titleCache.get(item.id);
      if (t) { titleEl.textContent = t; Gallery.updateTitle(key, t); }
    });
  }
  return card;
}

function renderSaved() {
  const items = Gallery.loadSorted();
  const hiddenItems = items.filter((it) => Gallery.isHiddenFromHome(Gallery.keyOf(it)));
  const visibleItems = items.filter((it) => !Gallery.isHiddenFromHome(Gallery.keyOf(it)));

  main.innerHTML = `
    <div class="section">
      ${backButton()}
      <h2 class="section-title" style="margin-bottom:6px">Links Salvos</h2>
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:20px">Vídeos e playlists do YouTube guardados para ouvir quando quiser. Fixe os favoritos para mantê-los no topo.</p>
      ${items.length ? `<div class="album-grid" id="gallery-grid"></div>` : `
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17 3H7a2 2 0 00-2 2v16l7-3 7 3V5a2 2 0 00-2-2z"/></svg>
          <p>Nenhum link salvo ainda.</p>
          <p style="font-size:11px;color:var(--text-muted)">Cole uma URL do YouTube na Busca e clique em Salvar.</p>
        </div>`}
      ${hiddenItems.length ? `
        <div style="margin-top:32px">
          <h3 class="section-title" style="margin-bottom:6px;font-size:16px">Ocultos da Home</h3>
          <p style="font-size:11.5px;color:var(--text-muted);margin-bottom:14px">Estes itens foram ocultados da seção "Links Salvos" no Início, mas continuam disponíveis aqui.</p>
          <div class="album-grid" id="gallery-hidden-grid"></div>
        </div>` : ''}
    </div>
  `;

  const grid = document.getElementById('gallery-grid');
  if (grid) visibleItems.forEach((item) => grid.appendChild(createGalleryCard(item, renderSaved)));

  const hiddenGrid = document.getElementById('gallery-hidden-grid');
  if (hiddenGrid) {
    hiddenItems.forEach((item) => {
      const card = createGalleryCard(item, renderSaved);
      // Adicionar badge de "Oculto da Home" no card
      const badge = document.createElement('div');
      badge.style.cssText = 'position:absolute;top:6px;left:50%;transform:translateX(-50%);z-index:5;padding:2px 8px;font-size:9px;font-weight:700;letter-spacing:0.06em;color:#fff;background:rgba(10,228,72,0.85);border-radius:4px;pointer-events:none;';
      badge.textContent = 'OCULTO DA HOME';
      card.querySelector('.album-cover-wrap').appendChild(badge);
      // Mudar o título do botão de remover para "Restaurar na Home"
      const delBtn = card.querySelector('.gallery-del');
      if (delBtn) {
        delBtn.title = 'Restaurar na Home';
        delBtn.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        delBtn.onclick = (e) => {
          e.stopPropagation();
          Gallery.unhideFromHome(Gallery.keyOf(item));
          showToast('Restaurado na Home!');
          renderSaved();
          // Se estiver na home, atualiza o carrossel
          if (state.view === 'home') renderHomeSaved();
        };
      }
      hiddenGrid.appendChild(card);
    });
  }
}

// ============================================
// RENDER VIEWS
// ============================================
const main = document.getElementById('main-content');

// Botao "voltar uma etapa": retorna para a view de origem (por padrao, a Biblioteca)
function backButton(targetView = 'library', label = 'Voltar') {
  return `<button class="back-btn" data-back-to="${targetView}" title="Voltar uma etapa">
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6" stroke-linecap="round" stroke-linejoin="round"/></svg>
    ${label}
  </button>`;
}

// Delegacao: qualquer .back-btn dentro do conteudo principal navega de volta.
// Escuta no #main-content (persistente), entao funciona apos cada re-render.
main.addEventListener('click', (e) => {
  const btn = e.target.closest('.back-btn[data-back-to]');
  if (btn) setView(btn.dataset.backTo);
});

function setView(view) {
  state.prevView = state.view;
  state.view = view;
  document.querySelectorAll('.nav-btn[data-view]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });

  switch(view) {
    case 'home': renderHome(); break;
    case 'search': renderSearch(); break;
    case 'library': renderLibrary(); break;
    case 'profile': renderProfile(); break;
    case 'liked': renderLiked(); break;
    case 'recent': renderRecent(); break;
    case 'saved': renderSaved(); break;
  }
}

const expandedPlaylists = new Set(); // ids expandidos persistem entre re-renders da Home

// Playlist automatica "Curtidas": sempre a primeira em "Suas Playlists".
// E virtual (espelha state.likedTracks): adicionar = curtir, remover = descurtir.
const LIKED_PL_ID = 'liked';
function likedPlaylistConfig() {
  const tracks = TRACKS.filter(t => state.likedTracks.has(t.id));
  return {
    id: LIKED_PL_ID,
    name: 'Curtidas',
    subtitle: tracks.length + ' faixa(s) \u00B7 suas curtidas',
    tracks,
    isUser: false,
    isLiked: true,
    cover: tracks[0] && tracks[0].cover,
  };
}

// Repopula apenas o carrossel de "Links Salvos" da Home (fixados primeiro, ocultos filtrados).
function renderHomeSaved() {
  const track = document.getElementById('home-saved-carousel');
  if (!track) return;
  const items = Gallery.loadSortedForHome();
  track.replaceChildren();
  if (!items.length) {
    const p = document.createElement('p');
    p.style.cssText = 'font-size:12px;color:var(--text-muted);padding:8px 0';
    const allItems = Gallery.loadSorted();
    const hiddenCount = allItems.length - items.length;
    p.textContent = allItems.length === 0
      ? 'Nenhum link salvo ainda. Cole uma URL do YouTube na Busca e clique em Salvar.'
      : hiddenCount > 0
        ? hiddenCount + ' link(s) oculto(s) da Home. Ver todos em "Links Salvos" na Biblioteca.'
        : 'Nenhum link salvo ainda.';
    track.appendChild(p);
    return;
  }
  items.forEach(item => track.appendChild(createGalleryCard(item, renderHomeSaved, 'hideFromHome')));
}

function renderHome() {
  const userPls = UserPlaylists.load();
  const tastes = Tastes.load();

  main.innerHTML = `
    <div class="section">
      <div class="section-header pl-home-header">
        <h2 class="section-title">Suas Playlists</h2>
        <div class="pl-home-actions">
          <button class="pl-action-btn" id="btn-new-playlist">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19" stroke-linecap="round"/><line x1="5" y1="12" x2="19" y2="12" stroke-linecap="round"/></svg>
            Nova
          </button>
          <button class="pl-action-btn" id="btn-export-pls" title="Baixar playlists como arquivo JSON">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" stroke-linecap="round"/><polyline points="7 10 12 15 17 10" stroke-linecap="round" stroke-linejoin="round"/><line x1="12" y1="15" x2="12" y2="3" stroke-linecap="round"/></svg>
            Exportar
          </button>
          <button class="pl-action-btn" id="btn-import-pls" title="Importar playlists de um arquivo JSON">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" stroke-linecap="round"/><polyline points="17 8 12 3 7 8" stroke-linecap="round" stroke-linejoin="round"/><line x1="12" y1="3" x2="12" y2="15" stroke-linecap="round"/></svg>
            Importar
          </button>
          <input type="file" id="import-pls-file" accept=".json,application/json" style="display:none">
        </div>
      </div>
      ${buildCarousel('home-user-pl', 'home-user-pl-carousel')}
    </div>
    <div class="section">
      <div class="section-header pl-home-header">
        <h2 class="section-title">Feitas para Você</h2>
        <button class="pl-action-btn" id="btn-edit-tastes" title="Editar seus gostos no Perfil">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" stroke-linecap="round"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" stroke-linejoin="round"/></svg>
          Editar gostos
        </button>
      </div>
      <p style="font-size:11.5px;color:var(--text-muted);margin:-6px 0 14px">Playlists geradas dinamicamente a partir dos seus gêneros favoritos.</p>
      ${buildCarousel('home-dyn-pl', 'home-dyn-pl-carousel')}
    </div>
    <div class="section" id="reco-mix-section">
      <div class="section-header pl-home-header">
        <h2 class="section-title">Mixes para Você</h2>
        <button class="pl-action-btn" id="btn-refresh-reco" title="Gerar novos mixes e novidades">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10" stroke-linecap="round" stroke-linejoin="round"/><polyline points="1 20 1 14 7 14" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Atualizar
        </button>
      </div>
      <p style="font-size:11.5px;color:var(--text-muted);margin:-6px 0 14px">Mixes diversos a partir das suas curtidas, do que você ouve e dos seus gostos.</p>
      <div class="pl-carousel-wrap" id="reco-mix-wrap">
        <button class="pl-carousel-arrow pl-carousel-prev" id="reco-mix-prev" title="Anterior"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <div class="pl-carousel-track" id="reco-mix-carousel"><p style="font-size:12px;color:var(--text-muted)">Gerando seus mixes\u2026</p></div>
        <button class="pl-carousel-arrow pl-carousel-next" id="reco-mix-next" title="Próximo"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      </div>
    </div>
    <div class="section" id="home-saved-section">
      <div class="section-header pl-home-header">
        <h2 class="section-title">Links Salvos</h2>
        <button class="pl-action-btn" id="btn-see-saved" title="Ver todos os links salvos">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14" stroke-linecap="round"/><polyline points="12 5 19 12 12 19" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Ver todos
        </button>
      </div>
      <p style="font-size:11.5px;color:var(--text-muted);margin:-6px 0 14px">Seus vídeos e playlists salvos. Fixe os favoritos para mantê-los no topo.</p>
      <div class="pl-carousel-wrap" id="home-saved-wrap">
        <button class="pl-carousel-arrow pl-carousel-prev" id="home-saved-prev" title="Anterior"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <div class="pl-carousel-track" id="home-saved-carousel"></div>
        <button class="pl-carousel-arrow pl-carousel-next" id="home-saved-next" title="Próximo"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      </div>
    </div>
    <div class="section" id="reco-news-section" style="display:none">
      <h2 class="section-title" style="margin-bottom:6px">Novidades para Você</h2>
      <p style="font-size:11.5px;color:var(--text-muted);margin-bottom:14px">Lançamentos recentes dos artistas e gêneros que você curte.</p>
      <div class="exp-related-row" id="reco-news-row"></div>
    </div>
  `;

  // Renderiza playlists do usuario como cards no carrossel
  const userCarousel = document.getElementById('home-user-pl-carousel');
  if (userCarousel) {
    // "Curtidas" sempre em primeiro
    userCarousel.appendChild(createPlaylistCard(likedPlaylistConfig()));
    userPls.forEach(pl => {
      const tracks = UserPlaylists.tracksOf(pl);
      const card = createPlaylistCard({
        id: pl.id,
        name: pl.name,
        subtitle: pl.items.length + ' faixas',
        tracks: tracks,
        isUser: true,
        cover: tracks[0] && tracks[0].cover,
      });
      userCarousel.appendChild(card);
    });
    attachCarouselArrows('home-user-pl');
  }

  // Renderiza playlists dinamicas como cards (placeholder inicial)
  const dynCarousel = document.getElementById('home-dyn-pl-carousel');
  const homeToken = ++renderHomeToken;
  tastes.forEach(genre => {
    const card = createPlaylistCard({
      id: 'dyn_' + genre,
      name: genre,
      subtitle: 'carregando\u2026',
      tracks: [],
      isUser: false,
      isDynamic: true,
      cover: null,
    });
    dynCarousel.appendChild(card);

    loadDynamicPlaylist(genre).then(tracks => {
      if (homeToken !== renderHomeToken) return;
      const freshCard = createPlaylistCard({
        id: 'dyn_' + genre,
        name: genre,
        subtitle: tracks.length ? tracks.length + ' faixas' : 'indisponível',
        tracks: tracks,
        isUser: false,
        isDynamic: true,
        cover: tracks.length ? tracks[0].cover : null,
      });
      if (card.parentNode) card.parentNode.replaceChild(freshCard, card);
      attachTrackListeners();
    });
  });
  attachCarouselArrows('home-dyn-pl');

  document.getElementById('btn-new-playlist').addEventListener('click', () => {
    const name = prompt('Nome da nova playlist:');
    if (name && name.trim()) {
      UserPlaylists.create(name);
      renderHome();
      renderSidebarPlaylists();
    }
  });
  document.getElementById('btn-export-pls').addEventListener('click', () => UserPlaylists.exportJson());
  document.getElementById('btn-edit-tastes').addEventListener('click', () => setView('profile'));
  const fileInput = document.getElementById('import-pls-file');
  document.getElementById('btn-import-pls').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files[0]) {
      UserPlaylists.importJson(fileInput.files[0], () => { renderHome(); renderSidebarPlaylists(); });
    }
  });

  // Secao "Links Salvos" da Home (com fixar)
  renderHomeSaved();
  attachCarouselArrows('home-saved');
  const seeSavedBtn = document.getElementById('btn-see-saved');
  if (seeSavedBtn) seeSavedBtn.addEventListener('click', () => setView('saved'));

  // Recomendacoes inteligentes: mixes diversos + novidades (assincrono)
  if (typeof Reco !== 'undefined') {
    Reco.renderMixes('reco-mix-carousel');
    Reco.renderNews('reco-news-row', 'reco-news-section');
    const refreshBtn = document.getElementById('btn-refresh-reco');
    if (refreshBtn) refreshBtn.addEventListener('click', () => {
      refreshBtn.disabled = true;
      Reco.refreshAll('reco-mix-carousel', 'reco-news-row', 'reco-news-section')
        .finally(() => { refreshBtn.disabled = false; });
    });
  }

  attachTrackListeners();
}

// HTML base do carrossel
function buildCarousel(prefix, trackId) {
  return `
    <div class="pl-carousel-wrap" id="${prefix}-wrap">
      <button class="pl-carousel-arrow pl-carousel-prev" id="${prefix}-prev" title="Anterior">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <div class="pl-carousel-track" id="${trackId}"></div>
      <button class="pl-carousel-arrow pl-carousel-next" id="${prefix}-next" title="Próximo">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    </div>
    <div class="pl-expand-container hidden" id="${prefix}-expand"></div>
  `;
}

// Anexa eventos de click as setas do carrossel
function attachCarouselArrows(prefix) {
  const track = document.getElementById(prefix + '-carousel');
  const prev = document.getElementById(prefix + '-prev');
  const next = document.getElementById(prefix + '-next');
  if (!track || !prev || !next) return;

  const scrollAmount = 200;
  prev.addEventListener('click', () => {
    track.scrollBy({ left: -scrollAmount, behavior: 'smooth' });
  });
  next.addEventListener('click', () => {
    track.scrollBy({ left: scrollAmount, behavior: 'smooth' });
  });

  // Mostra/oculta setas com base na posicao do scroll
  function updateArrows() {
    prev.style.opacity = track.scrollLeft <= 5 ? '0' : '1';
    prev.style.pointerEvents = track.scrollLeft <= 5 ? 'none' : 'auto';
    const maxScroll = track.scrollWidth - track.clientWidth;
    next.style.opacity = track.scrollLeft >= maxScroll - 5 ? '0' : '1';
    next.style.pointerEvents = track.scrollLeft >= maxScroll - 5 ? 'none' : 'auto';
  }
  track.addEventListener('scroll', updateArrows, { passive: true });
  updateArrows();
}

let renderHomeToken = 0;
let lastExpandedCardId = null; // ultimo card expandido na Home

// Cria um card de playlist estilo album-card para a Home
function createPlaylistCard(cfg) {
  const card = document.createElement('div');
  card.className = 'album-card playlist-home-card' + (lastExpandedCardId === cfg.id ? ' expanded' : '');
  card.dataset.plId = cfg.id;

  const coverWrap = document.createElement('div');
  coverWrap.className = 'album-cover-wrap';

  if (cfg.cover) {
    const img = document.createElement('img');
    img.src = cfg.cover;
    img.alt = '';
    img.loading = 'lazy';
    coverWrap.appendChild(img);
  } else {
    const ph = document.createElement('div');
    ph.style.cssText = 'width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,rgba(10,228,72,0.15),rgba(0,0,0,0.5));color:var(--text-muted);';
    ph.innerHTML = cfg.isLiked
      ? '<svg viewBox="0 0 24 24" width="40" height="40" fill="var(--green)" stroke="none"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>'
      : '<svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
    coverWrap.appendChild(ph);
  }

  const overlay = document.createElement('div');
  overlay.className = 'album-overlay';
  overlay.innerHTML = '<button class="album-play-btn"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>';
  coverWrap.appendChild(overlay);

  // Botao de delete (apenas playlists do usuario)
  if (cfg.isUser) {
    const del = document.createElement('button');
    del.className = 'gallery-del';
    del.title = 'Excluir playlist';
    del.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18" stroke-linecap="round"/><line x1="6" y1="6" x2="18" y2="18" stroke-linecap="round"/></svg>';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm('Excluir a playlist "' + cfg.name + '"?')) {
        UserPlaylists.remove(cfg.id);
        if (lastExpandedCardId === cfg.id) lastExpandedCardId = null;
        renderHome();
        renderSidebarPlaylists();
      }
    });
    coverWrap.appendChild(del);
  }

  const info = document.createElement('div');
  info.className = 'album-info';
  const titleEl = document.createElement('div');
  titleEl.className = 'album-title';
  titleEl.textContent = cfg.name;
  const sub = document.createElement('div');
  sub.className = 'album-artist';
  sub.textContent = cfg.subtitle;
  info.appendChild(titleEl);
  info.appendChild(sub);

  card.appendChild(coverWrap);
  card.appendChild(info);

  // Play ao clicar no botao de play
  overlay.querySelector('.album-play-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    if (cfg.tracks.length) playTrack(cfg.tracks[0], cfg.tracks);
  });

  // Expandir ao clicar no card (exceto no botao play/delete)
  card.addEventListener('click', (e) => {
    if (e.target.closest('.album-play-btn') || e.target.closest('.gallery-del')) return;
    togglePlaylistExpand(cfg, card);
  });

  return card;
}

function togglePlaylistExpand(cfg, clickedCard) {
  const useUserSlot = cfg.isUser || cfg.isLiked;
  const expandContainerId = useUserSlot ? 'home-user-pl-expand' : 'home-dyn-pl-expand';
  const expandContainer = document.getElementById(expandContainerId);
  const carouselWrap = document.getElementById(useUserSlot ? 'home-user-pl-wrap' : 'home-dyn-pl-wrap');

  // Se clicou no mesmo card ja expandido, fecha
  if (lastExpandedCardId === cfg.id) {
    expandContainer.classList.add('hidden');
    document.querySelectorAll('.playlist-home-card.expanded').forEach(c => c.classList.remove('expanded'));
    lastExpandedCardId = null;
    return;
  }

  // Remove expanded de todos os cards
  document.querySelectorAll('.playlist-home-card.expanded').forEach(c => c.classList.remove('expanded'));
  clickedCard.classList.add('expanded');
  lastExpandedCardId = cfg.id;

  // Posiciona o expand-container logo apos o wrapper do carrossel
  if (carouselWrap && carouselWrap.nextSibling) {
    carouselWrap.parentElement.insertBefore(expandContainer, carouselWrap.nextSibling);
  }

  // Preenche o container
  expandContainer.innerHTML = '';
  expandContainer.classList.remove('hidden');

  const header = document.createElement('div');
  header.className = 'pl-expand-header';
  header.innerHTML = `
    <div>
      <div class="pl-expand-title">${escapeHtml(cfg.name)}</div>
      <div class="pl-expand-subtitle">${cfg.tracks.length} faixa(s) \u00B7 ${cfg.isLiked ? 'suas curtidas' : (cfg.isUser ? 'criada por você' : 'baseada no seu gosto')}</div>
    </div>
    <button class="pl-expand-close" title="Fechar">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18" stroke-linecap="round"/><line x1="6" y1="6" x2="18" y2="18" stroke-linecap="round"/></svg>
    </button>
  `;
  header.querySelector('.pl-expand-close').addEventListener('click', () => {
    expandContainer.classList.add('hidden');
    clickedCard.classList.remove('expanded');
    lastExpandedCardId = null;
  });
  expandContainer.appendChild(header);

  const body = document.createElement('div');
  body.className = 'pl-expand-body';
  if (cfg.tracks.length) {
    const list = document.createElement('div');
    list.className = 'track-list';
    list.innerHTML = cfg.tracks.map((t, i) => trackRow(t, i + 1, cfg.tracks)).join('');
    // Botao de remover faixa (playlists do usuario e Curtidas)
    if (cfg.isUser || cfg.isLiked) {
      Array.from(list.children).forEach((row, i) => {
        const rm = document.createElement('button');
        rm.className = 'row-action-btn';
        rm.title = cfg.isLiked ? 'Descurtir' : 'Remover da playlist';
        rm.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18" stroke-linecap="round"/><line x1="6" y1="6" x2="18" y2="18" stroke-linecap="round"/></svg>';
        rm.addEventListener('click', (e) => {
          e.stopPropagation();
          const track = cfg.tracks[i];
          if (cfg.isLiked) {
            state.likedTracks.delete(track.id);
            saveLikedTracks();
            updatePlayerUI();
          } else {
            const key = track.id.startsWith('yt_') ? 'y:' + track.videoId : 'l:' + track.id;
            UserPlaylists.removeItem(cfg.id, key);
          }
          // Atualiza sem re-renderizar tudo
          cfg.tracks.splice(i, 1);
          togglePlaylistExpand(cfg, clickedCard);
        });
        row.insertBefore(rm, row.querySelector('.track-duration'));
      });
    }
    // Reordenacao por drag and drop (apenas playlists do usuario)
    if (cfg.isUser) {
      enableTrackDrag(list, () => {
        const idOrder = Array.from(list.children).map(r => r.dataset.track);
        cfg.tracks.sort((a, b) => idOrder.indexOf(a.id) - idOrder.indexOf(b.id));
        const keys = cfg.tracks.map(t => t.id.startsWith('yt_') ? 'y:' + t.videoId : 'l:' + t.id);
        UserPlaylists.setOrder(cfg.id, keys);
        // Re-renderiza a lista expandida com a nova ordem
        lastExpandedCardId = null;
        togglePlaylistExpand(cfg, clickedCard);
      });
    }
    body.appendChild(list);
  } else if (cfg.isDynamic) {
    body.innerHTML = '<p class="pl-acc-empty">Carregando faixas\u2026</p>';
  } else if (cfg.isLiked) {
    body.innerHTML = '<p class="pl-acc-empty">Você ainda não curtiu músicas. Toque o coração em uma faixa para adicioná-la aqui.</p>';
  } else {
    body.innerHTML = '<p class="pl-acc-empty">Playlist vazia. Use o botão + nas faixas ou nos resultados da busca para adicionar.</p>';
  }
  expandContainer.appendChild(body);

  attachTrackListeners();
  // Scroll suave para o container
  expandContainer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function playlistAccordionItem(cfg) {
  const wrap = document.createElement('div');
  wrap.className = 'pl-acc-item' + (expandedPlaylists.has(cfg.id) ? ' expanded' : '');
  wrap.dataset.plId = cfg.id;

  const header = document.createElement('div');
  header.className = 'pl-acc-header';

  const cover = document.createElement('div');
  cover.className = 'pl-acc-cover';
  const coverSrc = cfg.cover || (cfg.tracks[0] && cfg.tracks[0].cover);
  if (coverSrc) cover.style.backgroundImage = 'url("' + coverSrc + '")';
  else if (cfg.isLiked) cover.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="var(--green)" stroke="none"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>';
  else cover.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';

  const info = document.createElement('div');
  info.className = 'pl-acc-info';
  const name = document.createElement('div');
  name.className = 'pl-acc-name';
  name.textContent = cfg.name;
  const sub = document.createElement('div');
  sub.className = 'pl-acc-sub';
  sub.textContent = cfg.subtitle;
  info.appendChild(name);
  info.appendChild(sub);

  const playBtn = document.createElement('button');
  playBtn.className = 'pl-acc-play';
  playBtn.title = 'Tocar playlist';
  playBtn.disabled = !cfg.tracks.length;
  playBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  playBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (cfg.tracks.length) playTrack(cfg.tracks[0], cfg.tracks);
  });

  header.appendChild(cover);
  header.appendChild(info);
  header.appendChild(playBtn);

  if (cfg.isUser) {
    const delBtn = document.createElement('button');
    delBtn.className = 'pl-acc-del';
    delBtn.title = 'Excluir playlist';
    delBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6" stroke-linecap="round"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" stroke-linecap="round"/></svg>';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm('Excluir a playlist "' + cfg.name + '"?')) {
        UserPlaylists.remove(cfg.id);
        expandedPlaylists.delete(cfg.id);
        renderHome();
        renderSidebarPlaylists();
      }
    });
    header.appendChild(delBtn);
  }

  const chevron = document.createElement('div');
  chevron.className = 'pl-acc-chevron';
  chevron.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  header.appendChild(chevron);

  const body = document.createElement('div');
  body.className = 'pl-acc-body';
  if (cfg.tracks.length) {    const list = document.createElement('div');
    list.className = 'track-list';
    list.innerHTML = cfg.tracks.map((t, i) => trackRow(t, i + 1, cfg.tracks)).join('');
    // Botao de remover faixa (playlists do usuario e Curtidas)
    if (cfg.isUser || cfg.isLiked) {
      Array.from(list.children).forEach((row, i) => {
        const rm = document.createElement('button');
        rm.className = 'row-action-btn';
        rm.title = cfg.isLiked ? 'Descurtir' : 'Remover da playlist';
        rm.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18" stroke-linecap="round"/><line x1="6" y1="6" x2="18" y2="18" stroke-linecap="round"/></svg>';
        rm.addEventListener('click', (e) => {
          e.stopPropagation();
          const track = cfg.tracks[i];
          if (cfg.isLiked) {
            state.likedTracks.delete(track.id);
            saveLikedTracks();
            updatePlayerUI();
            renderLibrary();
          } else {
            const key = track.id.startsWith('yt_') ? 'y:' + track.videoId : 'l:' + track.id;
            UserPlaylists.removeItem(cfg.id, key);
            renderHome();
          }
        });
        row.insertBefore(rm, row.querySelector('.track-duration'));
      });
    }
    // Reordenacao por drag and drop (apenas playlists do usuario)
    if (cfg.isUser) {
      enableTrackDrag(list, () => {
        const idOrder = Array.from(list.children).map(r => r.dataset.track);
        const tracks = idOrder.map(getTrack).filter(Boolean);
        const keys = tracks.map(t => t.id.startsWith('yt_') ? 'y:' + t.videoId : 'l:' + t.id);
        UserPlaylists.setOrder(cfg.id, keys);
        // Re-renderiza mantendo o acordeao expandido (expandedPlaylists persiste)
        renderLibrary();
      });
    }
    body.appendChild(list);
  } else if (cfg.isDynamic) {
    body.innerHTML = '<p class="pl-acc-empty">Carregando faixas\u2026</p>';
  } else if (cfg.isLiked) {
    body.innerHTML = '<p class="pl-acc-empty">Você ainda não curtiu músicas. Toque o coração em uma faixa para adicioná-la aqui.</p>';
  } else {
    body.innerHTML = '<p class="pl-acc-empty">Playlist vazia. Use o botão + nas faixas ou nos resultados da busca para adicionar.</p>';
  }

  header.addEventListener('click', () => {
    const nowExpanded = wrap.classList.toggle('expanded');
    if (nowExpanded) expandedPlaylists.add(cfg.id);
    else expandedPlaylists.delete(cfg.id);
  });

  wrap.appendChild(header);
  wrap.appendChild(body);
  return wrap;
}

function renderSearch() {
  main.innerHTML = `
    <div class="section">
      <div id="search-results"></div>
      <div id="search-genres">
        <!-- Explorar seus Gostos como carrossel -->
        <h3 class="section-title" style="margin-bottom:14px">Explorar seus Gostos</h3>
        ${buildCarousel('search-genres', 'search-genres-carousel')}

        <!-- Tendências como carrossel -->
        <div id="search-trending" style="margin-top:32px">
          <h3 class="section-title" style="margin-bottom:4px">Tendências</h3>
          <p style="font-size:11.5px;color:var(--text-muted);margin:0 0 14px">Principais tendências para você.</p>
          ${buildCarousel('search-trending', 'search-trending-carousel')}
          <div id="trending-results" style="display:none"></div>
        </div>
      </div>
    </div>
  `;

  // Preenche o carrossel de gostos com cards de genero
  const genresTrack = document.getElementById('search-genres-carousel');
  if (genresTrack) {
    Tastes.load().forEach(g => {
      const card = document.createElement('div');
      card.className = 'genre-card';
      card.dataset.genre = g;
      card.innerHTML = `<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg><span class="genre-name">${escapeHtml(g)}</span>`;
      card.addEventListener('click', () => {
        globalSearchInput.value = g;
        performSearch(g);
        globalSearchInput.focus();
      });
      genresTrack.appendChild(card);
    });
  }
  attachCarouselArrows('search-genres');

  // Tendencias (assincrono; some junto com #search-genres durante uma busca)
  loadTrendingSection();

  // Reexecuta a busca atual (se houver texto na barra superior)
  performSearch(globalSearchInput.value.trim());
}

// Preenche a secao "Tendencias" da pagina de busca (agora um carrossel)
async function loadTrendingSection() {
  const carousel = document.getElementById('search-trending-carousel');
  if (!carousel) return;
  const items = await fetchTrendingMusic();
  carousel.replaceChildren();
  if (!items.length) {
    const p = document.createElement('p');
    p.className = 'yt-search-status';
    p.textContent = 'Tendências indisponíveis no momento. Tente novamente mais tarde.';
    carousel.appendChild(p);
    return;
  }
  // Cria cards de album para cada item (mesmo estilo dos cards da Home)
  items.forEach(r => {
    const card = document.createElement('div');
    card.className = 'album-card';

    const wrap = document.createElement('div');
    wrap.className = 'album-cover-wrap';
    const img = document.createElement('img');
    img.src = 'https://i.ytimg.com/vi/' + r.videoId + '/mqdefault.jpg';
    img.alt = '';
    img.loading = 'lazy';
    wrap.appendChild(img);

    const overlay = document.createElement('div');
    overlay.className = 'album-overlay';
    overlay.innerHTML = '<button class="album-play-btn"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>';
    wrap.appendChild(overlay);

    const info = document.createElement('div');
    info.className = 'album-info';
    const title = document.createElement('div');
    title.className = 'album-title';
    title.textContent = r.title;
    const artist = document.createElement('div');
    artist.className = 'album-artist';
    artist.textContent = (r.author || '') + (r.views ? ' \u00B7 ' + fmtViews(r.views) : '');
    info.appendChild(title);
    info.appendChild(artist);

    card.appendChild(wrap);
    card.appendChild(info);

    overlay.querySelector('.album-play-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      playYouTubeResult(r, items);
    });
    card.addEventListener('click', (e) => {
      if (e.target.closest('.album-play-btn')) return;
      playYouTubeResult(r, items);
    });

    carousel.appendChild(card);
  });
  attachCarouselArrows('search-trending');
}

async function performSearch(raw) {
  {
    const q = raw.toLowerCase();
    const resultsEl = document.getElementById('search-results');
    const genresEl = document.getElementById('search-genres');
    if (!resultsEl || !genresEl) return;

    if (!q) {
      resultsEl.innerHTML = '';
      genresEl.style.display = '';
      return;
    }
    genresEl.style.display = 'none';
    // Salva no historico de pesquisas recentes
    addSearchToHistory(raw);

    // Check if input is a YouTube URL
    if (isYouTubeUrl(raw)) {
      const videoId = extractVideoId(raw);
      const playlistId = extractPlaylistId(raw);

      if (!videoId && !playlistId) {
        resultsEl.innerHTML = `<div class="empty-state"><p>URL do YouTube não reconhecida</p></div>`;
        return;
      }

      // Show preview card with thumbnail
      const thumbUrl = videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 9%22%3E%3Crect width=%2216%22 height=%229%22 fill=%22%23111%22/%3E%3Cpath d=%22M6.5 2.5v3.2a1.3 1.3 0 101 1.26V4h2v-1z%22 fill=%22%230AE448%22/%3E%3C/svg%3E';
      const watchUrl = videoId ? `https://youtube.com/watch?v=${videoId}` : `https://youtube.com/playlist?list=${playlistId}`;

      resultsEl.innerHTML = `
        <div class="url-result-card">
          <img src="${thumbUrl}" alt="Preview" class="url-result-thumb" id="url-preview-img" onerror="this.onerror=null;this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 9%22%3E%3Crect width=%2216%22 height=%229%22 fill=%22%23111%22/%3E%3Cpath d=%22M6.5 2.5v3.2a1.3 1.3 0 101 1.26V4h2v-1z%22 fill=%22%230AE448%22/%3E%3C/svg%3E'">
          <div class="url-result-info">
            <div class="url-result-label">${videoId ? 'Vídeo' : 'Playlist'}</div>
            <div class="url-result-id">ID: ${videoId || playlistId}</div>
            <div class="url-result-meta" id="url-meta"></div>
            <div class="url-result-actions">
              <button class="btn-play-main" id="url-play-btn" style="width:44px;height:44px">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
              </button>
              <button class="url-result-link" id="url-save-btn" title="Salvar para ouvir depois">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3H7a2 2 0 00-2 2v16l7-3 7 3V5a2 2 0 00-2-2z"/></svg>
                Salvar
              </button>
              <a href="${watchUrl}" target="_blank" rel="noopener" class="url-result-link">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" stroke-linecap="round" stroke-linejoin="round"/><polyline points="15 3 21 3 21 9" stroke-linecap="round" stroke-linejoin="round"/><line x1="10" y1="14" x2="21" y2="3" stroke-linecap="round" stroke-linejoin="round"/></svg>
                Abrir no YouTube
              </a>
            </div>
          </div>
        </div>
      `;

      // Try to get metadata (usa o cache compartilhado de oEmbed)
      if (videoId) {
        fetchOembed(videoId).then(() => {
          const t = titleCache.get(videoId);
          const a = channelCache.get(videoId);
          if (t) {
            const metaEl = document.getElementById('url-meta');
            if (metaEl) metaEl.innerHTML = `<strong>${escapeHtml(t)}</strong><br><span style="color:var(--text-secondary)">por ${escapeHtml(a || '')}</span>`;
          }
        });
      }

      document.getElementById('url-play-btn').addEventListener('click', () => {
        playFromUrl(raw);
      });

      document.getElementById('url-save-btn').addEventListener('click', () => {
        Gallery.save({
          id: videoId,
          list: playlistId,
          title: videoId ? titleCache.get(videoId) || null : null,
        });
      });

      return;
    }

    // Busca por texto: resultados online (debounce) + faixas ja conhecidas nesta sessao
    const known = TRACKS.filter(t => t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q));

    resultsEl.innerHTML = `
      <div id="yt-search-section">
        <h3 class="section-title" style="margin-bottom:12px">Resultados</h3>
        <div id="yt-search-results"><p class="yt-search-status">Buscando\u2026</p></div>
      </div>
      ${known.length ? `<h3 class="section-title" style="margin:24px 0 12px">Já tocadas nesta sessão</h3><div class="track-list">${known.map((t, i) => trackRow(t, i + 1, known)).join('')}</div>` : ''}
    `;
    attachTrackListeners();

    // Debounce: so busca no YouTube depois que o usuario para de digitar
    if (ytSearchDebounce) clearTimeout(ytSearchDebounce);
    const myToken = ++ytSearchToken;
    ytSearchDebounce = setTimeout(async () => {
      const results = await searchYouTube(raw);
      if (myToken !== ytSearchToken) return; // busca obsoleta
      const container = document.getElementById('yt-search-results');
      if (!container) return;
      renderYtSearchResults(container, results);
    }, 500);
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

let ytSearchDebounce = null;

function renderYtSearchResults(container, results) {
  if (!results.length) {
    container.innerHTML = '<p class="yt-search-status">Nenhum resultado encontrado no momento. Tente outros termos ou cole um link diretamente.</p>';
    return;
  }
  container.replaceChildren();
  const list = document.createElement('div');
  list.className = 'track-list';

  results.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'track-row yt-result-row';

    const num = document.createElement('div');
    num.className = 'track-num';
    num.innerHTML = `<span>${i + 1}</span><svg class="track-play-icon" viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;

    const thumb = document.createElement('img');
    thumb.className = 'track-thumb yt-result-thumb';
    thumb.src = 'https://i.ytimg.com/vi/' + r.videoId + '/mqdefault.jpg';
    thumb.alt = '';
    thumb.loading = 'lazy';

    const details = document.createElement('div');
    details.className = 'track-details';
    const t = document.createElement('div');
    t.className = 'track-title';
    t.textContent = r.title;
    const a = document.createElement('div');
    a.className = 'track-artist';
    a.textContent = r.author + (r.views ? ' \u00B7 ' + fmtViews(r.views) : '');
    details.appendChild(t);
    details.appendChild(a);

    const addBtn = document.createElement('button');
    addBtn.className = 'row-action-btn yt-add-btn';
    addBtn.title = 'Adicionar à playlist';
    addBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19" stroke-linecap="round"/><line x1="5" y1="12" x2="19" y2="12" stroke-linecap="round"/></svg>';
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openPlaylistChooser({ type: 'yt', videoId: r.videoId, title: r.title, artist: r.author, duration: r.duration });
    });

    const saveBtn = document.createElement('button');
    saveBtn.className = 'row-action-btn yt-save-btn';
    saveBtn.title = 'Salvar link';
    saveBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3H7a2 2 0 00-2 2v16l7-3 7 3V5a2 2 0 00-2-2z"/></svg>';
    saveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      Gallery.save({ id: r.videoId, list: null, title: r.title });
    });

    // Menu "..." (mobile): concentra Adicionar e Salvar
    const menuBtn = document.createElement('button');
    menuBtn.className = 'row-action-btn track-menu-btn';
    menuBtn.title = 'Mais opções';
    menuBtn.innerHTML = MENU_ICON_DOTS;
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openTrackMenu(r.title, [
        { label: 'Adicionar à playlist', icon: MENU_ICON_ADD, onClick: () => openPlaylistChooser({ type: 'yt', videoId: r.videoId, title: r.title, artist: r.author, duration: r.duration }) },
        { label: 'Salvar link', icon: MENU_ICON_SAVE, onClick: () => Gallery.save({ id: r.videoId, list: null, title: r.title }) },
      ]);
    });

    const dur = document.createElement('div');
    dur.className = 'track-duration';
    dur.textContent = r.duration ? fmtTime(r.duration) : '';

    row.appendChild(num);
    row.appendChild(thumb);
    row.appendChild(details);
    row.appendChild(addBtn);
    row.appendChild(saveBtn);
    row.appendChild(menuBtn);
    row.appendChild(dur);
    row.addEventListener('click', () => playYouTubeResult(r, results));
    list.appendChild(row);
  });
  container.appendChild(list);
}

function renderLibrary() {
  const userPls = UserPlaylists.load();
  main.innerHTML = `
    <div class="section">
      <h2 class="section-title" style="margin-bottom:20px">Biblioteca</h2>

      <!-- Pastas: Curtidas, Recentes, Salvos -->
      <div class="lib-folders">
        <div class="lib-folder" id="lib-folder-liked">
          <div class="lib-folder-icon" style="background:rgba(255,92,0,0.12)">
            <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="#FF5C00" stroke-width="1.8"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>
          </div>
          <div class="lib-folder-name">Curtidas</div>
          <div class="lib-folder-count">${state.likedTracks.size} musicas</div>
        </div>

        <div class="lib-folder" id="lib-folder-recent">
          <div class="lib-folder-icon" style="background:rgba(0,112,243,0.12)">
            <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="#0070F3" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14" stroke-linecap="round"/></svg>
          </div>
          <div class="lib-folder-name">Recentes</div>
          <div class="lib-folder-count">${state.history.length} tocadas</div>
        </div>

        <div class="lib-folder" id="lib-folder-saved">
          <div class="lib-folder-icon" style="background:rgba(10,228,72,0.12)">
            <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="#0AE448" stroke-width="1.8"><path d="M17 3H7a2 2 0 00-2 2v16l7-3 7 3V5a2 2 0 00-2-2z"/></svg>
          </div>
          <div class="lib-folder-name">Salvos</div>
          <div class="lib-folder-count">${Gallery.load().length} links</div>
        </div>
      </div>

      <div class="divider" style="margin:24px 0"></div>

      <h3 class="section-title" style="margin-bottom:16px;font-size:18px">Suas Playlists</h3>
      <div class="pl-accordion" id="lib-accordion"></div>
    </div>
  `;

  // Event listeners das pastas
  document.getElementById('lib-folder-liked').addEventListener('click', () => setView('liked'));
  document.getElementById('lib-folder-recent').addEventListener('click', () => setView('recent'));
  document.getElementById('lib-folder-saved').addEventListener('click', () => setView('saved'));

  const acc = document.getElementById('lib-accordion');
  // "Curtidas" sempre em primeiro
  acc.appendChild(playlistAccordionItem(likedPlaylistConfig()));
  if (userPls.length) {
    userPls.forEach(pl => acc.appendChild(
      playlistAccordionItem({
        id: pl.id,
        name: pl.name,
        subtitle: pl.items.length + ' faixas \u00B7 criada por você',
        tracks: UserPlaylists.tracksOf(pl),
        isUser: true,
        cover: null,
      })
    ));
  } else {
    const note = document.createElement('p');
    note.style.cssText = 'font-size:12px;color:var(--text-muted);margin-top:12px';
    note.textContent = 'Nenhuma playlist criada ainda. Vá para o Início e clique em "Nova".';
    acc.appendChild(note);
  }
  attachTrackListeners();
}

function renderProfile() {
  const uniqueTracks = new Set(state.history.map(h => h.trackId));
  const totalTime = state.history.length * 240;
  const tastes = Tastes.load();
  const suggestions = ['Indie', 'Synthwave', 'Rock', 'Pop', 'Música Brasileira', 'Jazz', 'Lo-Fi', 'Eletrônica', 'Hip Hop', 'MPB', 'Sertanejo', 'Clássica', 'Metal', 'Reggae', 'Funk']
    .filter(s => !tastes.some(t => t.toLowerCase() === s.toLowerCase()));

  main.innerHTML = `
    <div class="section">
      <div class="profile-header">
        <img src="public/avatars/user-avatar.jpg" alt="Profile" class="profile-avatar" onerror="this.style.display='none'">
        <div>
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);margin-bottom:6px">Perfil</div>
          <div class="profile-name">Ouvinte</div>
          <p class="profile-bio">Suas playlists dinâmicas são geradas a partir dos gostos abaixo.</p>
          <div class="profile-stats-row">
            <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg> ${state.likedTracks.size} curtidas</span>
            <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 18v-6a9 9 0 0118 0v6"/><path d="M21 19a2 2 0 01-2 2h-1a2 2 0 01-2-2v-3a2 2 0 012-2h3zM3 19a2 2 0 002 2h1a2 2 0 002-2v-3a2 2 0 00-2-2H3z"/></svg> ${uniqueTracks.size} ouvidas</span>
            <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14" stroke-linecap="round"/></svg> ${Math.floor(totalTime / 3600)}h</span>
          </div>
        </div>
      </div>
    </div>

    <div class="section" style="padding-top:0">
      <h3 class="section-title" style="margin-bottom:6px">Seus Gostos</h3>
      <p style="font-size:11.5px;color:var(--text-muted);margin-bottom:14px">Cada gênero vira uma playlist dinâmica no Início. Adicione, remova ou crie os seus.</p>
      <div class="taste-chips" id="taste-chips"></div>
      <div class="taste-add">
        <input type="text" id="taste-input" placeholder="Adicionar gênero (ex.: bossa nova)" maxlength="40">
        <button id="taste-add-btn">Adicionar</button>
      </div>
      ${suggestions.length ? `
        <div style="margin-top:14px">
          <div style="font-size:10.5px;color:var(--text-muted);margin-bottom:8px">Sugestões:</div>
          <div class="taste-chips taste-suggestions" id="taste-suggestions"></div>
        </div>` : ''}
    </div>

    <div class="section" style="padding-top:0">
      <h3 class="section-title" style="margin-bottom:6px">Sem Anúncios e Promoções</h3>
      <p style="font-size:11.5px;color:var(--text-muted);margin-bottom:14px">Proteção do MinStream: filtra conteúdo patrocinado das buscas e recomendações e usa o player em modo de privacidade (sem anúncios personalizados).</p>
      <div class="adshield-card" id="adshield-card">
        <div class="adshield-icon ${AdShield.enabled() ? 'on' : ''}">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" stroke-linejoin="round"/>${AdShield.enabled() ? '<polyline points="9 12 11 14 15 10" stroke-linecap="round" stroke-linejoin="round"/>' : ''}</svg>
        </div>
        <div class="adshield-info">
          <div class="adshield-status">${AdShield.enabled() ? 'Proteção ativa' : 'Proteção desativada'}</div>
          <div class="adshield-sub">${AdShield.blockedCount()} promoção(ões) filtrada(s) até agora</div>
        </div>
        <button class="pl-action-btn" id="adshield-toggle">${AdShield.enabled() ? 'Desativar' : 'Ativar'}</button>
      </div>
    </div>

    <div class="stats-grid">
      <div class="stat-card"><svg viewBox="0 0 24 24" fill="none" stroke="#0AE448" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14" stroke-linecap="round"/></svg><div class="stat-value">${Math.floor(totalTime / 3600)}</div><div class="stat-label">Horas Tocadas</div></div>
      <div class="stat-card"><svg viewBox="0 0 24 24" fill="none" stroke="#FF5C00" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg><div class="stat-value">${state.likedTracks.size}</div><div class="stat-label">Curtidas</div></div>
      <div class="stat-card"><svg viewBox="0 0 24 24" fill="none" stroke="#0070F3" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg><div class="stat-value">${UserPlaylists.load().length}</div><div class="stat-label">Playlists</div></div>
      <div class="stat-card"><svg viewBox="0 0 24 24" fill="none" stroke="#A3A3A3" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg><div class="stat-value">${tastes.length}</div><div class="stat-label">Gostos</div></div>
    </div>
  `;

  const chipsEl = document.getElementById('taste-chips');

  // Toggle do mecanismo sem anuncios
  const shieldBtn = document.getElementById('adshield-toggle');
  if (shieldBtn) shieldBtn.addEventListener('click', () => {
    const next = !AdShield.enabled();
    AdShield.setEnabled(next);
    renderProfile();
    showToast(next ? 'Proteção contra anúncios ativada' : 'Proteção contra anúncios desativada');
  });

  tastes.forEach(genre => {
    const chip = document.createElement('span');
    chip.className = 'taste-chip';
    const label = document.createElement('span');
    label.textContent = genre;
    const x = document.createElement('button');
    x.title = 'Remover';
    x.innerHTML = '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18" stroke-linecap="round"/><line x1="6" y1="6" x2="18" y2="18" stroke-linecap="round"/></svg>';
    x.addEventListener('click', () => {
      Tastes.remove(genre);
      renderProfile();
      showToast('"' + genre + '" removido dos seus gostos');
    });
    chip.appendChild(label);
    chip.appendChild(x);
    chipsEl.appendChild(chip);
  });

  const input = document.getElementById('taste-input');
  const addTaste = (g) => {
    if (Tastes.add(g)) { renderProfile(); showToast('"' + g.trim() + '" adicionado aos seus gostos'); }
  };
  document.getElementById('taste-add-btn').addEventListener('click', () => addTaste(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addTaste(input.value);
    e.stopPropagation();
  });

  const sugEl = document.getElementById('taste-suggestions');
  if (sugEl) {
    suggestions.forEach(s => {
      const chip = document.createElement('button');
      chip.className = 'taste-chip taste-chip-suggestion';
      chip.textContent = '+ ' + s;
      chip.addEventListener('click', () => addTaste(s));
      sugEl.appendChild(chip);
    });
  }
}

function renderLiked() {
  const tracks = TRACKS.filter(t => state.likedTracks.has(t.id));
  main.innerHTML = `
    <div class="section">
      ${backButton()}
      <h2 class="section-title" style="margin-bottom:20px">Músicas Curtidas</h2>
      ${tracks.length ? `<div class="track-list">${tracks.map((t, i) => trackRow(t, i + 1, tracks)).join('')}</div>` : `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg><p>Nenhuma música curtida ainda</p></div>`}
    </div>
  `;
  attachTrackListeners();
}

function clearRecent() {
  if (!confirm('Limpar todo o histórico de músicas tocadas?')) return;
  state.history = [];
  saveHistory();
  renderRecent();
  showToast('Histórico limpo');
}

function renderRecent() {
  const tracks = state.history.slice(0, 30).map(h => getTrack(h.trackId)).filter(Boolean);
  main.innerHTML = `
    <div class="section">
      ${backButton()}
      <div class="section-header">
        <h2 class="section-title">Tocados Recentemente</h2>
        ${state.history.length ? `<button class="pl-action-btn" id="btn-clear-recent" title="Limpar histórico">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6" stroke-linecap="round"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" stroke-linecap="round"/></svg>
          Limpar
        </button>` : ''}
      </div>
      ${tracks.length ? `<div class="track-list">${tracks.map((t, i) => trackRow(t, i + 1, tracks)).join('')}</div>` : `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14" stroke-linecap="round"/></svg><p>Nenhuma música tocada ainda. Comece a ouvir!</p></div>`}
    </div>
  `;
  const clearBtn = document.getElementById('btn-clear-recent');
  if (clearBtn) clearBtn.addEventListener('click', clearRecent);
  attachTrackListeners();
}

// ============================================
// HTML HELPERS
// ============================================
function trackRow(track, num, tracks) {
  const isActive = state.currentTrack?.id === track.id;
  const isLiked = state.likedTracks.has(track.id);
  return `
    <div class="track-row ${isActive ? 'active' : ''}" data-track="${track.id}" data-tracks='${JSON.stringify(tracks.map(t=>t.id))}'>
      <div class="track-num" data-num="${num}">
        ${isActive && state.isPlaying ? `<div class="eq-bars"><div class="eq-bar"></div><div class="eq-bar"></div><div class="eq-bar"></div></div>` : `<span>${num}</span>`}
        <svg class="track-play-icon" viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
      </div>
      <img src="${track.cover}" alt="" class="track-thumb" loading="lazy">
      <div class="track-details">
        <div class="track-title">${escapeHtml(track.title)}</div>
        <div class="track-artist">${escapeHtml(track.artist)}</div>
      </div>
      ${track.bpm ? `<div class="track-bpm">${track.bpm} BPM</div>` : ''}
      <button class="row-action-btn track-add-btn" data-add-track="${track.id}" title="Adicionar à playlist">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19" stroke-linecap="round"/><line x1="5" y1="12" x2="19" y2="12" stroke-linecap="round"/></svg>
      </button>
      <button class="row-action-btn track-menu-btn" data-menu-track="${track.id}" title="Mais opções">${MENU_ICON_DOTS}</button>
      <div class="track-duration">${fmtTime(track.duration)}</div>
    </div>
  `;
}

// ============================================
// EVENT LISTENERS
// ============================================
function attachTrackListeners() {
  document.querySelectorAll('.track-row').forEach(row => {
    if (row.dataset.wired) return;
    row.dataset.wired = '1';
    row.addEventListener('click', () => {
      const trackId = row.dataset.track;
      if (!trackId) return;
      const trackIds = JSON.parse(row.dataset.tracks || '[]');
      const tracks = trackIds.map(getTrack).filter(Boolean);
      playTrack(getTrack(trackId), tracks);
    });
  });
  document.querySelectorAll('[data-add-track]').forEach(btn => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const track = getTrack(btn.dataset.addTrack);
      if (!track) return;
      const item = track.id.startsWith('yt_')
        ? { type: 'yt', videoId: track.videoId, title: track.title, artist: track.artist, duration: track.duration }
        : { type: 'local', trackId: track.id };
      openPlaylistChooser(item);
    });
  });
  // Menu "..." (mobile): concentra as acoes da linha
  document.querySelectorAll('[data-menu-track]').forEach(btn => {
    if (btn.dataset.wiredMenu) return;
    btn.dataset.wiredMenu = '1';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const track = getTrack(btn.dataset.menuTrack);
      if (!track) return;
      const item = track.id.startsWith('yt_')
        ? { type: 'yt', videoId: track.videoId, title: track.title, artist: track.artist, duration: track.duration }
        : { type: 'local', trackId: track.id };
      openTrackMenu(track.title, [
        { label: 'Adicionar à playlist', icon: MENU_ICON_ADD, onClick: () => openPlaylistChooser(item) },
      ]);
    });
  });
}

// Sidebar nav
document.querySelectorAll('.nav-btn[data-view]').forEach(btn => {
  btn.addEventListener('click', () => setView(btn.dataset.view));
});

// Sidebar (recolhe/expande automaticamente pelo hover)
const sidebarEl = document.getElementById('sidebar');

function initSidebar() {
  // Painel recolhido por padrao
  sidebarEl.classList.add('collapsed');
  sidebarEl.classList.remove('expanded');
}

// Expande quando o mouse entra e permanece expandido enquanto o mouse
// estiver sobre o painel; recolhe assim que o mouse sai.
sidebarEl.addEventListener('mouseenter', () => {
  sidebarEl.classList.remove('collapsed');
  sidebarEl.classList.add('expanded');
});
sidebarEl.addEventListener('mouseleave', () => {
  sidebarEl.classList.add('collapsed');
  sidebarEl.classList.remove('expanded');
});

// Render playlists in sidebar
const playlistNav = document.getElementById('playlist-nav');

// Abre a Biblioteca ja com a playlist expandida e rola ate ela
function openPlaylistInLibrary(plId) {
  expandedPlaylists.add(plId);
  setView('library');
  requestAnimationFrame(() => {
    const item = document.querySelector('#lib-accordion [data-pl-id="' + plId + '"]');
    if (item) {
      item.classList.add('expanded');
      item.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });
}

function renderSidebarPlaylists() {
  const pls = UserPlaylists.load();
  playlistNav.replaceChildren();

  // "Curtidas" sempre em primeiro
  const likedBtn = document.createElement('button');
  likedBtn.className = 'nav-btn';
  likedBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="var(--green)" stroke="none"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>' +
    '<span class="nav-label nav-pl-name">Curtidas</span>';
  likedBtn.addEventListener('click', () => openPlaylistInLibrary(LIKED_PL_ID));
  playlistNav.appendChild(likedBtn);

  pls.forEach(pl => {
    const btn = document.createElement('button');
    btn.className = 'nav-btn';
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>' +
      '<span class="nav-label nav-pl-name"></span>';
    btn.querySelector('.nav-pl-name').textContent = pl.name;
    btn.addEventListener('click', () => openPlaylistInLibrary(pl.id));
    playlistNav.appendChild(btn);
  });
}

// (nav de playlists da sidebar e renderizado por renderSidebarPlaylists)

// ============================================
// PLAYER UI
// ============================================
const playerCover = document.getElementById('player-cover');
const playerTitle = document.getElementById('player-title');
const playerArtist = document.getElementById('player-artist');
const btnPlay = document.getElementById('btn-play');
const iconPlay = document.getElementById('icon-play');
const iconPause = document.getElementById('icon-pause');
const btnLike = document.getElementById('btn-like');
const btnShuffle = document.getElementById('btn-shuffle');
const btnRepeat = document.getElementById('btn-repeat');
const iconRepeat = document.getElementById('icon-repeat');
const iconRepeat1 = document.getElementById('icon-repeat1');
const progressFill = document.getElementById('progress-fill');
const progressHandle = document.getElementById('progress-handle');
const timeCurrent = document.getElementById('time-current');
const timeTotal = document.getElementById('time-total');
// Verdadeiro enquanto o usuario arrasta a bolinha do progresso:
// pausa a atualizacao automatica da barra para nao brigar com o dedo
let isScrubbing = false;
const btnMute = document.getElementById('btn-mute');
const iconVol = document.getElementById('icon-vol');
const iconMute = document.getElementById('icon-mute');
const volumeSlider = document.getElementById('volume-slider');

function updatePlayerUI() {
  const t = state.currentTrack;
  if (!t) return;

  // Garante que o VU meter volte a animar quando algo comeca a tocar
  if (state.isPlaying) ensureVuMeter();

  playerCover.src = t.cover;
  playerTitle.textContent = t.title;
  playerArtist.textContent = t.artist;

  iconPlay.style.display = state.isPlaying ? 'none' : '';
  iconPause.style.display = state.isPlaying ? '' : 'none';

  if (!isScrubbing) {
    const prog = state.duration > 0 ? (state.currentTime / state.duration) * 100 : 0;
    progressFill.style.width = prog + '%';
    progressHandle.style.left = prog + '%';

    timeCurrent.textContent = fmtTime(state.currentTime);
    timeTotal.textContent = '-' + fmtTime(Math.max(0, state.duration - state.currentTime));
  }

  btnLike.classList.toggle('liked', state.likedTracks.has(t.id));
  btnShuffle.classList.toggle('active', state.isShuffled);

  iconRepeat.style.display = state.repeatMode === 'one' ? 'none' : '';
  iconRepeat1.style.display = state.repeatMode === 'one' ? '' : 'none';
  btnRepeat.classList.toggle('active', state.repeatMode !== 'off');

  iconVol.style.display = state.isMuted ? 'none' : '';
  iconMute.style.display = state.isMuted ? '' : 'none';

  refreshQueuePanel();
  if (isExpanded) {
    if (state.playerMode === 'cover') fillExpandedCover();
    if (state.playerMode === 'queue') buildExpandedQueue(false);
    updateExpandedContext();
    loadRelatedVideos();
  }

  // Refresh track rows to show equalizer
  if (state.view === 'home' || state.view === 'album' || state.view === 'playlist') {
    document.querySelectorAll('.track-row').forEach(row => {
      if (!row.dataset.track) return; // linhas de resultado do YouTube nao participam
      const isActive = row.dataset.track === t.id;
      row.classList.toggle('active', isActive);
      const numEl = row.querySelector('.track-num');
      if (numEl) {
        if (isActive && state.isPlaying) {
          numEl.innerHTML = `<div class="eq-bars"><div class="eq-bar"></div><div class="eq-bar"></div><div class="eq-bar"></div></div><svg class="track-play-icon" viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
        } else {
          numEl.innerHTML = `<span>${numEl.dataset.num || ''}</span><svg class="track-play-icon" viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
        }
      }
    });
  }
}

// Player controls
btnPlay.addEventListener('click', togglePlay);
document.getElementById('btn-prev').addEventListener('click', prevTrack);
document.getElementById('btn-next').addEventListener('click', nextTrack);
btnShuffle.addEventListener('click', toggleShuffle);
btnRepeat.addEventListener('click', cycleRepeat);
btnMute.addEventListener('click', toggleMute);
btnLike.addEventListener('click', () => { if (state.currentTrack) toggleLike(state.currentTrack.id); });

volumeSlider.addEventListener('input', (e) => setVolume(Number(e.target.value)));

// Progress bar
document.getElementById('progress-container').addEventListener('click', (e) => {
  const rect = e.currentTarget.getBoundingClientRect();
  const ratio = (e.clientX - rect.left) / rect.width;
  seekToTime(ratio * state.duration);
});

// ===== Scrub preciso pela bolinha (toque e mouse) =====
// Arrastar move a bolinha com preview ao vivo do tempo; ao soltar, busca a
// posicao exata. Reusa seekToTime — nenhuma logica de reproducao nova.
(function initPrecisionScrub() {
  const container = document.getElementById('progress-container');

  function ratioFromEvent(e) {
    const rect = container.getBoundingClientRect();
    if (!rect.width) return 0;
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  }

  function preview(ratio) {
    const prog = ratio * 100;
    progressFill.style.width = prog + '%';
    progressHandle.style.left = prog + '%';
    if (state.duration > 0) {
      const t = ratio * state.duration;
      timeCurrent.textContent = fmtTime(t);
      timeTotal.textContent = '-' + fmtTime(Math.max(0, state.duration - t));
    }
  }

  container.addEventListener('pointerdown', (e) => {
    if (!state.duration) return;
    isScrubbing = true;
    try { container.setPointerCapture(e.pointerId); } catch (_) {}
    preview(ratioFromEvent(e));
  });

  container.addEventListener('pointermove', (e) => {
    if (!isScrubbing) return;
    e.preventDefault();
    preview(ratioFromEvent(e));
  });

  function finish(e) {
    if (!isScrubbing) return;
    isScrubbing = false;
    seekToTime(ratioFromEvent(e) * state.duration);
  }
  container.addEventListener('pointerup', finish);
  container.addEventListener('pointercancel', () => { isScrubbing = false; updatePlayerUI(); });
})();

// ===== MODO TV: video em reproducao em tela cheia =====
// Usa a Fullscreen API sobre o container do video; onde a API nao existe
// (iPhones antigos), a classe body.tv-mode aplica um fallback CSS que ocupa
// a tela inteira. Nao altera a reproducao — apenas apresenta o video.
function isTvMode() { return document.body.classList.contains('tv-mode'); }

function enterTvMode() {
  if (!state.currentTrack) { showToast('Toque uma música para usar o Modo TV'); return; }
  document.body.classList.add('tv-mode');
  const req = videoCover.requestFullscreen || videoCover.webkitRequestFullscreen;
  if (req) {
    try {
      const p = req.call(videoCover);
      if (p && p.catch) p.catch(() => {}); // fallback CSS ja cobre a tela
    } catch (_) {}
  }
}

function exitTvMode() {
  document.body.classList.remove('tv-mode');
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  if (fsEl) {
    const ex = document.exitFullscreen || document.webkitExitFullscreen;
    try {
      const p = ex.call(document);
      if (p && p.catch) p.catch(() => {});
    } catch (_) {}
  }
}

function toggleTvMode() { isTvMode() ? exitTvMode() : enterTvMode(); }

document.getElementById('exp-tab-tv').addEventListener('click', toggleTvMode);
document.getElementById('tv-exit').addEventListener('click', (e) => { e.stopPropagation(); exitTvMode(); });
// Saida nativa (Esc / gesto do sistema) tambem limpa o Modo TV
function onFsChange() {
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  if (!fsEl && isTvMode()) document.body.classList.remove('tv-mode');
}
document.addEventListener('fullscreenchange', onFsChange);
document.addEventListener('webkitfullscreenchange', onFsChange);

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;

  switch(e.key) {
    case ' ': e.preventDefault(); togglePlay(); break;
    case 'ArrowRight': if (e.shiftKey) { e.preventDefault(); nextTrack(); } break;
    case 'ArrowLeft': if (e.shiftKey) { e.preventDefault(); prevTrack(); } break;
    case 'm': case 'M': toggleMute(); break;
    case 's': case 'S': toggleShuffle(); break;
    case 'r': case 'R': cycleRepeat(); break;
    case 'l': case 'L': if (state.currentTrack) toggleLike(state.currentTrack.id); break;
    case 't': case 'T': toggleExpanded(); break;
    case 'f': case 'F': toggleTvMode(); break;
    case 'q': case 'Q': toggleQueuePanel(); break;
    case '?':
      e.preventDefault();
      document.getElementById('help-overlay').style.display = 'flex';
      break;
    case 'Escape':
      document.getElementById('help-overlay').style.display = 'none';
      closeExpanded();
      break;
  }
});

document.getElementById('help-close').addEventListener('click', () => {
  document.getElementById('help-overlay').style.display = 'none';
});

// ============================================
// VU METER (Canvas 2D)
// ============================================
const vuCanvas = document.getElementById('vu-meter');
const vuCtx = vuCanvas.getContext('2d');
const NUM_VU_BARS = 16;
const vuBarWidth = (vuCanvas.width - (NUM_VU_BARS - 1) * 2) / NUM_VU_BARS;
const vuTargets = new Float32Array(NUM_VU_BARS);
const vuCurrents = new Float32Array(NUM_VU_BARS);

let vuRunning = false;

// Inicia o loop do VU meter apenas se ele nao estiver rodando.
// O loop se auto-encerra quando fica ocioso (nada tocando e barras ja no
// repouso), evitando um requestAnimationFrame perpetuo em segundo plano.
function ensureVuMeter() {
  if (vuRunning || document.hidden) return;
  vuRunning = true;
  drawVUMeter();
}

function drawVUMeter() {
  vuCtx.clearRect(0, 0, vuCanvas.width, vuCanvas.height);

  const time = Date.now() / 1000;
  let active = state.isPlaying;
  for (let i = 0; i < NUM_VU_BARS; i++) {
    if (state.isPlaying) {
      const freq = i < NUM_VU_BARS / 2
        ? Math.sin(time * 4 + i * 0.6) * 0.5 + 0.5
        : Math.sin(time * 5 + i * 0.8) * 0.4 + 0.4;
      vuTargets[i] = Math.max(0.05, Math.min(1, freq + Math.random() * 0.1));
    } else {
      vuTargets[i] = Math.max(0.05, vuTargets[i] * 0.95);
    }
    vuCurrents[i] += (vuTargets[i] - vuCurrents[i]) * 0.15;
    // Ainda ha movimento perceptivel a animar?
    if (vuCurrents[i] > 0.06) active = true;

    const h = vuCurrents[i] * vuCanvas.height;
    const x = i * (vuBarWidth + 2);
    const y = vuCanvas.height - h;

    // Color gradient: orange -> green
    const ratio = i / NUM_VU_BARS;
    const r = Math.round(255 * (1 - ratio) + 10 * ratio);
    const g = Math.round(92 * (1 - ratio) + 228 * ratio);
    const b = Math.round(0 * (1 - ratio) + 72 * ratio);

    vuCtx.fillStyle = `rgb(${r},${g},${b})`;
    vuCtx.fillRect(x, y, vuBarWidth, h);
  }

  if (active && !document.hidden) {
    requestAnimationFrame(drawVUMeter);
  } else {
    vuRunning = false;
  }
}
ensureVuMeter();

// ============================================
// BACKGROUND PARTICLES
// ============================================
const bgCanvas = document.getElementById('bg-particles');
const bgCtx = bgCanvas.getContext('2d');
let bgW, bgH;

function resizeBg() {
  bgW = bgCanvas.width = window.innerWidth;
  bgH = bgCanvas.height = window.innerHeight;
}
resizeBg();
window.addEventListener('resize', resizeBg);

const COLORS = ['#0AE448', '#FF5C00', '#0070F3', '#E0E0E0'];
const particles = Array.from({ length: 50 }, () => ({
  x: Math.random() * bgW,
  y: Math.random() * bgH,
  vx: (Math.random() - 0.5) * 0.3,
  vy: (Math.random() - 0.5) * 0.3,
  size: Math.random() * 2 + 0.5,
  opacity: Math.random() * 0.2 + 0.03,
  color: COLORS[Math.floor(Math.random() * COLORS.length)],
}));

let particlesRunning = false;

// Inicia o laco das particulas apenas se ainda nao estiver rodando.
// Enquanto a aba estiver oculta o laco se encerra (nada e desenhado);
// visibilitychange o retoma ao voltar o foco.
function ensureParticles() {
  if (particlesRunning || document.hidden) return;
  particlesRunning = true;
  drawParticles();
}

function drawParticles() {
  if (document.hidden) { particlesRunning = false; return; }
  requestAnimationFrame(drawParticles);
  bgCtx.clearRect(0, 0, bgW, bgH);

  for (const p of particles) {
    p.x += p.vx;
    p.y += p.vy;
    if (p.x < 0) p.x = bgW;
    if (p.x > bgW) p.x = 0;
    if (p.y < 0) p.y = bgH;
    if (p.y > bgH) p.y = 0;

    bgCtx.beginPath();
    bgCtx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    bgCtx.fillStyle = p.color;
    bgCtx.globalAlpha = p.opacity;
    bgCtx.fill();
  }

  // Connections
  bgCtx.strokeStyle = '#0AE448';
  bgCtx.lineWidth = 0.5;
  for (let i = 0; i < particles.length; i++) {
    for (let j = i + 1; j < particles.length; j++) {
      const dx = particles[i].x - particles[j].x;
      const dy = particles[i].y - particles[j].y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 150) {
        bgCtx.globalAlpha = 0.02 * (1 - dist / 150);
        bgCtx.beginPath();
        bgCtx.moveTo(particles[i].x, particles[i].y);
        bgCtx.lineTo(particles[j].x, particles[j].y);
        bgCtx.stroke();
      }
    }
  }
  bgCtx.globalAlpha = 1;
}
ensureParticles();

// ============================================
// BARRA SUPERIOR (busca global + navegacao)
// ============================================
const globalSearchInput = document.getElementById('global-search');
const searchClearBtn = document.getElementById('search-clear-btn');
const searchRecentDropdown = document.getElementById('search-recent-dropdown');
let globalSearchDebounce = null;
const SEARCH_HISTORY_KEY = 'minstream_search_history';
const SEARCH_HISTORY_MAX = 5;

// Carrega historico de pesquisas
function loadSearchHistory() {
  try {
    const raw = localStorage.getItem(SEARCH_HISTORY_KEY);
    const items = raw ? JSON.parse(raw) : [];
    return Array.isArray(items) ? items : [];
  } catch (_) { return []; }
}

// Salva historico de pesquisas
function saveSearchHistory(items) {
  try { localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(items.slice(0, SEARCH_HISTORY_MAX))); } catch (_) {}
}

// Adiciona uma pesquisa ao historico (evita duplicados, move para o topo)
function addSearchToHistory(query) {
  const q = query.trim();
  if (!q) return;
  let items = loadSearchHistory();
  items = items.filter(item => item.toLowerCase() !== q.toLowerCase());
  items.unshift(q);
  saveSearchHistory(items);
}

// Remove uma pesquisa do historico
function removeSearchFromHistory(query) {
  const items = loadSearchHistory().filter(item => item !== query);
  saveSearchHistory(items);
  renderSearchRecentDropdown();
}

// Limpa todo o historico
function clearSearchHistory() {
  try { localStorage.removeItem(SEARCH_HISTORY_KEY); } catch (_) {}
  renderSearchRecentDropdown();
}

// Renderiza o dropdown de pesquisas recentes
function renderSearchRecentDropdown() {
  const items = loadSearchHistory();
  if (!items.length) {
    searchRecentDropdown.innerHTML = '<div class="search-recent-empty">Nenhuma pesquisa recente</div>';
    return;
  }
  const frag = document.createDocumentFragment();

  const header = document.createElement('div');
  header.className = 'search-recent-header';
  header.innerHTML = '<span>Recentes</span>';
  const clearAll = document.createElement('button');
  clearAll.className = 'search-recent-clear';
  clearAll.textContent = 'Limpar';
  clearAll.addEventListener('click', (e) => {
    e.stopPropagation();
    clearSearchHistory();
  });
  header.appendChild(clearAll);
  frag.appendChild(header);

  items.forEach(item => {
    const row = document.createElement('div');
    row.className = 'search-recent-item';
    row.innerHTML = `
      <div class="search-recent-item-left">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35" stroke-linecap="round"/></svg>
        <span class="search-recent-text">${escapeHtml(item)}</span>
      </div>
      <button class="search-recent-delete" title="Remover" data-query="${escapeHtml(item)}">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18" stroke-linecap="round"/><line x1="6" y1="6" x2="18" y2="18" stroke-linecap="round"/></svg>
      </button>
    `;
    // Clicar no item executa a busca
    row.addEventListener('click', (e) => {
      if (e.target.closest('.search-recent-delete')) return;
      globalSearchInput.value = item;
      searchClearBtn.classList.remove('hidden');
      hideSearchRecentDropdown();
      addSearchToHistory(item);
      if (state.view !== 'search') setView('search');
      else performSearch(item);
    });
    // Botao deletar
    row.querySelector('.search-recent-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      removeSearchFromHistory(item);
    });
    frag.appendChild(row);
  });
  searchRecentDropdown.replaceChildren(frag);
}

function showSearchRecentDropdown() {
  renderSearchRecentDropdown();
  searchRecentDropdown.classList.remove('hidden');
}

function hideSearchRecentDropdown() {
  searchRecentDropdown.classList.add('hidden');
}

// Mostra/oculta botao de limpar conforme conteudo do input
function updateSearchClearBtn() {
  if (globalSearchInput.value.trim().length > 0) {
    searchClearBtn.classList.remove('hidden');
  } else {
    searchClearBtn.classList.add('hidden');
  }
}

// Botao X: limpa input, refoca e reexibe recentes
searchClearBtn.addEventListener('click', () => {
  globalSearchInput.value = '';
  searchClearBtn.classList.add('hidden');
  globalSearchInput.focus();
  showSearchRecentDropdown();
  // Limpa resultados
  const resultsEl = document.getElementById('search-results');
  const genresEl = document.getElementById('search-genres');
  if (resultsEl) resultsEl.innerHTML = '';
  if (genresEl) genresEl.style.display = '';
});

// Fecha dropdown ao clicar fora
document.addEventListener('click', (e) => {
  if (!e.target.closest('#tb-search-wrap')) {
    hideSearchRecentDropdown();
  }
});

globalSearchInput.addEventListener('input', () => {
  const raw = globalSearchInput.value.trim();
  updateSearchClearBtn();
  // Se comecou a digitar, esconde o dropdown de recentes
  if (raw.length > 0) hideSearchRecentDropdown();
  else showSearchRecentDropdown();
  if (state.view !== 'search') setView('search'); // renderSearch ja executa performSearch
  else {
    if (globalSearchDebounce) clearTimeout(globalSearchDebounce);
    globalSearchDebounce = setTimeout(() => performSearch(raw), 120);
  }
});
globalSearchInput.addEventListener('focus', () => {
  // Minimiza o player expandido se estiver ativo
  if (isExpanded) closeExpanded();
  updateSearchClearBtn();
  showSearchRecentDropdown();
  if (state.view !== 'search') setView('search');
});
globalSearchInput.addEventListener('paste', (e) => {
  const pasted = (e.clipboardData || window.clipboardData).getData('text');
  if (isYouTubeUrl(pasted.trim())) {
    setTimeout(() => {
      performSearch(globalSearchInput.value.trim());
      updateSearchClearBtn();
    }, 10);
  }
});
globalSearchInput.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') {
    const q = globalSearchInput.value.trim();
    if (q) {
      addSearchToHistory(q);
      hideSearchRecentDropdown();
    }
  }
});

document.getElementById('btn-expand').addEventListener('click', toggleExpanded);

// ============================================
// INIT
// ============================================
// Recria em TRACKS as faixas curtidas em sessoes anteriores (metadados persistidos),
// para que "Curtidas" e o perfil de recomendacao funcionem apos recarregar.
if (typeof Reco !== 'undefined') Reco.hydrateLikes();
renderSidebarPlaylists();
renderHome();
initSidebar();

// Restaura a ultima musica reproduzida da sessao anterior
(function restoreLastSession() {
  const last = loadLastTrack();
  if (!last || !last.track) return;

  // Restaura a track no estado
  state.currentTrack = last.track;
  state.queue = last.queue || [last.track];
  state.queueIndex = last.queueIndex || 0;
  state.currentPlaylist = last.currentPlaylist || null;
  state.currentTime = last.currentTime || 0;

  // Adiciona a track ao TRACKS se nao existir
  if (!TRACKS.find(t => t.id === last.track.id)) {
    TRACKS.push(last.track);
  }

  // Carrega no player (sem autoplay — inicia pausado)
  state.isPlaying = false;
  loadTrack(last.track);
  updatePlayerUI();

  // Garante que o placeholder desapareca
  videoCover.classList.add('has-video');
})();

// ============================================
// APRIMORAMENTOS DE UI PARA MOBILE (estilo iOS)
// Apenas UX: nenhuma logica de negocio muda aqui.
// ============================================
(function initMobileUI() {
  const mqMobile = window.matchMedia('(max-width: 768px)');

  // Tocar no mini player (area de info) abre o player expandido,
  // como no Apple Music. Reusa toggleExpanded ja existente.
  const dockInfo = document.querySelector('#player-dock .player-info');
  if (dockInfo) {
    dockInfo.addEventListener('click', (e) => {
      if (!mqMobile.matches) return;
      if (e.target.closest('button')) return; // nao interfere em botoes
      if (!state.currentTrack) return;        // nada tocando ainda
      toggleExpanded();
    });
  }

  // Tocar na miniatura do video no mini player tambem expande
  const cover = document.getElementById('video-cover');
  if (cover) {
    cover.addEventListener('click', (e) => {
      if (!mqMobile.matches) return;
      if (isTvMode()) return;                 // no Modo TV o video fica livre
      if (isExpanded) return;                 // no palco, nao intercepta
      if (e.target.closest('button')) return;
      if (!state.currentTrack) return;
      toggleExpanded();
    });
  }
})();
