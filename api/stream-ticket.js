const dns = require('node:dns/promises');
const net = require('node:net');
const { encode } = require('../lib/stream-token');

function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    return p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224 ||
      (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168);
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    return s === '::' || s === '::1' || s.startsWith('fc') || s.startsWith('fd') ||
      s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb');
  }
  return true;
}
async function assertPublic(url) {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('URL do servidor de mídia inválida.');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local')) throw new Error('Host local não permitido.');
  const ips = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!ips.length || ips.some(x => privateIp(x.address))) throw new Error('Host local/privado bloqueado.');
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });
  try {
    const { kind, id, ext } = req.body || {};
    const host = process.env.XTREAM_HOST;
    const username = process.env.XTREAM_USERNAME;
    const password = process.env.XTREAM_PASSWORD;
    if (!host || !username || !password)
      return res.status(503).json({ error: 'Conexão não configurada: cadastre XTREAM_HOST, XTREAM_USERNAME e XTREAM_PASSWORD nas variáveis privadas da Vercel.' });
    if (![kind, id, ext].every(x => typeof x === 'string'))
      return res.status(400).json({ error: 'Dados do stream incompletos.' });
    if (!['movie', 'series', 'live'].includes(kind) || !/^\d{1,20}$/.test(id) || !/^[a-zA-Z0-9]{1,10}$/.test(ext))
      return res.status(400).json({ error: 'Tipo, ID ou formato do stream inválido.' });
    if (host.length > 400 || username.length > 180 || password.length > 180)
      return res.status(400).json({ error: 'Campo excede o limite permitido.' });
    const base = new URL(host.trim());
    if (base.search || base.hash) return res.status(400).json({ error: 'Informe apenas o endereço base do provedor.' });
    await assertPublic(base);
    const prefix = base.pathname.replace(/\/$/, '');
    base.pathname = `${prefix}/${kind}/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${id}.${ext}`;
    base.search = '';
    const token = encode({ url: base.toString(), exp: Date.now() + 2 * 60 * 60 * 1000 });
    return res.status(200).json({ url: `/api/stream?t=${encodeURIComponent(token)}` });
  } catch (e) {
    const message = e.message.includes('STREAM_PROXY_SECRET') ? e.message : 'Não foi possível preparar o stream. Verifique a conexão com o host do provedor.';
    return res.status(502).json({ error: message });
  }
};
