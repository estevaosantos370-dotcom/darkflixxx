const dns = require('node:dns/promises');
const net = require('node:net');
const { encode } = require('../lib/stream-token');

const ALLOWED = new Set([
  'get_user_info', 'get_vod_categories', 'get_vod_streams', 'get_vod_info',
  'get_series_categories', 'get_series', 'get_series_info', 'get_live_categories', 'get_live_streams'
]);

function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    return p[0] === 10 || p[0] === 127 || p[0] === 0 ||
      (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) || p[0] >= 224;
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    return s === '::1' || s === '::' || s.startsWith('fc') || s.startsWith('fd') ||
      s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb') || s.startsWith('::ffff:127.');
  }
  return true;
}

function forceHttp(value) {
  const url = new URL(value);
  if (url.protocol === 'https:') {
    url.protocol = 'http:';
    if (url.port === '443') url.port = '';
  }
  if (url.protocol !== 'http:') throw new Error('XTREAM_HOST precisa usar HTTP.');
  return url;
}

async function assertPublic(url) {
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local')) throw new Error('Host local bloqueado.');
  const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addresses.length || addresses.some(x => isPrivate(x.address))) throw new Error('O endereço do servidor não pode ser privado/local.');
}

function proxyImageUrls(value) {
  if (Array.isArray(value)) return value.map(proxyImageUrls);
  if (!value || typeof value !== 'object') return value;
  for (const [name, item] of Object.entries(value)) {
    if (typeof item === 'string' && /(?:icon|cover|image|poster|logo|backdrop)/i.test(name) && /^https?:\/\//i.test(item)) {
      try {
        const image = new URL(item);
        if (!image.username && !image.password) {
          const token = encode({ url: forceHttp(image).toString(), exp: Date.now() + 2 * 60 * 60 * 1000 });
          value[name] = `/api/proxy?t=${encodeURIComponent(token)}`;
        }
      } catch {}
    } else if (item && typeof item === 'object') {
      value[name] = proxyImageUrls(item);
    }
  }
  return value;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type, User-Agent, Cache-Control, Pragma');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Este endpoint usa somente GET.' });
  try {
    const query = req.query || {};
    const { series_id, vod_id, action } = query;
    const host = process.env.XTREAM_HOST;
    const username = process.env.XTREAM_USERNAME;
    const password = process.env.XTREAM_PASSWORD;
    if (!host || !username || !password)
      return res.status(503).json({ error: 'Conexão não configurada: cadastre XTREAM_HOST, XTREAM_USERNAME e XTREAM_PASSWORD nas variáveis privadas da Vercel.' });
    if (typeof action !== 'string' || !ALLOWED.has(action)) return res.status(400).json({ error: 'Ação não permitida.' });
    if ((series_id !== undefined && !/^\d{1,20}$/.test(String(series_id))) ||
        (vod_id !== undefined && !/^\d{1,20}$/.test(String(vod_id))))
      return res.status(400).json({ error: 'ID de conteúdo inválido.' });
    if (host.length > 400 || username.length > 180 || password.length > 180)
      return res.status(400).json({ error: 'Campo excede o limite permitido.' });

    let url = forceHttp(host.trim());
    if (url.search || url.hash || url.username || url.password) return res.status(400).json({ error: 'Informe somente o host-base Xtream, sem query, fragmento ou credenciais na URL.' });
    url.pathname = url.pathname.replace(/\/$/, '') + '/player_api.php';
    url.search = '';
    url.searchParams.set('username', username);
    url.searchParams.set('password', password);
    url.searchParams.set('action', action);
    if (action === 'get_series_info') url.searchParams.set('series_id', String(series_id || ''));
    if (action === 'get_vod_info') url.searchParams.set('vod_id', String(vod_id || ''));

    let upstream;
    for (let hop = 0; hop < 6; hop++) {
      await assertPublic(url);
      upstream = await fetch(url, {
        method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(18000),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Accept: 'application/json, */*',
          'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
          'Cache-Control': 'no-cache', Pragma: 'no-cache',
          Origin: url.origin, Referer: `${url.origin}/`
        }
      });
      if (![301, 302, 303, 307, 308].includes(upstream.status)) break;
      const location = upstream.headers.get('location');
      if (!location) return res.status(502).json({ error: 'O provedor enviou redirecionamento sem destino.' });
      url = forceHttp(new URL(location, url));
      if (hop === 5) return res.status(502).json({ error: 'O provedor excedeu o limite de redirecionamentos HTTP.' });
    }
    const text = await upstream.text();
    if (!upstream.ok) return res.status(502).json({ error: `O provedor respondeu HTTP ${upstream.status}.` });
    let data;
    try { data = JSON.parse(text); } catch { return res.status(502).json({ error: 'Resposta inválida do provedor. Confirme o endereço e as credenciais.' }); }
    return res.status(200).json({ data: proxyImageUrls(data) });
  } catch (e) {
    const message = e.message.includes('STREAM_PROXY_SECRET') ? e.message :
      e.cause?.code === 'ECONNREFUSED' || e.code === 'ECONNREFUSED' ? 'CONNECTION_REFUSED: o host HTTP do catálogo recusou a conexão a partir da Vercel. Confirme o endereço e a porta com o provedor.' :
      e.name === 'TimeoutError' ? 'Tempo esgotado ao conectar ao provedor HTTP.' : 'Não foi possível conectar. Confira as variáveis privadas e o endereço HTTP do provedor.';
    return res.status(502).json({ error: message });
  }
};
