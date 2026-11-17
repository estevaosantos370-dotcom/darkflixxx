const dns = require('node:dns/promises');
const net = require('node:net');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
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
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('URL de mídia inválida.');
  }
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local')) throw new Error('Host local bloqueado.');
  const ips = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!ips.length || ips.some(x => privateIp(x.address))) throw new Error('Host privado bloqueado.');
}

function alternateProtocol(url) {
  const alternate = new URL(url);
  if (url.protocol === 'http:' && (!url.port || url.port === '80')) {
    alternate.protocol = 'https:';
    alternate.port = '';
    return alternate;
  }
  if (url.protocol === 'https:' && (!url.port || url.port === '443')) {
    alternate.protocol = 'http:';
    alternate.port = '';
    return alternate;
  }
  return null;
}

function tokenUrl(url, exp) {
  return `/api/proxy?t=${encodeURIComponent(encode({ url, exp }))}`;
}

function rewritePlaylist(text, baseUrl, exp) {
  const absolute = value => {
    try { return new URL(value.trim(), baseUrl).toString(); } catch { return ''; }
  };
  return text.split(/\r?\n/).map(line => {
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
  }).join('\n');
}

function setStreamError(res, message) {
  res.setHeader('X-Stream-Error', message);
  res.setHeader('Access-Control-Expose-Headers', 'X-Stream-Error, Content-Range, Accept-Ranges');
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', 'X-Stream-Error, Content-Range, Accept-Ranges');
  if (!['GET', 'HEAD'].includes(req.method)) return res.status(405).end('Use GET or HEAD.');

  let controller;
  try {
    const payload = decode(req.query?.t);
    let current = new URL(payload.url);
    const requestedRange = req.headers.range;
    let range = requestedRange;
    let originalOrigin = current.origin;
    let originalReferer = current.toString();
    let protocolRetryUsed = false;
    const isPlaylist = /\.m3u8(?:$|\?)/i.test(current.href);
    const isMp4Like = /\.(mp4|m4v|mov|mkv)(?:$|\?)/i.test(current.href);

    if (!isPlaylist && isMp4Like && req.method !== 'HEAD') {
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
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: '*/*',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        Referer: current.origin === originalOrigin ? originalReferer : `${current.origin}/`
      };
      if (range) headers.Range = range;
      if (req.headers['if-range']) headers['If-Range'] = req.headers['if-range'];
      try {
        upstream = await fetch(current, { method: req.method, headers, redirect: 'manual', signal: controller.signal });
      } catch (error) {
        if ((error.cause?.code || error.code) !== 'ECONNREFUSED' || protocolRetryUsed) throw error;
        const alternate = alternateProtocol(current);
        if (!alternate) throw error;
        await assertPublic(alternate);
        protocolRetryUsed = true;
        current = alternate;
        originalOrigin = current.origin;
        originalReferer = current.toString();
        headers.Referer = originalReferer;
        upstream = await fetch(current, { method: req.method, headers, redirect: 'manual', signal: controller.signal });
      }
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
      if (upstream.status === 416) {
        const contentRange = upstream.headers.get('content-range');
        if (contentRange) res.setHeader('Content-Range', contentRange);
        return res.status(416).end();
      }
      const hint = upstream.status === 401 || upstream.status === 403
        ? ' O provedor recusou as credenciais ou o acesso a este stream.' : '';
      const message = `O host de mídia respondeu HTTP ${upstream.status}.${hint}`;
      setStreamError(res, message);
      return res.status(502).json({ error: message });
    }

    if (playlist && req.method !== 'HEAD') {
      const body = await upstream.text();
      if (!body.trim()) {
        const message = 'O provedor devolveu uma playlist HLS vazia.';
        setStreamError(res, message);
        return res.status(502).json({ error: message });
      }
      if (!/^\uFEFF?\s*#EXTM3U(?:\s|$)/i.test(body)) {
        const blocked = /forbidden|access denied|unauthorized|cloudflare|error 403/i.test(body.slice(0, 2000));
        const message = blocked
          ? 'O provedor devolveu uma página de bloqueio no lugar da playlist HLS.'
          : `O endereço .m3u8 não devolveu uma playlist HLS válida (HTTP ${upstream.status}).`;
        setStreamError(res, message);
        return res.status(502).json({ error: message });
      }
      res.statusCode = upstream.status === 206 ? 206 : 200;
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      return res.end(rewritePlaylist(body, current, payload.exp));
    }

    if (/text\/html|application\/(?:json|xml)|text\/xml/i.test(type)) {
      const body = req.method === 'HEAD' ? '' : await upstream.text();
      const blocked = /forbidden|access denied|unauthorized|cloudflare|error 403/i.test(body.slice(0, 2000));
      const message = blocked
        ? 'O provedor devolveu uma página de bloqueio no lugar do segmento de vídeo.'
        : `O provedor devolveu ${type || 'conteúdo textual'} em vez de mídia (${current.pathname.split('/').pop()}).`;
      setStreamError(res, message);
      return res.status(502).json({ error: message });
    }

    if (isMp4Like && range && upstream.status !== 206) {
      const message = 'O servidor de mídia ignorou Range e não respondeu 206; este arquivo não pode ser transmitido por partes.';
      setStreamError(res, message);
      return res.status(502).json({ error: message });
    }

    res.statusCode = upstream.status;
    for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    if (isMp4Like) res.setHeader('Accept-Ranges', 'bytes');
    if (req.method === 'HEAD' || !upstream.body) return res.end();
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (e) {
    if (res.headersSent || res.writableEnded) return;
    const missingSecret = e.message.includes('STREAM_PROXY_SECRET');
    const connection = e.cause?.code || e.code;
    const message = missingSecret ? e.message : connection === 'ECONNREFUSED'
      ? 'CONNECTION_REFUSED: o host/porta do stream recusou a conexão até pela Vercel. Confirme com o provedor o endereço de mídia e se o servidor está ativo.'
      : e.name === 'TimeoutError' ? 'O host de mídia não respondeu dentro do tempo limite.'
      : e.message.includes('Host privado') || e.message.includes('Host local') ? e.message
      : 'Não foi possível buscar o stream no provedor. Confira o endereço de mídia e a conectividade do servidor.';
    setStreamError(res, message);
    return res.status(502).json({ error: message });
  }
};
