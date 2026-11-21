// Otaku Vault — Web Push helper (Cloudflare Worker, free tier is fine)
//
// What it does:
//   POST /subscribe  -> stores { subscription, titleIds, lastCounts } in KV
//   Daily cron       -> asks AniList for the latest aired episode count of the
//                       stored titles; when a count went up, sends a Web Push
//                       (VAPID, payload encrypted with aes128gcm per RFC 8291)
//                       and saves the new counts.
//
// Config (see README.md):
//   KV binding        SUBS
//   Var               VAPID_PUBLIC_KEY   (base64url, from a VAPID key generator)
//   Secret            VAPID_PRIVATE_KEY  (base64url)
//   Var (optional)    VAPID_SUBJECT      e.g. "mailto:you@example.com"

const ANILIST_URL = 'https://graphql.anilist.co';

// ---------- small byte helpers ----------
function b64uToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64u(bytes) {
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function concatBytes(...arrays) {
  const total = arrays.reduce((a, x) => a + x.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function hmac(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, dataBytes));
}

// ---------- VAPID auth (RFC 8292) ----------
async function vapidAuthHeader(endpoint, env) {
  const pub = b64uToBytes(env.VAPID_PUBLIC_KEY);   // 65-byte uncompressed point
  const priv = b64uToBytes(env.VAPID_PRIVATE_KEY); // 32-byte scalar
  const jwk = {
    kty: 'EC', crv: 'P-256',
    x: bytesToB64u(pub.slice(1, 33)),
    y: bytesToB64u(pub.slice(33, 65)),
    d: bytesToB64u(priv),
  };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = {
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT || 'mailto:admin@example.com',
  };
  const enc = new TextEncoder();
  const unsigned = bytesToB64u(enc.encode(JSON.stringify(header))) + '.' + bytesToB64u(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(unsigned));
  const jwt = unsigned + '.' + bytesToB64u(new Uint8Array(sig));
  return 'vapid t=' + jwt + ', k=' + env.VAPID_PUBLIC_KEY;
}

// ---------- Payload encryption (RFC 8291, aes128gcm) ----------
async function encryptPayload(subscription, plaintext) {
  const uaPublic = b64uToBytes(subscription.keys.p256dh); // 65 bytes
  const authSecret = b64uToBytes(subscription.keys.auth); // 16 bytes
  const enc = new TextEncoder();

  // Ephemeral sender key pair + ECDH shared secret with the subscriber key.
  const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, ephemeral.privateKey, 256));

  // IKM: PRK = HMAC(auth, shared); IKM = HMAC(PRK, "WebPush: info" || 0x00 || ua || as || 0x01)
  const prkKey = await hmac(authSecret, shared);
  const ikm = await hmac(prkKey, concatBytes(enc.encode('WebPush: info'), new Uint8Array([0]), uaPublic, asPublic, new Uint8Array([1])));

  // CEK + nonce via HKDF with a fresh salt.
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk2 = await hmac(salt, ikm);
  const cek = (await hmac(prk2, concatBytes(enc.encode('Content-Encoding: aes128gcm'), new Uint8Array([0, 1])))).slice(0, 16);
  const nonce = (await hmac(prk2, concatBytes(enc.encode('Content-Encoding: nonce'), new Uint8Array([0, 1])))).slice(0, 12);

  // One record: plaintext || 0x02 (final record delimiter).
  const padded = concatBytes(enc.encode(plaintext), new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded));

  // Header: salt(16) || record size(4) || key id length(1) || sender public key
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concatBytes(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

async function sendPush(subscription, payloadText, env) {
  const body = await encryptPayload(subscription, payloadText);
  return fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL': '86400',
      'Authorization': await vapidAuthHeader(subscription.endpoint, env),
    },
    body,
  });
}

// ---------- /subscribe ----------
async function handleSubscribe(request, env) {
  let data;
  try { data = await request.json(); } catch (e) { return new Response('Bad JSON', { status: 400 }); }
  const sub = data && data.subscription;
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return new Response('Invalid subscription', { status: 400 });
  }
  const titleIds = Array.isArray(data.titleIds)
    ? data.titleIds.filter((x) => Number.isInteger(x)).slice(0, 100)
    : [];
  const key = 'sub:' + (await sha256Hex(sub.endpoint));
  let lastCounts = {};
  const existing = await env.SUBS.get(key);
  if (existing) {
    try { lastCounts = JSON.parse(existing).lastCounts || {}; } catch (e) { /* start fresh */ }
  }
  await env.SUBS.put(key, JSON.stringify({ subscription: sub, titleIds, lastCounts }));
  return Response.json({ ok: true });
}

// ---------- Daily check ----------
async function checkAll(env) {
  const listed = await env.SUBS.list({ prefix: 'sub:' });
  for (const k of listed.keys) {
    const raw = await env.SUBS.get(k.name);
    if (!raw) continue;
    let record;
    try { record = JSON.parse(raw); } catch (e) { continue; }
    const subscription = record.subscription;
    const titleIds = record.titleIds;
    const lastCounts = record.lastCounts || {};
    if (!subscription || !Array.isArray(titleIds) || !titleIds.length) continue;

    const query = 'query ($ids: [Int]) { Page(page: 1, perPage: 50) { media(id_in: $ids, type: ANIME) { id status episodes nextAiringEpisode { episode } title { english romaji } } } }';
    let media = [];
    try {
      const res = await fetch(ANILIST_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { ids: titleIds.slice(0, 50) } }),
      });
      if (!res.ok) continue;
      const json = await res.json();
      media = (json.data && json.data.Page && json.data.Page.media) || [];
    } catch (e) { continue; }

    const fresh = [];
    media.forEach((m) => {
      let aired = null;
      if (m.nextAiringEpisode && m.nextAiringEpisode.episode) aired = m.nextAiringEpisode.episode - 1;
      else if (m.status === 'FINISHED' && m.episodes) aired = m.episodes;
      if (aired === null) return;
      const prev = lastCounts[m.id];
      if (prev !== undefined && aired > prev) {
        fresh.push({ name: (m.title && (m.title.english || m.title.romaji)) || 'Your anime', ep: aired });
      }
      lastCounts[m.id] = aired;
    });

    if (fresh.length) {
      const bodyText = fresh.length === 1
        ? 'Episode ' + fresh[0].ep + ' of ' + fresh[0].name + ' just aired!'
        : fresh.length + ' of your shows have new episodes: ' + fresh.map((f) => f.name).join(', ');
      try {
        const res = await sendPush(subscription, JSON.stringify({ title: 'Otaku Vault', body: bodyText, url: './' }), env);
        if (res.status === 404 || res.status === 410) {
          await env.SUBS.delete(k.name); // subscription is gone for good
          continue;
        }
      } catch (e) { /* network hiccup — keep the subscription, retry tomorrow */ }
    }

    record.lastCounts = lastCounts;
    await env.SUBS.put(k.name, JSON.stringify(record));
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method === 'POST' && url.pathname === '/subscribe') {
      const res = await handleSubscribe(request, env);
      Object.entries(cors).forEach(([h, v]) => res.headers.set(h, v));
      return res;
    }
    if (request.method === 'GET' && url.pathname === '/') {
      return new Response('Otaku Vault push worker is running.');
    }
    return new Response('Not found', { status: 404 });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkAll(env));
  },
};
