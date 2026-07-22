/*
 * Testa a aba "Playlists" do perfil do artista com o app.js REAL:
 *  - a aba nasce escondida e so aparece quando ha playlists;
 *  - mostra a contagem;
 *  - a lista vira cartoes (capa, contagem de videos, titulo, salvar);
 *  - tocar um cartao manda o ID certo para o player;
 *  - salvar guarda a playlist em "Links Salvos";
 *  - capa quebrada cai para os metadados oficiais;
 *  - voltar para "Tudo" volta a desenhar os videos.
 *
 * Sem rede: as funcoes de busca sao substituidas por dublês.
 */
const { JSDOM } = require('/home/claude/node_modules/jsdom');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

function grabFn(name) {
  const heads = ['\nfunction ' + name + '(', '\nasync function ' + name + '('];
  let start = -1;
  for (const h of heads) {
    const i = src.indexOf(h);
    if (i !== -1) { start = i + 1; break; }
  }
  if (start === -1) throw new Error('funcao nao encontrada em app.js: ' + name);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('chaves desbalanceadas em ' + name);
}
function grabLine(rx, label) {
  const m = rx.exec(src);
  if (!m) throw new Error('declaracao nao encontrada: ' + label);
  return m[0].replace(/^(const|let) /, 'var ');
}

const dom = new JSDOM('<!doctype html><body><main id="main"></main></body>', { pretendToBeVisual: true });
const { window } = dom;

// ---- dublês do que a pagina do artista consome -------------------------
let tocou = null;
let salvou = null;
let metaPedida = 0;

const sandbox = {
  console, window,
  document: window.document,
  Image: window.Image,
  MouseEvent: window.MouseEvent,
  main: window.document.getElementById('main'),
  isValidPlaylistId: (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{12,50}$/.test(id),
  playlistMetaCache: new Map(),
  playFromUrl: (url) => { tocou = url; },
  fetchPlaylistMeta: (id) => { metaPedida++; return Promise.resolve({ title: 'Nome oficial', cover: 'oficial.jpg' }); },
  Gallery: { save: (data) => { salvou = data; return true; } },
  Follows: { isFollowing: () => false, follow: () => {}, unfollow: () => {}, updateAvatar: () => {} },
  showToast: () => {},
  backButton: () => '<button class="back-btn"></button>',
  playYouTubeResult: () => {},
  renderHomeFollows: () => {},
  escapeHtml: (t) => String(t),
  fmtCompact: (n) => String(n),
  renderYtSearchResults: (container, results) => {
    container.replaceChildren();
    const marca = window.document.createElement('div');
    marca.className = 'lista-de-videos';
    marca.textContent = results.length + ' videos';
    container.appendChild(marca);
  },
};

const code = [
  grabLine(/let artistPlaylists = \[\];/, 'artistPlaylists'),
  grabLine(/let artistPlaylistsFromSearch = [^\n]+/, 'artistPlaylistsFromSearch'),
  grabLine(/let artistPlaylistsToken = [^\n]+/, 'artistPlaylistsToken'),
  grabLine(/let artistActiveTab = [^\n]+/, 'artistActiveTab'),
  grabLine(/let artistDisplayedVideos = \[\];/, 'artistDisplayedVideos'),
  grabLine(/let currentArtistProfile = [^\n]+/, 'currentArtistProfile'),
  grabLine(/let artistPageEl = [^\n]+/, 'artistPageEl'),
  grabLine(/const artistRefs = \{\};/, 'artistRefs'),
  grabLine(/const PLAYLIST_COVER_FALLBACK = [^\n]+/, 'PLAYLIST_COVER_FALLBACK'),
  grabFn('ensureArtistPage'),
  grabFn('updateArtistFollowBtn'),
  grabFn('setArtistTab'),
  grabFn('sortArtistVideos'),
  grabFn('artistTabNote'),
  grabFn('renderArtistVideos'),
  grabFn('renderArtistPlaylists'),
  grabFn('artistPlaylistCard'),
  grabFn('updateArtistPlaylistsTab'),
  grabFn('playArtistPlaylist'),
].join('\n\n');

vm.createContext(sandbox);
vm.runInContext(code, sandbox);

const resultados = [];
function checa(nome, cond) {
  resultados.push([nome, !!cond]);
  console.log((cond ? '  ok  ' : ' FALHA') + '  ' + nome);
}
function tap(el) { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); }

