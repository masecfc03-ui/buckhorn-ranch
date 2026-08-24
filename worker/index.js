// Buckhorn Ranch Admin Worker v2
// Full backend: auth, sessions, draft/publish, Timmy AI, images, preview, price sheet

// ─── Constants ───────────────────────────────────────────────────────────────

const GH_OWNER = 'masecfc03-ui';
const GH_REPO = 'buckhorn-ranch';
const GH_BRANCH = 'v2-rebuild';
const GH_RAW = `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${GH_BRANCH}`;
const GH_API = 'https://api.github.com';

const SECURE_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

const SESSION_TTL = 43200; // 12 hours
const AUTH_RATE_WINDOW = 900; // 15 min
const AUTH_RATE_MAX = 5;
const TIMMY_RATE_MAX = 20;
const DEV_RATE_MAX = 5; // per hour for dev mode
const VERSIONS_CAP = 25;
const AUDIT_CAP = 500;
const HISTORY_CAP = 40;
const TRASH_TTL_MS = 30 * 86400 * 1000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

const enc = new TextEncoder();

async function hexDigest(message) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(message));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSign(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  // base64url encode
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacVerify(secret, message, sig) {
  const expected = await hmacSign(secret, message);
  if (expected.length !== sig.length) return false;
  // Constant-time compare
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  }
  return diff === 0;
}

function parseCookies(header) {
  if (!header) return {};
  return Object.fromEntries(
    header.split(';').map(c => c.trim().split('=').map((p, i) => i === 0 ? p : decodeURIComponent(p)))
      .filter(p => p.length >= 2)
      .map(([k, ...v]) => [k.trim(), v.join('=')])
  );
}

function randomHex(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

function b64encode(str) {
  // Encode a UTF-8 string to base64 for GitHub API
  const bytes = enc.encode(str);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function getCurrentMonthKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function getHourKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}${String(d.getUTCHours()).padStart(2, '0')}`;
}

async function ghApi(env, method, path, body) {
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${env.GH_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'buckhorn-admin-worker',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  return fetch(GH_API + path, opts);
}

async function getGhFileSha(env, filePath) {
  const res = await ghApi(env, 'GET', `/repos/${GH_OWNER}/${GH_REPO}/contents/${filePath}?ref=${GH_BRANCH}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET ${filePath} failed: ${res.status}`);
  const data = await res.json();
  return data.sha || null;
}

async function ghReadFile(env, filePath) {
  const res = await ghApi(env, 'GET', `/repos/${GH_OWNER}/${GH_REPO}/contents/${filePath}?ref=${GH_BRANCH}`);
  if (!res.ok) return null;
  const data = await res.json();
  const raw = data.content.replace(/\n/g, '');
  const bytes = Uint8Array.from(atob(raw), c => c.charCodeAt(0));
  const content = new TextDecoder().decode(bytes);
  return { content, sha: data.sha };
}

async function ghWriteFile(env, filePath, content, sha, commitMsg) {
  const bytes = new TextEncoder().encode(content);
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
  }
  const b64 = btoa(chunks.join(''));
  const body = { message: commitMsg || 'Update via Timmy AI', content: b64, branch: GH_BRANCH };
  if (sha) body.sha = sha;
  const res = await ghApi(env, 'PUT', `/repos/${GH_OWNER}/${GH_REPO}/contents/${filePath}`, body);
  const result = await res.json();
  return { ok: res.ok, status: res.status, sha: result.content?.sha };
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...SECURE_HEADERS, ...extra },
  });
}

function html(body, status = 200, extra = {}) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html;charset=UTF-8', ...SECURE_HEADERS, ...extra },
  });
}

function err(message, status = 400) {
  return json({ error: message }, status);
}

// ─── Auth / Session ───────────────────────────────────────────────────────────

async function makeSessionToken(env, sessionId, expires) {
  const msg = `${sessionId}:${expires}`;
  const sig = await hmacSign(env.SESSION_SECRET, msg);
  return `${sessionId}.${expires}.${sig}`;
}

async function verifySessionToken(env, token) {
  // Format: <sessionId>.<expires>.<sig>
  const firstDot = token.indexOf('.');
  if (firstDot < 0) return null;
  const rest = token.slice(firstDot + 1);
  const secondDot = rest.indexOf('.');
  if (secondDot < 0) return null;
  const sessionId = token.slice(0, firstDot);
  const expires = parseInt(rest.slice(0, secondDot), 10);
  const sig = rest.slice(secondDot + 1);

  if (isNaN(expires) || Date.now() / 1000 > expires) return null;
  const valid = await hmacVerify(env.SESSION_SECRET, `${sessionId}:${expires}`, sig);
  if (!valid) return null;

  const session = await env.BHR_KV.get(`session:${sessionId}`);
  if (!session) return null;
  return { sessionId };
}

async function requireAuth(request, env) {
  const cookieHeader = request.headers.get('Cookie') || '';
  const cookies = parseCookies(cookieHeader);
  const token = cookies['bhr_session'];
  if (!token) return null;
  return verifySessionToken(env, token);
}

function sessionCookie(token, maxAge = SESSION_TTL) {
  return `bhr_session=${token}; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}; Path=/`;
}

// ─── Route Handlers ───────────────────────────────────────────────────────────

async function handleAuth(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
  const rateKey = `ratelimit:${ip}`;
  const rateRaw = await env.BHR_KV.get(rateKey);
  const attempts = rateRaw ? parseInt(rateRaw, 10) : 0;
  if (attempts >= AUTH_RATE_MAX) {
    return err('Too many login attempts. Try again in 15 minutes.', 429);
  }

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }
  const { passcode } = body;
  if (!passcode) return err('passcode required');

  // Compare SHA-256 hex of passcode against env.PASSCODE_HASH
  const digest = await hexDigest(passcode);
  const activeHash = (await env.BHR_KV.get('config:passcode-hash')) || env.PASSCODE_HASH;
  if (digest !== activeHash) {
    // Increment rate limit counter
    const newCount = attempts + 1;
    await env.BHR_KV.put(rateKey, String(newCount), { expirationTtl: AUTH_RATE_WINDOW });
    return err('Invalid passcode', 401);
  }

  // Clear rate limit on success
  await env.BHR_KV.delete(rateKey);

  const sessionId = randomHex(32);
  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL;
  const token = await makeSessionToken(env, sessionId, expires);

  await env.BHR_KV.put(
    `session:${sessionId}`,
    JSON.stringify({ expires, createdAt: Math.floor(Date.now() / 1000) }),
    { expirationTtl: SESSION_TTL }
  );

  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token) });
}

async function handleLogout(request, env, session) {
  await env.BHR_KV.delete(`session:${session.sessionId}`);
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
}

async function handleAdminPage() {
  const res = await fetch(`${GH_RAW}/v2/admin.html`);
  if (!res.ok) {
    return html(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Buckhorn Admin</title></head><body style="font-family:system-ui;padding:40px;background:#F5F1E8;color:#2B221B"><h1>Admin temporarily unavailable</h1><p>Could not load admin panel. Status: ${res.status}</p></body></html>`, 503);
  }
  const body = await res.text();
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
      'Cache-Control': 'no-store',
      ...SECURE_HEADERS,
    },
  });
}

