// Endpoint público de proxy HLS/mídia. O ticket assinado restringe a URL de origem;
// delegamos ao mesmo fluxo seguro de streaming para manter playlists, Range e headers.
module.exports = require('./stream');