const PLID = 'PLtemporada20AbCdEfGhIjKlMnOpQrSt';
const playlists = [
  { playlistId: PLID, title: 'Temporada 20', author: 'MasterChef Brasil', videos: 42, thumbnail: 'capa1.jpg' },
  { playlistId: 'PLprovasAbCdEfGhIjKlMnOpQrStUvWx', title: 'Provas Criativas', author: '', videos: 1, thumbnail: '' },
];

// Monta a pagina e o perfil
const page = sandbox.ensureArtistPage();
sandbox.main.replaceChildren(page);
sandbox.currentArtistProfile = { name: 'MasterChef Brasil', videos: [{ videoId: 'aaaaaaaaaaa' }, { videoId: 'bbbbbbbbbbb' }] };

const tabBtn = page.querySelector('.artist-tab[data-tab="playlists"]');
checa('a aba Playlists existe no template', !!tabBtn);
checa('a referencia tabPlaylists foi capturada', sandbox.artistRefs.tabPlaylists === tabBtn);
checa('a aba nasce escondida', tabBtn.hidden === true);

// Sem playlists: continua escondida
sandbox.updateArtistPlaylistsTab();
checa('sem playlists a aba segue escondida', tabBtn.hidden === true);

// Chegaram playlists
sandbox.artistPlaylists = playlists;
sandbox.updateArtistPlaylistsTab();
checa('com playlists a aba aparece', tabBtn.hidden === false);
checa('a aba mostra a contagem', /2/.test(tabBtn.textContent));

// Abre a aba
sandbox.setArtistTab('playlists');
const grid = sandbox.artistRefs.videos.querySelector('.album-grid');
checa('a aba desenha uma grade de cartoes', !!grid);
checa('um cartao por playlist', grid.querySelectorAll('.playlist-card').length === 2);
checa('a nota explica a origem das playlists', /canal/i.test(sandbox.artistRefs.listNote.textContent));

const card = grid.querySelector('.playlist-card');
checa('o cartao mostra o titulo', card.querySelector('.album-title').textContent === 'Temporada 20');
checa('o cartao mostra o autor', /MasterChef Brasil/.test(card.querySelector('.album-artist').textContent));
checa('o cartao usa a capa da playlist', card.querySelector('img').getAttribute('src') === 'capa1.jpg');
checa('o cartao mostra a contagem de videos', card.querySelector('.playlist-card-badge').textContent === '42 vídeos');
checa('singular correto com um video',
  grid.querySelectorAll('.playlist-card')[1].querySelector('.playlist-card-badge').textContent === '1 vídeo');

// Capa quebrada -> metadados oficiais
const img = card.querySelector('img');
img.dispatchEvent(new window.Event('error'));
checa('capa quebrada busca os metadados oficiais', metaPedida === 1);
setTimeout(() => {}, 0);

// Salvar nao pode tocar a playlist
tocou = null;
tap(card.querySelector('.playlist-card-save'));
checa('salvar guarda a playlist', salvou && salvou.list === PLID && salvou.title === 'Temporada 20');
checa('salvar nao dispara a reproducao', tocou === null);

// Tocar
tap(card);
checa('tocar o cartao manda a playlist para o player',
  tocou === 'https://www.youtube.com/playlist?list=' + PLID);
checa('o nome da playlist e semeado para o cabecalho',
  (sandbox.playlistMetaCache.get(PLID) || {}).title === 'Temporada 20');

// ID invalido nao toca
tocou = null;
sandbox.playArtistPlaylist({ playlistId: 'curto', title: 'x' });
checa('playlist com ID invalido nao toca', tocou === null);

// Voltar para Tudo redesenha os videos
sandbox.setArtistTab('all');
checa('voltar para Tudo redesenha os videos',
  !!sandbox.artistRefs.videos.querySelector('.lista-de-videos'));
checa('a aba Playlists continua disponivel', tabBtn.hidden === false);

// Trocar de canal (sem playlists) esconde a aba e volta para Tudo
sandbox.setArtistTab('playlists');
sandbox.artistPlaylists = [];
sandbox.updateArtistPlaylistsTab();
checa('canal sem playlists esconde a aba', tabBtn.hidden === true);
checa('e volta sozinho para a aba Tudo', sandbox.artistActiveTab === 'all');

const falhas = resultados.filter(r => !r[1]);
console.log(falhas.length ? '\nFALHOU: ' + falhas.length + ' verificação(ões)' : '\nPASSOU');
process.exit(falhas.length ? 1 : 0);
