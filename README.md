# MinStream

MinStream é um streaming de música em página única (SPA/PWA) escrito em HTML, CSS e JavaScript puros, sem frameworks, sem build e sem backend próprio. A reprodução usa a YouTube IFrame API (via domínio `youtube-nocookie.com`, em modo de privacidade) e a busca usa instâncias públicas de Piped/Invidious como fonte de metadados — nenhuma API key é necessária. Todos os dados do usuário ficam no `localStorage` do navegador.

## Estrutura de arquivos

| Arquivo | Papel |
|---|---|
| `index.html` | Layout base: topbar com busca, sidebar, player dock, player expandido, painel de fila, tab bar mobile e modais. |
| `app.js` | Núcleo da aplicação: estado global, player, views (Início, Buscar, Biblioteca, Perfil), playlists do usuário, curtidas, histórico, links salvos, gostos e AdShield. |
| `recommendations.js` | Motor de recomendação client-side (`Reco`): monta um perfil a partir de curtidas/histórico/gostos e gera "Mixes para Você" e "Novidades". Deve ser carregado **antes** de `app.js`. |
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
- Atalhos de teclado: `Espaço`, `Shift+←/→`, `M`, `S`, `R`, `L`, `T`, `F`, `Q`, `?`.

### Busca
- Busca por texto (Piped/Invidious, com fallback entre instâncias) e por URL do YouTube (vídeo ou playlist), com pré-visualização e botão **Salvar**.
- Histórico de pesquisas recentes.
- Seção **Explorar seus Gostos**: cards de gênero (com degradê cinza-escuro → verde) que disparam a busca.
- Seção **Tendências**: as músicas em alta no YouTube nas últimas 24 horas (trending de música via Invidious, com fallback para o trending do Piped), ordenadas da mais reproduzida para a menos, com contagem de reproduções, cache de 30 min e as mesmas ações por faixa (tocar, adicionar, salvar, menu "..." no mobile).

### Playlists e biblioteca
- **Playlists do usuário**: criar, excluir, adicionar/remover faixas, exportar/importar JSON.
  - Faixas duplicadas (mesmo ID) são bloqueadas em qualquer caminho — adição manual, salvamento de mixes pelo sistema e importação de JSON; dados legados são saneados automaticamente ao carregar.
  - Ordenação padrão da faixa mais recente para a mais antiga (novas faixas entram no topo).
  - Reordenação por **drag and drop** pela alça de arrastar (funciona com mouse e toque), tanto na Home quanto na Biblioteca; a ordem é persistida.
- **Curtidas**: playlist virtual espelhando os likes (adicionar = curtir).
- **Recentes**: histórico das últimas faixas tocadas.
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
- Edição dos **gostos** (gêneros) que alimentam as playlists dinâmicas, com sugestões.
- Estatísticas de uso (horas, curtidas, playlists, gostos).
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

O botão **Exportar** na Home gera um backup das playlists em JSON; **Importar** restaura (playlists com IDs já existentes são ignoradas e faixas duplicadas dentro de cada playlist são removidas).

## Notas técnicas

- `TRACKS` é um registro em memória populado dinamicamente (buscas, playlists dinâmicas e do usuário); não há catálogo pré-carregado.
- IDs de faixa: locais (`trackId`) ou do YouTube (`yt_<videoId>`); dentro das playlists cada item usa a chave `l:<trackId>` ou `y:<videoId>`, que também é o critério de deduplicação.
- A busca alterna automaticamente entre instâncias Piped/Invidious quando uma falha.
- Sem dependências externas além das fontes do Google Fonts e da IFrame API do YouTube.
