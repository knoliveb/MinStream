/*
 * Testa, com o app.js REAL, o caminho novo que traz as playlists de um
 * canal para o perfil do artista:
 *  - reconhecimento de URL de canal (/@handle, /c/, /user/, /channel/UC…),
 *    inclusive com o sufixo /playlists do link do YouTube;
 *  - resolucao handle -> UCID (Piped falhando, Invidious resolvendo);
 *  - playlists pela aba de canal do Piped (/channel -> /channels/tabs);
 *  - playlists pelo endpoint direto do Invidious;
 *  - atalho quando a aba ja veio junto com o conteudo do canal;
 *  - deduplicacao, AdShield e cache;
 *  - fetchChannelContent aceitando canal sem videos (so playlists).
 *
 * As instancias publicas sao simuladas: nenhuma requisicao real de rede.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

// ---- extrai declaracoes do app.js real (sem executar o arquivo todo) ----
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
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('chaves desbalanceadas em ' + name);
}

function grabLine(rx, label) {
  const m = rx.exec(src);
  if (!m) throw new Error('declaracao nao encontrada: ' + label);
  return m[0];
}

const FNS = [
  'isValidId', 'isValidPlaylistId', 'extractVideoId', 'extractPlaylistId',
  'safeDecode', 'extractChannelRef', 'resolveChannelId',
  'normalizePipedTabPlaylists', 'normalizeInvidiousChannelPlaylists',
  'dedupePlaylists', 'fetchPipedTabPlaylists', 'pipedPlaylistTabOf',
  'fetchChannelPlaylists', 'fetchChannelContent',
  'normalizePiped', 'normalizeInvidious', 'channelIdFromUrl', 'rankByPlays',
];

// `const` no topo de um script do vm nao vira propriedade do contexto —
// o teste precisa enxergar os caches, entao viram `var`.
const asVar = (s) => s.replace(/^const /, 'var ');

const code = [
  asVar(grabLine(/const UCID_RE = [^\n]+/, 'UCID_RE')),
  asVar(grabLine(/const channelIdRefCache = new Map\(\);[^\n]*/, 'channelIdRefCache')),
  asVar(grabLine(/const channelPlaylistsCache = new Map\(\);[^\n]*/, 'channelPlaylistsCache')),
  ...FNS.map(grabFn),
].join('\n\n');

// ---- ambiente: instancias simuladas -----------------------------------
let calls = [];
let routes = {};

function reply(body, ok) {
  return Promise.resolve({ ok: ok !== false, json: () => Promise.resolve(body) });
}

