/* global self, caches, fetch */
'use strict';

// ---------------------------------------------------------------------------
// Service Worker do app da CEI Angela Amin.
//
// Objetivo: permitir "Instalar" o app no celular (PWA) e deixar a abertura
// mais rapida guardando em cache os arquivos que NAO mudam a cada acesso
// (html/css/js/logo). Dados sensiveis (mensagens, anexos, fotos, financeiro,
// etc.) NUNCA sao guardados em cache aqui - toda rota "/api/*" e o socket.io
// sempre vao direto para o servidor, para nao guardar informacao antiga nem
// burlar a protecao de "somente visualizar" dos anexos.
//
// IMPORTANTE: sempre que os arquivos do app forem atualizados, mude o
// CACHE_VERSION abaixo (ex: 'v1' -> 'v2'). Isso faz o navegador dos usuarios
// baixar tudo de novo automaticamente, em vez de continuar usando uma copia
// antiga guardada no celular.
// ---------------------------------------------------------------------------
const CACHE_VERSION = 'cei-angela-amin-v1';

const APP_SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.json',
  '/logo.png',
  '/logo-icon.png',
  '/icon-192.png',
  '/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names.filter((n) => n !== CACHE_VERSION).map((n) => caches.delete(n))
      )
    ).then(() => self.clients.claim())
  );
});

function isApi(url) {
  return url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // POST/PUT/DELETE sempre vao direto pro servidor

  const url = new URL(req.url);

  // Nunca cachear API, socket.io, anexos ou fotos - sempre dado fresco do servidor.
  if (isApi(url)) return;

  // Navegacao (abrir o app / dar F5): tenta a rede primeiro pra sempre pegar a
  // versao mais nova; se estiver offline, cai pro index.html guardado em cache.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Demais arquivos estaticos (css/js/imagens/libs do cdn): responde do cache
  // na hora (app abre rapido) e atualiza o cache por baixo dos panos.
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetchPromise = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