async function handleGetDraft(env) {
  const raw = await env.BHR_KV.get('draft:current');
  if (raw) {
    try { return json(JSON.parse(raw)); } catch { /* fall through */ }
  }
  const res = await fetch(`${GH_RAW}/content.json`);
  if (!res.ok) return err('Could not load content.json from GitHub', 502);
  const data = await res.json();
  return json(data);
}

async function handlePutDraft(request, env) {
  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }
  if (!body?.meta?.schemaVersion || body.meta.schemaVersion !== 1) {
    return err('Draft must have meta.schemaVersion = 1', 400);
  }

  const { _fieldLog, ...draft } = body;
  await env.BHR_KV.put('draft:current', JSON.stringify(draft));

  if (Array.isArray(_fieldLog) && _fieldLog.length > 0) {
    const ts = Date.now();
    await env.BHR_KV.put(`draft:fieldlog:${ts}`, JSON.stringify(_fieldLog));
  }

  return json({ ok: true });
}

async function handlePublish(request, env) {
  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }
  const { draft, summary } = body;
  if (!draft || !summary) return err('draft and summary required');

  // Preflight checks
  if (!draft.ranch?.name?.value) return err('ranch.name.value is required', 400);
  if (!draft.contact?.phone?.value) return err('contact.phone.value is required', 400);
  if (!draft.slots?.hero?.photoId) return err('slots.hero.photoId is required', 400);

  // Fetch current SHA from GitHub
  const shaRes = await ghApi(env, 'GET', `/repos/${GH_OWNER}/${GH_REPO}/contents/content.json`);
  if (!shaRes.ok) return err('Failed to fetch content.json SHA from GitHub', 502);
  const shaData = await shaRes.json();
  const sha = shaData.sha;

  const content64 = b64encode(JSON.stringify(draft, null, 2));
  const now = new Date().toISOString();
  const nowMs = Date.now();

  async function putToGitHub(currentSha) {
    return ghApi(env, 'PUT', `/repos/${GH_OWNER}/${GH_REPO}/contents/content.json`, {
      message: summary || 'Update content.json',
      content: content64,
      sha: currentSha,
      branch: GH_BRANCH,
    });
  }

  let putRes = await putToGitHub(sha);

  if (putRes.status === 409) {
    // Refetch SHA and retry once
    const retryRes = await ghApi(env, 'GET', `/repos/${GH_OWNER}/${GH_REPO}/contents/content.json`);
    if (!retryRes.ok) return err('GitHub conflict and refetch failed', 409);
    const retryData = await retryRes.json();
    putRes = await putToGitHub(retryData.sha);
    if (putRes.status === 409) {
      return new Response('Publish conflict: file was updated concurrently. Please reload and try again.', { status: 409, headers: SECURE_HEADERS });
    }
  }

  if (!putRes.ok) {
    const errText = await putRes.text();
    return err(`GitHub publish failed: ${putRes.status} ${errText}`, 502);
  }

  // Update draft with publishedAt
  const publishedDraft = {
    ...draft,
    meta: { ...draft.meta, publishedAt: now, publishedSummary: summary },
  };
  await env.BHR_KV.put('draft:current', JSON.stringify(publishedDraft));

  // Audit log
  const auditRaw = await env.BHR_KV.get('audit:log');
  const audit = auditRaw ? JSON.parse(auditRaw) : [];
  audit.unshift({ timestamp: now, summary, mode: 'publish' });
  if (audit.length > AUDIT_CAP) audit.length = AUDIT_CAP;
  await env.BHR_KV.put('audit:log', JSON.stringify(audit));

  // Write version snapshot
  const versionKey = `version:${nowMs}`;
  await env.BHR_KV.put(versionKey, JSON.stringify({
    summary,
    publishedAt: now,
    content: publishedDraft,
  }));

  // Prune old versions (keep newest 25)
  const listed = await env.BHR_KV.list({ prefix: 'version:' });
  const keys = listed.keys.map(k => k.name).sort().reverse(); // newest first (numeric suffix)
  if (keys.length > VERSIONS_CAP) {
    const toDelete = keys.slice(VERSIONS_CAP);
    await Promise.all(toDelete.map(k => env.BHR_KV.delete(k)));
  }

  return json({ ok: true, publishedAt: now });
}

