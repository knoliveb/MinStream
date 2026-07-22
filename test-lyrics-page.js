/*
 * Testa a página de letra em tela cheia (mobile) com o lyrics.js REAL:
 *  - não abre sem letra ("Buscando letra…", "Sem letra disponível",
 *    instrumental);
 *  - abre com letra sincronizada ou texto simples;
 *  - fecha e volta para a tela anterior;
 *  - toque numa linha dentro da tela busca aquele instante;
 *  - toque numa linha do container pequeno NÃO busca (abre a tela);
 *  - troca para faixa sem letra fecha a tela sozinha.
 */
const { JSDOM } = require('/home/claude/node_modules/jsdom');
const fs = require('fs');
const base = '/home/claude/minstream/';

const html = fs.readFileSync(base + 'index.html', 'utf8')
  .replace(/<link[^>]*fonts\.[^>]*>/g, '')
  .replace(/<script[^>]*><\/script>/g, '');

const dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true, runScripts: 'dangerously' });
const { window } = dom;
const { document } = window;

// ---- ambiente mínimo que o lyrics.js lê do app.js ----
let seeked = null;
let syncCalls = 0;
const sandboxGlobals = {
  state: { currentTrack: { videoId: 'v1', title: 'Faixa', artist: 'Artista' }, currentTime: 0, duration: 200, apiReady: false },
  isExpanded: true,
  expandedIsMobile: true,
  seekToTime: (t) => { seeked = t; },
  showToast: () => {},
  syncLyricsPage: () => { syncCalls++; },
};

window.fetch = () => new Promise(() => {}); // LRCLIB nunca responde no teste
Object.assign(window, sandboxGlobals);

function run(code) {
  const s = document.createElement('script');
  s.textContent = code;
  document.body.appendChild(s);
}

// Globais do app.js que o lyrics.js lê (declaradas no escopo do script)
run(Object.keys(sandboxGlobals).map(k => `var ${k} = window.${k};`).join('\n'));

// O lyrics.js real. O gancho de teste é injetado DENTRO do módulo (antes
// do return), único jeito de alimentar um estado de letra sem rede.
let src = fs.readFileSync(base + 'lyrics.js', 'utf8');
const marca = '  return { enabled, setEnabled, applyVisibility, pageOpen, closePage };';
if (!src.includes(marca)) throw new Error('assinatura do módulo mudou; ajuste o teste');
src = src.replace(marca,
  '  window.__setEntry = function (entry) { cur = entry; curKey = "v1"; renderCurrent(); };\n' + marca);
run(src);

const page = document.getElementById('lyrics-page');
const box = document.getElementById('mp-lyrics-box');
const mpScroll = document.getElementById('mp-lyrics-scroll');
const lpScroll = document.getElementById('lp-scroll');

function tap(el) { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); }
function aberta() { return page.classList.contains('open'); }

const linhas = [
  { t: 0, text: 'linha um' },
  { t: 5, text: 'linha dois' },
  { t: 10, text: 'linha tres' },
];

const resultados = [];
function checa(nome, cond) {
  resultados.push([nome, !!cond]);
  console.log((cond ? '  ok  ' : ' FALHA') + '  ' + nome);
}

// 1) sem letra buscada ainda -> não abre
window.__setEntry(null);
tap(box);
checa('não abre enquanto busca a letra', !aberta());

// 2) "Sem letra disponível" -> não abre
window.__setEntry({ status: 'none' });
tap(box);
checa('não abre com "Sem letra disponível"', !aberta());
checa('o aviso continua visível no container', /Sem letra/.test(mpScroll.textContent));

// 3) instrumental -> não abre
window.__setEntry({ status: 'instrumental' });
tap(box);
checa('não abre em faixa instrumental', !aberta());

// 4) letra sincronizada -> abre
window.__setEntry({ status: 'synced', lines: linhas, plain: 'x' });
tap(box);
checa('abre com letra sincronizada', aberta());
checa('a letra foi copiada para a tela cheia', lpScroll.querySelectorAll('.lyrics-line').length === 3);
checa('avisa o app.js para preencher o transporte', syncCalls > 0);
checa('body marca a tela como aberta', document.body.classList.contains('lyrics-page-open'));
checa('aria-hidden = false quando aberta', page.getAttribute('aria-hidden') === 'false');

// 5) toque numa linha da tela cheia busca o instante
seeked = null;
tap(lpScroll.querySelectorAll('.lyrics-line')[2]);
checa('tocar numa linha da tela cheia busca o instante', seeked === 10);

// 6) fechar volta para a tela anterior
tap(document.getElementById('lp-close'));
checa('fecha ao tocar no botão de fechar', !aberta());
checa('body volta ao normal', !document.body.classList.contains('lyrics-page-open'));
checa('aria-hidden = true quando fechada', page.getAttribute('aria-hidden') === 'true');

// 7) no container pequeno, tocar numa linha ABRE a tela (não busca)
seeked = null;
tap(mpScroll.querySelectorAll('.lyrics-line')[1]);
checa('toque no container pequeno abre a tela', aberta());
checa('e não busca o instante por baixo', seeked === null);

// 8) botões do cabeçalho do container não abrem a tela
tap(document.getElementById('lp-close'));
const btnSync = document.getElementById('mp-lyrics-sync');
tap(btnSync);
checa('botão do cabeçalho não abre a tela', !aberta());

// 9) letra só em texto simples também abre
window.__setEntry({ status: 'plain', plain: 'verso um\nverso dois' });
tap(box);
checa('abre com letra sem sincronização', aberta());

// 10) trocar para faixa sem letra fecha a tela sozinha
window.__setEntry({ status: 'none' });
checa('faixa sem letra fecha a tela aberta', !aberta());

const falhas = resultados.filter(r => !r[1]);
console.log(falhas.length ? '\nFALHOU: ' + falhas.length + ' verificação(ões)' : '\nPASSOU');
process.exit(falhas.length ? 1 : 0);
