# Dark Flix — Web Player para Vercel

Projeto pronto para publicar na Vercel: interface HTML/CSS/JavaScript responsiva e função serverless Node.js em `api/xtream.js`. Não usa PHP, MySQL nem dados de demonstração.

## Publicação

1. Descompacte o pacote e envie a pasta `darkflix-vercel` para um repositório GitHub.
2. Na Vercel, importe esse repositório. A Vercel serve `index.html` e cria a rota serverless `/api/xtream` a partir de `api/xtream.js`.
3. Não são necessárias dependências nem variáveis de ambiente.
4. Abra o site publicado e informe URL base, usuário e senha Xtream fornecidos pelo seu provedor. A tela valida a conta antes de carregar o catálogo real.

## Incluído

- Login diretamente pela autenticação do provedor.
- Perfis locais, início, filmes, séries, canais ao vivo, busca e filtro por categorias retornadas pelo provedor.
- Detalhes e sinopses de filmes; temporadas e seleção de episódios para séries.
- Favoritos e lista “Continuar assistindo”, separados por perfil e armazenados neste navegador.
- Player HTML5 com tentativa de HLS nativo ou HLS.js, controle de tela cheia, nova tentativa e seletor de variantes de URL (`m3u8`, `ts`, `mp4`) quando aplicável.
- Proxy serverless de consultas Xtream no mesmo domínio, com ações permitidas explicitamente, validação de host/IP e redirecionamentos bloqueados.

## Limites importantes

- Credenciais do provedor, perfis, favoritos e histórico ficam no `localStorage` do navegador atual; não sincronizam entre dispositivos. Não existe serviço de contas/painel administrativo nesta versão.
- A função Vercel faz proxy das respostas JSON da API. Os segmentos de vídeo são obtidos diretamente do provedor, não retransmitidos pela função serverless. Para HLS.js, o host de mídia pode precisar permitir CORS; alguns provedores, navegadores, codecs ou formatos podem impedir reprodução web. O seletor tenta variantes, mas não converte formatos.
- As contas administrativas, usuários, revendedores e operações MySQL do script original foram removidos conforme solicitado. Para sincronizar dados ou recriar gestão multiusuário segura seria necessário adicionar armazenamento persistente e autenticação server-side.
- Use somente serviços e conteúdo para os quais você tem autorização.
