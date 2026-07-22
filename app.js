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
  currentPlaylistName: null, // nome legivel da playlist em reproducao (ou null)
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
      currentPlaylistName: state.currentPlaylistName,
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
// Preferencia do usuario (Perfil > Configuracoes): quando desligada, o
// player permanece no modo capa e nao transiciona sozinho para o video.
// ============================================
const AUTO_VIDEO_KEY = 'minstream_auto_video';

function autoVideoEnabled() {
  try { return localStorage.getItem(AUTO_VIDEO_KEY) !== '0'; } catch (_) { return true; }
}

function setAutoVideoEnabled(on) {
  try { localStorage.setItem(AUTO_VIDEO_KEY, on ? '1' : '0'); } catch (_) {}
}

let autoVideoTimer = null;

function startAutoVideoTimer() {
  // Cancela timer anterior se existir
  if (autoVideoTimer) {
    clearTimeout(autoVideoTimer);
    autoVideoTimer = null;
  }
  // Inicia sempre no modo capa
  setPlayerMode('cover');
  // Preferencia do usuario: sem transicao automatica, fica na capa
  if (!autoVideoEnabled()) return;
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
  state.currentPlaylistName = null;
  // Busca o nome da playlist do YouTube em segundo plano (para o cabecalho)
  if (playlistId) {
    fetchPlaylistMeta(playlistId).then(meta => {
      if (meta && meta.title && state.currentPlaylist === playlistId) {
        state.currentPlaylistName = meta.title;
        updateExpandedContext();
      }
    }).catch(() => {});
  }
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
// Player mobile isolado (usado so em telas pequenas)
const mobilePlayer = document.getElementById('mobile-player');
const mpStage = document.getElementById('mp-stage');
let isExpanded = false;
let expandedIsMobile = false; // qual player esta aberto (mobile x desktop)

// Limiar unico para decidir qual player usar (bate com o @media 768px do CSS)
function isMobileView() {
  return window.matchMedia('(max-width: 768px)').matches;
}

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
  // Espelha no player mobile (abas + atributo de modo)
  if (mobilePlayer) {
    mobilePlayer.dataset.mode = mode;
    mobilePlayer.querySelectorAll('.mp-tab[data-mode]').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.mode === mode);
    });
  }
  // Espelha o modo no body (usado pelo CSS de paisagem/imersão)
  if (expandedIsMobile) {
    try { document.body.setAttribute('data-mp-mode', mode); } catch (_) {}
  }

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
  if (mode === 'queue') { buildExpandedQueue(true); if (expandedIsMobile) buildMobileQueue(true); }
  // Aplica as preferencias de visibilidade (relacionados / controles) do
  // player mobile conforme o modo atual.
  if (expandedIsMobile) applyMobilePlayerPrefs();
}

// Mostra/esconde "Videoclipes relacionados", os controles do player e a
// secao de Letra no player mobile, conforme as preferencias do usuario
// para o modo atual.
function applyMobilePlayerPrefs() {
  if (!mobilePlayer) return;
  const mode = mobilePlayer.dataset.mode || 'cover';
  const showRelated = MobilePlayerPrefs.isVisible(mode, 'related');
  const showTransport = MobilePlayerPrefs.isVisible(mode, 'transport');
  const showLyrics = MobilePlayerPrefs.isVisible(mode, 'lyrics');

  const related = document.getElementById('mp-related');
  const lyrics = document.getElementById('mp-lyrics');
  // Bloco de controles = info+curtir, progresso, transporte e rodape
  const controlEls = [
    mobilePlayer.querySelector('.mp-meta-row'),
    mobilePlayer.querySelector('.mp-progress'),
    mobilePlayer.querySelector('.mp-controls'),
    mobilePlayer.querySelector('.mp-footer'),
  ];

  if (related) related.classList.toggle('mp-hidden-pref', !showRelated);
  if (lyrics) lyrics.classList.toggle('mp-hidden-pref', !showLyrics);
  controlEls.forEach(el => { if (el) el.classList.toggle('mp-hidden-pref', !showTransport); });
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

// Palco ativo: o .exp-stage (desktop) ou o #mp-stage (mobile). O vídeo
// compartilhado (#video-cover) e posicionado sobre este elemento.
function activeStageEl() {
  return (isExpanded && expandedIsMobile) ? mpStage : expStage;
}

function _doSync() {
  // Em paisagem, no player mobile modo vídeo, o CSS assume o fullscreen
  // (100dvw/100dvh sob o notch). Não sobrescrevemos os estilos inline.
  if (isExpanded && expandedIsMobile && state.playerMode === 'video' &&
      window.matchMedia('(orientation: landscape)').matches) {
    // Limpa qualquer posicao inline remanescente para o CSS reger sozinho
    if (videoCover.style.left || videoCover.style.width) {
      videoCover.style.left = '';
      videoCover.style.top = '';
      videoCover.style.width = '';
      videoCover.style.height = '';
    }
    return;
  }
  const stage = activeStageEl();
  if (!stage) return;
  const r = stage.getBoundingClientRect();
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
  const host = expandedIsMobile ? mobilePlayer : expandedPlayer;
  const st = host ? host.scrollTop : 0;
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
  resizeDebounce = setTimeout(() => {
    // Se o player esta aberto e a tela cruzou o limiar mobile/desktop,
    // troca para o player correto (reabre no formato adequado).
    if (isExpanded && isMobileView() !== expandedIsMobile) {
      closeExpanded();
      openExpanded();
    } else {
      syncVideoToStage();
    }
  }, 120);
});

// Mudanca de orientacao: em paisagem o CSS assume o video (fullscreen);
// ao voltar a retrato, o _doSync reposiciona sobre o palco. Reagimos aos
// dois sentidos reaplicando a sincronizacao apos o reflow.
window.addEventListener('orientationchange', () => {
  setTimeout(() => {
    if (isExpanded && state.playerMode === 'video') syncVideoToStage();
  }, 250);
});
// O loop de sincronizacao (rAF) ja reposiciona o video a cada frame no modo
// video; no scroll basta atualizar a opacidade. Evita re-toggle de classes e
// reinicios do loop a cada evento de rolagem.
expandedPlayer.addEventListener('scroll', () => {
  updateVideoOpacityOnScroll();
}, { passive: true });

// Scroll do player mobile: mesma logica de opacidade do video
if (mobilePlayer) {
  mobilePlayer.addEventListener('scroll', () => {
    updateVideoOpacityOnScroll();
  }, { passive: true });
}

// ResizeObserver nos palcos (desktop e mobile) detecta mudancas de tamanho
if (typeof ResizeObserver !== 'undefined') {
  syncObserver = new ResizeObserver(() => {
    if (isExpanded && state.playerMode === 'video') _doSync();
  });
  syncObserver.observe(expStage);
  if (mpStage) syncObserver.observe(mpStage);
}

// ============================================
// FUNDO DO PLAYER EXPANDIDO (DESKTOP)
// Mesmo comportamento do player mobile: a capa da faixa entra desfocada
// atras do conteudo. Alem disso o fundo REAGE A COR DA CAPA — a
// thumbnail e amostrada num canvas pequeno e o matiz dominante vira um
// tom que tinge o topo do fundo, com transicao suave na troca de faixa.
// Alimenta duas variaveis no <body>, lidas pelo #exp-backdrop no CSS:
//   --exp-bg     -> url() da capa
//   --exp-accent -> cor derivada da capa (ausente = fundo neutro escuro)
// Mesma ideia (e mesmo criterio de fallback) do fundo do container de
// letra; aqui a amostragem e independente, sem depender do lyrics.js.
// ============================================
const ExpBackdrop = (function () {
  const accentCache = new Map(); // url da capa -> cor css (ou null)
  const CACHE_CAP = 80;
  let currentUrl = '';

  function coverUrlOf(t) {
    if (!t) return '';
    return t.videoId
      ? 'https://i.ytimg.com/vi/' + t.videoId + '/hqdefault.jpg'
      : (t.cover || '');
  }

  function setVar(name, value) {
    try {
      if (value) document.body.style.setProperty(name, value);
      else document.body.style.removeProperty(name);
    } catch (_) {}
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

  // Matiz dominante ponderado por saturacao x brilho (buckets de 30 graus).
  // Capas acinzentadas ou ilegiveis (CORS) retornam null -> fundo neutro.
  function computeAccent(img) {
    const canvas = document.createElement('canvas');
    const W = 32, H = 18;
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext && canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, W, H);
    const data = ctx.getImageData(0, 0, W, H).data; // lanca se a imagem for "tainted"

    const B = 12;
    const wSum = new Array(B).fill(0);
    const rSum = new Array(B).fill(0), gSum = new Array(B).fill(0), bSum = new Array(B).fill(0);
    let colored = 0;

    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const { h, s, l } = rgbToHsl(r, g, b);
      if (l < 0.1 || l > 0.92 || s < 0.15) continue;
      const w = s * (0.4 + 0.6 * l);
      const k = Math.min(B - 1, Math.floor(h / (360 / B)));
      wSum[k] += w; rSum[k] += r * w; gSum[k] += g * w; bSum[k] += b * w;
      colored += w;
    }
    if (colored < 4) return null;

    let best = 0;
    for (let k = 1; k < B; k++) if (wSum[k] > wSum[best]) best = k;
    const w = wSum[best] || 1;
    const { h, s } = rgbToHsl(rSum[best] / w, gSum[best] / w, bSum[best] / w);
    // Tom com o matiz da capa, saturacao contida e luz baixa: cor evidente
    // sem competir com o texto branco por cima.
    const s2 = Math.round(Math.min(0.66, Math.max(0.30, s)) * 100);
    return 'hsl(' + Math.round(h) + ', ' + s2 + '%, 30%)';
  }

  function apply(track) {
    const url = coverUrlOf(track !== undefined ? track : state.currentTrack);
    currentUrl = url;
    setVar('--exp-bg', url ? 'url("' + url + '")' : 'none');
    if (!url) { setVar('--exp-accent', null); return; }
    if (accentCache.has(url)) { setVar('--exp-accent', accentCache.get(url)); return; }
    try {
      const img = new Image();
      img.crossOrigin = 'anonymous'; // i.ytimg.com envia CORS: da para ler os pixels
      img.decoding = 'async';
      img.onload = () => {
        let color = null;
        try { color = computeAccent(img); } catch (_) { color = null; }
        accentCache.set(url, color);
        if (accentCache.size > CACHE_CAP) {
          const first = accentCache.keys().next().value;
          if (first !== undefined) accentCache.delete(first);
        }
        if (url === currentUrl) setVar('--exp-accent', color);
      };
      img.onerror = () => { if (url === currentUrl) setVar('--exp-accent', null); };
      img.src = url;
    } catch (_) { setVar('--exp-accent', null); }
  }

  return { apply };
})();

function fillExpandedCover() {
  const t = state.currentTrack;
  const img = document.getElementById('exp-cover-img');
  const infoTitle = document.getElementById('exp-cover-info-title');
  const infoArtist = document.getElementById('exp-cover-info-artist');
  if (!t) {
    img.src = '';
    infoTitle.textContent = 'Nada tocando';
    infoArtist.textContent = '';
    ExpBackdrop.apply(null);
    return;
  }
  img.src = t.videoId
    ? 'https://i.ytimg.com/vi/' + t.videoId + '/hqdefault.jpg'
    : (t.cover || '');
  // Fundo do player expandido: capa desfocada + tom tirado da propria capa
  ExpBackdrop.apply(t);
  infoTitle.textContent = t.title || '';
  infoArtist.textContent = t.artist || '';
  // Espelha capa/fundo no player mobile
  if (expandedIsMobile) updateMobileMeta();
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
  expandedIsMobile = isMobileView();
  document.body.classList.add('theater-open');
  document.body.classList.toggle('mobile-theater', expandedIsMobile);
  // Abre apenas o player correspondente ao tamanho de tela
  if (expandedIsMobile) {
    mobilePlayer.classList.add('open');
    // Mobile abre focado na capa (o video continua a um toque na aba)
    setPlayerMode(state.playerMode || 'cover');
    updateMobileMeta();
  } else {
    expandedPlayer.classList.add('open');
    ExpandedLayout.apply(); // aplica o layout escolhido (clássico/moderno)
    ExpBackdrop.apply();    // fundo com a capa desfocada + cor da capa
    setPlayerMode(state.playerMode || 'video');
  }
  updateExpandedContext();
  loadRelatedVideos();
  // Inicia o loop de sincronização do vídeo com o palco
  if (state.playerMode === 'video') startSyncLoop();
}

// Atualiza título/artista/capa/curtida do player mobile a partir do estado
function updateMobileMeta() {
  if (!isExpanded || !expandedIsMobile) return;
  const t = state.currentTrack;
  const titleEl = document.getElementById('mp-title');
  const artistEl = document.getElementById('mp-artist');
  const coverEl = document.getElementById('mp-cover-img');
  const likeBtn = document.getElementById('mp-like');
  if (titleEl) titleEl.textContent = t ? (t.title || '') : '';
  if (artistEl) artistEl.textContent = t ? (t.artist || '') : '';
  if (coverEl) {
    coverEl.src = t
      ? (t.videoId ? 'https://i.ytimg.com/vi/' + t.videoId + '/hqdefault.jpg' : (t.cover || ''))
      : '';
  }
  // Fundo do player mobile (mesma capa, borrada via CSS)
  try {
    document.body.style.setProperty('--mp-bg', (coverEl && coverEl.src) ? 'url("' + coverEl.src + '")' : 'none');
  } catch (_) {}
  if (likeBtn && t) likeBtn.classList.toggle('active', state.likedTracks.has(t.id));
}

// Fila do player mobile (reusa makeQueueLi; mesma logica do desktop)
let mpQueueKey = '';
function buildMobileQueue(force) {
  const ul = document.getElementById('mp-queue-items');
  if (!ul) return;
  const isYt = !!(state.currentPlaylist && ytQueue.length);
  const key = isYt
    ? 'yt:' + ytQueue.join(',') + '#' + ytQueueIndex
    : 'lc:' + state.queue.map(t => t.id).join(',') + '#' + state.queueIndex;
  if (!force && key === mpQueueKey) return;
  mpQueueKey = key;

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
  const active = ul.querySelector('.queue-item.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

let lastRelatedArtist = null;
let relatedToken = 0;

function updateExpandedContext() {
  const t = state.currentTrack;
  // Desktop: mantem o comportamento atual (nome da faixa)
  const ctx = document.getElementById('exp-context');
  if (ctx) ctx.textContent = t ? (t.title || 'Tocando agora') : 'Tocando agora';

  // Mobile: cabecalho mostra o NOME DA PLAYLIST em reproducao; se nao for
  // uma playlist, mostra "Tocando agora". O rotulo superior tambem muda.
  const mpCtx = document.getElementById('mp-context-name');
  const mpLabel = document.querySelector('#mobile-player .mp-context-label');
  // E playlist se ha nome (playlists do usuario/YT) OU se ha um ID de
  // playlist do YouTube cujo nome ainda esta sendo buscado.
  const isList = !!(state.currentPlaylistName || state.currentPlaylist);
  const plName = state.currentPlaylistName || (state.currentPlaylist ? 'Playlist do YouTube' : null);
  if (mpCtx) mpCtx.textContent = isList ? plName : 'Tocando agora';
  if (mpLabel) mpLabel.textContent = isList ? 'TOCANDO DA PLAYLIST' : 'TOCANDO AGORA';
}

// ============================================
// CARROSSEL DOS VIDEOCLIPES RELACIONADOS (player expandido desktop)
// No layout MODERNO a faixa rola no eixo X: as setas laterais deslizam
// uma "pagina" inteira (quantos cards couberem na largura visivel) e se
// apagam ao chegar nas pontas. No layout Classico o CSS mantem as setas
// ocultas — a faixa continua rolando por arrasto/trackpad, como antes.
// O mobile (#mp-related-row) nao tem wrapper e nao e afetado.
// ============================================
let updateRelatedArrows = function () {};

function initRelatedCarousel() {
  const row = document.getElementById('exp-related-row');
  const prev = document.getElementById('exp-related-prev');
  const next = document.getElementById('exp-related-next');
  if (!row || !prev || !next) return;

  const GAP = 14; // mesmo gap do CSS da faixa

  // Quantos cards cabem na area visivel -> passo de uma pagina
  function pageStep() {
    const card = row.querySelector('.exp-related-card');
    const w = card ? card.getBoundingClientRect().width : 220;
    const perPage = Math.max(1, Math.floor((row.clientWidth + GAP) / (w + GAP)));
    return (w + GAP) * perPage;
  }

  prev.addEventListener('click', () => row.scrollBy({ left: -pageStep(), behavior: 'smooth' }));
  next.addEventListener('click', () => row.scrollBy({ left: pageStep(), behavior: 'smooth' }));

  updateRelatedArrows = function () {
    const max = row.scrollWidth - row.clientWidth;
    const rolavel = max > 5;
    prev.classList.toggle('is-off', !rolavel || row.scrollLeft <= 5);
    next.classList.toggle('is-off', !rolavel || row.scrollLeft >= max - 5);
  };

  row.addEventListener('scroll', updateRelatedArrows, { passive: true });
  window.addEventListener('resize', updateRelatedArrows);
  // Troca de layout (classico <-> moderno) e abertura do player mudam a
  // largura da faixa: o observer reavalia as setas sozinho.
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(updateRelatedArrows).observe(row);
  }
  updateRelatedArrows();
}

async function loadRelatedVideos() {
  const t = state.currentTrack;
  // Preenche o player ativo: mobile usa #mp-related, desktop usa #exp-related
  const row = document.getElementById(expandedIsMobile ? 'mp-related-row' : 'exp-related-row');
  const wrap = document.getElementById(expandedIsMobile ? 'mp-related' : 'exp-related');
  if (!row || !wrap) return;
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
    img.loading = 'lazy'; img.decoding = 'async';
    const label = document.createElement('div');
    label.className = 'exp-related-label';
    label.textContent = r.title;
    card.appendChild(img);
    card.appendChild(label);
    card.addEventListener('click', () => playYouTubeResult(r, filtered));
    row.appendChild(card);
  });
  // Respeita a preferencia de visibilidade do usuario (mobile)
  if (expandedIsMobile) applyMobilePlayerPrefs();
  // Desktop: lista nova comeca do inicio e as setas sao reavaliadas
  else { row.scrollLeft = 0; updateRelatedArrows(); }
}

