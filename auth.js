'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function loadConfig() {
  if (process.env.KC_BASE_URL) {
    return {
      port: process.env.PORT || 3000,
      host: process.env.HOST || '0.0.0.0',
      kcPort: process.env.KC_PORT || 8080,
      kcPublicUrl: process.env.KC_PUBLIC_URL || '',
      kcBaseUrl: process.env.KC_BASE_URL,
      realm: process.env.REALM || 'asana',
      clientId: process.env.CLIENT_ID || 'asana-lite',
      clientSecret: process.env.CLIENT_SECRET || '',
      sessionSecret: process.env.SESSION_SECRET || 'dev-secret-change-me',
      ownerSub: process.env.OWNER_SUB || ''
    };
  }
  return JSON.parse(
    fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8').replace(/^\uFEFF/, '')
  );
}

const CONFIG = loadConfig();

const SESSION_COOKIE = 'alsid';
const OIDC_COOKIE = 'alc';
const SESSION_TTL = 7 * 24 * 3600 * 1000;
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');

const sessions = new Map(); // sid -> { sub, name, idToken, exp }

function loadSessions() {
  try {
    const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8').replace(/^\uFEFF/, ''));
    const now = Date.now();
    for (const [sid, s] of Object.entries(raw)) {
      if (s && typeof s.exp === 'number' && s.exp > now) sessions.set(sid, s);
    }
  } catch { /* нет файла или битый — стартуем с пустой карты */ }
}

let saveTimer = null;
function persistSessions() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const out = {};
      for (const [sid, s] of sessions) out[sid] = s;
      const tmp = SESSIONS_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(out), 'utf8');
      fs.renameSync(tmp, SESSIONS_FILE);
    } catch { /* переживаемаем */ }
  }, 300);
}

loadSessions();

/* ---------- cookies ---------- */

function parseCookies(req) {
  const out = new Map();
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try {
        out.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
      } catch { /* битая кодировка — пропускаем */ }
    }
  }
  return out;
}

function setCookie(res, name, value, opts = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`;
  if (opts.maxAge != null) c += `; Max-Age=${Math.floor(opts.maxAge / 1000)}`;
  if (opts.expire) c += '; Expires=Thu, 01 Jan 1970 00:00:00 GMT';
  const prev = res.getHeader('Set-Cookie');
  const arr = prev ? (Array.isArray(prev) ? prev.concat([c]) : [prev, c]) : [c];
  res.setHeader('Set-Cookie', arr);
}

/* ---------- sessions ---------- */

function newSession(user) {
  const sid = crypto.randomBytes(24).toString('base64url');
  sessions.set(sid, { sub: user.sub, name: user.name, idToken: user.idToken, exp: Date.now() + SESSION_TTL });
  persistSessions();
  return sid;
}

function getSession(req) {
  const sid = parseCookies(req).get(SESSION_COOKIE);
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  if (Date.now() > s.exp) {
    sessions.delete(sid);
    persistSessions();
    return null;
  }
  s.exp = Date.now() + SESSION_TTL;
  persistSessions();
  return { sid, sub: s.sub, name: s.name, idToken: s.idToken };
}

function destroySession(sid) {
  sessions.delete(sid);
  persistSessions();
}

/* ---------- OIDC helpers ---------- */

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function b64urlJson(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

let jwksCache = { keys: null, fetched: 0 };

async function getSigningKey(kid) {
  if (!jwksCache.keys || Date.now() - jwksCache.fetched > 3600_000) {
    const res = await fetch(`${CONFIG.kcBaseUrl}/realms/${CONFIG.realm}/protocol/openid-connect/certs`);
    if (!res.ok) throw new Error('JWKS недоступен');
    jwksCache = { keys: (await res.json()).keys, fetched: Date.now() };
  }
  return jwksCache.keys.find((k) => k.kid === kid) || null;
}

async function verifyIdToken(idToken, expectedNonce, expectedIss) {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('неверный формат id_token');
  const [h, p, sig] = parts;
  const header = b64urlJson(h);
  if (header.alg !== 'RS256') throw new Error('неподдерживаемый алгоритм токена');
  const jwk = await getSigningKey(header.kid);
  if (!jwk) throw new Error('ключ подписи не найден');
  const publicKey = crypto.createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${h}.${p}`);
  const ok = verifier.verify(publicKey, Buffer.from(sig, 'base64url'));
  if (!ok) throw new Error('подпись токена не сошлась');

  const payload = b64urlJson(p);
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now - 30) throw new Error('токен просрочен');
  const issLocal = `${CONFIG.kcBaseUrl}/realms/${CONFIG.realm}`;
  const iss = expectedIss || issLocal;
  const normIss = (s) => String(s).replace(/^https?:\/\//, '');
  if (normIss(payload.iss) !== normIss(iss) && normIss(payload.iss) !== normIss(issLocal)) throw new Error('чужой издатель токена');
  if (payload.aud !== CONFIG.clientId) throw new Error('токен выдан другому клиенту');
  if (expectedNonce && payload.nonce !== expectedNonce) throw new Error('nonce не совпал');
  return payload;
}

// kcOrigin: адрес Keycloak, доступный ИМЕННО ЭТОМУ браузеру
// (тот же хост, что у приложения, но порт Keycloak)
function kcPublicOrigin(appOrigin) {
  if (CONFIG.kcPublicUrl) return CONFIG.kcPublicUrl.replace(/\/$/, '');
  try {
    const u = new URL(appOrigin);
    u.port = String(CONFIG.kcPort || 8080);
    return u.origin;
  } catch {
    return `${CONFIG.kcBaseUrl}`;
  }
}

async function exchangeCode(code, verifier, redirectUri) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: CONFIG.clientId,
    client_secret: CONFIG.clientSecret,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  const res = await fetch(`${CONFIG.kcBaseUrl}/realms/${CONFIG.realm}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json();
  if (!res.ok || !data.id_token) throw new Error('обмен кода не удался: ' + (data.error_description || res.status));
  return data;
}

function authorizeUrl(kcOrigin, redirectUri, state, nonce, codeChallenge) {
  const u = new URL(`${kcOrigin}/realms/${CONFIG.realm}/protocol/openid-connect/auth`);
  u.searchParams.set('client_id', CONFIG.clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', 'openid');
  u.searchParams.set('state', state);
  u.searchParams.set('nonce', nonce);
  u.searchParams.set('code_challenge', codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

function logoutUrl(idToken) {
  const u = new URL(`${CONFIG.kcBaseUrl}/realms/${CONFIG.realm}/protocol/openid-connect/logout`);
  if (idToken) u.searchParams.set('id_token_hint', idToken);
  u.searchParams.set('client_id', CONFIG.clientId);
  return u.toString();
}

module.exports = {
  CONFIG, SESSION_COOKIE, OIDC_COOKIE, kcPublicOrigin,
  parseCookies, setCookie,
  newSession, getSession, destroySession,
  verifyIdToken, exchangeCode, authorizeUrl, logoutUrl, b64url,
};
