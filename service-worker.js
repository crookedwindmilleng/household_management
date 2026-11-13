const CACHE = "wiwy-shell-v35";
const CORE = [
  "./index.html", "./css/app.css",
  "./js/app.js", "./js/cloud.js", "./js/auth.js", "./js/store.js", "./js/config.js",
  "./wiwy-release.json"
];
const OPTIONAL = [
  "./manifest.webmanifest", "./icons/icon.svg", "./icons/icon-192.png",
  "./icons/icon-512.png", "./icons/wiwy-emblem.png", "./icons/away-suitcase.svg"
];

self.addEventListener("install", event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  // Fetch required shell files individually. This avoids addAll's opaque failure
  // behavior and reports the exact asset that prevents installation.
  for (const path of CORE) {
    const url = new URL(path, self.registration.scope);
    const response = await fetch(url, { cache: "reload" });
    if (!response.ok || response.type === "opaque") {
      throw new Error(`WIWY update could not download ${url.pathname} (${response.status}).`);
    }
    await cache.put(url, response.clone());
  }
  // Nonessential icons/manifest must never block an application update.
  await Promise.allSettled(OPTIONAL.map(async path => {
    const url = new URL(path, self.registration.scope);
    const response = await fetch(url, { cache: "reload" });
    if (response.ok && response.type !== "opaque") await cache.put(url, response);
  }));
  // Do not skip waiting automatically. WIWY asks the user before activation.
})()));

self.addEventListener("message", event => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", event => event.waitUntil((async () => {
  const keys = (await caches.keys()).filter(key => key.startsWith("wiwy-shell-v")).sort((a,b) => {
    const av = Number(a.split("-v").pop()), bv = Number(b.split("-v").pop());
    return av - bv;
  });
  // Keep the active shell and the two previous shells for recovery.
  const obsolete = keys.filter(key => key !== CACHE).slice(0, Math.max(0, keys.length - 3));
  await Promise.all(obsolete.map(key => caches.delete(key)));
  await self.clients.claim();
})()));

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  if (new URL(request.url).pathname.endsWith("/wiwy-release.json")) {
    event.respondWith(fetch(request, { cache: "no-store" }).catch(async () => {
      const cache = await caches.open(CACHE);
      return cache.match("./wiwy-release.json");
    }));
    return;
  }
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(request);
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (response && response.ok && response.type !== "opaque") await cache.put(request, response.clone());
      return response;
    } catch (error) {
      if (request.mode === "navigate") {
        const shell = await cache.match("./index.html");
        if (shell) return shell;
      }
      throw error;
    }
  })());
});

self.addEventListener("push", event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch { data = { body: event.data?.text() || "You have a new WIWY update." }; }
  const title = data.title || "Wherever I'm With You";
  const options = {
    body: data.body || "You have a new household update.",
    tag: data.tag || data.event_key || "wiwy-update",
    data: { url: data.url || "./" },
    renotify: true
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "./", self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const client of list) {
      if (client.url.startsWith(self.location.origin) && "focus" in client) return client.focus();
    }
    return self.clients.openWindow(target);
  }));
});