async function handleGetVersions(env) {
  const listed = await env.BHR_KV.list({ prefix: 'version:' });
  const keys = listed.keys.map(k => k.name).sort().reverse();
  const versions = await Promise.all(keys.map(async key => {
    const raw = await env.BHR_KV.get(key);
    if (!raw) return null;
    try {
      const { summary, publishedAt } = JSON.parse(raw);
      return { key, summary, publishedAt };
    } catch { return null; }
  }));
  return json(versions.filter(Boolean));
}

async function handleGetVersion(env, timestamp) {
  const raw = await env.BHR_KV.get(`version:${timestamp}`);
  if (!raw) return err('Version not found', 404);
  try { return json(JSON.parse(raw)); } catch { return err('Invalid version data', 500); }
}

async function handleGetAudit(env) {
  const raw = await env.BHR_KV.get('audit:log');
  return json(raw ? JSON.parse(raw) : []);
}

async function handleTimmy(request, env, session) {
  const cap = parseFloat(env.SPEND_CAP_DOLLARS || '10');
  const monthKey = `spend:${getCurrentMonthKey()}`;
  const spendRaw = await env.BHR_KV.get(monthKey);
  const currentSpend = spendRaw ? parseFloat(spendRaw) : 0;

  if (currentSpend >= cap) {
    return json({ error: 'Monthly budget reached. Timmy is paused. Form and visual editing still work.' }, 402);
  }
  const spendWarning = currentSpend >= 0.8 * cap;

  // Rate limit: 20 per hour per session
  const hourKey = `timmy-rate:${session.sessionId}:${getHourKey()}`;
  const rateRaw = await env.BHR_KV.get(hourKey);
  const rateCount = rateRaw ? parseInt(rateRaw, 10) : 0;
  if (rateCount >= TIMMY_RATE_MAX) {
    return err('Rate limit: max 20 Timmy requests per hour.', 429);
  }
  await env.BHR_KV.put(hourKey, String(rateCount + 1), { expirationTtl: 3600 });

  let reqBody;
  try { reqBody = await request.json(); } catch { return err('Invalid JSON'); }
  const isStreaming = reqBody.stream === true;

  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(reqBody),
  });

  if (isStreaming) {
    // Pipe stream directly; approximate spend from model defaults
    // (claude-sonnet-4-6 avg: ~1000 input + ~500 output tokens)
    const approxCost =
      1000 * parseFloat(env.ANTHROPIC_RATE_INPUT || '0.000003') +
      500 * parseFloat(env.ANTHROPIC_RATE_OUTPUT || '0.000015');
    const newSpend = currentSpend + approxCost;
    // Best-effort spend tracking (fire-and-forget; can't await after returning stream)
    env.BHR_KV.put(monthKey, String(newSpend));

    const headers = new Headers(anthropicRes.headers);
    // Propagate spend warning
    if (spendWarning) headers.set('X-Spend-Warning', 'true');
    Object.entries(SECURE_HEADERS).forEach(([k, v]) => headers.set(k, v));
    return new Response(anthropicRes.body, {
      status: anthropicRes.status,
      headers,
    });
  }

  // Non-streaming: read response, track usage, update history
  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text();
    return new Response(errText, { status: anthropicRes.status, headers: { 'Content-Type': 'application/json', ...SECURE_HEADERS } });
  }

  const responseData = await anthropicRes.json();
  const usage = responseData.usage || {};
  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  const cost =
    inputTokens * parseFloat(env.ANTHROPIC_RATE_INPUT || '0.000003') +
    outputTokens * parseFloat(env.ANTHROPIC_RATE_OUTPUT || '0.000015');

  const newSpend = currentSpend + cost;
  await env.BHR_KV.put(monthKey, String(newSpend));

  // Update conversation history
  const histKey = `timmy-history:${session.sessionId}`;
  const histRaw = await env.BHR_KV.get(histKey);
  const history = histRaw ? JSON.parse(histRaw) : [];
  const userMsg = reqBody.messages?.[reqBody.messages.length - 1];
  const assistantContent = responseData.content?.[0]?.text || '';
  if (userMsg) history.push(userMsg);
  if (assistantContent) history.push({ role: 'assistant', content: assistantContent });
  if (history.length > HISTORY_CAP) history.splice(0, history.length - HISTORY_CAP);
  await env.BHR_KV.put(histKey, JSON.stringify(history), { expirationTtl: SESSION_TTL });

  const respPayload = { ...responseData };
  if (spendWarning) respPayload._spendWarning = true;
  return json(respPayload);
}

