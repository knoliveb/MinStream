# MinStream

MinStream é um streaming de música em página única (SPA/PWA) escrito em HTML, CSS e JavaScript puros, sem frameworks, sem build e sem backend próprio. A reprodução usa a YouTube IFrame API (via domínio `youtube-nocookie.com`, em modo de privacidade) e a busca usa instâncias públicas de Piped/Invidious como fonte de metadados — nenhuma API key é necessária. Todos os dados do usuário ficam no `localStorage` do navegador.

## Estrutura de arquivos

| Arquivo | Papel |
|---|---|
| `index.html` | Layout base: topbar com busca, sidebar, player dock, player expandido, painel de fila, tab bar mobile e modais. |
| `app.js` | Núcleo da aplicação: estado global, player, views (Início, Buscar, Biblioteca, Perfil), playlists do usuário, curtidas, histórico, links salvos, gostos e AdShield. |
| `recommendations.js` | Motor de recomendação client-side (`Reco`): monta um perfil a partir de curtidas/histórico/gostos e gera "Mixes para Você" e "Novidades". Deve ser carregado **antes** de `app.js`. |
| `lyrics.js` | Módulo de letra sincronizada (`Lyrics`): busca a letra da faixa no LRCLIB (serviço aberto/gratuito), sincroniza linha a linha com a reprodução e preenche os containers de letra dos dois players expandidos. Autocontido — apenas lê o estado do app; carregado **depois** de `app.js`. |
| `style.css` | Todo o estilo, incluindo tema escuro, responsividade mobile (≤768px) e animações. |
| `manifest.json` | Manifesto PWA (instalável, tela cheia, tema escuro). |

## Como executar

Por usar `fetch` e a IFrame API, a aplicação deve ser servida por HTTP (não abrir via `file://`):

```bash
# qualquer servidor estático serve, por exemplo:
python3 -m http.server 8080
# ou
npx serve .
```

Depois acesse `http://localhost:8080`.

## Funcionalidades

### Reprodução
- Player fixo (dock) com play/pause, anterior/próximo, aleatório, repetir (off/all/one), volume, mudo e barra de progresso com arraste.
- Player expandido com três modos: **Vídeo**, **Capa** (áudio continua) e **Fila**, além de **Modo TV** (tela cheia).
- Fila de reprodução local e suporte a playlists do YouTube (via URL).
  - A fila local pode ser **reordenada por drag and drop** (alça em cada item, mouse ou toque), tanto no painel lateral da fila quanto na aba **Fila** do player expandido; a ordem de reprodução (próxima/anterior) passa a seguir a nova disposição e a faixa em execução é preservada. A fila de playlists do YouTube é gerida pelo player embutido e não é reordenável.
