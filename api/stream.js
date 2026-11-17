const dns = require('node:dns/promises');
const net = require('node:net');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { decode, encode } = require('../lib/stream-token');
const CHUNK = 4 * 1024 * 1024;
const TICKET_TTL = 6 * 60 * 60 * 1000;

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

function normalizeProtocol(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Este proxy aceita apenas origens HTTP ou HTTPS.');
  if (url.username || url.password) throw new Error('URL de mídia inválida: não são permitidas credenciais embutidas no host.');
  return url;
}

async function assertPublic(url) {
  if (url.username || url.password) throw new Error('URL de mídia inválida: o proxy não aceita credenciais embutidas no host.');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local')) throw new Error('Host local bloqueado.');
  const ips = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!ips.length || ips.some(x => privateIp(x.address))) throw new Error('Host privado bloqueado.');
}

function tokenUrl(url, exp) {
  return `/api/proxy?t=${encodeURIComponent(encode({ url: normalizeProtocol(url).toString(), exp }))}`;
}

function rewritePlaylist(text, baseUrl, parentExp) {
  // Renova o ticket: se o ticket pai expira em menos de 1h, gera novo exp de 6h
  const exp = (!parentExp || parentExp - Date.now() < 60 * 60 * 1000)
    ? Date.now() + TICKET_TTL
    : parentExp;

  const absolute = value => {
    try { return normalizeProtocol(new URL(value.trim(), baseUrl)).toString(); } catch { return ''; }
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

async function fetchUpstream(url, headers, signal) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fetch(url, { method: 'GET', headers, redirect: 'manual', signal });
    } catch (e) {
      lastErr = e;
      const code = e.cause?.code || e.code;
      if (attempt === 1 || (code !== 'ECONNRESET' && code !== 'ECONNREFUSED')) throw e;
      await new Promise(r => setTimeout(r, 400));
    }
  }
  throw lastErr;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Accept, Range, If-Range, User-Agent, Cache-Control, Pragma, Icy-MetaData');
  res.setHeader('Access-Control-Expose-Headers', 'X-Stream-Error, Content-Range, Accept-Ranges');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Este proxy usa somente GET.' });

  let controller;
  try {
    const payload = decode(req.query?.t);
    let current = normalizeProtocol(payload.url);
    const requestedRange = req.headers.range;
    let range = requestedRange;
    const originalOrigin = current.origin;
    const originalReferer = current.toString();
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
      const headers = {
        'User-Agent': process.env.XTREAM_STREAM_USER_AGENT || process.env.XTREAM_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: '*/*',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        Origin: originalOrigin,
        Referer: originalReferer
      };
      if (range) headers.Range = range;
      if (req.headers['if-range']) headers['If-Range'] = req.headers['if-range'];

      upstream = await fetchUpstream(current, headers, controller.signal);

      if (![301, 302, 303, 307, 308].includes(upstream.status)) break;
      const location = upstream.headers.get('location');
      if (!location) throw new Error('O host de mídia enviou um redirecionamento sem destino.');
      current = normalizeProtocol(new URL(location, current).toString());
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
      const hint = (upstream.status === 401 || upstream.status === 403)
        ? ' O provedor recusou as credenciais ou o acesso a este stream.' : '';
      const message = `O host de mídia respondeu HTTP ${upstream.status}.${hint}`;
      setStreamError(res, message);
      return res.status(502).json({ error: message });
    }

    if (playlist) {
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
      // NÃO força Accept-Ranges em playlist HLS
      return res.end(rewritePlaylist(body, current, payload.exp));
    }

    if (/text\/html|application\/(?:json|xml)|text\/xml/i.test(type)) {
      const body = await upstream.text();
      const blocked = /forbidden|access denied|unauthorized|cloudflare|error 403/i.test(body.slice(0, 2000));
      const message = blocked
        ? 'O provedor devolveu uma página de bloqueio no lugar do segmento de vídeo.'
        : `O provedor devolveu ${type || 'conteúdo textual'} em vez de mídia.`;
      setStreamError(res, message);
      return res.status(502).json({ error: message });
    }

    // Para MP4, se a origem ignorar Range, continua transmitindo (não trava)
    if (isMp4Like && range && upstream.status !== 206) {
      res.setHeader('X-Stream-Warning', 'Origin ignorou Range; fallback para stream contínuo.');
    }

    res.statusCode = upstream.status;
    for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    if (isMp4Like && upstream.status === 206) res.setHeader('Accept-Ranges', 'bytes');
    if (!upstream.body) return res.end();

    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (e) {
    if (res.headersSent || res.writableEnded) return;
    const missingSecret = e.message.includes('STREAM_PROXY_SECRET');
    const connection = e.cause?.code || e.code;
    const message = missingSecret ? e.message : connection === 'ECONNREFUSED'
      ? 'CONNECTION_REFUSED: a origem recusou a conexão da Vercel. Confirme o host e a porta com o provedor.'
      : e.name === 'TimeoutError' ? 'O host de mídia não respondeu dentro do tempo limite.'
      : e.message.includes('Host privado') || e.message.includes('Host local') || e.message.includes('somente origens') ? e.message
      : 'Não foi possível buscar o stream no provedor.';
    setStreamError(res, message);
    return res.status(502).json({ error: message });
  }
};
