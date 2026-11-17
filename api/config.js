module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Somente GET.' });
  const host = process.env.XTREAM_HOST;
  if (!host) return res.status(503).json({ error: 'XTREAM_HOST não configurado.' });
  // Retorna apenas o host base, sem credenciais
  try {
    const url = new URL(host);
    return res.status(200).json({ host: `${url.protocol}//${url.host}` });
  } catch {
    return res.status(500).json({ error: 'XTREAM_HOST inválido.' });
  }
};