function closeExpanded() {
  isExpanded = false;
  // A letra em tela cheia vive por cima do player: sai junto com ele
  try {
    if (typeof Lyrics !== 'undefined' && Lyrics.pageOpen && Lyrics.pageOpen()) Lyrics.closePage();
  } catch (_) {}
  document.body.classList.remove('theater-open', 'mobile-theater');
  document.body.removeAttribute('data-mp-mode');
  expandedPlayer.classList.remove('open');
  if (mobilePlayer) mobilePlayer.classList.remove('open');
  expandedIsMobile = false;
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

// ============================================
// PLAYER MOBILE — listeners (reusam as mesmas acoes do dock)
// ============================================
if (mobilePlayer) {
  document.getElementById('mp-close').addEventListener('click', closeExpanded);
  mobilePlayer.querySelectorAll('.mp-tab[data-mode]').forEach(tab => {
    tab.addEventListener('click', () => setPlayerMode(tab.dataset.mode));
  });
  document.getElementById('mp-play').addEventListener('click', togglePlay);
  document.getElementById('mp-next').addEventListener('click', nextTrack);
  document.getElementById('mp-prev').addEventListener('click', prevTrack);
  document.getElementById('mp-shuffle').addEventListener('click', toggleShuffle);
  document.getElementById('mp-repeat').addEventListener('click', cycleRepeat);
  document.getElementById('mp-like').addEventListener('click', () => {
    if (state.currentTrack) { toggleLike(state.currentTrack.id); updateMobileMeta(); }
  });
  document.getElementById('mp-tv').addEventListener('click', toggleTvMode);
  const mpShare = document.getElementById('mp-share');
  if (mpShare) mpShare.addEventListener('click', () => {
    const t = state.currentTrack;
    if (!t) return;
    const url = t.videoId ? 'https://youtu.be/' + t.videoId : '';
    if (navigator.share && url) navigator.share({ title: t.title || 'MinStream', url }).catch(() => {});
    else if (url && navigator.clipboard) { navigator.clipboard.writeText(url); showToast('Link copiado'); }
  });

  // Scrub na barra de progresso do player mobile
  setupMobileScrub();
}

// Barra de progresso do player mobile: toque e arraste para buscar.
function setupMobileScrub() {
  const bar = document.getElementById('mp-progress-bar');
  if (!bar) return;
  let dragging = false;
  function pctFromEvent(e) {
    const rect = bar.getBoundingClientRect();
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
    return Math.max(0, Math.min(1, x / rect.width));
  }
  function preview(pct) {
    const fill = document.getElementById('mp-progress-fill');
    const handle = document.getElementById('mp-progress-handle');
    if (fill) fill.style.width = (pct * 100) + '%';
    if (handle) handle.style.left = (pct * 100) + '%';
  }
  function commit(pct) {
    if (state.duration > 0) seekToTime(pct * state.duration);
  }
  bar.addEventListener('touchstart', (e) => { dragging = true; preview(pctFromEvent(e)); }, { passive: true });
  bar.addEventListener('touchmove', (e) => { if (dragging) { preview(pctFromEvent(e)); e.preventDefault(); } }, { passive: false });
  bar.addEventListener('touchend', (e) => { if (dragging) { dragging = false; commit(pctFromEvent(e.changedTouches ? { touches: e.changedTouches } : e)); } });
  bar.addEventListener('click', (e) => commit(pctFromEvent(e)));
}

// ============================================
// PAGINA DE LETRA EM TELA CHEIA (MOBILE) — transporte
// A letra em si (linhas, destaque e rolagem) e do lyrics.js, que decide
// quando a tela pode abrir. Aqui ficam titulo/artista, barra de
// progresso com arraste, tempos e play/pause. O syncLyricsPage e
// chamado pelo poll (updatePlayerUI) enquanto a tela esta aberta e uma
// vez pelo lyrics.js no momento da abertura.
// ============================================
let lpScrubbing = false;

function lyricsPageOpen() {
  return document.body.classList.contains('lyrics-page-open');
}

function syncLyricsPage() {
  const page = document.getElementById('lyrics-page');
  if (!page) return;
  const t = state.currentTrack;

  const titleEl = document.getElementById('lp-title');
  const artistEl = document.getElementById('lp-artist');
  if (titleEl) titleEl.textContent = t ? (t.title || '') : '';
  if (artistEl) artistEl.textContent = t ? (t.artist || '') : '';

  const icPlay = document.getElementById('lp-icon-play');
  const icPause = document.getElementById('lp-icon-pause');
  if (icPlay && icPause) {
    icPlay.style.display = state.isPlaying ? 'none' : '';
    icPause.style.display = state.isPlaying ? '' : 'none';
  }

  if (lpScrubbing) return; // nao sobrescreve o arraste em andamento
  const pct = state.duration > 0 ? (state.currentTime / state.duration) * 100 : 0;
  const fill = document.getElementById('lp-progress-fill');
  const handle = document.getElementById('lp-progress-handle');
  const cur = document.getElementById('lp-time-current');
  const tot = document.getElementById('lp-time-total');
  if (fill) fill.style.width = pct + '%';
  if (handle) handle.style.left = pct + '%';
  if (cur) cur.textContent = fmtTime(state.currentTime);
  if (tot) tot.textContent = fmtTime(state.duration);
}

function setupLyricsPageControls() {
  const play = document.getElementById('lp-play');
  if (play) play.addEventListener('click', togglePlay);

  const bar = document.getElementById('lp-progress-bar');
  if (!bar) return;
  function pctFromEvent(e) {
    const rect = bar.getBoundingClientRect();
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
    return Math.max(0, Math.min(1, x / rect.width));
  }
  function preview(pct) {
    const fill = document.getElementById('lp-progress-fill');
    const handle = document.getElementById('lp-progress-handle');
    const cur = document.getElementById('lp-time-current');
    if (fill) fill.style.width = (pct * 100) + '%';
    if (handle) handle.style.left = (pct * 100) + '%';
    if (cur && state.duration > 0) cur.textContent = fmtTime(pct * state.duration);
  }
  function commit(pct) {
    lpScrubbing = false;
    if (state.duration > 0) seekToTime(pct * state.duration);
  }
  bar.addEventListener('touchstart', (e) => { lpScrubbing = true; preview(pctFromEvent(e)); }, { passive: true });
  bar.addEventListener('touchmove', (e) => { if (lpScrubbing) { preview(pctFromEvent(e)); e.preventDefault(); } }, { passive: false });
  bar.addEventListener('touchend', (e) => {
    if (!lpScrubbing) return;
    commit(pctFromEvent(e.changedTouches ? { touches: e.changedTouches } : e));
  });
  bar.addEventListener('touchcancel', () => { lpScrubbing = false; });
  bar.addEventListener('click', (e) => commit(pctFromEvent(e)));
}
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

// Metadados de playlist (titulo + capa) para os cartoes de links salvos.
// Ordem: oEmbed oficial do YouTube (mesmo endpoint dos videos) ->
// Piped /playlists/{id} -> Invidious /api/v1/playlists/{id}.
const playlistMetaCache = new Map(); // listId -> { title, cover } | null

async function fetchPlaylistMeta(listId) {
  if (playlistMetaCache.has(listId)) return playlistMetaCache.get(listId);
  // 1) oEmbed do YouTube (leve, sem key)
  try {
    const url = 'https://www.youtube.com/oembed?format=json&url=' +
      encodeURIComponent('https://www.youtube.com/playlist?list=' + listId);
    const res = await fetchWithTimeout(url, 4500);
    if (res.ok) {
      const json = await res.json();
      if (json && (json.title || json.thumbnail_url)) {
        const meta = { title: json.title || null, cover: json.thumbnail_url || null };
        playlistMetaCache.set(listId, meta);
        return meta;
      }
    }
  } catch (_) {}
  // 2) Instancias publicas (mesmas fontes da busca)
  for (const src of YT_SEARCH_SOURCES) {
    try {
      const url = src.kind === 'piped'
        ? src.base + '/playlists/' + encodeURIComponent(listId)
        : src.base + '/api/v1/playlists/' + encodeURIComponent(listId);
      const res = await fetchWithTimeout(url, 4500);
      if (!res.ok) continue;
      const data = await res.json();
      let title = null, cover = null;
      if (src.kind === 'piped') {
        title = (data && data.name) || null;
        cover = (data && data.thumbnailUrl) || null;
        if (!cover && data && Array.isArray(data.relatedStreams) && data.relatedStreams[0]) {
          const vid = extractVideoId(data.relatedStreams[0].url || '');
          if (vid) cover = 'https://i.ytimg.com/vi/' + vid + '/mqdefault.jpg';
        }
      } else {
        title = (data && data.title) || null;
        const v0 = data && Array.isArray(data.videos) && data.videos[0];
        if (v0 && v0.videoId) cover = 'https://i.ytimg.com/vi/' + v0.videoId + '/mqdefault.jpg';
      }
      if (title || cover) {
        const meta = { title, cover };
        playlistMetaCache.set(listId, meta);
        return meta;
      }
    } catch (_) { /* tenta a proxima instancia */ }
  }
  playlistMetaCache.set(listId, null);
  return null;
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
      // Atualiza o ID para que updatePlayerUI detecte mudanca de track
      // e o botao de curtir opere sobre o video correto
      state.currentTrack.id = 'yt_' + vd.video_id;
      if (vd.title) state.currentTrack.title = vd.title;
      if (vd.author) state.currentTrack.artist = vd.author;
      state.currentTrack.cover = 'https://i.ytimg.com/vi/' + vd.video_id + '/hqdefault.jpg';
      materializeYtTrack(vd.video_id, state.currentTrack.title, state.currentTrack.artist, 0);
      updatePlayerUI();
      saveLastTrack();
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

function playTrack(track, tracks, playlistName) {
  if (!track) return;
  state.currentTrack = track;
  state.currentPlaylist = null;  // local track, not a YT playlist
  state.currentPlaylistName = playlistName || null;
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
      cover: data.cover || null,
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

  // Persiste a capa descoberta (miniatura de playlist via metadados)
  function updateCover(key, cover) {
    if (!cover) return;
    const items = load();
    const it = items.find((i) => keyOf(i) === key);
    if (it && !it.cover) { it.cover = cover; persist(items); }
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

  return { load, save, remove, keyOf, watchUrlOf, updateTitle, updateCover, isPinned, togglePin, loadSorted, hideFromHome, unhideFromHome, isHiddenFromHome, loadHomeHidden, loadSortedForHome };
})();

// ============================================
// SEGUIR ARTISTAS
// O usuario segue perfis de artistas (botao "Seguir" na pagina do
// artista). Os seguidos aparecem na secao "Seguindo" do Inicio como
// circulos com a foto do perfil e o nome; clicar abre o perfil.
// localStorage: 'minstream_follows' (prefixo coberto pelo Takeout),
// itens { name, avatar, followedAt }, sem duplicados (nome normalizado),
// max 100. O avatar e persistido ao seguir e atualizado ("self-heal")
// quando o perfil e visitado de novo com uma foto melhor disponivel.
// ============================================
const Follows = (function () {
  const KEY = 'minstream_follows';
  const MAX = 100;

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
  }
  function persist(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (_) {}
  }
  function normKey(name) { return String(name || '').trim().toLowerCase(); }

  function isFollowing(name) {
    const k = normKey(name);
    return !!k && load().some(f => normKey(f && f.name) === k);
  }
  function follow(name, avatar) {
    const n = String(name || '').trim();
    if (!n) return false;
    const list = load();
    const k = normKey(n);
    if (list.some(f => normKey(f && f.name) === k)) return false;
    list.unshift({ name: n, avatar: avatar || null, followedAt: Date.now() });
    if (list.length > MAX) list.length = MAX;
    persist(list);
    return true;
  }
  function unfollow(name) {
    const k = normKey(name);
    persist(load().filter(f => normKey(f && f.name) !== k));
  }
  // Completa/atualiza a foto do perfil quando uma melhor for descoberta
  function updateAvatar(name, avatar) {
    if (!avatar) return;
    const k = normKey(name);
    const list = load();
    const f = list.find(x => normKey(x && x.name) === k);
    if (f && f.avatar !== avatar) { f.avatar = avatar; persist(list); }
  }
  function count() { return load().length; }

  return { load, isFollowing, follow, unfollow, updateAvatar, count };
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
// ============================================
// PREFERENCIAS DO PLAYER MOBILE
// O usuario personaliza, por modo (video/capa/fila), se aparecem:
//  - a secao "Videoclipes relacionados" (related)
//  - os "controles do player" (transport: progresso + botoes)
// Persistido em localStorage; padrao = tudo visivel.
// ============================================
const MobilePlayerPrefs = (function () {
  const KEY = 'minstream_mp_prefs';
  const MODES = ['video', 'cover', 'queue'];
  const SECTIONS = ['related', 'transport', 'lyrics'];

  function defaults() {
    // Tudo visivel por padrao
    const d = {};
    MODES.forEach(m => { d[m] = { related: true, transport: true, lyrics: true }; });
    return d;
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return defaults();
      const parsed = JSON.parse(raw);
      const base = defaults();
      MODES.forEach(m => {
        if (parsed && parsed[m]) {
          SECTIONS.forEach(s => {
            if (typeof parsed[m][s] === 'boolean') base[m][s] = parsed[m][s];
          });
        }
      });
      return base;
    } catch (_) { return defaults(); }
  }

  function save(prefs) {
    try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch (_) {}
  }

  function isVisible(mode, section) {
    const p = load();
    return !!(p[mode] && p[mode][section]);
  }

  function setVisible(mode, section, visible) {
    const p = load();
    if (!p[mode]) p[mode] = { related: true, transport: true, lyrics: true };
    p[mode][section] = !!visible;
    save(p);
  }

  return { load, save, isVisible, setVisible, MODES, SECTIONS };
})();

// ============================================
// LAYOUT DO PLAYER EXPANDIDO (desktop)
// Dois modos de visualização com as MESMAS funções e elementos:
//  - 'classic' (padrão): vídeo/capa/fila em cima, letra abaixo,
//    relacionados por último (layout empilhado atual);
//  - 'modern': vídeo/capa/fila e letra lado a lado (duas colunas),
//    com os videoclipes relacionados em largura total abaixo.
// A escolha é do usuário (Perfil > Configurações) e persiste em
// 'minstream_exp_layout' (prefixo coberto pelo Takeout).
// ============================================
const ExpandedLayout = (function () {
  const KEY = 'minstream_exp_layout';
  function get() {
    try { return localStorage.getItem(KEY) === 'modern' ? 'modern' : 'classic'; }
    catch (_) { return 'classic'; }
  }
  function set(mode) {
    const m = (mode === 'modern') ? 'modern' : 'classic';
    try { localStorage.setItem(KEY, m); } catch (_) {}
    apply();
    return m;
  }
  function isModern() { return get() === 'modern'; }
  // Aplica a classe no player expandido desktop; o CSS faz o resto.
  function apply() {
    const el = document.getElementById('expanded-player');
    if (el) el.classList.toggle('layout-modern', get() === 'modern');
  }
  return { get, set, isModern, apply };
})();

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

// Extrai o ID de canal (UC...) de uma URL de uploader do Piped
function channelIdFromUrl(u) {
  if (!u) return '';
  const m = /\/channel\/(UC[A-Za-z0-9_-]{10,})/.exec(u);
  return m ? m[1] : '';
}

function normalizePiped(items) {
  return (items || [])
    .filter(it => it && it.url && it.url.includes('watch?v='))
    .map(it => ({
      videoId: extractVideoId(it.url),
      title: it.title || '',
      author: it.uploaderName || '',
      channelId: channelIdFromUrl(it.uploaderUrl),
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
      channelId: it.authorId || '',
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

// Filtro de ordenacao da busca: 'relevance' (padrao), 'views', 'date'
let ytSearchSort = 'relevance';

function setYtSearchSort(sort) {
  ytSearchSort = sort;
}

function getYtSearchSort() {
  return ytSearchSort;
}

// Ordenacao local dos resultados conforme o filtro escolhido.
// Garante o resultado certo mesmo quando a instancia ignora o
// parametro de sort do servidor (o Piped nao suporta sort na busca).
//   'plays'     -> comportamento legado (rankByPlays): usado pelos fluxos
//                  internos (mixes, novidades, relacionados, tendencias)
//   'relevance' -> preserva a ordem de relevancia devolvida pela API
//   'views'     -> mais visualizados primeiro (ordenacao local, estavel)
//   'date'      -> mais recentes primeiro (timestamp `published`; itens
//                  sem data vao para o fim, na ordem original)
function applySearchSort(items, sort) {
  if (!Array.isArray(items)) return items;
  if (sort === 'views') {
    return items
      .map((it, i) => ({ it, i }))
      .sort((a, b) => ((b.it.views || 0) - (a.it.views || 0)) || (a.i - b.i))
      .map(x => x.it);
  }
  if (sort === 'date') {
    return items
      .map((it, i) => ({ it, i }))
      .sort((a, b) => ((b.it.published || 0) - (a.it.published || 0)) || (a.i - b.i))
      .map(x => x.it);
  }
  if (sort === 'relevance') return items.slice();
  return rankByPlays(items); // 'plays' (padrao interno)
}

// Busca uma pagina numa instancia. Piped devolve { items, nextpage };
// Invidious pagina por numero. Retorna { raw, nextpage }.
async function fetchSearchPage(src, q, sort, page, nextpage) {
  let url;
  if (src.kind === 'piped') {
    url = (page > 1 && nextpage)
      ? src.base + '/nextpage/search?nextpage=' + encodeURIComponent(nextpage) +
        '&q=' + encodeURIComponent(q) + '&filter=videos'
      : src.base + '/search?q=' + encodeURIComponent(q) + '&filter=videos';
    // Piped nao suporta sort na busca; a ordenacao e feita localmente.
  } else {
    url = src.base + '/api/v1/search?q=' + encodeURIComponent(q) + '&type=video&page=' + page;
    // Nomes corretos da API do Invidious (sort_by=...):
    if (sort === 'views') url += '&sort_by=view_count';
    else if (sort === 'date') url += '&sort_by=upload_date';
    else url += '&sort_by=relevance';
  }
  const res = await fetchWithTimeout(url, 4500);
  if (!res.ok) throw new Error('http ' + res.status);
  const data = await res.json();
  if (src.kind === 'piped') {
    return { raw: normalizePiped(data && data.items), nextpage: (data && data.nextpage) || null };
  }
  return { raw: normalizeInvidious(data), nextpage: null };
}

// ============================================
// MOTOR DE RELEVANCIA DA BUSCA (estilo Google -> YouTube)
// A busca de texto da UI deixa de simplesmente confiar na ordem crua da
// instancia (ou so no numero de views) e passa a ranquear por RELEVANCIA
// real, combinando varios sinais como um buscador faz:
//   - correspondencia da consulta: frase exata, cobertura dos termos com
//     tolerancia a acento e a erro de digitacao, e match no artista/canal;
//   - canal/upload oficial (VEVO / "- Topic" / "Official") — os uploads
//     canonicos de musica que o Google prioriza;
//   - popularidade (views em escala log, com teto: corrobora, nao domina);
//   - concordancia entre instancias (aparecer em varias fontes reforca);
//   - plausibilidade de duracao de musica;
//   - leve personalizacao pelos artistas que o usuario mais toca (PlayStats).
// Alem disso AGREGA varias instancias em paralelo e deduplica por videoId
// (mais cobertura e robustez). Os filtros explicitos "Mais visualizado" /
// "Mais recente" continuam mandando (applySearchSort); o motor abaixo vale
// para "Relevancia". Os fluxos internos (mixes, novidades, relacionados,
// tendencias, playlists dinamicas) mantem o caminho legado, intacto.
// ============================================

// Normalizacao para COMPARACAO textual (a consulta enviada a API continua a
// original): minusculas, sem acento, sem pontuacao, espacos colapsados.
function stripDiacritics(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
function normalizeText(s) {
  return stripDiacritics(String(s || '').toLowerCase())
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Ruido comum em titulos de musica: sai da conta de cobertura de termos
// (a frase completa ainda casa e continua pesando).
const SEARCH_STOPWORDS = new Set([
  'official', 'oficial', 'video', 'videoclipe', 'audio', 'music', 'musica',
  'hd', '4k', 'lyrics', 'lyric', 'letra', 'feat', 'ft', 'the', 'a', 'o', 'de',
]);

function tokenizeQuery(s) {
  return normalizeText(s).split(' ').filter(t => t && t.length >= 2);
}

// Distancia de edicao <= 1 (barata, sem matriz): tolera 1 erro de digitacao.
function editDistanceLE1(a, b) {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (la > lb) i++;          // remocao
    else if (lb > la) j++;     // insercao
    else { i++; j++; }         // substituicao
  }
  if (i < la || j < lb) edits++;
  return edits <= 1;
}

// Um termo casa com alguma palavra? igualdade, prefixo (>=3) ou 1 erro (>=5).
function tokenMatchesWords(words, tok) {
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === tok) return true;
    if (tok.length >= 3 && w.startsWith(tok)) return true;
    if (tok.length >= 5 && Math.abs(w.length - tok.length) <= 1 && editDistanceLE1(w, tok)) return true;
  }
  return false;
}

// Pontua um resultado quanto a relevancia para a consulta
function scoreRelevance(it, ctx) {
  const title = normalizeText(it.title || '');
  const author = normalizeText(it.author || '');
  const hay = title + ' ' + author;
  const nq = ctx.nq;
  let s = 0;

  // 1) Correspondencia de frase (mais forte quanto mais exata)
  if (nq) {
    if (title === nq) s += 60;
    else if (title.startsWith(nq)) s += 34;
    else if (title.includes(nq)) s += 24;
    else if (hay.includes(nq)) s += 14;
  }

  // 2) Cobertura dos termos (titulo + artista), com fuzzy
  const titleWords = title ? title.split(' ') : [];
  const authorWords = author ? author.split(' ') : [];
  let covered = 0, authorHits = 0;
  ctx.tokens.forEach(tok => {
    if (tokenMatchesWords(titleWords, tok)) covered++;
    else if (tokenMatchesWords(authorWords, tok)) { covered++; authorHits++; }
  });
  const coverage = ctx.tokens.length ? covered / ctx.tokens.length : 0;
  s += coverage * 40;
  if (ctx.tokens.length && coverage === 1) s += 12;
  s += authorHits * 4;

  // 3) Canal/upload oficial (uploads canonicos de musica)
  if (/vevo$/.test(author) || / - topic$/.test(author) || author.includes('official')) s += 8;
  if (/(official\s+(video|audio|music\s*video))|(video\s+oficial|audio\s+oficial|clipe\s+oficial)/.test(title)) s += 6;

  // 4) Popularidade (log, teto baixo)
  const views = it.views || 0;
  if (views > 0) s += Math.min(18, Math.log10(views + 1) * 2.2);

  // 5) Concordancia entre instancias
  if (ctx.maxAgree > 1 && it._count > 1) s += ((it._count - 1) / (ctx.maxAgree - 1)) * 8;

  // 6) Duracao plausivel de musica
  const d = it.duration || 0;
  if (d >= 60 && d <= 600) s += 4;
  else if (d > 0 && d < 45) s -= 6;
  else if (d > 1800) s -= 4;

  // 7) Personalizacao leve: artistas mais tocados
  if (ctx.artistPlays && it.author) {
    const p = ctx.artistPlays.get((it.author || '').trim().toLowerCase()) || 0;
    if (p > 0) s += Math.min(6, Math.log2(p + 1) * 1.5);
  }

  // 8) Penalidades leves para ruido nao solicitado
  if (!nq.includes('reaction') && !nq.includes('reagindo') && /\breaction\b|reagindo/.test(title)) s -= 5;
  if (!/(\b1\s*hour\b|\b1h\b|\bloop\b|\bhoras?\b)/.test(nq) && /(1\s*hour|1h\s*loop|10\s*hours|\bloop\b)/.test(title)) s -= 4;

  return s;
}

// Ranqueia por relevancia (estavel; desempate por views e ordem original)
function rankByRelevance(items, query) {
  const nq = normalizeText(query);
  let tokens = tokenizeQuery(query).filter(t => !SEARCH_STOPWORDS.has(t));
  if (!tokens.length) tokens = tokenizeQuery(query); // consulta so de stopwords
  const ctx = {
    nq,
    tokens,
    maxAgree: items.reduce((m, it) => Math.max(m, it._count || 1), 1),
    artistPlays: (typeof PlayStats !== 'undefined' && PlayStats.artistPlays) ? PlayStats.artistPlays() : null,
  };
  return items
    .map((it, i) => ({ it, i, s: scoreRelevance(it, ctx) }))
    .sort((a, b) => (b.s - a.s) || ((b.it.views || 0) - (a.it.views || 0)) || (a.i - b.i))
    .map(x => x.it);
}

// Busca todas as paginas de UMA instancia (deduplicando dentro dela)
async function fetchSourcePages(src, q, sort, maxPages) {
  const seen = new Set();
  const collected = [];
  let nextpage = null;
  for (let page = 1; page <= maxPages; page++) {
    let out;
    try { out = await fetchSearchPage(src, q, sort, page, nextpage); }
    catch (_) { break; } // pagina extra falhou: segue com o que ja tem
    nextpage = out.nextpage;
    out.raw.forEach(it => {
      if (!seen.has(it.videoId)) { seen.add(it.videoId); collected.push(it); }
    });
    if (src.kind === 'piped' && !nextpage) break; // sem mais paginas
    if (!out.raw.length) break;
  }
  return collected;
}

const SEARCH_AGG_INSTANCES = 3;   // instancias consultadas em paralelo (UI)
const SEARCH_AGG_DEADLINE = 6500; // teto de espera antes de usar o parcial

// Agrega varias instancias em paralelo e funde por videoId, guardando o
// sinal de concordancia (_count). Resolve cedo quando ja ha resultado de
// sobra, sem esperar as instancias mais lentas.
async function aggregateSearch(q, sort, maxPages) {
  const picked = YT_SEARCH_SOURCES.slice(0, SEARCH_AGG_INSTANCES);
  const merged = new Map();
  let done = 0, earlyResolve;
  const early = new Promise(r => { earlyResolve = r; });
  const absorb = (list) => {
    (list || []).forEach((it, idx) => {
      const ex = merged.get(it.videoId);
      if (!ex) {
        merged.set(it.videoId, Object.assign({}, it, { _count: 1, _rankSum: idx }));
      } else {
        ex._count += 1;
        ex._rankSum += idx;
        if ((it.views || 0) > (ex.views || 0)) ex.views = it.views;
        if (!ex.author && it.author) ex.author = it.author;
        if (!ex.duration && it.duration) ex.duration = it.duration;
        if (!ex.channelId && it.channelId) ex.channelId = it.channelId;
        if (!ex.published && it.published) { ex.published = it.published; ex.publishedText = it.publishedText || ex.publishedText; }
      }
    });
  };
  const tasks = picked.map(src =>
    fetchSourcePages(src, q, sort, maxPages)
      .then(absorb).catch(() => {})
      .finally(() => {
        done++;
        if ((done >= 2 && merged.size >= 12) || done >= picked.length) earlyResolve();
      })
  );
  const all = Promise.allSettled(tasks);
  await Promise.race([early, all, new Promise(r => setTimeout(r, SEARCH_AGG_DEADLINE))]);
  if (!merged.size) await all; // todas so lentas: espera o ciclo completo
  return [...merged.values()];
}

// Remove os campos internos de agregacao antes de devolver/cachear
function stripAggFields(r) {
  if (r && (r._count !== undefined || r._rankSum !== undefined)) {
    const c = Object.assign({}, r);
    delete c._count; delete c._rankSum;
    return c;
  }
  return r;
}

// opts.sort: quando informado (busca da UI) usa o MOTOR DE RELEVANCIA com
// agregacao de instancias e ranqueamento por relevancia/views/data. Sem
// opts, mantem o caminho legado (1a instancia que responde, ranking por
// reproducoes) — usado por mixes, novidades, relacionados, tendencias e
// playlists dinamicas, que fazem muitas chamadas em lote.
async function searchYouTube(query, opts) {
  const q = (query || '').trim();
  if (!q) return [];
  const sort = (opts && opts.sort) || 'plays';
  const isUi = !!(opts && opts.sort);
  const maxPages = isUi ? 2 : 1;
  const cap = isUi ? 30 : 12;
  const cacheKey = normalizeText(q) + '|sort=' + sort;
  if (ytSearchCache.has(cacheKey)) return ytSearchCache.get(cacheKey);

  // Caminho da UI: agrega instancias, deduplica e ranqueia pelo motor.
  if (isUi) {
    let items = [];
    try { items = AdShield.filter(await aggregateSearch(q, sort, maxPages)); }
    catch (_) { items = []; }
    if (items.length) {
      const ordered = (sort === 'views' || sort === 'date')
        ? applySearchSort(items, sort)
        : rankByRelevance(items, q); // 'relevance'
      const top = ordered.slice(0, cap).map(stripAggFields);
      ytSearchCache.set(cacheKey, top);
      return top;
    }
    ytSearchCache.set(cacheKey, []);
    return [];
  }

  // Caminho interno (legado): 1a instancia que devolve resultado.
  for (const src of YT_SEARCH_SOURCES) {
    try {
      const items = AdShield.filter(await fetchSourcePages(src, q, sort, maxPages));
      if (items.length) {
        const top = applySearchSort(items, sort).slice(0, cap);
        ytSearchCache.set(cacheKey, top);
        return top;
      }
    } catch (_) { /* tenta a proxima instancia */ }
  }
  ytSearchCache.set(cacheKey, []);
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
// SHORTS DO YOUTUBE (videos curtos verticais)
// Busca shorts usando as mesmas instancias Piped/Invidious.
// Filtra por duracao curta (<= 90s) e palavras-chave tipicas de shorts.
// Cache em memoria com TTL de 30 min.
// ============================================
const ytShortsCache = new Map();
const SHORTS_TTL = 30 * 60 * 1000;
const SHORTS_MAX_DURATION = 90; // segundos

function normalizeShorts(items) {
  return (items || [])
    .filter(it => {
      if (!it || !it.videoId) return false;
      // So videos curtos
      if (typeof it.duration === 'number' && it.duration > SHORTS_MAX_DURATION) return false;
      if (typeof it.duration === 'number' && it.duration <= 0) return false;
      return isValidId(it.videoId);
    })
    .map(it => ({
      videoId: it.videoId,
      title: it.title || '',
      author: it.author || '',
      channelId: it.channelId || '',
      duration: it.duration || 0,
      views: it.views || 0,
    }));
}

async function searchYouTubeShorts(query) {
  const q = query.trim();
  const cacheKey = 'shorts:' + q;
  const cached = ytShortsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < SHORTS_TTL) return cached.items;

  // Queries otimizadas para shorts: adiciona termos que ajudam a encontrar conteudo curto
  const queries = [q, q + ' shorts', q + ' short'];
  const uniqueQueries = [...new Set(queries)];

  const allResults = [];
  for (const src of YT_SEARCH_SOURCES) {
    try {
      for (const searchQ of uniqueQueries) {
        const url = src.kind === 'piped'
          ? src.base + '/search?q=' + encodeURIComponent(searchQ) + '&filter=videos'
          : src.base + '/api/v1/search?q=' + encodeURIComponent(searchQ) + '&type=video';
        const res = await fetchWithTimeout(url, 4000);
        if (!res.ok) continue;
        const data = await res.json();
        const raw = src.kind === 'piped'
          ? normalizePiped(data && data.items)
          : normalizeInvidious(data);
        allResults.push(...(raw || []));
      }
      // Se conseguiu resultados de alguma instancia, para
      if (allResults.length) break;
    } catch (_) { /* tenta proxima instancia */ }
  }

  // Filtra por duracao e remove duplicados
  const shorts = normalizeShorts(allResults);
  const byId = new Map();
  shorts.forEach(s => {
    if (!byId.has(s.videoId)) byId.set(s.videoId, s);
  });

  // Ordena por views (mais populares primeiro)
  const items = rankByPlays([...byId.values()]).slice(0, 20);
  ytShortsCache.set(cacheKey, { items, at: Date.now() });
  return items;
}

// Agrega shorts dos gostos e artistas do usuario
async function fetchShortsForUser() {
  const tastes = (typeof Tastes !== 'undefined' ? Tastes.load() : []).slice(0, 3);
  const topArtists = (typeof PlayStats !== 'undefined') ? PlayStats.top(5) : [];

  const queries = [];
  tastes.forEach(t => queries.push(t + ' music shorts'));
  topArtists.forEach(a => { if (a.artist) queries.push(a.artist + ' shorts'); });
  // Fallback: queries genericas de shorts musicais
  queries.push('music shorts', 'trending shorts music');

  const unique = [...new Set(queries.map(q => q.trim()).filter(Boolean))];
  if (!unique.length) return [];

  // Busca com concorrencia limitada (max 3 simultaneas)
  const allResults = [];
  for (let i = 0; i < unique.length; i += 3) {
    const batch = unique.slice(i, i + 3);
    const results = await Promise.all(batch.map(q => searchYouTubeShorts(q).catch(() => [])));
    results.forEach(list => allResults.push(...(list || [])));
  }

  // Deduplica por videoId
  const byId = new Map();
  allResults.forEach(r => {
    if (!r.videoId || byId.has(r.videoId)) return;
    byId.set(r.videoId, r);
  });

  // Embaralha para variedade e retorna ate 30 shorts
  const shorts = [...byId.values()];
  for (let i = shorts.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shorts[i], shorts[j]] = [shorts[j], shorts[i]];
  }
  return shorts.slice(0, 30);
}

// ============================================
// PERFIL DO ARTISTA
// Ao pesquisar um artista, o app monta uma pagina de perfil que reune
// o conteudo do canal dele no YouTube: avatar/banner, inscritos,
// descricao e os videos do canal (via Piped/Invidious), ranqueados
// pelo sistema de acuracia (mais reproduzidos primeiro).
// ============================================
const ytChannelSearchCache = new Map();
const artistProfileCache = new Map(); // nome (lower) -> perfil (memoria: zera no F5)
let currentArtistProfile = null;
// Aba ativa do perfil do artista: 'all' (Tudo), 'recent' (Recente) ou
// 'views' (Mais tocado). Reiniciada para 'all' a cada perfil aberto.
let artistActiveTab = 'all';
// Lista atualmente exibida (ja ordenada pela aba ativa) — usada tambem
// pelo "Tocar tudo" para tocar na mesma ordem que o usuario ve.
let artistDisplayedVideos = [];

function fmtCompact(n) {
  if (!n || n <= 0) return '';
  try {
    return new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
  } catch (_) { return String(n); }
}

function normalizePipedChannels(items) {
  return (items || [])
    .filter(it => it && it.url && it.url.includes('/channel/'))
    .map(it => ({
      channelId: (it.url.split('/channel/')[1] || '').split(/[/?#]/)[0],
      name: it.name || '',
      avatar: it.thumbnail || '',
      subs: (typeof it.subscribers === 'number' && it.subscribers > 0) ? it.subscribers : 0,
      description: it.description || '',
    }))
    .filter(c => /^UC[A-Za-z0-9_-]{10,}$/.test(c.channelId));
}

function normalizeInvidiousChannels(items) {
  return (items || [])
    .filter(it => it && it.type === 'channel' && it.authorId)
    .map(it => ({
      channelId: it.authorId,
      name: it.author || '',
      avatar: (it.authorThumbnails && it.authorThumbnails.length)
        ? it.authorThumbnails[it.authorThumbnails.length - 1].url : '',
      subs: (typeof it.subCount === 'number' && it.subCount > 0) ? it.subCount : 0,
      description: it.description || '',
    }));
}

async function searchYouTubeChannels(query) {
  const q = query.trim();
  if (!q) return [];
  const key = q.toLowerCase();
  if (ytChannelSearchCache.has(key)) return ytChannelSearchCache.get(key);

  for (const src of YT_SEARCH_SOURCES) {
    try {
      const url = src.kind === 'piped'
        ? src.base + '/search?q=' + encodeURIComponent(q) + '&filter=channels'
        : src.base + '/api/v1/search?q=' + encodeURIComponent(q) + '&type=channel';
      const res = await fetchWithTimeout(url, 4500);
      if (!res.ok) continue;
      const data = await res.json();
      const items = src.kind === 'piped'
        ? normalizePipedChannels(data && data.items)
        : normalizeInvidiousChannels(data);
      if (items.length) {
        const top = items.slice(0, 5);
        ytChannelSearchCache.set(key, top);
        return top;
      }
    } catch (_) { /* tenta a proxima instancia */ }
  }
  // Nao grava cache vazio: as instancias publicas oscilam, entao uma
  // proxima tentativa (ex.: novo clique) pode funcionar.
  return [];
}

// Busca os videos (e metadados extras) do canal
async function fetchChannelContent(channel) {
  for (const src of YT_SEARCH_SOURCES) {
    try {
      if (src.kind === 'piped') {
        const res = await fetchWithTimeout(src.base + '/channel/' + channel.channelId, 5000);
        if (!res.ok) continue;
        const data = await res.json();
        const vids = AdShield.filter(normalizePiped(data.relatedStreams || []));
        if (!vids.length) continue;
        return {
          ...channel,
          name: data.name || channel.name,
          avatar: data.avatarUrl || channel.avatar,
          banner: data.bannerUrl || '',
          subs: (typeof data.subscriberCount === 'number' && data.subscriberCount > 0) ? data.subscriberCount : channel.subs,
          description: data.description || channel.description,
          videos: rankByPlays(vids).slice(0, 30), // acuracia: mais reproduzidos primeiro
        };
      } else {
        const res = await fetchWithTimeout(src.base + '/api/v1/channels/' + channel.channelId + '/videos', 5000);
        if (!res.ok) continue;
        const data = await res.json();
        const arr = (Array.isArray(data) ? data : (data && data.videos) || [])
          .map(it => ({ ...it, type: it.type || 'video' }));
        const vids = AdShield.filter(normalizeInvidious(arr));
        if (!vids.length) continue;
        return { ...channel, banner: '', videos: rankByPlays(vids).slice(0, 30) };
      }
    } catch (_) { /* tenta a proxima instancia */ }
  }
  return null;
}

// Resolve o melhor canal para um nome de artista e busca seu conteudo.
// Resiliente por construcao: os endpoints de canal das instancias
// publicas falham com frequencia MESMO quando a busca de videos
// funciona. Por isso ha tres caminhos, do mais rico ao garantido:
//   1. busca de canais -> conteudo do canal;
//   2. ID do canal extraido dos proprios resultados de video
//      (uploaderUrl/authorId) -> conteudo do canal;
//   3. fallback garantido: perfil montado com os videos do artista
//      vindos da busca comum (que comprovadamente funciona no app).
async function fetchArtistProfile(name) {
  const qn = name.trim().toLowerCase();
  const matches = (n) => {
    const x = (n || '').trim().toLowerCase();
    return !!x && (x === qn || x.includes(qn) || qn.includes(x));
  };

  // Os dois caminhos de resolucao correm EM PARALELO (era sequencial:
  // cada um podia levar segundos; juntos, o tempo cai pela metade)
  let searchResults = [];
  let channels = [];
  try {
    [searchResults, channels] = await Promise.all([
      searchYouTube(name).then(r => r || []).catch(() => []),
      searchYouTubeChannels(name).catch(() => []),
    ]);
  } catch (_) {}
  const byAuthor = searchResults.filter(r => matches(r.author));
  const authorVideos = byAuthor.length >= 3 ? byAuthor : searchResults;

  // Candidatos a canal: (a) busca de canais...
  const candidates = [];
  channels.filter(c => matches(c.name)).forEach(c => candidates.push(c));
  if (!candidates.length && channels.length) candidates.push(channels[0]);

  // ...(b) e o canal extraido dos proprios resultados de video
  const vidWithChannel = byAuthor.find(r => r.channelId) || searchResults.find(r => r.channelId);
  if (vidWithChannel && !candidates.some(c => c.channelId === vidWithChannel.channelId)) {
    candidates.push({
      channelId: vidWithChannel.channelId,
      name: vidWithChannel.author,
      avatar: '', subs: 0, description: '',
    });
  }

  // Tenta o conteudo completo do canal para cada candidato, com um prazo
  // total: se as instancias estiverem lentas, cai para o fallback em vez
  // de acumular timeouts (era a principal causa da espera longa)
  const deadline = Date.now() + 8000;
  for (const ch of candidates.slice(0, 3)) {
    if (!ch.channelId || Date.now() > deadline) continue;
    try {
      const full = await fetchChannelContent(ch);
      if (full && (full.videos || []).length) return full;
    } catch (_) { /* tenta o proximo candidato */ }
  }

  // Fallback garantido: monta o perfil com o que a busca encontrou
  if (authorVideos.length) {
    const best = candidates[0] || null;
    return {
      channelId: best ? best.channelId : '',
      name: (best && matches(best.name)) ? best.name
        : (byAuthor[0] ? byAuthor[0].author : name.trim()),
      avatar: best ? best.avatar : '',
      subs: best ? best.subs : 0,
      description: best ? best.description : '',
      videos: rankByPlays(authorVideos.slice()),
      fromSearch: true, // indica que veio da busca, nao do canal
    };
  }
  return null;
}

// Abre (e monta, se preciso) a pagina de perfil do artista
// ============================================
// PAGINA DO ARTISTA — ESTRUTURA PRE-EXISTENTE
// A pagina e criada UMA unica vez (template persistente com referencias
// diretas aos campos). Abrir um artista apenas: (1) anexa a estrutura ao
// main e mostra o skeleton na hora — com o nome ja preenchido; (2) busca
// os dados em paralelo; (3) preenche os campos. Nada de reconstruir/
// re-parsear HTML a cada visita: so escrita de texto/atributos.
// ============================================
let artistPageEl = null;
const artistRefs = {};

function ensureArtistPage() {
  if (artistPageEl) return artistPageEl;
  artistPageEl = document.createElement('div');
  artistPageEl.className = 'section artist-page';
  artistPageEl.innerHTML = `
    ${backButton('search')}
    <div class="artist-hero" data-ref="hero">
      <div class="artist-avatar-wrap" data-ref="avatarWrap">
        <img class="artist-avatar" data-ref="avatar" alt="" decoding="async" style="display:none">
      </div>
      <div class="artist-hero-info">
        <div class="artist-kicker">Perfil do artista</div>
        <h2 class="artist-name" data-ref="name"></h2>
        <div class="artist-meta" data-ref="meta"></div>
        <p class="artist-desc" data-ref="desc" style="display:none"></p>
        <div class="artist-hero-actions">
          <button class="btn-play-main artist-play-all" data-ref="playAll" title="Tocar todo o conteúdo">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            Tocar tudo
          </button>
          <button class="artist-follow-btn" data-ref="followBtn" aria-pressed="false" title="Seguir este artista">
            <svg class="ico-plus" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19" stroke-linecap="round"/><line x1="5" y1="12" x2="19" y2="12" stroke-linecap="round"/></svg>
            <svg class="ico-check" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <span>Seguir</span>
          </button>
        </div>
      </div>
    </div>
    <h3 class="section-title" data-ref="listTitle" style="margin:26px 0 4px">Conteúdo do canal</h3>
    <p style="font-size:11.5px;color:var(--text-muted);margin:0 0 12px" data-ref="listNote"></p>
    <div class="artist-tabs" data-ref="tabs" role="tablist" aria-label="Filtrar conteúdo do artista">
      <button class="artist-tab active" data-tab="all" role="tab" aria-selected="true">Tudo</button>
      <button class="artist-tab" data-tab="recent" role="tab" aria-selected="false">Recente</button>
      <button class="artist-tab" data-tab="views" role="tab" aria-selected="false">Mais tocado</button>
    </div>
    <div data-ref="videos"></div>
  `;
  artistPageEl.querySelectorAll('[data-ref]').forEach(el => { artistRefs[el.dataset.ref] = el; });
  // Listeners permanentes (uma unica vez, nunca re-vinculados)
  artistRefs.avatar.addEventListener('error', () => { artistRefs.avatar.style.display = 'none'; });
  artistRefs.playAll.addEventListener('click', () => {
    // Toca respeitando a aba ativa (ordem exibida): "Tocar tudo" segue o
    // que o usuario esta vendo — Tudo, Recente ou Mais tocado.
    const v = (artistDisplayedVideos && artistDisplayedVideos.length)
      ? artistDisplayedVideos
      : (currentArtistProfile && currentArtistProfile.videos);
    if (v && v.length) playYouTubeResult(v[0], v);
  });
  // Abas Tudo / Recente / Mais tocado (delegacao, vinculada uma unica vez)
  artistRefs.tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.artist-tab');
    if (!btn || btn.classList.contains('active')) return;
    setArtistTab(btn.dataset.tab);
  });
  artistRefs.followBtn.addEventListener('click', () => {
    const p = currentArtistProfile;
    if (!p || !p.name) return;
    if (Follows.isFollowing(p.name)) {
      Follows.unfollow(p.name);
      showToast('Você deixou de seguir ' + p.name + '.');
    } else {
      Follows.follow(p.name, p.avatar || null);
      showToast('Seguindo ' + p.name + '! O perfil aparece na seção "Seguindo" do Início.');
    }
    updateArtistFollowBtn();
    // Reflete na hora caso a Home esteja montada (a funcao ignora se nao houver)
    if (typeof renderHomeFollows === 'function') renderHomeFollows();
  });
  return artistPageEl;
}

// Estado visual do botao Seguir conforme o perfil atual
function updateArtistFollowBtn() {
  if (!artistRefs.followBtn) return;
  const p = currentArtistProfile;
  const on = !!(p && p.name && Follows.isFollowing(p.name));
  artistRefs.followBtn.classList.toggle('following', on);
  artistRefs.followBtn.setAttribute('aria-pressed', String(on));
  const lab = artistRefs.followBtn.querySelector('span');
  if (lab) lab.textContent = on ? 'Seguindo' : 'Seguir';
  artistRefs.followBtn.title = on ? 'Deixar de seguir este artista' : 'Seguir este artista';
}

// Anexa a estrutura (se ainda nao estiver no main) e entra em modo skeleton
function showArtistSkeleton(name) {
  ensureArtistPage();
  if (!artistPageEl.isConnected) main.replaceChildren(artistPageEl);
  main.scrollTop = 0;
  artistPageEl.classList.add('loading');
  artistRefs.hero.style.backgroundImage = '';
  artistRefs.avatar.style.display = 'none';
  artistRefs.avatar.removeAttribute('src');
  artistRefs.name.textContent = name;          // o nome ja e conhecido: aparece na hora
  artistRefs.meta.textContent = 'Carregando canal\u2026';
  artistRefs.desc.style.display = 'none';
  artistRefs.desc.textContent = '';
  artistRefs.playAll.disabled = true;
  artistRefs.followBtn.disabled = true;
  artistRefs.listTitle.textContent = 'Conteúdo do canal';
  artistRefs.listNote.textContent = '';
  // Abas voltam a "Tudo" no carregamento (sem renderizar: o perfil anterior
  // ainda pode estar em memoria; renderArtistView chama setArtistTab depois)
  artistActiveTab = 'all';
  artistDisplayedVideos = [];
  if (artistRefs.tabs) {
    artistRefs.tabs.querySelectorAll('.artist-tab').forEach(b => {
      const on = b.dataset.tab === 'all';
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    });
  }
  // Linhas fantasma no lugar da lista (shimmer)
  artistRefs.videos.innerHTML = '<div class="track-skel"></div>'.repeat(6);
}

async function openArtistProfile(name) {
  const q = (name || '').trim();
  if (!q) return;
  state.prevView = state.view;
  state.view = 'artist';
  document.querySelectorAll('.nav-btn[data-view]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === 'search');
  });

  // Estrutura visivel imediatamente, com o nome preenchido
  showArtistSkeleton(q);

  let profile = artistProfileCache.get(q.toLowerCase());
  if (!profile) {
    profile = await fetchArtistProfile(q);
    // So fixa em cache o perfil completo do canal; o perfil de fallback
    // (montado da busca) fica fora para uma proxima visita tentar de novo
    if (profile && !profile.fromSearch) artistProfileCache.set(q.toLowerCase(), profile);
  }
  if (state.view !== 'artist') return; // usuario navegou enquanto carregava

  if (!profile || !(profile.videos || []).length) {
    artistPageEl.classList.remove('loading');
    artistRefs.meta.textContent = 'Canal indisponível no momento';
    artistRefs.videos.innerHTML = '<div class="empty-state"><p>Não foi possível montar o perfil de "' + escapeHtml(q) + '" agora. Tente novamente mais tarde.</p></div>';
    return;
  }
  currentArtistProfile = profile;
  renderArtistView();
}

// Preenche os campos da estrutura pre-existente com o perfil atual
function renderArtistView() {
  const p = currentArtistProfile;
  if (!p) { setView('search'); return; }
  ensureArtistPage();
  if (!artistPageEl.isConnected) { main.replaceChildren(artistPageEl); main.scrollTop = 0; }
  artistPageEl.classList.remove('loading');

  const videos = p.videos || [];

  artistRefs.hero.style.backgroundImage = p.banner
    ? "linear-gradient(rgba(10,10,10,0.55),rgba(10,10,10,0.94)),url('" + p.banner + "')"
    : '';
  if (p.avatar) {
    artistRefs.avatar.src = p.avatar;
    artistRefs.avatar.style.display = '';
  } else {
    artistRefs.avatar.style.display = 'none';
  }
  artistRefs.name.textContent = p.name;
  artistRefs.meta.textContent = [
    p.subs ? fmtCompact(p.subs) + ' inscritos' : null,
    videos.length + (p.fromSearch ? ' faixas encontradas' : ' vídeos do canal'),
  ].filter(Boolean).join(' \u00B7 ');
  if (p.description) {
    artistRefs.desc.textContent = p.description.slice(0, 280) + (p.description.length > 280 ? '\u2026' : '');
    artistRefs.desc.style.display = '';
  } else {
    artistRefs.desc.style.display = 'none';
  }
  artistRefs.playAll.disabled = !videos.length;
  artistRefs.followBtn.disabled = false;
  // Se o usuario ja segue este artista, aproveita a visita para
  // completar/atualizar a foto do perfil persistida
  Follows.updateAvatar(p.name, p.avatar || null);
  updateArtistFollowBtn();
  artistRefs.listTitle.textContent = p.fromSearch ? 'Conteúdo do artista' : 'Conteúdo do canal';
  // Reinicia as abas em "Tudo" a cada perfil aberto; setArtistTab cuida da
  // nota e de renderizar a lista ja ordenada pela aba.
  setArtistTab('all');
}

// Ordena uma copia dos videos do artista conforme a aba:
//   'all'    -> ordem padrao (como o perfil veio: mais reproduzidos primeiro)
//   'recent' -> mais recentes primeiro (timestamp `published`; sem data ao fim)
//   'views'  -> mais reproduzidos primeiro (views). Empates preservam a ordem.
function sortArtistVideos(videos, tab) {
  const list = (videos || []).slice();
  if (tab === 'recent') {
    return list
      .map((it, i) => ({ it, i }))
      .sort((a, b) => ((b.it.published || 0) - (a.it.published || 0)) || (a.i - b.i))
      .map(x => x.it);
  }
  if (tab === 'views') {
    return list
      .map((it, i) => ({ it, i }))
      .sort((a, b) => ((b.it.views || 0) - (a.it.views || 0)) || (a.i - b.i))
      .map(x => x.it);
  }
  return list; // 'all'
}

// Texto de apoio sob o titulo, conforme a aba ativa
function artistTabNote(tab, fromSearch) {
  if (tab === 'recent') {
    return fromSearch
      ? 'Conteúdo do artista encontrado na busca, do mais recente para o mais antigo.'
      : 'Do mais recente para o mais antigo (data de publicação).';
  }
  if (tab === 'views') {
    return fromSearch
      ? 'Conteúdo do artista encontrado na busca, do mais reproduzido para o menos.'
      : 'Do mais reproduzido para o menos (acurácia por reproduções).';
  }
  return fromSearch
    ? 'O canal do artista está temporariamente inacessível; exibindo todo o conteúdo dele encontrado na busca.'
    : 'Todo o conteúdo do canal, do mais reproduzido para o menos.';
}

// Ativa uma aba, sincroniza o visual dos botoes e re-renderiza a lista
function setArtistTab(tab) {
  artistActiveTab = tab;
  if (artistRefs.tabs) {
    artistRefs.tabs.querySelectorAll('.artist-tab').forEach(b => {
      const on = b.dataset.tab === tab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    });
  }
  renderArtistVideos();
}

// Ordena pela aba ativa, atualiza a nota e desenha a lista de videos.
// Guarda a ordem exibida para o "Tocar tudo" seguir a mesma sequencia.
function renderArtistVideos() {
  const p = currentArtistProfile;
  if (!p || !artistRefs.videos) return;
  artistDisplayedVideos = sortArtistVideos(p.videos || [], artistActiveTab);
  if (artistRefs.listNote) {
    artistRefs.listNote.textContent = artistTabNote(artistActiveTab, p.fromSearch);
  }
  renderYtSearchResults(artistRefs.videos, artistDisplayedVideos);
}

// ============================================
// TENDENCIAS — O MAIS VISTO DENTRO DOS GOSTOS DO USUARIO
// Conceito: em vez de so o trending generico, as "Tendencias" refletem
// o que esta em alta DENTRO dos gostos do usuario. Duas camadas:
//   1. PESSOAL (primaria): queries derivadas dos gostos (Tastes) e dos
//      artistas mais tocados (PlayStats), combinadas, deduplicadas por
//      videoId (aparicoes em varias buscas corroboram) e ordenadas por
//      views — o mais visto primeiro.
//   2. GERAL (fallback): trending de musica das ultimas 24h dos
//      endpoints publicos — quando o usuario ainda nao tem gostos ou as
//      buscas pessoais nao retornam nada.
// Cache de 30 min para acompanhar o dia sem martelar as instancias.
// ============================================
const TRENDING_CACHE_KEY = 'vibefm_trending_cache';
const TRENDING_TTL = 30 * 60 * 1000; // 30 min
const TRENDING_REGION = 'BR';

// Camada pessoal: o mais visto no YouTube dentro dos gostos do usuario
async function fetchTasteTrending() {
  const year = new Date().getFullYear();
  const queries = [];
  // Teto de queries: o conceito aplicado sem sobrecarregar as instancias
  // (ate 4 gostos x 2 formas + 4 artistas mais tocados = max 12 buscas)
  (typeof Tastes !== 'undefined' ? Tastes.load() : []).slice(0, 4).forEach(g => {
    queries.push(g + ' music ' + year);
    queries.push(g + ' hits ' + year);
  });
  if (typeof PlayStats !== 'undefined') {
    PlayStats.top(4).forEach(e => {
      if (e.artist) queries.push(e.artist + ' ' + year);
    });
  }
  const uniq = [...new Set(queries.map(q => q.trim()).filter(Boolean))];
  if (!uniq.length) return [];

  // Buscas com concorrencia limitada (max 3 simultaneas)
  const allResults = [];
  for (let i = 0; i < uniq.length; i += 3) {
    const batch = uniq.slice(i, i + 3);
    const results = await Promise.all(batch.map(q => searchYouTube(q).catch(() => [])));
    results.forEach(list => allResults.push(...(list || [])));
  }

  // Deduplica por videoId; aparicoes em varias buscas corroboram o item
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

  // Acuracia: mais vistos primeiro; top 16 para preencher o carrossel
  return rankByPlays([...byId.values()]).slice(0, 16);
}

async function fetchTrendingMusic() {
  try {
    const c = JSON.parse(localStorage.getItem(TRENDING_CACHE_KEY) || 'null');
    if (c && Date.now() - c.at < TRENDING_TTL && Array.isArray(c.items) && c.items.length) {
      return c.items;
    }
  } catch (_) {}

  // 1) Camada pessoal (gostos + artistas mais tocados)
  try {
    const personal = await fetchTasteTrending();
    if (personal.length) {
      try { localStorage.setItem(TRENDING_CACHE_KEY, JSON.stringify({ at: Date.now(), items: personal })); } catch (_) {}
      return personal;
    }
  } catch (_) { /* cai para a camada geral */ }

  // 2) Camada geral: trending de musica das ultimas 24h.
  // Invidious primeiro: tem a categoria "music" nativa no trending
  const sources = [...YT_SEARCH_SOURCES]
    .sort((a, b) => (a.kind === 'invidious' ? 0 : 1) - (b.kind === 'invidious' ? 0 : 1));

  for (const src of sources) {
    try {
      const url = src.kind === 'piped'
        ? src.base + '/trending?region=' + TRENDING_REGION
        : src.base + '/api/v1/trending?type=music&region=' + TRENDING_REGION;
      const res = await fetchWithTimeout(url, 4500);
      if (!res.ok) continue;
      const data = await res.json();
      let raw;
      if (src.kind === 'piped') {
        // Trending geral: mantem apenas duracoes tipicas de musica (1–12 min)
        const arr = Array.isArray(data) ? data : (data && data.items) || [];
        raw = normalizePiped(arr).filter(it => it.duration >= 60 && it.duration <= 720);
      } else {
        // Algumas versoes do Invidious omitem "type" no trending
        const arr = (Array.isArray(data) ? data : []).map(it => ({ ...it, type: it.type || 'video' }));
        raw = normalizeInvidious(arr);
      }
      const items = AdShield.filter(raw);
      if (items.length) {
        const top = rankByPlays(items).slice(0, 16);
        try { localStorage.setItem(TRENDING_CACHE_KEY, JSON.stringify({ at: Date.now(), items: top })); } catch (_) {}
        return top;
      }
    } catch (_) { /* tenta a proxima instancia */ }
  }
  return [];
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
// PERFIL DO USUARIO (personalizacao)
// Nome de exibicao editavel na pagina Perfil.
// Persistido em 'vibefm_profile' — apenas apresentacao,
// nao participa de nenhuma logica de negocio.
// ============================================
const UserProfile = (function () {
  const STORAGE_KEY = 'vibefm_profile';
  const DEFAULT_NAME = 'Ouvinte';

  function load() {
    try {
      const p = JSON.parse(localStorage.getItem(STORAGE_KEY));
      return (p && typeof p === 'object') ? p : {};
    } catch (_) { return {}; }
  }
  function persist(p) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(p)); } catch (_) {}
  }

  function name() {
    const n = (load().name || '').trim();
    return n || DEFAULT_NAME;
  }
  function setName(n) {
    n = String(n || '').trim().slice(0, 40);
    if (!n) return false;
    const p = load();
    p.name = n;
    persist(p);
    return true;
  }
  function initial() {
    return name().trim().charAt(0).toUpperCase() || 'O';
  }

  return { name, setName, initial, DEFAULT_NAME };
})();

// ============================================
// TAKEOUT — portabilidade de dados
// Exporta TODOS os dados do usuario salvos no localStorage
// (playlists, curtidas, links salvos, gostos, historico,
// estatisticas, caches etc.) para um arquivo .json e permite
// restaura-los em outro dispositivo via upload do arquivo.
// Nao altera nenhuma logica: apenas le/escreve as mesmas
// chaves ja usadas pelos modulos existentes.
// ============================================
const Takeout = (function () {
  // Todas as chaves da aplicacao usam estes prefixos
  const PREFIXES = ['vibefm_', 'minstream_'];

  function ownKeys() {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && PREFIXES.some(p => k.startsWith(p))) keys.push(k);
    }
    return keys.sort();
  }

  function collect() {
    const data = {};
    ownKeys().forEach(k => {
      try {
        const v = localStorage.getItem(k);
        if (v !== null) data[k] = v; // valores brutos (strings), como estao no storage
      } catch (_) {}
    });
    return data;
  }

  // Gera e entrega o arquivo minstream-takeout-AAAA-MM-DD.json.
  // No navegador, baixa via <a download>. Dentro do app (WebView do
  // Capacitor) esse caminho falha silenciosamente, entao a entrega segue
  // uma cadeia de alternativas ate uma funcionar:
  //   1. Plugins nativos do Capacitor (Filesystem/Share), se instalados;
  //   2. Web Share API com arquivo (compartilhar para Arquivos, Drive...);
  //   3. <a download> classico (navegadores);
  //   4. Copia o JSON para a area de transferencia (sempre disponivel).
  function buildPayload() {
    return {
      app: 'MinStream',
      kind: 'takeout',
      version: 1,
      exportedAt: new Date().toISOString(),
      data: collect(),
    };
  }

  function isNativeApp() {
    try {
      return !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function'
        && window.Capacitor.isNativePlatform());
    } catch (_) { return false; }
  }

  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) {}
    // Fallback legado
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (_) { return false; }
  }

  async function download() {
    const json = JSON.stringify(buildPayload(), null, 2);
    const fname = 'minstream-takeout-' + new Date().toISOString().slice(0, 10) + '.json';
    const native = isNativeApp();

    // 1) Plugins nativos do Capacitor, quando presentes no APK
    if (native && window.Capacitor.Plugins) {
      const P = window.Capacitor.Plugins;
      if (P.Filesystem && P.Filesystem.writeFile) {
        try {
          await P.Filesystem.writeFile({ path: fname, data: json, directory: 'DOCUMENTS', encoding: 'utf8' });
          if (P.Share && P.Share.share && P.Filesystem.getUri) {
            try {
              const uri = await P.Filesystem.getUri({ path: fname, directory: 'DOCUMENTS' });
              await P.Share.share({ title: fname, url: uri.uri, dialogTitle: 'Salvar takeout' });
            } catch (_) { /* usuario cancelou o share: arquivo ja esta salvo */ }
          }
          showToast('Takeout salvo em Documentos: ' + fname);
          return;
        } catch (_) { /* segue para a proxima alternativa */ }
      }
    }

    // 2) Web Share API com arquivo (abre a folha de compartilhamento)
    try {
      if (navigator.canShare && typeof File === 'function') {
        const file = new File([json], fname, { type: 'application/json' });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: fname });
          showToast('Takeout compartilhado — salve o arquivo onde preferir');
          return;
        }
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return; // usuario cancelou: nao insistir
    }

    // 3) Download classico (navegadores)
    if (!native) {
      const blob = new Blob([json], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      showToast('Takeout gerado: seus dados foram baixados em .json');
      return;
    }

    // 4) Garantia final no app: area de transferencia
    const copied = await copyToClipboard(json);
    showToast(copied
      ? 'Takeout copiado para a área de transferência — cole em um arquivo .json (Arquivos, Notas, Drive...)'
      : 'Não foi possível exportar automaticamente. Tente novamente ou use a versão no navegador.');
  }

  // ---------- Mesclagem aditiva por chave ----------
  // A importacao NUNCA sobrescreve o que ja existe no dispositivo:
  // os dados do arquivo sao SOMADOS aos locais, respeitando o formato
  // e os limites que cada modulo ja usa. Regra geral:
  //   - chave ausente localmente  -> copia o valor importado;
  //   - chave existente + merger  -> uniao/soma especifica do tipo;
  //   - chave existente sem merger -> mantem o valor local intacto.
  function parseJson(raw) {
    try { return JSON.parse(raw); } catch (_) { return undefined; }
  }
  function asArray(raw) {
    const v = parseJson(raw);
    return Array.isArray(v) ? v : null;
  }
  function asObject(raw) {
    const v = parseJson(raw);
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : null;
  }

  // Uniao de arrays: itens locais primeiro, importados inexistentes depois.
  // keyFn define a identidade de cada item; cap limita o total (0 = sem limite).
  function unionArrays(localRaw, importedRaw, keyFn, cap) {
    const loc = asArray(localRaw), imp = asArray(importedRaw);
    if (!loc || !imp) return null; // formato inesperado -> mantem o local
    const seen = new Set(loc.map(keyFn));
    const out = loc.slice();
    let added = 0;
    imp.forEach(it => {
      const k = keyFn(it);
      if (seen.has(k)) return;
      seen.add(k);
      out.push(it);
      added++;
    });
    if (!added) return null;
    return JSON.stringify(cap ? out.slice(0, cap) : out);
  }

  // Objeto: adiciona apenas as chaves que faltam (o local sempre vence).
  function mergeObjectAddMissing(localRaw, importedRaw) {
    const loc = asObject(localRaw), imp = asObject(importedRaw);
    if (!loc || !imp) return null;
    let added = 0;
    Object.keys(imp).forEach(k => {
      if (!(k in loc)) { loc[k] = imp[k]; added++; }
    });
    return added ? JSON.stringify(loc) : null;
  }

  // Playlists do usuario: playlists novas entram; nas de mesmo ID as
  // faixas que faltam sao acrescentadas ao final (dedupe pela mesma
  // chave 'l:<trackId>' / 'y:<videoId>' usada pelo UserPlaylists).
  function itemKeyOf(it) {
    return it && it.type === 'local' ? 'l:' + it.trackId : 'y:' + (it && it.videoId);
  }
  function mergeUserPlaylists(localRaw, importedRaw) {
    const loc = asArray(localRaw), imp = asArray(importedRaw);
    if (!loc || !imp) return null;
    const byId = new Map(loc.map(p => [p && p.id, p]));
    let changed = false;
    imp.forEach(p => {
      if (!p || !p.name || !Array.isArray(p.items)) return;
      const existing = byId.get(p.id);
      if (!existing) {
        loc.push({
          id: p.id || ('u' + Math.random().toString(36).slice(2)),
          name: String(p.name).slice(0, 60),
          createdAt: p.createdAt || Date.now(),
          items: p.items.filter(Boolean),
        });
        changed = true;
        return;
      }
      const keys = new Set((existing.items || []).map(itemKeyOf));
      p.items.forEach(it => {
        if (!it) return;
        const k = itemKeyOf(it);
        if (keys.has(k)) return;
        keys.add(k);
        existing.items.push(it);
        changed = true;
      });
    });
    return changed ? JSON.stringify(loc) : null;
  }

  // Historico de reproducao: uniao por (trackId, instante), ordenado do
  // mais recente para o mais antigo, com o mesmo teto de 100 eventos.
  function mergeHistory(localRaw, importedRaw) {
    const merged = unionArrays(localRaw, importedRaw,
      h => (h && h.trackId) + '|' + (h && h.at), 0);
    if (merged === null) return null;
    const arr = JSON.parse(merged);
    arr.sort((a, b) => (b.at || 0) - (a.at || 0));
    return JSON.stringify(arr.slice(0, 100));
  }

  // Contagem de reproducoes: as reproducoes dos dois dispositivos sao
  // SOMADAS por faixa; metadados locais vencem, faltantes vem do arquivo.
  // Poda com o mesmo criterio/limite (600) do modulo PlayStats.
  function mergePlayStats(localRaw, importedRaw) {
    const loc = asObject(localRaw), imp = asObject(importedRaw);
    if (!loc || !imp) return null;
    let changed = false;
    Object.entries(imp).forEach(([id, e]) => {
      if (!e || typeof e !== 'object') return;
      const cur = loc[id];
      if (!cur) { loc[id] = e; changed = true; return; }
      loc[id] = {
        plays: (cur.plays || 0) + (e.plays || 0),
        title: cur.title || e.title || '',
        artist: cur.artist || e.artist || '',
        videoId: cur.videoId || e.videoId || '',
        last: Math.max(cur.last || 0, e.last || 0),
      };
      changed = true;
    });
    if (!changed) return null;
    const keys = Object.keys(loc);
    if (keys.length > 600) {
      keys.sort((a, b) => (loc[a].plays - loc[b].plays) || (loc[a].last - loc[b].last));
      keys.slice(0, keys.length - 600).forEach(k => delete loc[k]);
    }
    return JSON.stringify(loc);
  }

  // Contadores simples: soma dos dois lados.
  function sumCounter(localRaw, importedRaw) {
    const a = parseInt(localRaw, 10), b = parseInt(importedRaw, 10);
    if (isNaN(a) || isNaN(b) || b <= 0) return null;
    return String(a + b);
  }

  // Estrategia de mesclagem por chave (chaves fora desta lista que ja
  // existirem localmente sao simplesmente mantidas — nunca sobrescritas).
  const MERGERS = {
    'vibefm_user_playlists': mergeUserPlaylists,
    'vibefm_liked': (l, i) => unionArrays(l, i, x => String(x), 0),
    'vibefm_liked_meta': mergeObjectAddMissing,
    'vibefm_history': mergeHistory,
    'vibefm_tastes': (l, i) => unionArrays(l, i, x => String(x).trim().toLowerCase(), 0),
    'vibefm_play_stats': mergePlayStats,
    'vibefm_gallery': (l, i) => unionArrays(l, i, it => ((it && it.id) || '') + '|' + ((it && it.list) || ''), 60),
    'vibefm_gallery_pinned': (l, i) => unionArrays(l, i, x => String(x), 0),
    'vibefm_gallery_home_hidden': (l, i) => unionArrays(l, i, x => String(x), 0),
    'minstream_follows': (l, i) => unionArrays(l, i, f => String((f && f.name) || '').trim().toLowerCase(), 100),
    'minstream_search_history': (l, i) => unionArrays(l, i, x => String(x).toLowerCase(), 5),
    'vibefm_adshield_stats': sumCounter,
    'vibefm_profile': mergeObjectAddMissing,
  };

  // Restaura um arquivo de takeout de forma ADITIVA: soma os dados do
  // arquivo aos ja existentes (sem sobrescrever nada) e recarrega a
  // pagina para que todos os modulos re-hidratem o estado pelos
  // caminhos normais de boot (sem tocar na logica).
  function restore(file, onFail) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const payload = JSON.parse(reader.result);
        const data = (payload && payload.kind === 'takeout' && payload.data && typeof payload.data === 'object')
          ? payload.data : null;
        if (!data) throw new Error('formato');
        const keys = Object.keys(data).filter(k =>
          typeof data[k] === 'string' && PREFIXES.some(p => k.startsWith(p)));
        if (!keys.length) throw new Error('vazio');
        let added = 0, mergedCount = 0, kept = 0;
        keys.forEach(k => {
          let localRaw = null;
          try { localRaw = localStorage.getItem(k); } catch (_) {}
          try {
            if (localRaw === null) {
              // Nao existe aqui: entra como novo
              localStorage.setItem(k, data[k]);
              added++;
            } else if (MERGERS[k]) {
              // Existe: soma/uniao especifica do tipo (local nunca e perdido)
              const merged = MERGERS[k](localRaw, data[k]);
              if (merged !== null && merged !== localRaw) {
                localStorage.setItem(k, merged);
                mergedCount++;
              } else {
                kept++;
              }
            } else {
              // Existe e nao ha estrategia: mantem o local intacto
              kept++;
            }
          } catch (_) { kept++; }
        });
        if (!added && !mergedCount) {
          showToast('Nada novo para adicionar: seus dados já contêm tudo do arquivo');
          return;
        }
        showToast('Dados somados aos existentes (' + (added + mergedCount) + ' registro(s) atualizados). Recarregando…');
        setTimeout(() => location.reload(), 900);
      } catch (_) {
        showToast('Arquivo de takeout inválido');
        if (onFail) onFail();
      }
    };
    reader.onerror = () => {
      showToast('Não foi possível ler o arquivo');
      if (onFail) onFail();
    };
    reader.readAsText(file);
  }

  return { download, restore, count: () => ownKeys().length };
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
// mode define o que o botao do canto faz:
//   undefined      -> 'Remover' (exclui o link de vez; usado na Biblioteca)
//   'hideFromHome' -> 'Ocultar da Home' (usado no carrossel do Inicio)
//   'restoreToHome'-> 'Restaurar na Home' (usado na lista "Ocultos da Home")
// IMPORTANTE: a acao do botao e decidida AQUI. Trocar o handler por fora
// (elemento.onclick) nao substitui este listener — os dois disparariam, e o
// link acabava removido do armazenamento ao ser restaurado.
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
    img.loading = 'lazy'; img.decoding = 'async';
    coverWrap.appendChild(img);
  } else if (item.cover) {
    // Capa de playlist ja conhecida (persistida no item)
    const img = document.createElement('img');
    img.src = item.cover;
    img.alt = '';
    img.loading = 'lazy'; img.decoding = 'async';
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
  del.className = 'gallery-del'; // o visual verde vem de #gallery-hidden-grid
  del.title = mode === 'hideFromHome' ? 'Ocultar da Home'
    : mode === 'restoreToHome' ? 'Restaurar na Home'
    : 'Remover';
  del.innerHTML = mode === 'restoreToHome'
    ? '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    : '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18" stroke-linecap="round"/><line x1="6" y1="6" x2="18" y2="18" stroke-linecap="round"/></svg>';
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    if (mode === 'hideFromHome') {
      Gallery.hideFromHome(key);
      showToast('Oculto da Home. Acesse "Links Salvos" na Biblioteca para ver todos.');
    } else if (mode === 'restoreToHome') {
      // Apenas volta a aparecer no Inicio — o link continua salvo.
      Gallery.unhideFromHome(key);
      showToast('Restaurado na Home!');
      renderHomeSaved(); // se o carrossel do Inicio existir, repovoa
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
  sub.textContent = isPlaylist ? 'Playlist \u00B7 YouTube' : 'youtu.be/' + item.id;
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

  // Playlists: completa nome e capa via metadados (persistidos no item,
  // entao nas proximas renderizacoes aparecem imediatamente)
  if (item.list && (!item.title || (!item.id && !item.cover))) {
    fetchPlaylistMeta(item.list).then(meta => {
      if (!meta) return;
      if (meta.title && !item.title) {
        titleEl.textContent = meta.title;
        Gallery.updateTitle(key, meta.title);
      }
      if (meta.cover && !item.id && !item.cover) {
        const img = document.createElement('img');
        img.src = meta.cover;
        img.alt = '';
        img.loading = 'lazy'; img.decoding = 'async';
        const ph = coverWrap.querySelector('.gallery-thumb-list');
        if (ph) ph.replaceWith(img);
        Gallery.updateCover(key, meta.cover);
      }
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
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:20px">Vídeos e playlists guardados para ouvir quando quiser. Fixe os favoritos para mantê-los no topo.</p>
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
      // O modo 'restoreToHome' ja monta o botao certo (e so ele) — restaurar
      // devolve o item a Home sem tirar nada dos links salvos.
      const card = createGalleryCard(item, renderSaved, 'restoreToHome');
      // Adicionar badge de "Oculto da Home" no card
      const badge = document.createElement('div');
      badge.style.cssText = 'position:absolute;top:6px;left:50%;transform:translateX(-50%);z-index:5;padding:2px 8px;font-size:9px;font-weight:700;letter-spacing:0.06em;color:#fff;background:rgba(10,228,72,0.85);border-radius:4px;pointer-events:none;';
      badge.textContent = 'OCULTO DA HOME';
      card.querySelector('.album-cover-wrap').appendChild(badge);
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
    case 'artist': currentArtistProfile ? renderArtistView() : renderSearch(); break;
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

// ============================================
// SECAO "SEGUINDO" DO INICIO
// Carrossel de artistas seguidos no topo da Home: cada item e um circulo
// com a foto do perfil e o nome embaixo; clicar abre o perfil. A secao
// fica oculta enquanto nao houver ninguem seguido. Usa as setas do
// carrossel padrao (attachCarouselArrows) via o prefixo 'home-follows'.
// ============================================
function renderHomeFollows() {
  const section = document.getElementById('home-follows-section');
  const track = document.getElementById('home-follows-carousel');
  if (!section || !track) return;
  const follows = Follows.load();
  if (!follows.length) { section.style.display = 'none'; return; }
  section.style.display = '';
  track.replaceChildren();
  follows.forEach(f => {
    if (!f || !f.name) return;
    const chip = document.createElement('button');
    chip.className = 'follow-chip';
    chip.title = 'Abrir o perfil de ' + f.name;
    const av = document.createElement('div');
    av.className = 'follow-avatar';
    const showInitial = () => { av.textContent = (f.name.trim().charAt(0) || '?').toUpperCase(); };
    if (f.avatar) {
      const img = document.createElement('img');
      img.src = f.avatar;
      img.alt = '';
      img.loading = 'lazy'; img.decoding = 'async';
      img.addEventListener('error', () => { img.remove(); showInitial(); });
      av.appendChild(img);
    } else {
      showInitial();
    }
    const nm = document.createElement('div');
    nm.className = 'follow-name';
    nm.textContent = f.name;
    chip.appendChild(av);
    chip.appendChild(nm);
    chip.addEventListener('click', () => openArtistProfile(f.name));
    track.appendChild(chip);
  });
}

function renderHome() {
  const userPls = UserPlaylists.load();
  const tastes = Tastes.load();

  main.innerHTML = `
    <div class="section" id="home-follows-section" style="display:none">
      <div class="section-header pl-home-header">
        <h2 class="section-title">Seguindo</h2>
      </div>
      <div class="pl-carousel-wrap follow-carousel-wrap" id="home-follows-wrap">
        <button class="pl-carousel-arrow pl-carousel-prev" id="home-follows-prev" title="Anterior">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <div class="pl-carousel-track follow-carousel-track" id="home-follows-carousel"></div>
        <button class="pl-carousel-arrow pl-carousel-next" id="home-follows-next" title="Próximo">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
    </div>
    <div class="section">
      <div class="section-header pl-home-header">
        <h2 class="section-title">Suas Playlists</h2>
        <div class="pl-home-actions">
          <button class="pl-action-btn" id="btn-pl-menu" title="Opções de playlists">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>
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
      <div class="pl-carousel-wrap" id="home-saved-wrap">
        <button class="pl-carousel-arrow pl-carousel-prev" id="home-saved-prev" title="Anterior"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <div class="pl-carousel-track" id="home-saved-carousel"></div>
        <button class="pl-carousel-arrow pl-carousel-next" id="home-saved-next" title="Próximo"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      </div>
    </div>
    <div class="section" id="reco-news-section" style="display:none">
      <h2 class="section-title" style="margin-bottom:14px">Novidades para Você</h2>
      <div class="pl-carousel-wrap" id="reco-news-wrap">
        <button class="pl-carousel-arrow pl-carousel-prev" id="reco-news-prev" title="Anterior"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <div class="pl-carousel-track" id="reco-news-carousel"></div>
        <button class="pl-carousel-arrow pl-carousel-next" id="reco-news-next" title="Próximo"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      </div>
    </div>
  `;

  // Secao "Seguindo" no topo (carrossel de artistas seguidos)
  renderHomeFollows();
  attachCarouselArrows('home-follows');

  // Renderiza playlists do usuario como cards no carrossel
  const userCarousel = document.getElementById('home-user-pl-carousel');
  if (userCarousel) {
    // Ordem em "Suas Playlists": Recentes primeiro, depois Curtidas e, por
    // fim, as demais playlists do usuario.
    // Pasta "Recentes": aparece so quando ja houve reproducao
    const recentFolder = createRecentFolderCard();
    if (recentFolder) userCarousel.appendChild(recentFolder);
    // "Curtidas" (playlist virtual dos likes) logo em seguida
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

  // Menu "..." de "Suas Playlists": concentra Nova, Exportar e Importar
  const fileInput = document.getElementById('import-pls-file');
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files[0]) {
      UserPlaylists.importJson(fileInput.files[0], () => { renderHome(); renderSidebarPlaylists(); });
    }
  });
  document.getElementById('btn-pl-menu').addEventListener('click', () => {
    openTrackMenu('Suas Playlists', [
      {
        label: 'Nova playlist',
        icon: MENU_ICON_ADD,
        onClick: () => {
          const name = prompt('Nome da nova playlist:');
          if (name && name.trim()) {
            UserPlaylists.create(name);
            renderHome();
            renderSidebarPlaylists();
          }
        },
      },
      {
        label: 'Exportar playlists (JSON)',
        icon: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" stroke-linecap="round"/><polyline points="7 10 12 15 17 10" stroke-linecap="round" stroke-linejoin="round"/><line x1="12" y1="15" x2="12" y2="3" stroke-linecap="round"/></svg>',
        onClick: () => UserPlaylists.exportJson(),
      },
      {
        label: 'Importar playlists (JSON)',
        icon: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" stroke-linecap="round"/><polyline points="17 8 12 3 7 8" stroke-linecap="round" stroke-linejoin="round"/><line x1="12" y1="3" x2="12" y2="15" stroke-linecap="round"/></svg>',
        onClick: () => fileInput.click(),
      },
    ]);
  });
  document.getElementById('btn-edit-tastes').addEventListener('click', () => setView('profile'));

  // Secao "Links Salvos" da Home (com fixar)
  renderHomeSaved();
  attachCarouselArrows('home-saved');
  const seeSavedBtn = document.getElementById('btn-see-saved');
  if (seeSavedBtn) seeSavedBtn.addEventListener('click', () => setView('saved'));

  // Recomendacoes inteligentes: mixes diversos + novidades (assincrono)
  if (typeof Reco !== 'undefined') {
    Reco.renderMixes('reco-mix-carousel');
    Reco.renderNews('reco-news-carousel', 'reco-news-section');
    const refreshBtn = document.getElementById('btn-refresh-reco');
    if (refreshBtn) refreshBtn.addEventListener('click', () => {
      refreshBtn.disabled = true;
      Reco.refreshAll('reco-mix-carousel', 'reco-news-carousel', 'reco-news-section')
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

// Card "Recentes" em "Suas Playlists" (Home): funciona como uma pasta
// expandida, com uma grade 2x2 das capas dos ultimos 4 videos distintos
// reproduzidos. Sem nada reproduzido, a pasta nao aparece (retorna null).
// Clique -> abre a secao "Recentes" da Biblioteca.
function createRecentFolderCard() {
  // Ultimas reproducoes distintas (por faixa), mais recentes primeiro
  const seen = new Set();
  const lastPlays = [];
  for (const h of state.history) {
    const k = h.videoId || h.trackId;
    if (!k || seen.has(k)) continue;
    seen.add(k);
    lastPlays.push(h);
    if (lastPlays.length === 4) break;
  }
  if (!lastPlays.length) return null; // nada reproduzido: pasta oculta

  const card = document.createElement('div');
  card.className = 'album-card recent-folder-card';
  card.title = 'Abrir Recentes na Biblioteca';

  const coverWrap = document.createElement('div');
  coverWrap.className = 'album-cover-wrap';

  const grid = document.createElement('div');
  grid.className = 'folder-cover-grid';
  for (let i = 0; i < 4; i++) {
    const cell = document.createElement('div');
    cell.className = 'folder-cover-cell';
    const h = lastPlays[i];
    if (h) {
      const t = getTrack(h.trackId);
      const src = h.videoId
        ? 'https://i.ytimg.com/vi/' + h.videoId + '/mqdefault.jpg'
        : (t && t.cover) || '';
      if (src) {
        const img = document.createElement('img');
        img.src = src;
        img.alt = '';
        img.loading = 'lazy'; img.decoding = 'async';
        cell.appendChild(img);
      }
    }
    grid.appendChild(cell);
  }
  coverWrap.appendChild(grid);

  // Selo de pasta no canto (indica que abre uma secao, nao toca direto)
  const badge = document.createElement('span');
  badge.className = 'folder-badge';
  badge.innerHTML = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" stroke-linejoin="round"/></svg>';
  coverWrap.appendChild(badge);

  const info = document.createElement('div');
  info.className = 'album-info';
  const titleEl = document.createElement('div');
  titleEl.className = 'album-title';
  titleEl.textContent = 'Recentes';
  const sub = document.createElement('div');
  sub.className = 'album-artist';
  sub.textContent = state.history.length + ' tocada(s) \u00B7 pasta';
  info.appendChild(titleEl);
  info.appendChild(sub);

  card.appendChild(coverWrap);
  card.appendChild(info);
  card.addEventListener('click', () => setView('recent'));
  return card;
}

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
    img.loading = 'lazy'; img.decoding = 'async';
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
    if (cfg.tracks.length) playTrack(cfg.tracks[0], cfg.tracks, cfg.name);
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
    if (cfg.tracks.length) playTrack(cfg.tracks[0], cfg.tracks, cfg.name);
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
        <h3 class="section-title" style="margin-bottom:14px">Explorar seus Gostos</h3>
        ${buildCarousel('search-genres', 'search-genres-carousel')}
        <div id="search-trending" style="margin-top:32px">
          <h3 class="section-title" style="margin-bottom:4px">Tendências</h3>
          <p style="font-size:11.5px;color:var(--text-muted);margin:0 0 14px">O mais reproduzido dentro dos seus gostos.</p>
          ${buildCarousel('search-trending', 'search-trending-carousel')}
        </div>
      </div>
      <div id="tiles-container"></div>
    </div>
  `;

  // Cards de genero no carrossel (clique -> busca pelo gosto)
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

  // Secao Tiles: shorts verticais do YouTube relacionados aos gostos
  renderTilesSection(document.getElementById('tiles-container'));
}

// Preenche a secao "Tendencias" da pagina de busca como um carrossel de
// cards (mesmo estilo dos cards da Home): capa 16:9, play no hover,
// titulo e "artista · reproducoes". Clique toca com a lista como fila.
async function loadTrendingSection() {
  if (!document.getElementById('search-trending-carousel')) return;
  const items = await fetchTrendingMusic();
  const carousel = document.getElementById('search-trending-carousel');
  if (!carousel) return; // usuario trocou de view enquanto carregava
  carousel.replaceChildren();
  if (!items.length) {
    const p = document.createElement('p');
    p.className = 'yt-search-status';
    p.textContent = 'Tendências indisponíveis no momento. Tente novamente mais tarde.';
    carousel.appendChild(p);
    return;
  }
  items.forEach(r => {
    const card = document.createElement('div');
    card.className = 'album-card';

    const wrap = document.createElement('div');
    wrap.className = 'album-cover-wrap';
    const img = document.createElement('img');
    img.src = 'https://i.ytimg.com/vi/' + r.videoId + '/mqdefault.jpg';
    img.alt = '';
    img.loading = 'lazy'; img.decoding = 'async';
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
    artist.className = 'album-artist artist-link';
    artist.textContent = (r.author || '') + (r.views ? ' \u00B7 ' + fmtViews(r.views) : '');
    if (r.author) {
      artist.title = 'Ver perfil de ' + r.author;
      artist.addEventListener('click', (e) => { e.stopPropagation(); openArtistProfile(r.author); });
    }
    info.appendChild(title);
    info.appendChild(artist);

    card.appendChild(wrap);
    card.appendChild(info);

    overlay.querySelector('.album-play-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      playYouTubeResult(r, items);
    });
    card.addEventListener('click', (e) => {
      if (e.target.closest('.album-play-btn') || e.target.closest('.artist-link')) return;
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
      // Tiles volta ao conteudo baseado nos gostos do usuario
      renderTilesSection(document.getElementById('tiles-container'), '');
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

      // Playlists: mostra o nome e a capa reais no preview e aquece o
      // cache de metadados, para o Salvar ja persistir tudo com o item
      if (playlistId) {
        fetchPlaylistMeta(playlistId).then(meta => {
          if (!meta || videoId) return; // com video, o oEmbed acima prevalece
          if (meta.title) {
            const metaEl = document.getElementById('url-meta');
            if (metaEl) metaEl.innerHTML = `<strong>${escapeHtml(meta.title)}</strong><br><span style="color:var(--text-secondary)">Playlist do YouTube</span>`;
          }
          if (meta.cover) {
            const img = document.getElementById('url-preview-img');
            if (img) img.src = meta.cover;
          }
        });
      }

      document.getElementById('url-play-btn').addEventListener('click', () => {
        playFromUrl(raw);
      });

      document.getElementById('url-save-btn').addEventListener('click', () => {
        // Salva ja com nome e capa quando os metadados estao em cache
        const cachedMeta = playlistId ? playlistMetaCache.get(playlistId) : null;
        const ok = Gallery.save({
          id: videoId,
          list: playlistId,
          title: videoId
            ? (titleCache.get(videoId) || null)
            : ((cachedMeta && cachedMeta.title) || null),
          cover: (!videoId && cachedMeta && cachedMeta.cover) || null,
        });
        if (!ok) return;

        // O que ainda nao chegou e buscado agora e persistido no item —
        // o cartao em "Links Salvos" nasce com nome e capa, sem depender
        // de uma nova busca de metadados a cada renderizacao
        const key = (videoId || '') + '|' + (playlistId || '');
        if (videoId && !titleCache.get(videoId)) {
          fetchOembed(videoId).then(() => {
            const t = titleCache.get(videoId);
            if (t) Gallery.updateTitle(key, t);
          });
        }
        if (playlistId && !(cachedMeta && cachedMeta.title && cachedMeta.cover)) {
          fetchPlaylistMeta(playlistId).then(meta => {
            if (!meta) return;
            if (meta.title) Gallery.updateTitle(key, meta.title);
            if (meta.cover) Gallery.updateCover(key, meta.cover);
          });
        }
      });

      return;
    }

    // Busca por texto: resultados online (debounce) + faixas ja conhecidas nesta sessao
    const known = TRACKS.filter(t => t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q));

    resultsEl.innerHTML = `
      <div id="artist-chip"></div>
      <div id="yt-search-section">
        <div class="search-results-header">
          <h3 class="section-title" style="margin-bottom:0">Resultados</h3>
          <div class="search-filter-bar" id="search-filter-bar">
            <button class="search-filter-btn" data-sort="relevance">Relevância</button>
            <button class="search-filter-btn" data-sort="views">Mais visualizado</button>
            <button class="search-filter-btn" data-sort="date">Mais recente</button>
          </div>
        </div>
        <div id="yt-search-results"><p class="yt-search-status">Buscando\u2026</p></div>
      </div>
      ${known.length ? `<h3 class="section-title" style="margin:24px 0 12px">Já tocadas nesta sessão</h3><div class="track-list">${known.map((t, i) => trackRow(t, i + 1, known)).join('')}</div>` : ''}
    `;
    attachTrackListeners();

    // Inicializa os botoes de filtro de ordenacao
    const filterBar = document.getElementById('search-filter-bar');
    if (filterBar) {
      const buttons = filterBar.querySelectorAll('.search-filter-btn');
      buttons.forEach(btn => {
        const sort = btn.dataset.sort;
        btn.classList.toggle('active', sort === ytSearchSort);
        btn.addEventListener('click', () => {
          if (sort === ytSearchSort) return;
          setYtSearchSort(sort);
          buttons.forEach(b => b.classList.toggle('active', b.dataset.sort === sort));
          // Refaz a busca com o novo filtro (o cache e por consulta+filtro,
          // entao voltar a um filtro ja visto e instantaneo)
          const currentQuery = globalSearchInput.value.trim();
          if (currentQuery) performSearch(currentQuery);
        });
      });
    }

    // Debounce: so busca no YouTube depois que o usuario para de digitar
    if (ytSearchDebounce) clearTimeout(ytSearchDebounce);
    const myToken = ++ytSearchToken;
    ytSearchDebounce = setTimeout(async () => {
      const results = await searchYouTube(raw, { sort: ytSearchSort });
      if (myToken !== ytSearchToken) return; // busca obsoleta
      const container = document.getElementById('yt-search-results');
      if (!container) return;
      renderYtSearchResults(container, results);
      // Se a pesquisa corresponde a um artista, oferece o perfil dele
      maybeShowArtistChip(raw, myToken);
      // Atualiza os Tiles com shorts relacionados a busca
      renderTilesSection(document.getElementById('tiles-container'), raw);
    }, 500);
  }
}

// Mostra um cartao "Artista — Ver perfil" acima dos resultados quando a
// pesquisa corresponde a um canal do YouTube (ex.: nome de artista).
async function maybeShowArtistChip(query, token) {
  if (!document.getElementById('artist-chip')) return;
  const channels = await searchYouTubeChannels(query);
  if (token !== ytSearchToken) return; // pesquisa mudou enquanto buscava
  const host = document.getElementById('artist-chip');
  if (!host || !channels.length) return;

  const qn = query.trim().toLowerCase();
  const best = channels.find(c => {
    const n = c.name.trim().toLowerCase();
    return n === qn || n.includes(qn) || qn.includes(n);
  });
  if (!best) return;

  host.replaceChildren();
  const card = document.createElement('div');
  card.className = 'artist-chip';
  card.title = 'Ver perfil de ' + best.name;
  if (best.avatar) {
    const img = document.createElement('img');
    img.src = best.avatar; img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
    img.onerror = function () { this.remove(); };
    card.appendChild(img);
  }
  const info = document.createElement('div');
  info.className = 'artist-chip-info';
  info.innerHTML = '<div class="artist-chip-kicker">Artista</div>';
  const nm = document.createElement('div');
  nm.className = 'artist-chip-name'; nm.textContent = best.name;
  info.appendChild(nm);
  if (best.subs) {
    const m = document.createElement('div');
    m.className = 'artist-chip-meta'; m.textContent = fmtCompact(best.subs) + ' inscritos';
    info.appendChild(m);
  }
  card.appendChild(info);
  const cta = document.createElement('span');
  cta.className = 'artist-chip-cta'; cta.textContent = 'Ver perfil \u2192';
  card.appendChild(cta);
  card.addEventListener('click', () => openArtistProfile(best.name));
  host.appendChild(card);
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
    if (r.author) {
      // Clique no nome do artista abre o perfil dele (conteudo do canal)
      a.classList.add('artist-link');
      a.title = 'Ver perfil de ' + r.author;
      a.addEventListener('click', (e) => {
        e.stopPropagation();
        openArtistProfile(r.author);
      });
    }
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

// ============================================
// TILES — SHORTS DO YOUTUBE (secao na pagina de busca)
// Feed masonry estilo Pinterest com videos curtos verticais
// relacionados aos gostos e artistas do usuario.
// ============================================
let tilesCache = null;
let tilesToken = 0;
let tilesCurrentQuery = null;

function renderTilesSection(container, query) {
  if (!container) return;

  // Se a query mudou, invalida o cache
  const queryKey = query || '';
  if (queryKey !== tilesCurrentQuery) {
    tilesCache = null;
    tilesCurrentQuery = queryKey;
  }

  // Se ja existe a secao, reutiliza; senao cria
  let section = document.getElementById('tiles-section');
  if (!section) {
    section = document.createElement('div');
    section.className = 'tiles-section';
    section.id = 'tiles-section';
    container.appendChild(section);
  }

  const subtitleText = query
    ? 'Vídeos curtos relacionados a "' + escapeHtml(query) + '"'
    : 'Vídeos curtos baseados nos seus gostos.';

  section.innerHTML = `
    <div class="tiles-header">
      <h3 class="section-title">Tiles</h3>
      <p class="tiles-subtitle">${subtitleText}</p>
    </div>
    <div class="tiles-masonry" id="tiles-masonry">
      <p class="tiles-loading">Carregando shorts...</p>
    </div>
  `;

  const masonry = section.querySelector('#tiles-masonry');
  const token = ++tilesToken;

  // Se ja tem cache valido para essa query, renderiza imediatamente
  if (tilesCache && tilesCache.length) {
    fillTilesMasonry(masonry, tilesCache);
    return;
  }

  // Decide se busca por query ou por gostos do usuario
  const fetcher = query ? searchYouTubeShorts(query) : fetchShortsForUser();

  fetcher.then(shorts => {
    if (token !== tilesToken) return;
    tilesCache = shorts;
    if (!shorts || !shorts.length) {
      masonry.innerHTML = '<p class="tiles-loading">Nenhum short encontrado no momento. Tente novamente mais tarde.</p>';
      return;
    }
    fillTilesMasonry(masonry, shorts);
  }).catch(() => {
    if (token !== tilesToken) return;
    masonry.innerHTML = '<p class="tiles-loading">Erro ao carregar shorts. Tente novamente.</p>';
  });
}

function fillTilesMasonry(masonry, shorts) {
  masonry.innerHTML = '';
  const frag = document.createDocumentFragment();

  shorts.forEach((s, i) => {
    const card = document.createElement('div');
    card.className = 'tiles-card';
    card.dataset.index = String(i);

    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'tiles-thumb';

    const img = document.createElement('img');
    img.src = 'https://i.ytimg.com/vi/' + s.videoId + '/hqdefault.jpg';
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    thumbWrap.appendChild(img);

    // Overlay com botao de play
    const overlay = document.createElement('div');
    overlay.className = 'tiles-overlay';
    overlay.innerHTML = '<button class="tiles-play-btn"><svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>';
    thumbWrap.appendChild(overlay);

    // Duracao
    if (s.duration > 0) {
      const dur = document.createElement('span');
      dur.className = 'tiles-duration';
      dur.textContent = fmtTime(s.duration);
      thumbWrap.appendChild(dur);
    }

    // Info
    const info = document.createElement('div');
    info.className = 'tiles-info';
    const title = document.createElement('div');
    title.className = 'tiles-title';
    title.textContent = s.title;
    const author = document.createElement('div');
    author.className = 'tiles-author';
    author.textContent = s.author;
    info.appendChild(title);
    info.appendChild(author);

    card.appendChild(thumbWrap);
    card.appendChild(info);

    // Clique toca o short
    card.addEventListener('click', () => {
      const track = materializeYtTrack(s.videoId, s.title, s.author, s.duration);
      // Cria uma fila com todos os shorts para navegacao continua
      const queue = shorts.map(sh => materializeYtTrack(sh.videoId, sh.title, sh.author, sh.duration));
      playTrack(track, queue);
      saveLastTrack();
      startAutoVideoTimer();
    });

    frag.appendChild(card);
  });

  masonry.appendChild(frag);
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
    note.textContent = 'Nenhuma playlist criada ainda. Vá para o Início e use o menu "..." > "Nova playlist".';
    acc.appendChild(note);
  }
  attachTrackListeners();
}

// Estado (em memoria) das secoes recolhiveis do Perfil.
// Por padrao TODAS vem recolhidas a cada carregamento da pagina;
// dentro da sessao o estado e preservado entre re-renders para a
// secao em uso nao fechar ao adicionar um gosto, alternar o
// AdShield etc. Ordem: Gostos, Metricas, Configuracoes.
const profileSectionsOpen = { tastes: false, metrics: false, settings: false };

function profileCollapseSection(key, title, subtitle, iconSvg, innerHtml) {
  const open = !!profileSectionsOpen[key];
  return `
    <div class="section profile-collapse ${open ? 'open' : ''}" data-psec="${key}">
      <button class="profile-collapse-head" data-psec-toggle="${key}" aria-expanded="${open}">
        <span class="profile-collapse-icon">${iconSvg}</span>
        <span class="profile-collapse-titles">
          <span class="profile-collapse-title">${title}</span>
          <span class="profile-collapse-sub">${subtitle}</span>
        </span>
        <svg class="profile-collapse-chevron" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <div class="profile-collapse-body">
        <div class="profile-collapse-inner">${innerHtml}</div>
      </div>
    </div>`;
}

function renderProfile() {
  const displayName = UserProfile.name();
  const uniqueTracks = new Set(state.history.map(h => h.trackId));
  const totalTime = state.history.length * 240;
  const tastes = Tastes.load();
  const suggestions = ['Indie', 'Synthwave', 'Rock', 'Pop', 'Música Brasileira', 'Jazz', 'Lo-Fi', 'Eletrônica', 'Hip Hop', 'MPB', 'Sertanejo', 'Clássica', 'Metal', 'Reggae', 'Funk']
    .filter(s => !tastes.some(t => t.toLowerCase() === s.toLowerCase()));

  // Metricas de escuta — leitura dos modulos existentes (sem nova logica):
  // Reco.buildProfile() ja combina curtidas + historico + PlayStats.
  let topArtists = [], topGenres = [];
  try {
    if (typeof Reco !== 'undefined') {
      const rp = Reco.buildProfile();
      topArtists = (rp.topArtists || []).slice(0, 6);
      topGenres = (rp.topGenres || []).slice(0, 6);
    }
  } catch (_) {}
  const artistPlays = (typeof PlayStats !== 'undefined') ? PlayStats.artistPlays() : new Map();
  const allStats = (typeof PlayStats !== 'undefined') ? PlayStats.top(600) : [];
  const topTracks = allStats.slice(0, 5);
  const totalPlays = allStats.reduce((s, e) => s + (e.plays || 0), 0);
  const savedLinks = (typeof Gallery !== 'undefined') ? Gallery.load().length : 0;
  const maxGenreScore = topGenres.length ? topGenres[0].score : 1;
  const fmtPlays = n => n === 1 ? '1 reprodução' : (n + ' reproduções');

  // ---------- Conteudo: secao GOSTOS ----------
  const tastesHtml = `
    <p class="psec-desc">Cada gênero vira uma playlist dinâmica no Início. Adicione, remova ou crie os seus.</p>
    <div class="taste-chips" id="taste-chips"></div>
    <div class="taste-add">
      <input type="text" id="taste-input" placeholder="Adicionar gênero (ex.: bossa nova)" maxlength="40">
      <button id="taste-add-btn">Adicionar</button>
    </div>
    ${suggestions.length ? `
      <div style="margin-top:14px">
        <div style="font-size:10.5px;color:var(--text-muted);margin-bottom:8px">Sugestões:</div>
        <div class="taste-chips taste-suggestions" id="taste-suggestions"></div>
      </div>` : ''}`;

  // ---------- Conteudo: secao METRICAS ----------
  const metricsHtml = `
    <div class="stats-grid psec-stats-grid">
      <div class="stat-card"><svg viewBox="0 0 24 24" fill="none" stroke="#0AE448" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14" stroke-linecap="round"/></svg><div class="stat-value">${Math.floor(totalTime / 3600)}</div><div class="stat-label">Horas Tocadas</div></div>
      <div class="stat-card"><svg viewBox="0 0 24 24" fill="none" stroke="#0AE448" stroke-width="2"><path d="M8 5v14l11-7z" fill="#0AE448" stroke="none"/></svg><div class="stat-value">${totalPlays}</div><div class="stat-label">Reproduções</div></div>
      <div class="stat-card"><svg viewBox="0 0 24 24" fill="none" stroke="#FF5C00" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg><div class="stat-value">${state.likedTracks.size}</div><div class="stat-label">Curtidas</div></div>
      <div class="stat-card"><svg viewBox="0 0 24 24" fill="none" stroke="#0070F3" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg><div class="stat-value">${UserPlaylists.load().length}</div><div class="stat-label">Playlists</div></div>
      <div class="stat-card"><svg viewBox="0 0 24 24" fill="none" stroke="#E4B10A" stroke-width="2"><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2v-7"/><polyline points="16 6 12 2 8 6" stroke-linecap="round" stroke-linejoin="round"/><line x1="12" y1="2" x2="12" y2="15" stroke-linecap="round"/></svg><div class="stat-value">${savedLinks}</div><div class="stat-label">Links Salvos</div></div>
      <div class="stat-card"><svg viewBox="0 0 24 24" fill="none" stroke="#A3A3A3" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg><div class="stat-value">${tastes.length}</div><div class="stat-label">Gostos</div></div>
    </div>

    <div class="psec-block">
      <h4 class="psec-subtitle">Quem você mais escuta</h4>
      <p class="psec-desc">Baseado nas suas curtidas, histórico e contagem de reproduções. Toque em um artista para abrir o perfil dele.</p>
      ${topArtists.length ? '<div class="top-artists-row" id="profile-top-artists"></div>'
        : '<p class="profile-empty-note">Ouça algumas faixas para ver seus artistas mais escutados aqui.</p>'}
    </div>

    <div class="psec-block">
      <h4 class="psec-subtitle">Faixas mais tocadas</h4>
      <p class="psec-desc">Suas faixas com mais reproduções neste dispositivo. Toque para ouvir de novo.</p>
      ${topTracks.length ? '<div class="top-tracks-list" id="profile-top-tracks"></div>'
        : '<p class="profile-empty-note">Nenhuma reprodução registrada ainda.</p>'}
    </div>

    <div class="psec-block">
      <h4 class="psec-subtitle">Gêneros que você mais ouve</h4>
      <p class="psec-desc">Combinação dos seus gostos com os gêneros das faixas que você curte.</p>
      ${topGenres.length ? '<div class="genre-bars" id="profile-genre-bars"></div>'
        : '<p class="profile-empty-note">Adicione gostos ou curta faixas para montar este ranking.</p>'}
    </div>`;

  // ---------- Conteudo: secao CONFIGURACOES ----------
  // Preferencia da letra sincronizada (modulo Lyrics em lyrics.js)
  const lyricsOn = (typeof Lyrics !== 'undefined') ? Lyrics.enabled() : true;
  const expLayout = (typeof ExpandedLayout !== 'undefined') ? ExpandedLayout.get() : 'classic';
  const settingsHtml = `
    <div class="psec-block" style="margin-top:0">
      <h4 class="psec-subtitle">Sem Anúncios e Promoções</h4>
      <p class="psec-desc">Proteção do MinStream: filtra conteúdo patrocinado das buscas e recomendações e usa o player em modo de privacidade (sem anúncios personalizados).</p>
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

    <div class="psec-block">
      <h4 class="psec-subtitle">Transição automática para vídeo</h4>
      <p class="psec-desc">Quando ativa, o player começa mostrando a capa e muda sozinho para o vídeo após 7 segundos. Desative para permanecer sempre na capa (o vídeo continua disponível pelo botão do player expandido).</p>
      <div class="adshield-card" id="autovideo-card">
        <div class="adshield-icon ${autoVideoEnabled() ? 'on' : ''}">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="15" height="14" rx="2"/><path d="M22 8l-5 4 5 4V8z" stroke-linejoin="round"/></svg>
        </div>
        <div class="adshield-info">
          <div class="adshield-status">${autoVideoEnabled() ? 'Transição automática ativa' : 'Transição automática desativada'}</div>
          <div class="adshield-sub">${autoVideoEnabled() ? 'Capa \u2192 vídeo após 7 segundos' : 'O player permanece no modo capa'}</div>
        </div>
        <button class="pl-action-btn" id="autovideo-toggle">${autoVideoEnabled() ? 'Desativar' : 'Ativar'}</button>
      </div>
    </div>

    <div class="psec-block">
      <h4 class="psec-subtitle">Letra da música (sincronizada)</h4>
      <p class="psec-desc">Mostra a letra da faixa em execução nos players expandidos (desktop e mobile), logo após os controles e antes de "Videoclipes relacionados" — sincronizada em tempo real quando disponível, como no Spotify. As letras vêm do <strong>LRCLIB</strong>, um serviço aberto e gratuito; quando não houver letra, a seção mostra "Sem letra disponível".</p>
      <div class="adshield-card" id="lyrics-card">
        <div class="adshield-icon ${lyricsOn ? 'on' : ''}">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 013 3v8a3 3 0 01-6 0V4a3 3 0 013-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2" stroke-linecap="round"/><line x1="12" y1="19" x2="12" y2="23" stroke-linecap="round"/><line x1="8" y1="23" x2="16" y2="23" stroke-linecap="round"/></svg>
        </div>
        <div class="adshield-info">
          <div class="adshield-status">${lyricsOn ? 'Letra visível nos players' : 'Letra oculta'}</div>
          <div class="adshield-sub">${lyricsOn ? 'Sincronização automática via LRCLIB' : 'A seção de letra não é exibida nos players'}</div>
        </div>
        <button class="pl-action-btn" id="lyrics-toggle">${lyricsOn ? 'Desativar' : 'Ativar'}</button>
      </div>
    </div>

    <div class="psec-block">
      <h4 class="psec-subtitle">Layout do player (desktop)</h4>
      <p class="psec-desc">Escolha como o player expandido organiza as informações no computador. No <strong>Clássico</strong>, o vídeo fica em cima e a letra logo abaixo. No <strong>Moderno</strong>, o vídeo e a letra aparecem <strong>lado a lado</strong>, com os videoclipes relacionados abaixo. As duas formas têm exatamente as mesmas funções — muda só a disposição.</p>
      <div class="layout-choice" id="layout-choice">
        <button class="layout-opt ${expLayout === 'classic' ? 'active' : ''}" data-layout="classic" aria-pressed="${expLayout === 'classic'}">
          <span class="layout-thumb layout-thumb-classic" aria-hidden="true">
            <span class="lt-video"></span><span class="lt-lyrics"></span><span class="lt-related"><i></i><i></i><i></i></span>
          </span>
          <span class="layout-opt-name">Clássico</span>
        </button>
        <button class="layout-opt ${expLayout === 'modern' ? 'active' : ''}" data-layout="modern" aria-pressed="${expLayout === 'modern'}">
          <span class="layout-thumb layout-thumb-modern" aria-hidden="true">
            <span class="lt-row"><span class="lt-video"></span><span class="lt-lyrics"></span></span>
            <span class="lt-related"><i></i><i></i><i></i></span>
          </span>
          <span class="layout-opt-name">Moderno</span>
        </button>
      </div>
    </div>

    <div class="psec-block">
      <h4 class="psec-subtitle">Player mobile — personalizar exibição</h4>
      <p class="psec-desc">Escolha, para cada modo do player no celular, se aparecem os <strong>controles do player</strong> (progresso, botões e curtir), a seção <strong>Letra da música</strong> e a seção <strong>Videoclipes relacionados</strong>. Vale apenas para a versão mobile.</p>
      <div class="mpp-grid" id="mpp-grid">
        ${['video','cover','queue'].map(mode => {
          const label = mode === 'video' ? 'Vídeo' : (mode === 'cover' ? 'Capa' : 'Fila');
          const tOn = MobilePlayerPrefs.isVisible(mode, 'transport');
          const lOn = MobilePlayerPrefs.isVisible(mode, 'lyrics');
          const rOn = MobilePlayerPrefs.isVisible(mode, 'related');
          return `
          <div class="mpp-mode">
            <div class="mpp-mode-title">${label}</div>
            <label class="mpp-row">
              <span>Controles do player</span>
              <button class="mpp-toggle ${tOn ? 'on' : ''}" data-mode="${mode}" data-section="transport" role="switch" aria-checked="${tOn}"><span class="mpp-knob"></span></button>
            </label>
            <label class="mpp-row">
              <span>Letra da música</span>
              <button class="mpp-toggle ${lOn ? 'on' : ''}" data-mode="${mode}" data-section="lyrics" role="switch" aria-checked="${lOn}"><span class="mpp-knob"></span></button>
            </label>
            <label class="mpp-row">
              <span>Videoclipes relacionados</span>
              <button class="mpp-toggle ${rOn ? 'on' : ''}" data-mode="${mode}" data-section="related" role="switch" aria-checked="${rOn}"><span class="mpp-knob"></span></button>
            </label>
          </div>`;
        }).join('')}
      </div>
    </div>

    <div class="psec-block">
      <h4 class="psec-subtitle">Takeout — Levar seus dados</h4>
      <p class="psec-desc">Baixe um arquivo .json com tudo o que está salvo neste navegador — playlists, curtidas, links salvos, gostos, histórico, estatísticas e preferências — e importe em outro dispositivo para continuar de onde parou.</p>
      <div class="takeout-card">
        <div class="takeout-icon">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" stroke-linecap="round"/><polyline points="7 10 12 15 17 10" stroke-linecap="round" stroke-linejoin="round"/><line x1="12" y1="15" x2="12" y2="3" stroke-linecap="round"/></svg>
        </div>
        <div class="takeout-info">
          <div class="takeout-status">Seus dados neste dispositivo</div>
          <div class="takeout-sub">${Takeout.count()} registro(s) no armazenamento local, prontos para exportar</div>
        </div>
        <div class="takeout-actions">
          <button class="pl-action-btn takeout-primary" id="takeout-export">Baixar meus dados</button>
          <button class="pl-action-btn" id="takeout-import">Importar takeout</button>
        </div>
      </div>
      <p style="font-size:10.5px;color:var(--text-muted);margin-top:10px">Ao importar, os dados do arquivo são <strong>somados</strong> aos que já existem neste navegador — playlists, curtidas, gostos e contagens são unidos, nada é sobrescrito — e a página é recarregada.</p>
    </div>`;

  // ---------- Icones e resumos dos cabecalhos ----------
  const icoTastes = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
  const icoMetrics = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10" stroke-linecap="round"/><line x1="12" y1="20" x2="12" y2="4" stroke-linecap="round"/><line x1="6" y1="20" x2="6" y2="14" stroke-linecap="round"/></svg>';
  const icoSettings = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33h0a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51h0a1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82v0a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>';

  const subTastes = tastes.length
    ? tastes.length + ' gênero(s): ' + escapeHtml(tastes.slice(0, 3).join(', ')) + (tastes.length > 3 ? '…' : '')
    : 'Nenhum gênero definido ainda';
  const subMetrics = Math.floor(totalTime / 3600) + 'h tocadas · ' + totalPlays + ' reproduções · ' + state.likedTracks.size + ' curtidas';
  const subSettings = (AdShield.enabled() ? 'Proteção ativa' : 'Proteção desativada') + ' · ' + (autoVideoEnabled() ? 'Vídeo automático' : 'Sempre na capa') + ' · ' + (lyricsOn ? 'Letra sincronizada' : 'Letra oculta') + ' · Takeout de dados';

  main.innerHTML = `
    <div class="section">
      <div class="profile-header">
        <div class="profile-avatar profile-avatar-initial" aria-hidden="true">${escapeHtml(UserProfile.initial())}</div>
        <div class="profile-header-info">
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);margin-bottom:6px">Perfil</div>
          <div class="profile-name-row">
            <div class="profile-name" id="profile-name-text">${escapeHtml(displayName)}</div>
            <button class="profile-edit-btn" id="profile-edit-btn" title="Editar nome">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.83 2.83 0 014 4L7.5 20.5 2 22l1.5-5.5z" stroke-linejoin="round"/></svg>
              <span>Editar</span>
            </button>
          </div>
          <div class="profile-name-form hidden" id="profile-name-form">
            <input type="text" id="profile-name-input" maxlength="40" placeholder="Seu nome" autocomplete="off" spellcheck="false">
            <button class="pl-action-btn" id="profile-name-save">Salvar</button>
            <button class="pl-action-btn profile-name-cancel" id="profile-name-cancel">Cancelar</button>
          </div>
          <p class="profile-bio">Suas playlists dinâmicas são geradas a partir dos seus gostos.</p>
          <div class="profile-stats-row">
            <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg> ${state.likedTracks.size} curtidas</span>
            <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 18v-6a9 9 0 0118 0v6"/><path d="M21 19a2 2 0 01-2 2h-1a2 2 0 01-2-2v-3a2 2 0 012-2h3zM3 19a2 2 0 002 2h1a2 2 0 002-2v-3a2 2 0 00-2-2H3z"/></svg> ${uniqueTracks.size} ouvidas</span>
            <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14" stroke-linecap="round"/></svg> ${Math.floor(totalTime / 3600)}h</span>
          </div>
        </div>
      </div>
    </div>

    ${profileCollapseSection('tastes', 'Gostos', subTastes, icoTastes, tastesHtml)}
    ${profileCollapseSection('metrics', 'Métricas', subMetrics, icoMetrics, metricsHtml)}
    ${profileCollapseSection('settings', 'Configurações', subSettings, icoSettings, settingsHtml)}
    <div style="height:24px"></div>
  `;

  // ----- Recolher/expandir secoes -----
  main.querySelectorAll('[data-psec-toggle]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-psec-toggle');
      profileSectionsOpen[key] = !profileSectionsOpen[key];
      const sec = main.querySelector('.profile-collapse[data-psec="' + key + '"]');
      if (sec) sec.classList.toggle('open', profileSectionsOpen[key]);
      btn.setAttribute('aria-expanded', String(!!profileSectionsOpen[key]));
    });
  });

  // ----- Edicao do nome -----
  const nameForm = document.getElementById('profile-name-form');
  const nameText = document.getElementById('profile-name-text');
  const nameInput = document.getElementById('profile-name-input');
  const openNameForm = () => {
    nameInput.value = UserProfile.name();
    nameForm.classList.remove('hidden');
    nameText.style.display = 'none';
    document.getElementById('profile-edit-btn').style.display = 'none';
    nameInput.focus();
    nameInput.select();
  };
  const closeNameForm = () => {
    nameForm.classList.add('hidden');
    nameText.style.display = '';
    document.getElementById('profile-edit-btn').style.display = '';
  };
  const saveName = () => {
    if (UserProfile.setName(nameInput.value)) {
      renderProfile();
      showToast('Nome atualizado para "' + UserProfile.name() + '"');
    } else {
      showToast('Digite um nome válido');
      nameInput.focus();
    }
  };
  document.getElementById('profile-edit-btn').addEventListener('click', openNameForm);
  document.getElementById('profile-name-save').addEventListener('click', saveName);
  document.getElementById('profile-name-cancel').addEventListener('click', closeNameForm);
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveName();
    if (e.key === 'Escape') closeNameForm();
    e.stopPropagation();
  });

  // ----- Metricas: quem voce mais escuta -----
  const artistsEl = document.getElementById('profile-top-artists');
  if (artistsEl) {
    topArtists.forEach((a, i) => {
      const plays = artistPlays.get(a.key) || 0;
      const card = document.createElement('button');
      card.className = 'top-artist-card';
      card.title = 'Abrir perfil de ' + a.artist;
      const av = document.createElement('span');
      av.className = 'top-artist-avatar';
      av.textContent = (a.artist || '?').trim().charAt(0).toUpperCase();
      const nm = document.createElement('span');
      nm.className = 'top-artist-name';
      nm.textContent = a.artist;
      const meta = document.createElement('span');
      meta.className = 'top-artist-meta';
      meta.textContent = '#' + (i + 1) + (plays ? ' · ' + fmtPlays(plays) : '');
      card.appendChild(av); card.appendChild(nm); card.appendChild(meta);
      card.addEventListener('click', () => openArtistProfile(a.artist));
      artistsEl.appendChild(card);
    });
  }

  // ----- Metricas: faixas mais tocadas -----
  const tracksEl = document.getElementById('profile-top-tracks');
  if (tracksEl) {
    topTracks.forEach((e, i) => {
      const row = document.createElement('button');
      row.className = 'top-track-row';
      row.title = 'Tocar "' + (e.title || '') + '"';
      const rank = document.createElement('span');
      rank.className = 'top-track-rank';
      rank.textContent = i + 1;
      const info = document.createElement('span');
      info.className = 'top-track-info';
      const t = document.createElement('span');
      t.className = 'top-track-title';
      t.textContent = e.title || 'Faixa';
      const a = document.createElement('span');
      a.className = 'top-track-artist';
      a.textContent = e.artist || '';
      info.appendChild(t); info.appendChild(a);
      const badge = document.createElement('span');
      badge.className = 'top-track-plays';
      badge.textContent = fmtPlays(e.plays || 0);
      row.appendChild(rank); row.appendChild(info); row.appendChild(badge);
      row.addEventListener('click', () => {
        const track = e.videoId
          ? materializeYtTrack(e.videoId, e.title, e.artist, 0)
          : getTrack(e.id);
        if (!track) { showToast('Faixa indisponível no momento'); return; }
        // Fila = o próprio ranking de mais tocadas (próxima/anterior seguem a lista)
        const queue = topTracks
          .map(x => x.videoId ? materializeYtTrack(x.videoId, x.title, x.artist, 0) : getTrack(x.id))
          .filter(Boolean);
        playTrack(track, queue.length ? queue : undefined);
      });
      tracksEl.appendChild(row);
    });
  }

  // ----- Metricas: generos mais ouvidos -----
  const genresEl = document.getElementById('profile-genre-bars');
  if (genresEl) {
    topGenres.forEach((g, i) => {
      const row = document.createElement('div');
      row.className = 'genre-bar-row';
      const label = document.createElement('span');
      label.className = 'genre-bar-label';
      label.textContent = g.genre;
      const barWrap = document.createElement('span');
      barWrap.className = 'genre-bar-track';
      const bar = document.createElement('span');
      bar.className = 'genre-bar-fill';
      bar.style.width = Math.max(8, Math.round((g.score / maxGenreScore) * 100)) + '%';
      barWrap.appendChild(bar);
      const rank = document.createElement('span');
      rank.className = 'genre-bar-rank';
      rank.textContent = '#' + (i + 1);
      row.appendChild(rank); row.appendChild(label); row.appendChild(barWrap);
      genresEl.appendChild(row);
    });
  }

  // ----- Configuracoes: takeout -----
  document.getElementById('takeout-export').addEventListener('click', () => Takeout.download());
  const takeoutFile = document.createElement('input');
  takeoutFile.type = 'file';
  takeoutFile.accept = 'application/json,.json,text/plain,.txt';
  takeoutFile.style.display = 'none';
  takeoutFile.addEventListener('change', () => {
    if (takeoutFile.files && takeoutFile.files[0]) Takeout.restore(takeoutFile.files[0]);
    takeoutFile.value = '';
  });
  main.appendChild(takeoutFile);
  document.getElementById('takeout-import').addEventListener('click', () => takeoutFile.click());

  // ----- Configuracoes: toggle do mecanismo sem anuncios -----
  const shieldBtn = document.getElementById('adshield-toggle');
  if (shieldBtn) shieldBtn.addEventListener('click', () => {
    const next = !AdShield.enabled();
    AdShield.setEnabled(next);
    renderProfile();
    showToast(next ? 'Proteção contra anúncios ativada' : 'Proteção contra anúncios desativada');
  });

  // ----- Configuracoes: toggle da transicao automatica capa -> video -----
  const autoVidBtn = document.getElementById('autovideo-toggle');
  if (autoVidBtn) autoVidBtn.addEventListener('click', () => {
    const next = !autoVideoEnabled();
    setAutoVideoEnabled(next);
    if (!next) cancelAutoVideoTimer(); // corta um timer ja agendado
    renderProfile();
    showToast(next
      ? 'Transição automática para vídeo ativada (7s)'
      : 'Transição automática desativada — o player fica na capa');
  });

  // ----- Configuracoes: toggle da letra sincronizada (modulo Lyrics) -----
  const lyricsBtn = document.getElementById('lyrics-toggle');
  if (lyricsBtn) lyricsBtn.addEventListener('click', () => {
    if (typeof Lyrics === 'undefined') return;
    const next = !Lyrics.enabled();
    Lyrics.setEnabled(next); // persiste e mostra/oculta os containers na hora
    renderProfile();
    showToast(next
      ? 'Letra da música ativada nos players'
      : 'Letra da música oculta nos players');
  });

  // ----- Configuracoes: layout do player expandido (desktop) -----
  const layoutChoice = document.getElementById('layout-choice');
  if (layoutChoice && typeof ExpandedLayout !== 'undefined') {
    layoutChoice.querySelectorAll('.layout-opt').forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.layout;
        if (mode === ExpandedLayout.get()) return;
        ExpandedLayout.set(mode); // persiste e aplica na hora (se aberto)
        // Atualiza o estado visual dos botões sem re-render pesado
        layoutChoice.querySelectorAll('.layout-opt').forEach(b => {
          const on = b.dataset.layout === mode;
          b.classList.toggle('active', on);
          b.setAttribute('aria-pressed', String(on));
        });
        showToast(mode === 'modern'
          ? 'Layout Moderno ativado: vídeo e letra lado a lado'
          : 'Layout Clássico ativado');
      });
    });
  }

  // ----- Configuracoes: toggles de exibicao do player mobile -----
  const mppGrid = document.getElementById('mpp-grid');
  if (mppGrid) {
    mppGrid.querySelectorAll('.mpp-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode;
        const section = btn.dataset.section;
        const next = !btn.classList.contains('on');
        MobilePlayerPrefs.setVisible(mode, section, next);
        btn.classList.toggle('on', next);
        btn.setAttribute('aria-checked', String(next));
        // Se o player mobile estiver aberto, reflete de imediato
        if (isExpanded && expandedIsMobile) applyMobilePlayerPrefs();
      });
    });
  }

  // ----- Gostos: chips, adicao e sugestoes -----
  const chipsEl = document.getElementById('taste-chips');
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
  // Mostra TODO o historico (ate 100 reproducoes). Faixas do YouTube
  // que ainda nao existem em TRACKS (apos um reload) sao recriadas a
  // partir dos metadados guardados no proprio historico.
  const tracks = state.history.map(h => {
    const t = getTrack(h.trackId);
    if (t) return t;
    if (h.videoId) return materializeYtTrack(h.videoId, h.title, h.artist, 0);
    return null;
  }).filter(Boolean);
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
      ${tracks.length ? `<p style="font-size:11.5px;color:var(--text-muted);margin:-6px 0 12px">${tracks.length} reproduções (as últimas 100 ficam guardadas)</p><div class="track-list">${tracks.map((t, i) => trackRow(t, i + 1, tracks)).join('')}</div>` : `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14" stroke-linecap="round"/></svg><p>Nenhuma música tocada ainda. Comece a ouvir!</p></div>`}
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
      <img src="${track.cover}" alt="" class="track-thumb" loading="lazy" decoding="async">
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

// Cache do ultimo estado renderizado: o poll chama updatePlayerUI a cada
// 500ms, mas quase nada muda entre ticks. So escrever no DOM o que
// realmente mudou elimina style/layout recalcs constantes.
const _uiCache = {
  trackId: null, playing: null, liked: null, shuffled: null,
  repeat: null, muted: null, prog: -1, cur: '', total: '', qlen: -1,
};

function updatePlayerUI() {
  const t = state.currentTrack;
  if (!t) return;

  const trackChanged = _uiCache.trackId !== t.id;
  const playChanged = _uiCache.playing !== state.isPlaying;

  // Garante que o VU meter volte a animar quando algo comeca a tocar
  if (state.isPlaying && playChanged) ensureVuMeter();

  if (trackChanged) {
    playerCover.src = t.cover;
    playerTitle.textContent = t.title;
    playerArtist.textContent = t.artist;
  }

  if (playChanged) {
    iconPlay.style.display = state.isPlaying ? 'none' : '';
    iconPause.style.display = state.isPlaying ? '' : 'none';
    // Botao verde enquanto toca (e nao branco)
    btnPlay.classList.toggle('playing', state.isPlaying);
  }

  if (!isScrubbing) {
    const prog = state.duration > 0 ? (state.currentTime / state.duration) * 100 : 0;
    const progKey = Math.round(prog * 10); // resolucao de 0,1%
    if (progKey !== _uiCache.prog) {
      _uiCache.prog = progKey;
      progressFill.style.width = prog + '%';
      progressHandle.style.left = prog + '%';
    }
    const cur = fmtTime(state.currentTime);
    if (cur !== _uiCache.cur) { _uiCache.cur = cur; timeCurrent.textContent = cur; }
    const total = '-' + fmtTime(Math.max(0, state.duration - state.currentTime));
    if (total !== _uiCache.total) { _uiCache.total = total; timeTotal.textContent = total; }
  }

  const liked = state.likedTracks.has(t.id);
  if (liked !== _uiCache.liked || trackChanged) btnLike.classList.toggle('liked', liked);
  if (state.isShuffled !== _uiCache.shuffled) btnShuffle.classList.toggle('active', state.isShuffled);
  if (state.repeatMode !== _uiCache.repeat) {
    iconRepeat.style.display = state.repeatMode === 'one' ? 'none' : '';
    iconRepeat1.style.display = state.repeatMode === 'one' ? '' : 'none';
    btnRepeat.classList.toggle('active', state.repeatMode !== 'off');
  }
  if (state.isMuted !== _uiCache.muted) {
    iconVol.style.display = state.isMuted ? 'none' : '';
    iconMute.style.display = state.isMuted ? '' : 'none';
  }

  // Fila e vistas do player expandido: so quando algo relevante mudou
  const qlen = state.queue.length;
  const queueDirty = trackChanged || playChanged || qlen !== _uiCache.qlen;
  if (queueDirty) refreshQueuePanel();
  if (isExpanded && (trackChanged || playChanged)) {
    if (state.playerMode === 'cover' && trackChanged) fillExpandedCover();
    if (state.playerMode === 'queue') buildExpandedQueue(false);
    if (trackChanged) {
      updateExpandedContext();
      loadRelatedVideos();
      // Fundo do expandido desktop segue a capa em QUALQUER modo (o
      // fillExpandedCover acima so roda no modo capa).
      if (!expandedIsMobile && state.playerMode !== 'cover') ExpBackdrop.apply();
    }
  }

  // Equalizer nas linhas de faixa: caro em listas longas — so na troca
  // de faixa ou play/pause, nunca a cada tick do poll
  if ((trackChanged || playChanged) &&
      (state.view === 'home' || state.view === 'album' || state.view === 'playlist')) {
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

  // ----- Espelha estado no player mobile, quando aberto -----
  if (isExpanded && expandedIsMobile) {
    if (trackChanged) updateMobileMeta();
    const mpIconPlay = document.getElementById('mp-icon-play');
    const mpIconPause = document.getElementById('mp-icon-pause');
    const mpPlay = document.getElementById('mp-play');
    if (playChanged && mpIconPlay && mpIconPause) {
      mpIconPlay.style.display = state.isPlaying ? 'none' : '';
      mpIconPause.style.display = state.isPlaying ? '' : 'none';
      if (mpPlay) mpPlay.classList.toggle('playing', state.isPlaying);
    }
    if (!isScrubbing) {
      const prog = state.duration > 0 ? (state.currentTime / state.duration) * 100 : 0;
      const mpFill = document.getElementById('mp-progress-fill');
      const mpHandle = document.getElementById('mp-progress-handle');
      const mpCur = document.getElementById('mp-time-current');
      const mpTot = document.getElementById('mp-time-total');
      if (mpFill) mpFill.style.width = prog + '%';
      if (mpHandle) mpHandle.style.left = prog + '%';
      if (mpCur) mpCur.textContent = fmtTime(state.currentTime);
      if (mpTot) mpTot.textContent = fmtTime(state.duration);
    }
    const mpLike = document.getElementById('mp-like');
    if (mpLike && (liked !== _uiCache.liked || trackChanged)) mpLike.classList.toggle('active', liked);
    const mpShuffle = document.getElementById('mp-shuffle');
    if (mpShuffle && state.isShuffled !== _uiCache.shuffled) mpShuffle.classList.toggle('active', state.isShuffled);
    const mpRepeat = document.getElementById('mp-repeat');
    if (mpRepeat && state.repeatMode !== _uiCache.repeat) mpRepeat.classList.toggle('active', state.repeatMode !== 'off');
    if (state.playerMode === 'queue' && queueDirty) buildMobileQueue(false);
  }

  // ----- Pagina de letra em tela cheia (mobile), quando aberta -----
  if (lyricsPageOpen()) syncLyricsPage();

  _uiCache.trackId = t.id;
  _uiCache.playing = state.isPlaying;
  _uiCache.liked = liked;
  _uiCache.shuffled = state.isShuffled;
  _uiCache.repeat = state.repeatMode;
  _uiCache.muted = state.isMuted;
  _uiCache.qlen = qlen;
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

// ===== GESTOS DO MODO TV (mobile) =====
// Sobre a tela cheia do vídeo:
//  - 1 toque simples  -> play/pause;
//  - 2 toques no lado DIREITO -> avança 5s (acumulativo: toques seguidos
//    somam +5s, +10s, +15s…);
//  - 2 toques no lado ESQUERDO -> retrocede 5s (idem, acumulativo).
// O duplo-toque é detectado por proximidade temporal + espacial; um toque
// solto (sem segundo toque dentro da janela) vira play/pause.
(function initTvGestures() {
  if (!videoCover) return;

  const DOUBLE_MS = 300;   // janela p/ considerar "duplo toque"
  const MOVE_TOL = 30;     // tolerância de movimento entre toques (px)
  const STEP = 5;          // segundos por duplo-toque
  const ACCUM_MS = 800;    // janela p/ acumular seeks consecutivos
  const HINT_MS = 700;     // duração do indicador visual

  let lastTapTime = 0;
  let lastTapX = 0, lastTapY = 0;
  let lastTapSide = null;
  let singleTimer = null;

  // Acúmulo de seek: enquanto o usuário continua o duplo-toque no mesmo
  // lado dentro de ACCUM_MS, o total exibido cresce (5,10,15…).
  let accumSide = null;
  let accumSecs = 0;
  let accumResetTimer = null;

  function liveTimeSec() {
    try {
      if (ytPlayer && state.apiReady && ytPlayer.getCurrentTime) {
        const t = ytPlayer.getCurrentTime();
        if (typeof t === 'number' && isFinite(t)) return t;
      }
    } catch (_) {}
    return state.currentTime || 0;
  }

  // Aplica o seek de forma incremental (cada duplo-toque já mexe no vídeo),
  // mantendo o rótulo acumulado visível (+5s, +10s…).
  function doSeek(side) {
    const dir = side === 'right' ? 1 : -1;
    const dur = state.duration || 0;

    if (accumSide !== side) { accumSide = side; accumSecs = 0; }
    accumSecs += STEP;

    let target = liveTimeSec() + dir * STEP;
    if (target < 0) target = 0;
    if (dur > 0 && target > dur) target = dur;
    seekToTime(target);

    showTvSeekHint(side, accumSecs);

    // Reinicia a janela de acumulação a cada toque
    if (accumResetTimer) clearTimeout(accumResetTimer);
    accumResetTimer = setTimeout(() => { accumSide = null; accumSecs = 0; }, ACCUM_MS);
  }

  // Indicador visual (setas + total) nas laterais
  let hintEl = null, hintTimer = null;
  function ensureHint() {
    if (hintEl) return hintEl;
    hintEl = document.createElement('div');
    hintEl.id = 'tv-seek-hint';
    hintEl.innerHTML = '<span class="tv-seek-ico"></span><span class="tv-seek-secs"></span>';
    videoCover.appendChild(hintEl);
    return hintEl;
  }
  function showTvSeekHint(side, secs) {
    const el = ensureHint();
    el.classList.remove('left', 'right', 'show');
    void el.offsetWidth; // reinicia a animação
    el.classList.add(side, 'show');
    el.querySelector('.tv-seek-ico').textContent = side === 'right' ? '»' : '«';
    el.querySelector('.tv-seek-secs').textContent = (side === 'right' ? '+' : '−') + secs + 's';
    if (hintTimer) clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { if (hintEl) hintEl.classList.remove('show'); }, HINT_MS);
  }

  function sideFromX(x) {
    const r = videoCover.getBoundingClientRect();
    return (x - r.left) < r.width / 2 ? 'left' : 'right';
  }

  // Só atua no Modo TV; fora dele, o app segue com seus controles normais.
  videoCover.addEventListener('pointerup', (e) => {
    if (!isTvMode()) return;
    // Ignora toques nos controles sobrepostos (ex.: botão Sair)
    if (e.target && e.target.closest && e.target.closest('#tv-exit')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    const now = Date.now();
    const x = e.clientX, y = e.clientY;
    const side = sideFromX(x);
    const near = Math.abs(x - lastTapX) <= MOVE_TOL && Math.abs(y - lastTapY) <= MOVE_TOL;
    const soon = (now - lastTapTime) <= DOUBLE_MS;

    if (soon && near && lastTapSide === side) {
      // Segundo toque: é um duplo-toque no mesmo lado -> seek
      if (singleTimer) { clearTimeout(singleTimer); singleTimer = null; }
      doSeek(side);
      lastTapTime = 0; // consome o par (evita triplo virar novo par)
      lastTapSide = null;
    } else {
      // Primeiro toque: aguarda um possível segundo antes de decidir
      lastTapTime = now; lastTapX = x; lastTapY = y; lastTapSide = side;
      if (singleTimer) clearTimeout(singleTimer);
      singleTimer = setTimeout(() => {
        singleTimer = null;
        togglePlay(); // toque simples -> play/pause
      }, DOUBLE_MS);
    }
  });

  // Evita que o duplo-toque dispare zoom/seleção no mobile
  videoCover.addEventListener('dblclick', (e) => { if (isTvMode()) e.preventDefault(); });
})();

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
      // Com a letra em tela cheia aberta, Esc volta para a tela anterior
      // (o player) em vez de fechar tudo de uma vez.
      if (typeof Lyrics !== 'undefined' && Lyrics.pageOpen && Lyrics.pageOpen()) {
        Lyrics.closePage();
        break;
      }
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
let vuLastTs = 0;
const VU_FRAME_MS = 33; // ~30fps: indistinguivel a olho nesse tamanho, metade do custo

// Inicia o loop do VU meter apenas se ele nao estiver rodando.
// O loop se auto-encerra quando fica ocioso (nada tocando e barras ja no
// repouso), evitando um requestAnimationFrame perpetuo em segundo plano.
function ensureVuMeter() {
  if (vuRunning || document.hidden) return;
  vuRunning = true;
  drawVUMeter();
}

function drawVUMeter(ts) {
  // Throttle a ~30fps: pula o desenho, mantem o agendamento
  if (ts && ts - vuLastTs < VU_FRAME_MS) {
    requestAnimationFrame(drawVUMeter);
    return;
  }
  if (ts) vuLastTs = ts;
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
// Menos particulas = custo quadratico bem menor na malha de conexoes
// (50 -> 36 no desktop e 22 no mobile corta ~50%/80% dos pares testados)
const REDUCED_MOTION = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const PARTICLE_COUNT = (window.matchMedia && window.matchMedia('(max-width: 768px)').matches) ? 22 : 36;
const particles = Array.from({ length: PARTICLE_COUNT }, () => ({
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
  if (REDUCED_MOTION) return; // preferencia do sistema: sem decoracao animada
  if (particlesRunning || document.hidden) return;
  particlesRunning = true;
  drawParticles();
}

let bgLastTs = 0;
const BG_FRAME_MS = 40;      // ~25fps: suficiente para particulas ambiente lentas
const CONNECT_DIST = 150;
const CONNECT_DIST_SQ = CONNECT_DIST * CONNECT_DIST;

function drawParticles(ts) {
  if (document.hidden) { particlesRunning = false; return; }
  requestAnimationFrame(drawParticles);
  // Throttle: desenha a ~25fps; o movimento e baseado em tempo real,
  // entao a velocidade visual nao muda com o framerate
  if (ts && ts - bgLastTs < BG_FRAME_MS) return;
  const dt = ts ? Math.min(3, (ts - bgLastTs) / 16.7) : 1;
  if (ts) bgLastTs = ts;
  bgCtx.clearRect(0, 0, bgW, bgH);

  for (const p of particles) {
    p.x += p.vx * dt;
    p.y += p.vy * dt;
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

  // Connections (distancia ao quadrado: sem sqrt no laco O(n^2))
  bgCtx.strokeStyle = '#0AE448';
  bgCtx.lineWidth = 0.5;
  for (let i = 0; i < particles.length; i++) {
    for (let j = i + 1; j < particles.length; j++) {
      const dx = particles[i].x - particles[j].x;
      const dy = particles[i].y - particles[j].y;
      const distSq = dx * dx + dy * dy;
      if (distSq < CONNECT_DIST_SQ) {
        bgCtx.globalAlpha = 0.02 * (1 - Math.sqrt(distSq) / CONNECT_DIST);
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
// PULL-TO-REFRESH — ATUALIZAR ARRASTANDO PARA BAIXO
// Em todas as paginas: arrastar o topo do conteudo para baixo mostra o
// circulo de carregamento e, ao soltar alem do limiar, os caches de
// conteudo dinamico sao invalidados e a view atual e re-renderizada
// (mesmo modelo do Spotify/YouTube Music).
// ============================================
const PullToRefresh = (function () {
  const THRESHOLD = 72;      // px de arraste para disparar o refresh
  const MAX_PULL = 120;      // px maximos de deslocamento do spinner
  const RESISTANCE = 0.5;    // fator de resistencia do arraste
  const MIN_SPIN_MS = 650;   // tempo minimo com o spinner girando

  let spinner = null;
  let startY = 0, startX = 0;
  let pulling = false;       // gesto elegivel em andamento
  let engaged = false;       // direcao vertical confirmada
  let refreshing = false;
  let pullDist = 0;

  function ensureSpinner() {
    if (spinner) return spinner;
    spinner = document.createElement('div');
    spinner.id = 'ptr-spinner';
    spinner.innerHTML = '<div class="ptr-circle"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-3.2-6.9"/><polyline points="21 3 21 9 15 9" fill="none"/></svg></div>';
    document.body.appendChild(spinner);
    return spinner;
  }

  function positionSpinner() {
    const rect = main.getBoundingClientRect();
    spinner.style.left = (rect.left + rect.width / 2) + 'px';
    spinner.style.top = rect.top + 'px';
  }

  function setPull(dist) {
    pullDist = dist;
    const eased = Math.min(MAX_PULL, dist * RESISTANCE);
    const ready = eased >= THRESHOLD * RESISTANCE ? 1 : eased / (THRESHOLD * RESISTANCE);
    spinner.style.setProperty('--ptr-y', eased + 'px');
    spinner.style.setProperty('--ptr-rot', (eased * 2.4) + 'deg');
    spinner.style.setProperty('--ptr-opacity', String(Math.min(1, ready + 0.15)));
    spinner.classList.toggle('ptr-ready', eased >= THRESHOLD * RESISTANCE);
  }

  // Invalida os caches de conteudo dinamico — o mesmo conjunto que o boot
  // limpa num F5 — mais os caches de busca em memoria.
  function invalidateCaches() {
    ['vibefm_news_cache', 'vibefm_taste_yt_playlists', 'vibefm_trending_cache'].forEach(k => {
      try { localStorage.removeItem(k); } catch (_) {}
    });
    try { ytSearchCache.clear(); } catch (_) {}
    try { ytPlaylistSearchCache.clear(); } catch (_) {}
    try { ytShortsCache.clear(); } catch (_) {}
    try { ytChannelSearchCache.clear(); } catch (_) {}
    try { artistProfileCache.clear(); } catch (_) {}
    try { dynamicPlaylistCache.clear(); } catch (_) {}
  }

  async function doRefresh() {
    refreshing = true;
    spinner.classList.add('ptr-refreshing');
    spinner.style.setProperty('--ptr-y', (THRESHOLD * RESISTANCE + 8) + 'px');
    const started = Date.now();
    invalidateCaches();
    try { setView(state.view); } catch (_) {}
    const wait = Math.max(0, MIN_SPIN_MS - (Date.now() - started));
    setTimeout(() => {
      spinner.classList.remove('ptr-refreshing', 'ptr-ready');
      spinner.classList.add('ptr-leaving');
      setTimeout(() => {
        spinner.classList.remove('ptr-leaving');
        spinner.style.setProperty('--ptr-y', '0px');
        spinner.style.setProperty('--ptr-opacity', '0');
        refreshing = false;
      }, 220);
    }, wait);
  }

  function onTouchStart(e) {
    if (refreshing || e.touches.length !== 1) return;
    if (main.scrollTop > 0) return;
    // Nao inicia sobre alcas de drag-and-drop (reordenacao de fila/playlist)
    if (e.target.closest('.drag-handle, .queue-drag-handle')) return;
    startY = e.touches[0].clientY;
    startX = e.touches[0].clientX;
    pulling = true;
    engaged = false;
    ensureSpinner();
    positionSpinner();
  }

  function onTouchMove(e) {
    if (!pulling || refreshing) return;
    const dy = e.touches[0].clientY - startY;
    const dx = e.touches[0].clientX - startX;
    if (!engaged) {
      // Confirma a direcao: gesto horizontal (carrosseis) nao dispara
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 8) { pulling = false; return; }
      if (dy > 8 && main.scrollTop <= 0) engaged = true;
      else if (dy < -4) { pulling = false; return; }
      else return;
    }
    if (main.scrollTop > 0) { cancelPull(); return; }
    if (dy <= 0) { cancelPull(); return; }
    e.preventDefault(); // impede o scroll/bounce nativo durante o gesto
    setPull(dy);
  }

  function cancelPull() {
    pulling = false;
    engaged = false;
    if (spinner && !refreshing) {
      spinner.classList.add('ptr-leaving');
      setTimeout(() => {
        spinner.classList.remove('ptr-leaving', 'ptr-ready');
        spinner.style.setProperty('--ptr-y', '0px');
        spinner.style.setProperty('--ptr-opacity', '0');
      }, 180);
    }
  }

  function onTouchEnd() {
    if (!pulling || refreshing) { pulling = false; return; }
    const fired = engaged && pullDist * RESISTANCE >= THRESHOLD * RESISTANCE;
    pulling = false;
    engaged = false;
    if (fired) doRefresh();
    else cancelPull();
    pullDist = 0;
  }

  function init() {
    // passive:false no touchmove para poder chamar preventDefault
    main.addEventListener('touchstart', onTouchStart, { passive: true });
    main.addEventListener('touchmove', onTouchMove, { passive: false });
    main.addEventListener('touchend', onTouchEnd, { passive: true });
    main.addEventListener('touchcancel', onTouchEnd, { passive: true });
  }

  return { init, refresh: doRefresh };
})();
PullToRefresh.init();

// ============================================
// INIT
// ============================================
// Sempre que a pagina e atualizada (recarregada), as informacoes tambem
// sao: os caches persistentes de conteudo dinamico sao invalidados no
// boot, entao Mixes, Novidades, Tendencias e as playlists por gosto sao
// rebuscados com dados frescos a cada carregamento. Os caches continuam
// valendo DENTRO da sessao (evitam martelar as instancias publicas ao
// navegar entre abas), mas nunca sobrevivem a um F5.
(function refreshOnPageLoad() {
  ['vibefm_news_cache', 'vibefm_taste_yt_playlists', 'vibefm_trending_cache'].forEach(k => {
    try { localStorage.removeItem(k); } catch (_) {}
  });
})();

// Recria em TRACKS as faixas curtidas em sessoes anteriores (metadados persistidos),
// para que "Curtidas" e o perfil de recomendacao funcionem apos recarregar.
if (typeof Reco !== 'undefined') Reco.hydrateLikes();
renderSidebarPlaylists();
renderHome();
initSidebar();
initRelatedCarousel(); // setas do carrossel de relacionados (layout Moderno)
setupLyricsPageControls(); // transporte da letra em tela cheia (mobile)

// Restaura a ultima musica reproduzida da sessao anterior
(function restoreLastSession() {
  const last = loadLastTrack();
  if (!last || !last.track) return;

  // Restaura a track no estado
  state.currentTrack = last.track;
  state.queue = last.queue || [last.track];
  state.queueIndex = last.queueIndex || 0;
  state.currentPlaylist = last.currentPlaylist || null;
  state.currentPlaylistName = last.currentPlaylistName || null;
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
