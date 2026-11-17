const dns = require('node:dns/promises');
const net = require('node:net');

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

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });
  try {
    const { host, username, password, action, series_id, vod_id } = req.body || {};
    if (typeof host !== 'string' || typeof username !== 'string' || typeof password !== 'string' || typeof action !== 'string')
      return res.status(400).json({ error: 'Informe endereço, usuário, senha e ação.' });
    if (!ALLOWED.has(action)) return res.status(400).json({ error: 'Ação não permitida.' });
    if ((series_id !== undefined && !/^\d{1,20}$/.test(String(series_id))) ||
        (vod_id !== undefined && !/^\d{1,20}$/.test(String(vod_id))))
      return res.status(400).json({ error: 'ID de conteúdo inválido.' });
    if (host.length > 400 || username.length > 180 || password.length > 180)
      return res.status(400).json({ error: 'Campo excede o limite permitido.' });
    const base = new URL(host.trim());
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash)
      return res.status(400).json({ error: 'Endereço inválido. Informe apenas a URL base do servidor.' });
    if (base.hostname === 'localhost' || base.hostname.endsWith('.local'))
      return res.status(400).json({ error: 'Endereço local não permitido.' });
    const addresses = net.isIP(base.hostname) ? [{ address: base.hostname }] : await dns.lookup(base.hostname, { all: true });
    if (!addresses.length || addresses.some(x => isPrivate(x.address)))
      return res.status(400).json({ error: 'O endereço do servidor não pode ser privado/local.' });
    base.pathname = base.pathname.replace(/\/$/, '') + '/player_api.php';
    base.search = '';
    base.searchParams.set('username', username);
    base.searchParams.set('password', password);
    base.searchParams.set('action', action);
    if (action === 'get_series_info') base.searchParams.set('series_id', String(series_id || ''));
    if (action === 'get_vod_info') base.searchParams.set('vod_id', String(vod_id || ''));
    const upstream = await fetch(base, { redirect: 'manual', signal: AbortSignal.timeout(18000), headers: { Accept: 'application/json' } });
    if (upstream.status >= 300 && upstream.status < 400)
      return res.status(502).json({ error: 'O servidor de conteúdo redirecionou a consulta; redirecionamentos foram bloqueados por segurança.' });
    const text = await upstream.text();
    if (!upstream.ok) return res.status(502).json({ error: `O provedor respondeu HTTP ${upstream.status}.` });
    let data;
    try { data = JSON.parse(text); } catch { return res.status(502).json({ error: 'Resposta inválida do provedor. Confirme o endereço e as credenciais.' }); }
    return res.status(200).json({ data });
  } catch (e) {
    const message = e.name === 'TimeoutError' ? 'Tempo esgotado ao conectar ao provedor.' : 'Não foi possível conectar. Confira o endereço, a rede e as credenciais.';
    return res.status(502).json({ error: message });
  }
};
