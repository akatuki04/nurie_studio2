const CACHE='nurie-studio-v3-20261029';
const APP=['./','./index.html','./style.css','./app.js','./outline-worker.js','./ai-worker.js','./manifest.webmanifest','./icons/icon-192.png','./icons/icon-512.png'];
self.addEventListener('install', e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(APP)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('nurie-studio-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=='GET'||u.origin!==location.origin)return;
  // Network first prevents stale code on GitHub Pages updates; offline fallback.
  e.respondWith(fetch(e.request).then(response=>{
    if(response.ok){const clone=response.clone();e.waitUntil(caches.open(CACHE).then(c=>c.put(e.request,clone)).catch(()=>{}));}
    return response;
  }).catch(()=>caches.match(e.request).then(hit=>hit||Response.error())));
});
