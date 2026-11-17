const dns = require('node:dns/promises');
const net = require('node:net');
const { Readable } = require('node:stream');
const { decode, encode } = require('../lib/stream-token');
const CHUNK = 4 * 1024 * 1024;

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
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('URL de mídia inválida.');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local')) throw new Error('Host local bloqueado.');
  const ips = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!ips.length || ips.some(x => privateIp(x.address))) throw new Error('Host privado bloqueado.');
}
function tokenUrl(url, exp) {
  return `/api/stream?t=${encodeURIComponent(encode({ url, exp }))}`;
}
function rewritePlaylist(text, baseUrl, exp) {
  const absolute = value => {
    try { return new URL(value.trim(), baseUrl).toString(); } catch { return ''; }
  };
  const lines = text.split(/\r?\n/).map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (!trimmed.startsWith('#')) {
      const url = absolute(trimmed);
      return url ? tokenUrl(url, exp) : line;
    }
    return line.replace(/URI="([^"]+)"/g, (match, uri) => {
      const url = absolute(uri);
      return url ? `URI="${tokenUrl(url, exp)}"` : match;
    });
  });
  return lines.join('\n');
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!['GET', 'HEAD'].includes(req.method)) return res.status(405).end('Use GET or HEAD.');
  let controller;
  try {
    const payload = decode(req.query?.t);
    let current = new URL(payload.url);
    const requestedRange = req.headers.range;
    let range = requestedRange;
    const isPlaylist = /\.m3u8(?:$|\?)/i.test(current.href);
    const isMp4Like = /\.(mp4|m4v|mov|mkv)(?:$|\?)/i.test(current.href);
    if (!isPlaylist && isMp4Like) {
      const m = requestedRange && requestedRange.match(/^bytes=(\d+)-(\d*)$/);
      if (requestedRange && !m) return res.status(416).end('Invalid Range.');
      const start = m ? Number(m[1]) : 0;
      const requestedEnd = m && m[2] ? Number(m[2]) : start + CHUNK - 1;
      const end = Math.min(requestedEnd, start + CHUNK - 1);
      range = `bytes=${start}-${end}`;
    }
    controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    let upstream;
    for (let hops = 0; hops < 6; hops++) {
      await assertPublic(current);
      const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36', 'Accept': '*/*' };
      headers.Referer = `${current.origin}/`;
      if (range) headers.Range = range;
      if (req.headers['if-range']) headers['If-Range'] = req.headers['if-range'];
      upstream = await fetch(current, { method: req.method, headers, redirect: 'manual', signal: controller.signal });
      if (![301, 302, 303, 307, 308].includes(upstream.status)) break;
      const location = upstream.headers.get('location');
      if (!location) throw new Error('O host de mídia enviou um redirecionamento sem destino.');
      current = new URL(location, current);
      if (hops === 5) throw new Error('O host de mídia excedeu o limite de redirecionamentos.');
    }
    if (!upstream) throw new Error('O provedor não respondeu.');
    const type = upstream.headers.get('content-type') || '';
    const playlist = /mpegurl|vnd\.apple\.mpegurl/i.test(type) || /\.m3u8(?:$|\?)/i.test(current.href);
    if (!upstream.ok && upstream.status !== 206) {
      const hint = upstream.status === 401 || upstream.status === 403 ? ' O provedor recusou as credenciais ou o acesso ao stream.' : '';
      return res.status(502).json({ error: `O host de mídia respondeu HTTP ${upstream.status}.${hint}` });
    }
    if (playlist && req.method !== 'HEAD') {
      const body = await upstream.text();
      if (!body.trim()) return res.status(502).json({ error: 'O provedor devolveu uma playlist vazia.' });
      res.statusCode = upstream.status === 206 ? 206 : 200;
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.end(rewritePlaylist(body, current, payload.exp));
    }
    if (isMp4Like && range && upstream.status !== 206) {
      return res.status(502).json({ error: 'O servidor de mídia não suporta Range/206; não é possível reproduzir este arquivo por partes.' });
    }
    res.statusCode = upstream.status;
    for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    if (isMp4Like) res.setHeader('Accept-Ranges', 'bytes');
    if (req.method === 'HEAD' || !upstream.body) return res.end();
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (e) {
    if (res.headersSent || res.writableEnded) return;
    const missingSecret = e.message.includes('STREAM_PROXY_SECRET');
    const connection = e.cause?.code || e.code;
    const message = missingSecret ? e.message : connection === 'ECONNREFUSED'
      ? 'CONNECTION_REFUSED: o host/porta do stream recusou a conexão até pela Vercel. Confirme com o provedor o endereço de mídia e se o servidor está ativo.'
      : e.name === 'TimeoutError' ? 'O host de mídia não respondeu dentro do tempo limite.'
      : e.message.includes('Host privado') || e.message.includes('Host local') ? e.message
      : 'Não foi possível buscar o stream no provedor. Confira o endereço de mídia e a conectividade do servidor.';
    res.setHeader('X-Stream-Error', message);
    return res.status(502).json({ error: message });
  }
};
