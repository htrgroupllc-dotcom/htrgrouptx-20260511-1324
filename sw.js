const CACHE = "htr-pwa-v5-wa15559554342";

self.addEventListener("install", e => {
  e.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);

  // API — не перехватывать
  if (url.pathname.startsWith("/api/")) return;

  // HTML-навигация — всегда с сети, не кешировать
  if (e.request.mode === "navigate") {
    e.respondWith(
      fetch(e.request).catch(() => caches.match("/index.html"))
    );
    return;
  }

  // Статические ресурсы (JS, CSS, изображения) — сеть + кеш
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

// ── Badge state persistence via IndexedDB ─────────────────────────────────────
function openBadgeDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("htr-badge-db", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function dbGet(db, key) {
  return new Promise(resolve => {
    const req = db.transaction("kv", "readonly").objectStore("kv").get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => resolve(null);
  });
}
async function dbSet(db, key, value) {
  return new Promise(resolve => {
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").put(value, key);
    tx.oncomplete = resolve;
    tx.onerror = resolve;
  });
}

async function checkAndSetBadge() {
  let db;
  try { db = await openBadgeDb(); } catch { return; }
  const [token, apiBase, lastSeenAt] = await Promise.all([
    dbGet(db, "token"), dbGet(db, "apiBase"), dbGet(db, "lastSeenAt"),
  ]);
  if (!token || !apiBase) return;
  const since = lastSeenAt ? `?since=${encodeURIComponent(lastSeenAt)}` : "";
  try {
    const res = await fetch(`${apiBase}/api/employee/unread-count${since}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    const data = await res.json();
    const count = typeof data.count === "number" ? data.count : 0;
    if ("setAppBadge" in self && count > 0) {
      self.setAppBadge(count).catch(() => {});
    } else if ("clearAppBadge" in self && count === 0) {
      self.clearAppBadge().catch(() => {});
    }
  } catch { /* network error */ }
}

// ── Message handler (from main page) ─────────────────────────────────────────
self.addEventListener("message", async event => {
  const msg = event.data || {};
  if (msg.type === "BADGE_INIT") {
    let db;
    try { db = await openBadgeDb(); } catch { return; }
    await Promise.all([
      dbSet(db, "token",      msg.token      ?? null),
      dbSet(db, "apiBase",    msg.apiBase    ?? null),
      dbSet(db, "lastSeenAt", msg.lastSeenAt ?? null),
    ]);
  } else if (msg.type === "BADGE_CLEAR") {
    if ("clearAppBadge" in self) self.clearAppBadge().catch(() => {});
  } else if (msg.type === "BADGE_CHECK") {
    await checkAndSetBadge();
  }
});

// ── Periodic Background Sync (Chrome Android) ─────────────────────────────────
self.addEventListener("periodicsync", event => {
  if (event.tag === "emp-badge-check") {
    event.waitUntil(checkAndSetBadge());
  }
});