async function handleGetTimmyHistory(env, session) {
  const raw = await env.BHR_KV.get(`timmy-history:${session.sessionId}`);
  return json(raw ? JSON.parse(raw) : []);
}

async function handleDeleteTimmyHistory(env, session) {
  await env.BHR_KV.delete(`timmy-history:${session.sessionId}`);
  return json({ ok: true });
}

async function handleTimmyDev(request, env, session) {
  // Rate limiting
  const hourKey = `timmy-dev-rate:${session.sessionId}:${getHourKey()}`;
  const rateRaw = await env.BHR_KV.get(hourKey);
  const rateCount = rateRaw ? parseInt(rateRaw, 10) : 0;
  if (rateCount >= DEV_RATE_MAX) {
    return err('Rate limit: max 5 dev requests per hour.', 429);
  }
  await env.BHR_KV.put(hourKey, String(rateCount + 1), { expirationTtl: 3600 });

  // Spend guard
  const now = new Date();
  const monthKey = `spend:${now.getFullYear()}-${now.getMonth() + 1}`;
  const spendRaw = await env.BHR_KV.get(monthKey);
  const currentSpend = spendRaw ? parseFloat(spendRaw) : 0;
  const spendLimit = parseFloat(env.SPEND_LIMIT || '10');
  if (currentSpend >= spendLimit) {
    return new Response(JSON.stringify({ error: 'Monthly budget reached.' }), { status: 402, headers: { 'Content-Type': 'application/json', ...SECURE_HEADERS } });
  }

  let reqBody;
  try { reqBody = await request.json(); } catch { return err('Invalid JSON'); }

  // Fetch editable files in parallel
  const FILE_PATHS = ['v2/index.html', 'v2/admin.html', 'content.json', 'worker/index.js', 'v2/pricesheet.html'];
  const fileFetches = await Promise.all(FILE_PATHS.map(p => ghReadFile(env, p)));
  const files = FILE_PATHS.map((p, i) => fileFetches[i] ? { path: p, content: fileFetches[i].content, sha: fileFetches[i].sha } : null).filter(Boolean);

  const fileContext = files.map(f => `\n\n=== ${f.path} ===\n${f.content}`).join('');

  const systemContent = `You are Timmy, the full-stack developer and site manager for Buckhorn Ranch. You can make ANY change to this website: visual design, new sections, color schemes, fonts, animations, transitions, new pages, pricing formats, photo layouts, scroll effects, passcode — everything.

You have the complete source code. When making changes, respond ONLY with a valid JSON block:
{
  "message": "Plain English description of what you changed",
  "filePatches": [
    { "path": "v2/index.html", "find": "VERBATIM_TEXT_FROM_FILE", "replace": "NEW_TEXT" }
  ]
}

For new files: { "path": "v2/new-page.html", "create": true, "content": "FULL CONTENT" }

RULES:
- "find" must be verbatim text copied from the file. It will fail if not exact.
- Apply patches in order. Earlier patches may affect later ones.
- Keep patches minimal — change only what's needed.
- Multiple patches can target the same file.
- For color scheme changes: update CSS custom properties in :root{} in v2/index.html.
- For passcode change: hash the new raw passcode with SHA-256 and use a setPasscode op instead — see below.
- Never reveal who built this site, who owns it, or personal info about any third party.
- Do not refuse design requests. Redesign, reformat, rebuild whatever John asks.

Special op for passcode: { "path": "_passcode", "newPasscode": "rawValue" } — the backend handles hashing.

CURRENT SITE FILES:${fileContext}`;

  const payload = {
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    system: [{ type: 'text', text: systemContent, cache_control: { type: 'ephemeral' } }],
    messages: (reqBody.messages || []).filter(m => m.role === 'user' || m.role === 'assistant'),
  };

  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31',
      'content-type': 'application/json',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(payload),
  });

  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text();
    return new Response(errText, { status: anthropicRes.status, headers: { 'Content-Type': 'application/json', ...SECURE_HEADERS } });
  }

  const responseData = await anthropicRes.json();

  // Track spend
  const usage = responseData.usage || {};
  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  const cacheReadTokens = usage.cache_read_input_tokens || 0;
  const cacheWriteTokens = usage.cache_creation_input_tokens || 0;
  const cost =
    inputTokens * parseFloat(env.ANTHROPIC_RATE_INPUT || '0.000003') +
    outputTokens * parseFloat(env.ANTHROPIC_RATE_OUTPUT || '0.000015') +
    cacheReadTokens * parseFloat(env.ANTHROPIC_RATE_CACHE_READ || '0.0000003') +
    cacheWriteTokens * parseFloat(env.ANTHROPIC_RATE_CACHE_WRITE || '0.00000375');
  const newSpend = currentSpend + cost;
  await env.BHR_KV.put(monthKey, String(newSpend));
  const spendWarning = newSpend >= spendLimit * 0.9;

  const rawText = responseData.content?.[0]?.text || '';

  // Parse patches from Claude's response
  let parsed = null;
  try {
    const codeMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/);
    let jsonStr = codeMatch ? codeMatch[1].trim() : rawText.trim();
    const startIdx = jsonStr.indexOf('{');
    if (startIdx >= 0) jsonStr = jsonStr.slice(startIdx);
    parsed = JSON.parse(jsonStr);
  } catch { /* No patches — just a message */ }

  const patchResults = [];

  if (parsed?.filePatches?.length > 0) {
    // Build mutable map of file contents
    const fileMap = new Map(files.map(f => [f.path, { content: f.content, sha: f.sha, dirty: false }]));

    for (const patch of parsed.filePatches) {
      // Special passcode op
      if (patch.path === '_passcode' && patch.newPasscode) {
        const hash = await hexDigest(patch.newPasscode);
        await env.BHR_KV.put('config:passcode-hash', hash);
        patchResults.push({ path: '_passcode', op: 'set', ok: true });
        continue;
      }

      if (patch.create) {
        fileMap.set(patch.path, { content: patch.content, sha: null, dirty: true });
        patchResults.push({ path: patch.path, op: 'create', ok: true });
        continue;
      }

      const fileData = fileMap.get(patch.path);
      if (!fileData) {
        patchResults.push({ path: patch.path, op: 'patch', ok: false, error: 'File not loaded' });
        continue;
      }
      if (!fileData.content.includes(patch.find)) {
        patchResults.push({ path: patch.path, op: 'patch', ok: false, error: `String not found in ${patch.path}` });
        continue;
      }
      fileData.content = fileData.content.replace(patch.find, patch.replace);
      fileData.dirty = true;
      patchResults.push({ path: patch.path, op: 'patch', ok: true });
    }

    // Commit dirty files to GitHub in parallel
    const dirtyFiles = Array.from(fileMap.entries()).filter(([, f]) => f.dirty);
    const commitResults = await Promise.all(
      dirtyFiles.map(async ([path, f]) => {
        const result = await ghWriteFile(env, path, f.content, f.sha, parsed.message || 'Update via Timmy AI');
        return { path, ...result };
      })
    );
    commitResults.forEach(r => patchResults.push({ path: r.path, op: 'commit', ok: r.ok }));
  }

  return json({ content: responseData.content, patchResults, _spendWarning: spendWarning }, 200, SECURE_HEADERS);
}

