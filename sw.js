/*
 * RABEH weekly show checklist — service worker.
 *
 * Makes the page open without a connection (studio Wi-Fi drops) while never holding an update back:
 *   - the page's own files: network first, the cached copy only when the network fails or is too slow;
 *   - Google Fonts: cache first (their URLs never change content);
 *   - everything else — above all the POSTs to the Apps Script web app — is not touched at all.
 *
 * Bump VERSION when a file is added to or removed from SHELL; old caches are dropped on activation.
 */
"use strict";

const VERSION = "v2";
const SHELL_CACHE = "rabeh-shell-" + VERSION;
const FONT_CACHE = "rabeh-fonts-" + VERSION;

// Relative to this file, so the same list works under any GitHub Pages sub-path.
const SHELL = [
  "./",
  "index.html",
  "style.css",
  "config.js",
  "checklist.js",
  "core.js",
  "app.js",
  "manifest.webmanifest",
  "img/camel.webp",
  "img/camel-wire.webp",
  "img/bg.jpg",
  "img/favicon.png",
  "img/apple-touch-icon.png",
  "img/icon-192.png",
  "img/icon-512.png"
];

const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

// On a connection that is up but crawling, show the cached page after this long instead of a blank screen.
const NETWORK_WAIT_MS = 4000;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      // One file failing must not stop the others from being cached, hence add() one by one.
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(new Request(url, { cache: "reload" })).catch(() => undefined))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names
        .filter((name) => name.indexOf("rabeh-") === 0 && name !== SHELL_CACHE && name !== FONT_CACHE)
        .map((name) => caches.delete(name))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return; // the sync API is POST only: never intercepted, never cached

  let url;
  try {
    url = new URL(request.url);
  } catch (err) {
    return;
  }

  if (url.origin === self.location.origin) {
    // Only this site's own folder; other paths on the same host are none of our business.
    if (url.href.indexOf(self.registration.scope) === 0) event.respondWith(networkFirst(event, request, url));
    return;
  }
  if (FONT_HOSTS.indexOf(url.hostname) !== -1) event.respondWith(cacheFirst(request));
});

// Every way of opening the page (./, index.html, ?date=…) shares one cache entry; other files drop their query.
// Only the page itself: a file of the site opened in a tab of its own (a link to img/bg.jpg, say) is a
// navigation too, and must not take the page's place in the cache.
function cacheKeyFor(request, url) {
  const base = new URL(self.registration.scope).pathname;
  if (request.mode === "navigate" && (url.pathname === base || url.pathname === base + "index.html")) return self.registration.scope;
  return url.origin + url.pathname;
}

function networkFirst(event, request, url) {
  const key = cacheKeyFor(request, url);
  const cached = () => caches.open(SHELL_CACHE).then((cache) => cache.match(key));

  // A navigation is passed through untouched (it carries its own redirect handling); for the other files
  // "no-cache" makes the browser revalidate, so a new version is picked up on the very next load.
  const network = request.mode === "navigate"
    ? fetch(request)
    : fetch(request.url, { cache: "no-cache", credentials: "same-origin" });

  // Store a copy of every good answer. Registered first, so the clone is taken before the page reads the
  // body, and held with waitUntil so it is stored even when the page was already answered from the cache.
  event.waitUntil(network.then((response) => {
    if (!(response && response.ok && response.type === "basic" && !response.redirected)) return undefined;
    // The page's entry only ever holds a page.
    if (key === self.registration.scope && !/^text\/html\b/i.test(response.headers.get("Content-Type") || "")) return undefined;
    const copy = response.clone();
    return caches.open(SHELL_CACHE).then((cache) => cache.put(key, copy));
  }).catch(() => undefined));

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(response);
    };
    const fallBack = (otherwise) => cached().then((hit) => {
      if (hit) settle(hit);
      else if (otherwise) otherwise();
    }, () => {
      if (otherwise) otherwise();
    });

    const timer = setTimeout(() => fallBack(null), NETWORK_WAIT_MS);

    network.then((response) => {
      // A server error with a good copy on hand: the copy is more useful on set.
      if (response.status >= 500) fallBack(() => settle(response));
      else settle(response);
    }, (err) => {
      fallBack(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
    });
  });
}

function cacheFirst(request) {
  return caches.open(FONT_CACHE).then((cache) => cache.match(request).then((hit) => {
    if (hit) return hit;
    return fetch(request).then((response) => {
      // The stylesheet is requested without CORS, so its response is opaque — still fine to keep.
      if (response && (response.ok || response.type === "opaque")) cache.put(request, response.clone());
      return response;
    });
  }));
}
