const crypto = require('node:crypto');

let cachedKey;
function key() {
  if (cachedKey) return cachedKey;
  const secret = process.env.STREAM_PROXY_SECRET;
  if (!secret || secret.length < 32) throw new Error('Configure STREAM_PROXY_SECRET com pelo menos 32 caracteres nas variáveis de ambiente da Vercel.');
  cachedKey = crypto.scryptSync(secret, 'darkflix-vercel-stream-v1', 32);
  return cachedKey;
}
function encode(payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map(b => b.toString('base64url')).join('.');
}
function decode(token) {
  const [ivText, tagText, dataText] = String(token || '').split('.');
  if (!ivText || !tagText || !dataText) throw new Error('Ticket de stream inválido.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  const body = Buffer.concat([decipher.update(Buffer.from(dataText, 'base64url')), decipher.final()]);
  const payload = JSON.parse(body.toString('utf8'));
  if (!payload.exp || payload.exp < Date.now()) throw new Error('Ticket expirado. Inicie a reprodução novamente.');
  return payload;
}
module.exports = { encode, decode };