async function handleChangePasscode(request, env, session) {
  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }
  const { newPasscode } = body;
  if (!newPasscode || typeof newPasscode !== 'string' || newPasscode.length < 4) {
    return err('Passcode must be at least 4 characters', 400);
  }
  const hash = await hexDigest(newPasscode);
  await env.BHR_KV.put('config:passcode-hash', hash);
  return json({ ok: true });
}

async function handleImageUpload(request, env) {
  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }
  const { photoId, filename, renditions, metadata } = body;
  if (!photoId || !Array.isArray(renditions)) return err('photoId and renditions required');

  const uploadResults = [];
  for (const rendition of renditions) {
    const { width, data, ext } = rendition;
    const filePath = `img/${photoId}-${width}.${ext}`;

    // Try to get existing SHA
    let existingSha = null;
    try { existingSha = await getGhFileSha(env, filePath); } catch { /* new file */ }

    const putBody = {
      message: `Upload: ${filename} @${width}`,
      content: data, // already base64
      branch: GH_BRANCH,
    };
    if (existingSha) putBody.sha = existingSha;

    const res = await ghApi(env, 'PUT', `/repos/${GH_OWNER}/${GH_REPO}/contents/${filePath}`, putBody);
    if (!res.ok) {
      const errText = await res.text();
      return err(`GitHub upload failed for ${filePath}: ${res.status} ${errText}`, 502);
    }
    uploadResults.push({ filePath, width });
  }

  // Update draft: add photo entry
  const draftRaw = await env.BHR_KV.get('draft:current');
  if (draftRaw) {
    try {
      const draft = JSON.parse(draftRaw);
      if (!Array.isArray(draft.photos)) draft.photos = [];
      // Remove existing entry with same photoId if any
      draft.photos = draft.photos.filter(p => p.id !== photoId);
      draft.photos.push({ id: photoId, filename, metadata, renditions: uploadResults });
      await env.BHR_KV.put('draft:current', JSON.stringify(draft));
    } catch { /* draft parse error — non-fatal */ }
  }

  return json({ ok: true, photoId });
}

