const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Action',
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS })
    }

    const action = request.headers.get('X-Action') || 'claude'

    // ── GitHub proxy ──────────────────────────────────────
    if (action === 'github') {
      const { method, path, body } = await request.json()
      const res = await fetch('https://api.github.com' + path, {
        method: method || 'GET',
        headers: {
          'Authorization': 'Bearer ' + env.GH_TOKEN,
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'buckhorn-admin',
        },
        body: body ? JSON.stringify(body) : undefined,
      })
      const data = await res.text()
      return new Response(data, {
        status: res.status,
        headers: { 'Content-Type': 'application/json', ...CORS },
      })
    }

    // ── Anthropic proxy ───────────────────────────────────
    const body = await request.text()
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body,
    })
    const data = await res.text()
    return new Response(data, {
      status: res.status,
      headers: { 'Content-Type': 'application/json', ...CORS },
    })
  },
}
