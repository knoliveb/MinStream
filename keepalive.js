/*
 * MinStream — keepalive.js (Android)
 *
 * Complemento do serviço nativo de segundo plano. Alguns aparelhos pausam o
 * player do YouTube no instante em que o app sai da tela. Este vigia observa
 * o estado do player (pelas mensagens que o iframe do YouTube envia à página,
 * o mesmo canal que a IFrame API usa) e, se detectar uma pausa NÃO pedida
 * pelo usuário logo após o app ir para segundo plano, manda o comando de
 * retomar.
 *
 * Regras para nunca brigar com o usuário:
 *  - só age se estava TOCANDO no momento em que o app saiu da tela;
 *  - só age nos primeiros 15s após sair da tela (pausas do sistema são
 *    imediatas) e no máximo 5 vezes — depois disso qualquer pausa é
 *    respeitada (ex.: botão do fone bluetooth);
 *  - não faz nada com o app visível.
 *
 * Nenhuma alteração em app.js é necessária.
 */
(function () {
  'use strict';

  var PLAYING = 1, PAUSED = 2, BUFFERING = 3;

  var lastState = -1;
  var wasPlayingBeforeHide = false;
  var hiddenAt = 0;
  var resumeAttempts = 0;

  /* "Tocando agora" lido pelo lado nativo (MainActivity faz polling deste
   * objeto em segundo plano e alimenta a MediaSession/notificação). */
  var nowPlaying = {
    title: '', artist: '', playing: false,
    position: 0, duration: 0, videoId: '', artUrl: ''
  };
  window.__msNowPlaying = nowPlaying;

  function ytIframe() {
    return document.querySelector(
      'iframe[src*="youtube.com/embed"], iframe[src*="youtube-nocookie.com/embed"]'
    );
  }

  // O iframe do YouTube publica o estado do player para a página (infoDelivery)
  window.addEventListener('message', function (e) {
    if (typeof e.data !== 'string') return;
    if (!e.origin || e.origin.indexOf('youtube') === -1) return;
    try {
      var d = JSON.parse(e.data);
      var info = d && d.info;
      if (!info) return;
      if (typeof info.playerState === 'number') {
        lastState = info.playerState;
        nowPlaying.playing = (lastState === PLAYING || lastState === BUFFERING);
      }
      // Tempo de reprodução e duração (para a barra de progresso nativa)
      if (typeof info.currentTime === 'number') nowPlaying.position = info.currentTime;
      if (typeof info.duration === 'number' && info.duration > 0) nowPlaying.duration = info.duration;
      // videoData traz título, autor e id (a capa vem da thumbnail oficial)
      if (info.videoData) {
        if (info.videoData.title)  nowPlaying.title  = info.videoData.title;
        if (info.videoData.author) nowPlaying.artist = info.videoData.author;
        if (info.videoData.video_id && info.videoData.video_id !== nowPlaying.videoId) {
          nowPlaying.videoId = info.videoData.video_id;
          nowPlaying.artUrl = 'https://i.ytimg.com/vi/' + nowPlaying.videoId + '/hqdefault.jpg';
        }
      }
    } catch (_) {}
  });

  function sendPlay() {
    var f = ytIframe();
    if (f && f.contentWindow) {
      f.contentWindow.postMessage(
        JSON.stringify({ event: 'command', func: 'playVideo', args: '' }), '*'
      );
    }
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      wasPlayingBeforeHide = (lastState === PLAYING || lastState === BUFFERING);
      hiddenAt = Date.now();
      resumeAttempts = 0;
    } else {
      wasPlayingBeforeHide = false;
    }
  });

  /* ------------------------------------------------------------------
   * Receptor dos controles nativos (notificação, tela de bloqueio, fone).
   * Chamado pelo Android via window.__msMedia('play'|'pause'|'toggle'|
   * 'next'|'prev'). play/pause/toggle falam direto com o iframe do YouTube;
   * next/prev reutilizam os atalhos de teclado que o app já possui
   * (Shift+→ / Shift+←), sem tocar na lógica de negócios.
   * ------------------------------------------------------------------ */
  function sendCmd(func, args) {
    var f = ytIframe();
    if (f && f.contentWindow) {
      f.contentWindow.postMessage(
        JSON.stringify({ event: 'command', func: func, args: args || '' }), '*'
      );
    }
  }

  function pressKey(key, code, keyCode, shift) {
    var opts = {
      key: key, code: code, keyCode: keyCode, which: keyCode,
      shiftKey: !!shift, bubbles: true, cancelable: true
    };
    document.dispatchEvent(new KeyboardEvent('keydown', opts));
    document.body && document.body.dispatchEvent(new KeyboardEvent('keydown', opts));
  }

  window.__msMedia = function (cmd) {
    try {
      switch (cmd) {
        case 'play':  sendCmd('playVideo');  break;
        case 'pause': sendCmd('pauseVideo'); break;
        case 'toggle':
          if (lastState === PLAYING || lastState === BUFFERING) sendCmd('pauseVideo');
          else sendCmd('playVideo');
          break;
        case 'next': pressKey('ArrowRight', 'ArrowRight', 39, true); break;
        case 'prev': pressKey('ArrowLeft',  'ArrowLeft',  37, true); break;
        default:
          // 'seek:<ms>' — arrasto na barra de progresso da tela de bloqueio
          if (cmd && cmd.indexOf('seek:') === 0) {
            var ms = parseInt(cmd.slice(5), 10);
            if (!isNaN(ms)) {
              var secs = ms / 1000;
              sendCmd('seekTo', [secs, true]);
              nowPlaying.position = secs;
            }
          }
      }
    } catch (_) {}
  };

  setInterval(function () {
    if (!document.hidden || !wasPlayingBeforeHide) return;
    if (Date.now() - hiddenAt > 15000) return;
    if (resumeAttempts >= 5) return;
    if (lastState === PAUSED) {
      resumeAttempts++;
      sendPlay();
    }
  }, 1500);
})();
