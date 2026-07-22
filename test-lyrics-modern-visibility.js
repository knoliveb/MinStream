/*
 * Testa, com o lyrics.js REAL, quando o container de letra do player
 * expandido (desktop) entra ou não na tela:
 *  - enquanto a busca corre, ele fica marcado como "pendente";
 *  - sem letra / instrumental, marcado como "sem letra";
 *  - com letra sincronizada ou texto simples, sem marca nenhuma;
 *  - o container do MOBILE nunca recebe essas marcas (lá o aviso
 *    "Buscando letra…" continua aparecendo).
 * E confere no style.css que, no layout MODERNO, as três marcas
 * (.hidden, .lyrics-none, .lyrics-pending) escondem o container — e que
 * o clássico continua mostrando o aviso durante a busca.
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

const sandboxGlobals = {
  state: { currentTrack: { videoId: 'v1', title: 'Faixa', artist: 'Artista' }, currentTime: 0, duration: 200, apiReady: false },
  isExpanded: true,
  expandedIsMobile: false, // desktop: o caso do layout moderno
  seekToTime: () => {},
  showToast: () => {},
  syncLyricsPage: () => {},
};

window.fetch = () => new Promise(() => {}); // LRCLIB nunca responde no teste
Object.assign(window, sandboxGlobals);

function run(code) {
  const s = document.createElement('script');
  s.textContent = code;
  document.body.appendChild(s);
}
run(Object.keys(sandboxGlobals).map(k => `var ${k} = window.${k};`).join('\n'));

let src = fs.readFileSync(base + 'lyrics.js', 'utf8');
const marca = '  return { enabled, setEnabled, applyVisibility, pageOpen, closePage };';
if (!src.includes(marca)) throw new Error('assinatura do módulo mudou; ajuste o teste');
src = src.replace(marca,
  '  window.__setEntry = function (entry) { cur = entry; curKey = "v1"; renderCurrent(); };\n' + marca);
run(src);

const exp = document.getElementById('exp-lyrics');
const mpScroll = document.getElementById('mp-lyrics-scroll');
const expScroll = document.getElementById('exp-lyrics-scroll');

const resultados = [];
function checa(nome, cond) {
  resultados.push([nome, !!cond]);
  console.log((cond ? '  ok  ' : ' FALHA') + '  ' + nome);
}
const tem = (c) => exp.classList.contains(c);

const linhas = [{ t: 0, text: 'linha um' }, { t: 5, text: 'linha dois' }];

checa('o container desktop existe', !!exp);

// 1) Busca em andamento -> pendente (o moderno esconde; o clássico avisa)
window.__setEntry(null);
checa('durante a busca fica marcado como pendente', tem('lyrics-pending'));
checa('durante a busca NÃO fica marcado como sem letra', !tem('lyrics-none'));
checa('o texto "Buscando letra" continua montado para o clássico',
  /Buscando letra/.test(expScroll.textContent));

// 2) Resolveu sem letra -> some de vez (nos dois layouts, como já era)
window.__setEntry({ status: 'none' });
checa('sem letra marca lyrics-none', tem('lyrics-none'));
checa('sem letra limpa a marca de pendente', !tem('lyrics-pending'));

// 3) Instrumental -> mesmo tratamento
window.__setEntry({ status: 'instrumental' });
checa('faixa instrumental marca lyrics-none', tem('lyrics-none'));
checa('faixa instrumental não fica pendente', !tem('lyrics-pending'));

// 4) Letra sincronizada -> container visível
window.__setEntry({ status: 'synced', lines: linhas, plain: 'linha um\nlinha dois' });
checa('letra sincronizada libera o container', !tem('lyrics-none') && !tem('lyrics-pending'));
checa('a letra foi montada no container desktop',
  expScroll.querySelectorAll('.lyrics-line').length === 2);

// 5) Só texto simples -> também visível
window.__setEntry({ status: 'plain', plain: 'verso um\nverso dois' });
checa('letra sem sincronização também libera o container',
  !tem('lyrics-none') && !tem('lyrics-pending'));

// 6) Voltar para uma faixa em busca esconde de novo
window.__setEntry(null);
checa('a faixa seguinte volta a esconder enquanto busca', tem('lyrics-pending'));

// 7) O mobile não é afetado
const mpRoot = document.getElementById('mp-lyrics');
checa('o container mobile não recebe a marca de pendente',
  !mpRoot || !mpRoot.classList.contains('lyrics-pending'));
checa('o aviso continua visível no player mobile', /Buscando letra/.test(mpScroll.textContent));

// ---- regras de estilo -------------------------------------------------
const css = fs.readFileSync(base + 'style.css', 'utf8');
const bloco = /#expanded-player\.layout-modern \.exp-lyrics\.hidden,\s*#expanded-player\.layout-modern \.exp-lyrics\.lyrics-none,\s*#expanded-player\.layout-modern \.exp-lyrics\.lyrics-pending \{\s*display: none;/;
checa('no moderno as três marcas escondem o container', bloco.test(css));
checa('a preferência do usuário (.hidden) tem especificidade suficiente no moderno',
  css.includes('#expanded-player.layout-modern .exp-lyrics.hidden'));
checa('o palco fica centralizado enquanto a letra não chega',
  css.includes(':has(> .exp-lyrics.lyrics-pending) .exp-stage'));
checa('o clássico NÃO esconde durante a busca (só .hidden e .lyrics-none)',
  !/^\.exp-lyrics\.lyrics-pending/m.test(css));
checa('a entrada do container tem animação no moderno', /@keyframes lyrics-reveal/.test(css));
checa('a animação respeita prefers-reduced-motion',
  /prefers-reduced-motion[\s\S]{0,400}layout-modern \.exp-lyrics \{ animation: none/.test(css));

const falhas = resultados.filter(r => !r[1]);
console.log(falhas.length ? '\nFALHOU: ' + falhas.length + ' verificação(ões)' : '\nPASSOU');
process.exit(falhas.length ? 1 : 0);
