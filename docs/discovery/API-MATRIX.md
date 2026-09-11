# Matriz de APIs oficiais — 11/09/2026

Levantamento de discovery, não especificação congelada. Nenhum app, escopo concedido, token ou conta foi verificado no painel dos provedores. Revalidar documentação e versão da API imediatamente antes da implementação.

## Meta

| Caminho | Evidência e escopo inicial | Pendente antes do conector |
| --- | --- | --- |
| Instagram com Facebook Login | Coleção oficial Meta: conta profissional e Page vinculada; listar Pages e obter identidade/token correspondente. Permissões de publicação a investigar: `pages_show_list`, `pages_read_engagement`, `instagram_basic`, `instagram_content_publish`. | Confirmar conjunto mínimo para endpoints selecionados, tarefas da Page, App Review/Advanced Access, exigência de Business Verification no caso concreto e versão Graph suportada. |
| Instagram com Instagram Login | Coleção oficial distingue este produto e permissões `instagram_business_basic` / `instagram_business_content_publish`. | Confirmar onboarding, renovação e requisitos específicos; não misturar tokens/scopes dos dois fluxos. Não implementar duas opções no primeiro incremento. |
| Facebook Pages | Página oficial de posts não pôde ser lida nesta sessão (HTTP 429). | Leitura oficial de criação de posts/fotos/Reels, scopes mínimos, Page token, review, renovação e limites. Nenhum endpoint ou lista de permissões é aprovado para implementação por este levantamento. |

Fonte consultada: [coleção oficial Instagram da Meta](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api?entity=request-23987686-ab559ffb-8e2c-4b0a-b43a-5737b6d2f672). A coleção inclui permissões para funções adicionais: não solicitar mensagens/comentários sem necessidade. Documentação principal a revalidar: [Instagram Publishing](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing/) e [Pages Posts](https://developers.facebook.com/docs/pages-api/posts/). O acesso direto à primeira também falhou; a coleção é evidência complementar oficial, não aprovação do app.

A [coleção de exemplos Meta](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api) demonstra criação de container de Reel, consulta de processamento e publicação do container. Salvar o container antes da etapa seguinte; HTTP aceito não equivale a publicação confirmada. Limites de mídia, carrosséis, Stories, expiração de containers e quotas devem ser documentados por formato no PR Meta. Não fixar números de memória.

Proposta para MVP: avaliar primeiro Facebook Login para atender conjuntamente Page e Instagram profissional, condicionado à configuração da conta de teste. OAuth exige state vinculado à sessão, uso único, expiração, redirect validado e PKCE quando suportado pelo fluxo escolhido. Persistir scopes efetivos e expiração; token revogado exige reconexão. Não registrar tokens em query strings de logs mesmo quando exemplos de documentação os mostram.

## TikTok

[Getting started oficial](https://developers.tiktok.com/doc/content-posting-api-get-started): Direct Post suporta vídeo/foto, exige app e usuário autorizados para `video.publish`, consulta de creator info e tratamento assíncrono. Aprovação de escopo e auditoria são gates distintos do sucesso de uma chamada de teste.

[Diretrizes Direct Post](https://developers.tiktok.com/doc/content-sharing-guidelines): o uso restrito a contas administradas pela própria equipe é explicitamente incompatível com o uso pretendido. Apps sem auditoria têm publicação privada. A interface precisa respeitar opções atuais do criador, consentimento e seleção de privacidade; URLs de mídia no servidor exigem domínio/prefixo verificado conforme o método aplicável.

Consequência para SocialFlow: **NO-GO para prometer Direct Post público como utilitário interno no desenho atual**. Suporte técnico a fotos não resolve elegibilidade. Reutilizar Postiz self-hosted também não demonstra aprovação do nosso app.

Alternativas a avaliar separadamente: provedor com integração oficialmente aprovada e contrato compatível; fluxo de exportação com publicação manual; produto com experiência adequada a público amplo. Nenhuma foi selecionada, contratada ou implementada. Upload assistido não deve ser apresentado como atalho garantido para auditoria.

## Gates das integrações

1. Fonte oficial acessível e requisitos/versão registrados por formato e fluxo OAuth.
2. Conta própria e permissões demonstradas; revisão do provedor quando aplicável.
3. Tenant e conta social autorizados no backend, inclusive no worker.
4. Tokens criptografados e logs redigidos; revogação/expiração testadas.
5. Fixtures de respostas e erros; processamento pendente, rate limit e timeout testados.
6. Publicação controlada com ID remoto confirmado e tratamento de resultado incerto.

Fases 1/2 podem ser planejadas sem credenciais sociais. Fase 3 continua com verificação Meta pendente; Fase 5 depende da resolução de elegibilidade TikTok.
