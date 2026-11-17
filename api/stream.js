const dns = require('node:dns/promises');
const net = require('node:net');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { decode, encode } = require('../lib/stream-token');

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
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Este proxy aceita apenas origens HTTP ou HTTPS.');
  }
  if (url.username || url.password) throw new Error('URL de mídia inválida: não são permitidas credenciais embutidas no host.');
  return url;
}

async function assertPublic(url) {
  if (url.username || url.password) {
    throw new Error('URL de mídia inválida: o proxy não aceita credenciais embutidas no host.');
  }
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local')) throw new Error('Host local bloqueado.');
  const ips = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!ips.length || ips.some(x => privateIp(x.address))) throw new Error('Host privado bloqueado.');
}

function tokenUrl(url, exp) {
  return `/api/proxy?t=${encodeURIComponent(encode({ url: normalizeProtocol(url).toString(), exp }))}`;
}

function rewritePlaylist(text, baseUrl, exp) {
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

// Retry simples: apenas para falhas de conexão, no máximo 1 vez
async function fetchWithOneRetry(url, options) {
  try {
    return await fetch(url, options);
  } catch (e) {
    const code = e.cause?.code || e.code;
    if (code !== 'ECONNRESET' && code !== 'ECONNREFUSED') throw e;
    await new Promise(r => setTimeout(r, 500));
    return await fetch(url, options);
  }
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

    // Para MP4, se houver Range, não limitamos à força o tamanho do bloco; apenas repassamos
    // Se o cliente não enviou Range, também não adicionamos artificialmente
    // Isso evita que a origem ignore Range e cause problemas

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

      upstream = await fetchWithOneRetry(current, {
        method: 'GET', headers, redirect: 'manual', signal: controller.signal
      });

      if (![301, 302, 303, 307, 308].includes(upstream.status)) break;
      const location = upstream.headers.get('location');
      if (!location) throw new Error('O host de mídia enviou um redirecionamento sem destino.');
      current = normalizeProtocol(new URL(location, current).toString());
      if (hops === 5) throw new Error('O host de mídia excedeu o limite de redirecionamentos.');
    }
    if (!upstream) throw new Error('O provedor não respondeu.');

    const type = upstream.headers.get('content-type') || '';
    const playlist = /mpegurl|vnd\.apple\.mpegurl/i.test(type) || /\.m3u8(?:$|\?)/i.test(current.href);

    // Se a origem retornar erro, tentar ler o corpo para dar uma dica (mas não travar)
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

    // Repassar os headers da origem (incluindo status e content-range)
    res.statusCode = upstream.status;
    for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    // Não forçar Accept-Ranges; deixar a origem decidir
    if (!upstream.body) return res.end();

    // Transmitir diretamente
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (e) {
    if (res.headersSent || res.writableEnded) return;
    const missingSecret = e.message.includes('STREAM_PROXY_SECRET');
    const connection = e.cause?.code || e.code;
    let message;
    if (missingSecret) {
      message = e.message;
    } else if (connection === 'ECONNREFUSED') {
      message = 'CONNECTION_REFUSED: a origem recusou a conexão da Vercel. Confirme o host e a porta com o provedor.';
    } else if (e.name === 'TimeoutError') {
      message = 'O host de mídia não respondeu dentro do tempo limite.';
    } else if (e.message.includes('Host privado') || e.message.includes('Host local') || e.message.includes('somente origens')) {
      message = e.message;
    } else {
      message = 'Não foi possível buscar o stream no provedor: ' + (e.message || 'erro desconhecido');
    }
    setStreamError(res, message);
    return res.status(502).json({ error: message });
  }
};