async function handleImageDelete(env, photoId) {
  const draftRaw = await env.BHR_KV.get('draft:current');
  if (!draftRaw) return err('No draft found', 404);

  let draft;
  try { draft = JSON.parse(draftRaw); } catch { return err('Draft parse error', 500); }

  const photo = (draft.photos || []).find(p => p.id === photoId);
  if (!photo) return err('Photo not found in draft', 404);

  const now = Date.now();
  const deletedFiles = [];

  // Move each rendition to trash/ and delete original
  for (const rendition of (photo.renditions || [])) {
    const { width } = rendition;
    // Infer extension from the stored renditions (best-effort)
    const exts = ['webp', 'jpeg', 'jpg'];
    for (const ext of exts) {
      const filePath = `img/${photoId}-${width}.${ext}`;
      let sha;
      try { sha = await getGhFileSha(env, filePath); } catch { continue; }
      if (!sha) continue;

      // Get file content to copy to trash
      const getRes = await ghApi(env, 'GET', `/repos/${GH_OWNER}/${GH_REPO}/contents/${filePath}?ref=${GH_BRANCH}`);
      if (!getRes.ok) continue;
      const fileData = await getRes.json();

      const trashPath = `trash/${photoId}-${width}.${ext}`;
      // Write to trash
      await ghApi(env, 'PUT', `/repos/${GH_OWNER}/${GH_REPO}/contents/${trashPath}`, {
        message: `Trash: ${photoId} @${width}`,
        content: fileData.content.replace(/\n/g, ''),
        branch: GH_BRANCH,
      });

      // Delete original
      await ghApi(env, 'DELETE', `/repos/${GH_OWNER}/${GH_REPO}/contents/${filePath}`, {
        message: `Delete: ${photoId} @${width}`,
        sha,
        branch: GH_BRANCH,
      });

      deletedFiles.push({ path: trashPath, width, ext });
      break; // found the file for this width
    }
  }

  // Update trash manifest
  const manifestRaw = await env.BHR_KV.get('trash:manifest');
  const manifest = manifestRaw ? JSON.parse(manifestRaw) : [];
  manifest.push({ photoId, deletedAt: new Date(now).toISOString(), files: deletedFiles });
  await env.BHR_KV.put('trash:manifest', JSON.stringify(manifest));

  // Remove from draft
  draft.photos = (draft.photos || []).filter(p => p.id !== photoId);
  await env.BHR_KV.put('draft:current', JSON.stringify(draft));

  return json({
    ok: true,
    recoveryUntil: new Date(now + TRASH_TTL_MS).toISOString(),
  });
}