const sandbox = {
  console,
  URL, // o vm nao herda os globais do Node
  encodeURIComponent, decodeURIComponent,
  YT_SEARCH_SOURCES: [
    { kind: 'piped', base: 'https://piped.test' },
    { kind: 'invidious', base: 'https://inv.test' },
  ],
  // AdShield real e testado a parte; aqui basta o contrato: filtra promo
  AdShield: {
    filter: (list) => (Array.isArray(list) ? list.filter(it => !/#publi\b/i.test(it.title || '')) : list),
  },
  PlayStats: { playsOfVideo: () => 0 },
  searchYouTubeChannels: async () => [],
  fetchWithTimeout: async (url) => {
    calls.push(url);
    for (const key of Object.keys(routes)) {
      if (url.includes(key)) return routes[key](url);
    }
    return { ok: false, json: () => Promise.resolve(null) };
  },
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

// ---- verificacoes ------------------------------------------------------
const resultados = [];
function checa(nome, cond) {
  resultados.push([nome, !!cond]);
  console.log((cond ? '  ok  ' : ' FALHA') + '  ' + nome);
}
function reset(novasRotas) {
  calls = [];
  routes = novasRotas || {};
  sandbox.channelIdRefCache.clear();
  sandbox.channelPlaylistsCache.clear();
}

const UCID = 'UCq1nGgSpVaAaBbCcDd';
// IDs de playlist do YouTube tem 34 caracteres; o app valida o formato,
// entao o teste usa IDs realistas
const PL = (nome) => (nome + 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789').slice(0, 34);
const LINK = 'https://www.youtube.com/@MasterChefBrasilOficial/playlists';

(async function () {
  // 1) Reconhecimento da URL de canal
  const ref = sandbox.extractChannelRef(LINK);
  checa('reconhece /@handle/playlists como canal', ref && ref.kind === 'handle');
  checa('extrai o nome legivel do handle', ref && ref.name === 'MasterChefBrasilOficial');
  checa('reconhece /channel/UC...', sandbox.extractChannelRef('https://www.youtube.com/channel/' + UCID + '/playlists').kind === 'id');
  checa('reconhece /c/nome', sandbox.extractChannelRef('https://www.youtube.com/c/MasterChef').kind === 'name');
  checa('reconhece /user/nome', sandbox.extractChannelRef('https://m.youtube.com/user/MasterChef').kind === 'user');
  checa('ignora URL de video', sandbox.extractChannelRef('https://www.youtube.com/watch?v=dQw4w9WgXcQ') === null);
  checa('ignora URL de playlist', sandbox.extractChannelRef('https://www.youtube.com/playlist?list=PLabcdefghij') === null);
  checa('ignora dominio de fora', sandbox.extractChannelRef('https://vimeo.com/@alguem') === null);

  // 2) handle -> UCID: Piped nao resolve, Invidious resolve
  reset({
    '/c/%40MasterChefBrasilOficial': () => reply(null, false),
    '/api/v1/resolveurl': () => reply({ ucid: UCID, pageType: 'WEB_PAGE_TYPE_CHANNEL' }),
  });
  const id = await sandbox.resolveChannelId(ref);
  checa('resolve o handle para o ID do canal', id === UCID);
  checa('tentou o Piped antes do Invidious', calls[0].includes('piped.test'));
  const antes = calls.length;
  await sandbox.resolveChannelId(ref);
  checa('a segunda resolucao vem do cache', calls.length === antes);

  // 3) Playlists pela aba de canal do Piped
  const tabData = '{"id":"' + UCID + '","contentFilters":["playlists"]}';
  reset({
    ['/channel/' + UCID]: () => reply({
      name: 'MasterChef Brasil',
      avatarUrl: 'a.jpg',
      bannerUrl: 'b.jpg',
      subscriberCount: 1234567,
      description: 'Canal oficial',
      relatedStreams: [
        { url: '/watch?v=aaaaaaaaaaa', title: 'Ep 1', uploaderName: 'MasterChef Brasil', uploaderUrl: '/channel/' + UCID, duration: 900, views: 500 },
      ],
      tabs: [{ name: 'playlists', data: tabData }],
    }),
    '/channels/tabs': (u) => {
      checa('a aba e pedida com o descritor devolvido pelo canal',
        u.includes(encodeURIComponent(tabData)));
      return reply({
        content: [
          { url: '/playlist?list=' + PL('PLtemporada20'), name: 'Temporada 20', uploaderName: 'MasterChef Brasil', videos: 42, thumbnail: 't1.jpg', type: 'playlist' },
          { url: '/playlist?list=' + PL('PLprovas'), name: 'Provas Criativas', uploaderName: 'MasterChef Brasil', videos: 17, thumbnail: 't2.jpg' },
          { url: '/playlist?list=' + PL('PLtemporada20'), name: 'Temporada 20 (duplicada)', videos: 42 },
          { url: '/playlist?list=' + PL('PLpubli'), name: 'Bloco #publi', videos: 3, type: 'playlist' },
          { url: '/watch?v=bbbbbbbbbbb', title: 'nao e playlist', type: 'stream' },
        ],
      });
    },
  });

  let pls = await sandbox.fetchChannelPlaylists({ channelId: UCID });
  checa('traz as playlists da aba do canal (Piped)', pls.length === 2);
  checa('primeira playlist com id, titulo e contagem',
    pls[0].playlistId === PL('PLtemporada20') && pls[0].title === 'Temporada 20' && pls[0].videos === 42);
  checa('descarta duplicadas pelo mesmo ID', pls.filter(p => p.playlistId === PL('PLtemporada20')).length === 1);
  checa('AdShield remove playlist promocional', !pls.some(p => /publi/i.test(p.title)));
  checa('itens que nao sao playlist ficam de fora', !pls.some(p => /nao e playlist/.test(p.title)));

  const antes2 = calls.length;
  await sandbox.fetchChannelPlaylists({ channelId: UCID });
  checa('a segunda busca do mesmo canal vem do cache', calls.length === antes2);

  // 4) Atalho: a aba ja veio junto com o conteudo do canal
  reset({
    '/channels/tabs': () => reply({ content: [{ url: '/playlist?list=' + PL('PLatalho'), name: 'Atalho', videos: 5 }] }),
    '/channel/': () => { throw new Error('nao deveria pedir o canal de novo'); },
  });
  pls = await sandbox.fetchChannelPlaylists({
    channelId: UCID, pipedBase: 'https://piped.test', pipedPlaylistTab: tabData,
  });
  checa('usa o descritor de aba ja conhecido, sem repedir o canal',
    pls.length === 1 && calls.length === 1);

  // 5) Piped fora do ar -> endpoint direto do Invidious
  reset({
    ['/channel/' + UCID]: () => reply(null, false),
    ['/api/v1/channels/' + UCID + '/playlists']: () => reply({
      playlists: [
        { playlistId: PL('PLinvidious1'), title: 'Melhores Momentos', author: 'MasterChef Brasil', videoCount: 30, playlistThumbnail: 'x.jpg' },
        { playlistId: PL('PLinvidious2'), title: 'Receitas', videoCount: 8, videos: [{ videoId: 'ccccccccccc' }] },
      ],
      continuation: null,
    }),
  });
  pls = await sandbox.fetchChannelPlaylists({ channelId: UCID });
  checa('cai para o endpoint de playlists do Invidious', pls.length === 2);
  checa('capa deduzida do primeiro video quando falta miniatura',
    pls[1].thumbnail.includes('ccccccccccc'));

  // 6) Nenhuma fonte responde -> lista vazia, sem cache negativo
  reset({});
  pls = await sandbox.fetchChannelPlaylists({ channelId: UCID });
  checa('sem fonte disponivel devolve lista vazia', pls.length === 0);
  checa('lista vazia nao entra em cache', !sandbox.channelPlaylistsCache.has(UCID));

  // 7) ID invalido nao gera requisicao
  reset({});
  pls = await sandbox.fetchChannelPlaylists({ channelId: 'nao-e-id' });
  checa('ID de canal invalido nao vai a rede', pls.length === 0 && calls.length === 0);

  // 8) fetchChannelContent: canal sem videos so passa com allowEmptyVideos
  const canalSoPlaylists = {
    name: 'Canal de Playlists',
    relatedStreams: [],
    tabs: [{ name: 'playlists', data: tabData }],
  };
  reset({ ['/channel/' + UCID]: () => reply(canalSoPlaylists), '/api/v1/channels/': () => reply({ videos: [] }) });
  let conteudo = await sandbox.fetchChannelContent({ channelId: UCID, name: '', avatar: '', subs: 0, description: '' });
  checa('canal sem videos continua sendo recusado por padrao', conteudo === null);

  reset({ ['/channel/' + UCID]: () => reply(canalSoPlaylists) });
  conteudo = await sandbox.fetchChannelContent(
    { channelId: UCID, name: '', avatar: '', subs: 0, description: '' },
    { allowEmptyVideos: true }
  );
  checa('com allowEmptyVideos o canal sem videos e aceito', !!conteudo);
  checa('e o descritor da aba de playlists vem junto',
    conteudo && conteudo.pipedPlaylistTab === tabData && conteudo.pipedBase === 'https://piped.test');

  // 9) Canal com videos segue igual ao comportamento antigo
  reset({
    ['/channel/' + UCID]: () => reply({
      name: 'MasterChef Brasil',
      relatedStreams: [
        { url: '/watch?v=aaaaaaaaaaa', title: 'Ep 1', uploaderName: 'MasterChef Brasil', duration: 900, views: 10 },
        { url: '/watch?v=bbbbbbbbbbb', title: 'Ep 2', uploaderName: 'MasterChef Brasil', duration: 900, views: 900 },
      ],
      tabs: [],
    }),
  });
  conteudo = await sandbox.fetchChannelContent({ channelId: UCID, name: '', avatar: '', subs: 0, description: '' });
  checa('canal com videos monta o perfil como antes', conteudo && conteudo.videos.length === 2);
  checa('videos continuam ranqueados por reproducoes', conteudo.videos[0].views === 900);
  checa('sem aba de playlists o descritor fica vazio', conteudo.pipedPlaylistTab === '');

  const falhas = resultados.filter(r => !r[1]);
  console.log(falhas.length ? '\nFALHOU: ' + falhas.length + ' verificação(ões)' : '\nPASSOU');
  process.exit(falhas.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