- Retomada da última faixa tocada entre sessões.
- **Sem legendas**: as legendas dos vídeos (inclusive as automáticas) são desativadas em todos os vídeos, em cada início de reprodução.
- VU meter animado e "videoclipes relacionados" no modo expandido.
- **Letra sincronizada (estilo Spotify)**: nos dois players expandidos (desktop e mobile), um container de **Letra** aparece logo após os controles do player e antes de "Videoclipes relacionados". A letra vem do **[LRCLIB](https://lrclib.net)** — serviço open source, gratuito e sem API key (formato LRC):
  - **Fundo opaco na cor da capa**: o container é um cartão opaco cuja cor acompanha a cor de destaque da capa da faixa (a thumbnail é amostrada num canvas; o matiz dominante vira um tom escuro de fundo, com o texto em escala de branco para contraste estável). Capas acinzentadas ou ilegíveis caem num fallback neutro escuro; a cor transiciona suavemente na troca de faixa e fica em cache por capa.
  - Quando existe letra **sincronizada**, a linha em execução é destacada e **a rolagem acompanha a letra**: um seguidor contínuo (rAF, aproximação exponencial ~600ms com teto de velocidade) desliza o scroll até a linha ativa no ritmo da música — sem saltos bruscos por linha. Rolagem manual pausa o seguidor por ~4s; **clicar em uma linha busca aquele instante** da faixa (reusa o `seekToTime` da barra de progresso); `prefers-reduced-motion` posiciona sem animar.
  - **Alternador com/sem sincronização**: no canto superior direito do container há um botão "Sincronizada / Sem sincronia" que alterna entre a letra acompanhando a reprodução e o texto completo estático (preferência persistida, válida para os dois players; o botão só aparece quando há letra sincronizada).
  - Quando só existe a versão **sem timestamps**, a letra é exibida como texto estático; quando não há letra (ou a faixa é instrumental), o container mostra **"Sem letra disponível"**.
  - A correspondência limpa os metadados vindos do YouTube (remove "(Official Video)", "Artista - " duplicado, sufixos "VEVO"/"- Topic" etc.) e escolhe o melhor resultado por proximidade de duração e afinidade de artista/título, preferindo letras sincronizadas. Busca sob demanda (só com um player expandido aberto), com cache em memória por faixa e sem cache de falhas de rede.
  - A seção pode ser **ativada/ocultada em Perfil → Configurações** ("Letra da música"), como as demais funcionalidades. No celular, também é possível ocultá-la **por modo do player** (Vídeo, Capa ou Fila) em "Player mobile — personalizar exibição", junto com os controles e os videoclipes relacionados.
- Atalhos de teclado: `Espaço`, `Shift+←/→`, `M`, `S`, `R`, `L`, `T`, `F`, `Q`, `?`.

### Perfil do artista
- Ao pesquisar por um artista, um cartão **"Artista — Ver perfil"** aparece acima dos resultados quando a pesquisa corresponde a um canal do YouTube; o nome do artista em qualquer linha de resultado também é clicável.
- A página de perfil reúne o conteúdo do canal do artista no YouTube: avatar, banner (quando disponível), inscritos, descrição, botão **Tocar tudo** e a lista de vídeos do canal, ranqueada do mais reproduzido para o menos (as APIs públicas retornam o lote mais recente do canal, ~30 vídeos).
- **Estrutura pré-existente**: a página é criada uma única vez (template persistente com referências diretas aos campos) e reaproveitada em todas as visitas — abrir um artista apenas preenche os campos. Ela aparece instantaneamente com o nome já preenchido e um skeleton (avatar e linhas com shimmer) enquanto os dados chegam; os dois fetches de resolução (vídeos e canais) correm em paralelo e a busca do conteúdo do canal tem prazo total de 8s antes de cair no fallback.
- **Resiliência**: a montagem tenta três caminhos — busca de canais → conteúdo do canal; ID do canal extraído dos próprios resultados de vídeo (`uploaderUrl`/`authorId`); e, se os endpoints de canal estiverem fora, um fallback garantido monta o perfil com os vídeos do artista vindos da busca comum (com aviso na página). Falhas não ficam em cache, então uma nova visita tenta o canal completo de novo.

### Busca
- Busca por texto (Piped/Invidious, com fallback entre instâncias) e por URL do YouTube (vídeo ou playlist), com pré-visualização e botão **Salvar**.
- Histórico de pesquisas recentes.
- Seção **Explorar seus Gostos**: carrossel horizontal de cards de gênero (degradê cinza-escuro → verde) que disparam a busca.
- Seção **Tendências**: carrossel de cards (capa 16:9, play no hover, título e "artista · reproduções", artista clicável para o perfil). O conteúdo vem em duas camadas: **pessoal** (primária) — o mais visto no YouTube dentro dos seus gostos, combinando buscas derivadas dos gêneros (Tastes) e dos artistas mais tocados (PlayStats), deduplicadas por vídeo e ordenadas por views, com teto de 12 buscas em lotes de 3; e **geral** (fallback) — o trending de música das últimas 24 horas, quando você ainda não tem gostos ou as buscas pessoais não retornam nada. Cache de 30 min.

### Playlists e biblioteca
- **Playlists do usuário**: criar, excluir, adicionar/remover faixas, exportar/importar JSON — as ações **Nova**, **Exportar** e **Importar** ficam no menu **"..."** ao lado de "Suas Playlists" no Início.
  - Faixas duplicadas (mesmo ID) são bloqueadas em qualquer caminho — adição manual, salvamento de mixes pelo sistema e importação de JSON; dados legados são saneados automaticamente ao carregar.
  - Ordenação padrão da faixa mais recente para a mais antiga (novas faixas entram no topo).
  - Reordenação por **drag and drop** pela alça de arrastar (funciona com mouse e toque), tanto na Home quanto na Biblioteca; a ordem é persistida.
- **Curtidas**: playlist virtual espelhando os likes (adicionar = curtir).
- **Recentes**: histórico completo de reprodução — todas as reproduções guardadas (até 100), incluindo faixas do YouTube recriadas a partir dos metadados após um reload.
- **Links Salvos**: galeria de vídeos/playlists do YouTube salvos, com fixar no topo e ocultar da Home.

### Recomendações
- **Sistema de acurácia por reprodução**: todo conteúdo vindo do YouTube (busca, playlists dinâmicas, mixes, novidades, relacionados) é ranqueado pela quantidade de reproduções — o mais reproduzido é considerado mais relevante e aparece primeiro; o menos reproduzido, por último. A contagem é exibida nos resultados da busca (ex.: "5,4 mi reproduções").
- **Contagem local de reproduções (`PlayStats`)**: o app registra quantas vezes você toca cada faixa (persistente, além dos 100 eventos do histórico). Artistas e faixas que você mais reproduz ganham peso no perfil de gosto e nos mixes; no "Descobrir", o já conhecido é penalizado para privilegiar o novo.
- **Feitas para Você**: playlists dinâmicas geradas a partir dos gêneros do perfil.
- **Mixes para Você**: "Mix do dia" e "Descobrir" (semente estável por dia), com opção de salvar como playlist — o ranqueamento combina afinidade de artista, popularidade global (views, escala log com teto), afinidade pessoal de replay, recência e diversidade.
- **Playlists prontas do YouTube**: até 3 playlists públicas do YouTube alinhadas aos seus gostos aparecem ao lado dos mixes (cache de 6h; renovadas no botão "Atualizar"); tocar uma delas usa o player nativo de playlists.
- **Rádio contínuo (retenção)**: quando a fila local termina e o repeat está desligado, o app não para — estende a fila automaticamente com sugestões parecidas (perfil + faixa atual) e segue tocando.
- **Novidades para Você**: lançamentos recentes dos artistas/gêneros que você ouve (cache de 6h).

### Perfil e proteção
- **Organização em seções recolhíveis**: abaixo do cabeçalho (avatar, nome e resumo, sempre visíveis), a página é dividida em três seções na ordem **Gostos → Métricas → Configurações**, todas **recolhidas por padrão** a cada carregamento. Cada cabeçalho mostra um resumo do conteúdo (ex.: gêneros escolhidos, horas/reproduções, estado da proteção) e expande/recolhe ao toque, com `aria-expanded` e animação (respeitando `prefers-reduced-motion`). Dentro da sessão, o estado aberto/fechado é preservado entre re-renders — adicionar um gosto ou alternar o AdShield não fecha a seção em uso.
- **Nome personalizável**: o nome de exibição do perfil pode ser editado (botão "Editar" ao lado do nome); o avatar mostra a inicial do nome. Apenas apresentação — não afeta nenhuma lógica.
- **Seção Gostos**: edição dos gêneros que alimentam as playlists dinâmicas, com sugestões.
- **Seção Métricas**:
  - Estatísticas de uso (horas, reproduções, curtidas, playlists, links salvos, gostos).
  - **Quem você mais escuta**: cards com os artistas mais relevantes do seu perfil (curtidas + histórico + contagem de reproduções, via `Reco.buildProfile`), com a contagem local de reproduções; tocar em um card abre o perfil do artista.
  - **Faixas mais tocadas**: top 5 do `PlayStats`, com a contagem por faixa; clicar reproduz a faixa usando o próprio ranking como fila.
  - **Gêneros que você mais ouve**: barras proporcionais ao peso de cada gênero no perfil de gosto.
- **Seção Configurações**:
  - **AdShield**: filtro de conteúdo patrocinado + player em modo de privacidade.
  - **Letra da música (sincronizada)**: mostra/oculta a seção de letra dos players expandidos (via LRCLIB). Preferência persistida e refletida na hora nos players abertos.
  - **Takeout (portabilidade de dados)**: baixa um arquivo `.json` com **todos** os dados do usuário salvos no `localStorage` (playlists, curtidas, links salvos, gostos, histórico, estatísticas, preferências e caches — todas as chaves `vibefm_*` e `minstream_*`). O mesmo arquivo pode ser **importado** em outro dispositivo, e a importação é **aditiva**: nada do que já existe é sobrescrito — os dados do arquivo são **somados** aos locais, respeitando o formato e os limites de cada módulo:
    - **Playlists**: playlists novas entram; nas de mesmo ID, as faixas que faltam são acrescentadas (dedupe pela mesma chave `l:`/`y:` do `UserPlaylists`), preservando nome e ordem locais.
    - **Curtidas, links salvos, gostos, buscas recentes, fixados/ocultos**: união sem duplicados (gostos e buscas deduplicam sem diferenciar maiúsculas; links pela chave `id|list`, com os mesmos tetos: 60 links, 5 buscas).
    - **Histórico**: união por (faixa, instante), ordenado do mais recente para o mais antigo, teto de 100.
    - **Contagem de reproduções (`PlayStats`)**: as reproduções dos dois dispositivos são **somadas** por faixa (metadados locais vencem, `last` = mais recente), com a mesma poda de 600 entradas; o contador do AdShield também é somado.
    - **Preferências escalares** (nome do perfil, AdShield on/off, modo do player, última faixa): o valor local é preservado; o importado só entra se a chave não existir.
    - Reimportar o mesmo arquivo não duplica nada nos dados estruturais (apenas os contadores somam de novo, por serem somas). Após a importação, a página é recarregada para o app re-hidratar o estado pelos caminhos normais de boot.
- **AdShield**: filtra conteúdo patrocinado das buscas/recomendações e usa o player em modo de privacidade.

### Mobile (≤768px)
- Tab bar inferior estilo iOS, modais como bottom sheets e alvos de toque maiores.
- No player expandido, o conteúdo reserva exatamente a altura da barra de controles — nada fica cortado ou encoberto (incluindo "Videoclipes relacionados").
- Nas listas de faixas, as ações **Adicionar à playlist** e **Salvar link** ficam concentradas no menu **"..."** de cada linha, e a numeração da lista é ocultada.

## Persistência (localStorage)

| Chave | Conteúdo |
|---|---|
| `vibefm_user_playlists` | Playlists criadas pelo usuário |
| `vibefm_liked` / `vibefm_liked_meta` | IDs curtidos e metadados para recomendação |
| `vibefm_history` | Histórico de reprodução (últimas 100) |
| `vibefm_tastes` | Gêneros favoritos |
| `vibefm_play_stats` | Contagem local de reproduções por faixa (sinal de relevância) |
| `vibefm_taste_yt_playlists` | Cache das playlists prontas do YouTube por gosto (6h) |
| `vibefm_trending_cache` | Cache das Tendências (30 min) |
| `vibefm_player_mode` | Modo do player expandido |
| `vibefm_news_cache` | Cache de "Novidades" |
| `minstream_last_track` | Última faixa tocada (retomada) |
| `vibefm_profile` | Personalização do perfil (nome de exibição) |
| `minstream_mp_prefs` | Personalização do player mobile por modo: controles, letra e videoclipes relacionados |
| `minstream_lyrics` | Preferência de exibição da letra sincronizada nos players ('1' padrão / '0' oculta) |
| `minstream_lyrics_sync` | Modo da letra: sincronizada ('1' padrão) ou texto completo sem sincronização ('0') |

O **Takeout** (Perfil) exporta todas as chaves acima (prefixos `vibefm_` e `minstream_`) em um único arquivo `.json`; a importação em outro dispositivo é **aditiva** — soma os dados aos existentes, sem sobrescrever nada.

**Atualização a cada recarga**: sempre que a página é atualizada (F5), os caches persistentes de conteúdo dinâmico (Novidades, Tendências, playlists por gosto) são invalidados no boot — tudo é rebuscado com dados frescos. Dentro da sessão os caches continuam valendo, para não sobrecarregar as instâncias públicas.

O botão **Exportar** (no menu "..." da Home) gera um backup das playlists em JSON; **Importar** restaura (playlists com IDs já existentes são ignoradas e faixas duplicadas dentro de cada playlist são removidas).

## Performance
- **Render seletivo**: o `updatePlayerUI` (chamado 2×/s pelo poll de progresso) usa dirty-checking — só escreve no DOM o que mudou; a varredura das linhas de faixa (equalizer) roda apenas na troca de faixa ou play/pause.
- **Listas virtualizadas pelo navegador**: linhas de faixa, itens de fila e cards usam `content-visibility: auto`, pulando layout/render do que está fora da tela (relevante nos 100 itens de Recentes).
- **Canvases econômicos**: VU meter a ~30fps e partículas de fundo a ~25fps com movimento baseado em tempo, menos partículas (36 desktop / 22 mobile), distância ao quadrado no laço O(n²) e pausa total com a aba oculta.
- **Animações no compositor**: `transition: all` foi substituído por listas explícitas de propriedades baratas; o pulso do botão play anima `transform/opacity` em pseudo-elemento (sem repaint de `box-shadow`).
- **Mobile**: blurs da topbar/tab bar reduzidos (12–14px) — mesmo visual, fração do custo por frame no scroll; imagens com `loading="lazy"` e `decoding="async"`.
- **Acessibilidade**: `prefers-reduced-motion` desliga partículas e reduz animações/transições ao essencial.

## Notas técnicas

- `TRACKS` é um registro em memória populado dinamicamente (buscas, playlists dinâmicas e do usuário); não há catálogo pré-carregado.
- IDs de faixa: locais (`trackId`) ou do YouTube (`yt_<videoId>`); dentro das playlists cada item usa a chave `l:<trackId>` ou `y:<videoId>`, que também é o critério de deduplicação.
- A busca alterna automaticamente entre instâncias Piped/Invidious quando uma falha.
- Sem dependências externas além das fontes do Google Fonts, da IFrame API do YouTube e da API pública do LRCLIB (letras; open source, sem chave).