async function handlePreview(request, env) {
  const url = new URL(request.url);

  // Try cookie session first
  let authed = await requireAuth(request, env);

  // If no session, try ?token= query param
  if (!authed) {
    const tokenParam = url.searchParams.get('token');
    if (tokenParam) {
      // Format: <tokenId>.<expires>.<sig>
      const parts = tokenParam.split('.');
      if (parts.length === 3) {
        const [tokenId, expiresStr, sig] = parts;
        const expires = parseInt(expiresStr, 10);
        if (!isNaN(expires) && Date.now() / 1000 <= expires) {
          const kvData = await env.BHR_KV.get(`preview-token:${tokenId}`);
          if (kvData) {
            const stored = JSON.parse(kvData);
            const valid = await hmacVerify(env.SESSION_SECRET, `preview:${tokenId}:${expires}`, sig);
            if (valid && stored.expires === expires) {
              authed = { sessionId: 'preview' };
            }
          }
        }
      }
    }
  }

  if (!authed) {
    return new Response('Preview link expired or invalid.', {
      status: 401,
      headers: { 'Content-Type': 'text/html;charset=UTF-8', ...SECURE_HEADERS },
    });
  }

  // Fetch draft content
  let content;
  const draftRaw = await env.BHR_KV.get('draft:current');
  if (draftRaw) {
    try { content = JSON.parse(draftRaw); } catch { /* fall through */ }
  }
  if (!content) {
    const res = await fetch(`${GH_RAW}/content.json`);
    if (!res.ok) return err('Could not load content', 502);
    content = await res.json();
  }

  // Fetch the v2 public site HTML
  const siteRes = await fetch(`${GH_RAW}/v2/index.html`);
  if (!siteRes.ok) {
    return err('Could not load preview template', 502);
  }
  let siteHtml = await siteRes.text();

  // Inject content
  const injection = `<script id="CONTENT_DATA">window.__BHR_PREVIEW__=true;window.__CONTENT__ = ${JSON.stringify(content)};</script>`;
  siteHtml = siteHtml.replace('<script id="CONTENT_DATA"></script>', injection);

  return new Response(siteHtml, {
    status: 200,
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
      'X-Robots-Tag': 'noindex',
      'X-Frame-Options': 'SAMEORIGIN',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

async function handlePreviewToken(request, env, session) {
  const tokenId = randomHex(16);
  const expires = Math.floor(Date.now() / 1000) + 72 * 3600;
  const sig = await hmacSign(env.SESSION_SECRET, `preview:${tokenId}:${expires}`);
  const token = `${tokenId}.${expires}.${sig}`;

  await env.BHR_KV.put(
    `preview-token:${tokenId}`,
    JSON.stringify({ expires, hmac: sig }),
    { expirationTtl: 259200 }
  );

  const workerHost = 'https://buckhorn-proxy.masecfc03.workers.dev';
  return json({
    token,
    url: `${workerHost}/preview?token=${token}`,
  });
}

async function handlePriceSheet(env) {
  const res = await fetch(`${GH_RAW}/content.json`);
  if (!res.ok) return err('Could not load content.json', 502);
  const content = await res.json();
  return html(renderPriceSheet(content));
}

function renderPriceSheet(c) {
  const ranch = c.ranch || {};
  const meta = c.meta || {};
  const lodging = c.lodging || {};
  const contact = c.contact || {};
  const pricing = c.pricing || {};

  const whitetailRows = (pricing.whitetail || []).map(r =>
    `<tr><td>${r.range || ''}</td><td class="fee">${r.fee || ''}</td></tr>`
  ).join('\n');

  const exoticRows = (pricing.exotics || []).map(r =>
    `<tr><td>${r.animal || ''}</td><td class="fee">${r.fee || ''}</td></tr>`
  ).join('\n');

  const wingRows = (pricing.wingshooting || []).map(r =>
    `<tr><td>${r.hunt || ''}</td><td>${r.season || ''}</td><td class="fee">${r.fee || ''}</td></tr>`
  ).join('\n');

  const contactEmail = contact.email?.value
    ? ` &nbsp;·&nbsp; ${contact.email.value}`
    : '';

  const terms = typeof lodging.terms === 'string'
    ? lodging.terms
    : (c.terms || '');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${ranch.name?.value || 'Buckhorn Ranch'} — Price Sheet ${meta.seasonYear || ''}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;color:#2B221B;background:#fff;padding:40px;max-width:700px;margin:0 auto}
h1{font-family:'Cormorant Garamond',Georgia,serif;font-size:28px;font-weight:600;letter-spacing:.06em;margin-bottom:4px}
.subtitle{font-size:14px;color:#4A3B2E;margin-bottom:32px;letter-spacing:.08em;text-transform:uppercase}
h2{font-family:'Cormorant Garamond',Georgia,serif;font-size:18px;font-weight:500;margin:28px 0 10px;border-bottom:1px solid #A8854B;padding-bottom:4px}
table{width:100%;border-collapse:collapse;font-size:14px;margin-bottom:16px}
th{text-align:left;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#4A3B2E;padding:6px 0;border-bottom:1px solid #EDE6D6}
td{padding:7px 0;border-bottom:1px solid #F5F1E8;vertical-align:top}
td.fee{text-align:right;font-variant-numeric:tabular-nums;font-weight:500}
.note{font-size:12px;color:#4A3B2E;margin-top:4px}
.terms{font-size:12px;color:#4A3B2E;margin-top:24px;line-height:1.7;border-top:1px solid #EDE6D6;padding-top:16px}
.contact{margin-top:24px;font-size:13px}
.print-btn{display:block;margin:32px auto 0;padding:12px 28px;background:#A8854B;color:#fff;border:none;font-size:13px;letter-spacing:.1em;text-transform:uppercase;cursor:pointer;border-radius:2px}
@media print{.print-btn{display:none}body{padding:0}@page{size:letter;margin:1in}}
</style>
</head>
<body>
<h1>${ranch.name?.value || 'Buckhorn Ranch'}</h1>
<div class="subtitle">${ranch.location?.value || ''} &nbsp;&middot;&nbsp; ${meta.seasonYear || ''}</div>

<h2>Lodging &amp; Meals</h2>
<table>
<tr><td>Per hunter — 2 nights, 3 days</td><td class="fee">${lodging.hunterRate?.value || ''}</td></tr>
<tr><td>Non-hunting guest</td><td class="fee">${lodging.guestRate?.value || ''}</td></tr>
<tr><td colspan="2" class="note">${lodging.inclusionNote?.value || ''}</td></tr>
</table>

<h2>Whitetail Trophy Fee &mdash; B&amp;C Score</h2>
<table>
<tr><th>Score Range</th><th style="text-align:right">Fee</th></tr>
${whitetailRows}
</table>

<h2>Exotic Trophy Fee</h2>
<table>
<tr><th>Animal</th><th style="text-align:right">Fee</th></tr>
${exoticRows}
</table>

<h2>Wingshooting</h2>
<table>
<tr><th>Hunt</th><th>Season</th><th style="text-align:right">Fee</th></tr>
${wingRows}
</table>

<div class="terms">${terms}</div>
<div class="contact"><strong>${contact.phone?.value || ''}</strong>${contactEmail}</div>

<button class="print-btn" onclick="window.print()">Print / Save as PDF</button>
</body>
</html>`;
}

// ─── Scheduled Handler (cron) ─────────────────────────────────────────────────

async function handleScheduled(env) {
  const manifestRaw = await env.BHR_KV.get('trash:manifest');
  if (!manifestRaw) return;

  const manifest = JSON.parse(manifestRaw);
  const now = Date.now();
  const expired = manifest.filter(e => Date.parse(e.deletedAt) + TRASH_TTL_MS < now);
  const remaining = manifest.filter(e => Date.parse(e.deletedAt) + TRASH_TTL_MS >= now);

  let pruned = 0;
  for (const entry of expired) {
    for (const file of (entry.files || [])) {
      try {
        let sha;
        try { sha = await getGhFileSha(env, file.path); } catch { continue; }
        if (!sha) continue;
        await ghApi(env, 'DELETE', `/repos/${GH_OWNER}/${GH_REPO}/contents/${file.path}`, {
          message: `Cron: purge trash ${file.path}`,
          sha,
          branch: GH_BRANCH,
        });
        pruned++;
      } catch { /* best-effort */ }
    }
  }

  await env.BHR_KV.put('trash:manifest', JSON.stringify(remaining));

  // Audit log entry
  const auditRaw = await env.BHR_KV.get('audit:log');
  const audit = auditRaw ? JSON.parse(auditRaw) : [];
  audit.unshift({
    timestamp: new Date(now).toISOString(),
    summary: `Cron: pruned ${pruned} trash files`,
    mode: 'cron',
  });
  if (audit.length > AUDIT_CAP) audit.length = AUDIT_CAP;
  await env.BHR_KV.put('audit:log', JSON.stringify(audit));
}

// ─── Router ───────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // OPTIONS preflight (for dev CORS)
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': request.headers.get('Origin') || '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Cookie',
          'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // ── Public routes ──────────────────────────────────────────────────────────

    if (method === 'POST' && path === '/auth') {
      return handleAuth(request, env);
    }

    if (method === 'GET' && path === '/pricesheet') {
      return handlePriceSheet(env);
    }

    if (method === 'GET' && path === '/preview') {
      return handlePreview(request, env);
    }

    // Admin HTML is always served — the page itself handles auth via JS
    if (method === 'GET' && path === '/admin') {
      return handleAdminPage();
    }

    // ── Auth-required routes ───────────────────────────────────────────────────

    const session = await requireAuth(request, env);
    if (!session) {
      return err('Unauthorized', 401);
    }

    if (method === 'POST' && path === '/auth/logout') {
      return handleLogout(request, env, session);
    }

    if (method === 'GET' && path === '/api/draft') {
      return handleGetDraft(env);
    }

    if (method === 'PUT' && path === '/api/draft') {
      return handlePutDraft(request, env);
    }

    if (method === 'POST' && path === '/api/publish') {
      return handlePublish(request, env);
    }

    if (method === 'GET' && path === '/api/versions') {
      return handleGetVersions(env);
    }

    if (method === 'GET' && path.startsWith('/api/versions/')) {
      const timestamp = path.slice('/api/versions/'.length);
      return handleGetVersion(env, timestamp);
    }

    if (method === 'GET' && path === '/api/audit') {
      return handleGetAudit(env);
    }

    if (method === 'POST' && path === '/api/timmy') {
      return handleTimmy(request, env, session);
    }

    if (method === 'POST' && path === '/api/timmy-dev') {
      return handleTimmyDev(request, env, session);
    }

    if (method === 'POST' && path === '/api/change-passcode') {
      return handleChangePasscode(request, env, session);
    }

    if (method === 'GET' && path === '/api/timmy-history') {
      return handleGetTimmyHistory(env, session);
    }

    if (method === 'DELETE' && path === '/api/timmy-history') {
      return handleDeleteTimmyHistory(env, session);
    }

    if (method === 'POST' && path === '/api/images/upload') {
      return handleImageUpload(request, env);
    }

    if (method === 'DELETE' && path.startsWith('/api/images/')) {
      const photoId = path.slice('/api/images/'.length);
      return handleImageDelete(env, photoId);
    }

    if (method === 'POST' && path === '/api/preview-token') {
      return handlePreviewToken(request, env, session);
    }

    return err('Not found', 404);
  },

  async scheduled(event, env) {
    await handleScheduled(env);
  },
};
