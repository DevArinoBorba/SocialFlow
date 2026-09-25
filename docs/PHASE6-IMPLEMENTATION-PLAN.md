# Fase 6 — Plano de implementação da geração de artes em lote

## Objetivo

Permitir que a equipe transforme conteúdo aprovado, marca e mídia já cadastrados
em artes estáticas reprodutíveis nos formatos 1:1, 4:5 e 9:16. O resultado deve
entrar na biblioteca de mídia existente e seguir o fluxo normal de revisão,
agendamento e publicação.

O primeiro incremento não inclui vídeo, inteligência artificial generativa nem
um editor gráfico livre. Esses itens aumentariam o risco técnico antes de o
modelo declarativo e o pipeline de renderização estarem validados.

## Princípios

- O template é declarativo, versionado e validado no servidor.
- A mesma entrada e a mesma versão do renderer produzem o mesmo resultado.
- Arquivos de fonte e imagem são privados e pertencem ao tenant.
- O navegador apenas configura e visualiza; a renderização definitiva ocorre no
  worker.
- Cada execução é idempotente e possui estado persistente, auditoria e limites de
  recursos.
- O renderer nunca recebe HTML, CSS, URLs ou caminhos arbitrários fornecidos pelo
  usuário.
- A Fase 6 reutiliza a biblioteca S3/R2, o PostgreSQL, o Redis/BullMQ e os controles
  de tenant já existentes.

## Incremento 1 — Uma arte estática controlada

Entregar o menor percurso completo antes do processamento em lote:

1. Criar o modelo persistente de template e sua versão imutável.
2. Suportar um layout aprovado com imagem de fundo, título, texto curto, logotipo
   opcional, cores e alinhamento.
3. Renderizar uma única arte em 1:1, 4:5 ou 9:16.
4. Salvar o arquivo final na biblioteca de mídia com origem `GENERATED` e vínculo
   com template, versão e entrada utilizada.
5. Exibir prévia, estado da execução e mensagem de erro segura na interface.
6. Registrar criação, execução e resultado no `AuditLog`.

### Gate

Com a mesma entrada, a mesma versão do template e a mesma versão do renderer,
duas execuções devem gerar o mesmo hash de conteúdo. Falha ou repetição não pode
criar ativos duplicados.

## Incremento 2 — Editor básico de templates

- Criar, duplicar, renomear, arquivar e versionar templates.
- Selecionar formato, fonte aprovada, cores da marca, alinhamento e safe areas.
- Validar contraste, overflow de texto e dimensões antes de enfileirar.
- Mostrar prévia com a mesma regra de layout usada pelo renderer definitivo.
- Restringir escrita a OWNER, ADMIN e EDITOR; APPROVER e CLIENT_VIEWER mantêm
  acesso somente de leitura conforme seu tenant.

### Gate

Testes de autorização e isolamento devem provar que nenhum usuário lê ou altera
template, fonte, mídia ou render de outro tenant.

## Incremento 3 — Lote de geração

- Gerar artes a partir de posts selecionados ou importação já validada.
- Criar job pai e jobs determinísticos por item e formato.
- Definir concorrência baixa e configurável no worker para proteger a VPS.
- Implementar retry apenas para falhas transitórias, cancelamento e retomada.
- Persistir progresso por item sem esconder sucesso parcial.
- Impedir que uma repetição do lote gere novamente itens já concluídos.

### Gate

Gerar 100 artes em ambiente isolado, com resultados consistentes, memória e CPU
limitadas, retomada após reinício do worker e nenhuma duplicação.

## Incremento 4 — Operação e aceite em homologação

- Métricas de duração, fila, memória, falhas e tamanho dos arquivos.
- Limites por quantidade de itens, resolução, pixels, texto e tamanho de fonte.
- Limpeza segura de arquivos temporários e política de retenção de execuções.
- Teste visual nos três formatos com textos curtos, longos e caracteres especiais.
- Deploy por imagem GHCR imutável, seguido de teste controlado sem publicação
  automática em rede social.

## Modelo de dados proposto

Os nomes finais dependem da revisão do schema, mas o domínio precisa representar:

- `DesignTemplate`: identidade, tenant, nome, estado e formato padrão.
- `DesignTemplateVersion`: especificação imutável, versão do renderer e hash.
- `RenderBatch`: solicitação, estado, totais, ator e chave de idempotência.
- `RenderJob`: entrada, formato, estado, tentativas, erro seguro e ativo resultante.
- `MediaAsset`: arquivo final já gerenciado pela biblioteca existente.

Não guardar imagens em JSON ou no PostgreSQL. A especificação referencia somente
IDs autorizados de marca, fonte e mídia.

## Pesquisa obrigatória antes do código

Antes de escolher o renderer, comparar pelo menos:

- SVG gerado no servidor e rasterizado com Sharp;
- HTML/CSS em navegador isolado;
- bibliotecas maduras de composição de canvas ou SVG.

A decisão deve registrar licença, atividade do projeto, suporte a fontes,
determinismo, consumo de memória, segurança de entradas e qualidade nos três
formatos. A escolha e as versões fixadas devem ser adicionadas ao ADR. Remotion
continua reservado para a Fase 7, após a revisão de licença e capacidade.

## Sequência de trabalho

1. Spike técnico isolado e ADR do renderer. **Concluído:** Satori + Sharp foi
   selecionado no [ADR-012](ADR.md#adr-012--renderer-estático-da-fase-6-21092026).
2. Contratos e schema do Incremento 1. **Concluído:** formatos, especificação
   declarativa, versões imutáveis, execuções idempotentes e isolamento RLS foram
   adicionados na migration `202609210001_design_templates_and_render_jobs`.
3. Renderer puro com testes de hash e casos de overflow. **Concluído:** o pacote
   `@socialflow/render` usa fontes empacotadas, bytes de mídia já autorizados e
   limites de texto, sem aceitar HTML, CSS, URL ou caminho arbitrário.
4. Armazenamento e fila idempotente. **Concluído.**
5. API com RBAC/RLS e auditoria. **Concluído.**
6. Interface de prévia e geração individual. **Concluído.**
7. Revisão independente do Incremento 1. **Concluída.**
8. Editor básico e geração em lote. **Incrementos 2 e 3 concluídos.**

### Estado atual — Incremento 4: operação e aceite

O gate automatizado de carga/resiliência do Incremento 3 e a validação de
qualidade foram reportados como aprovados em 23/09/2026. Falta concluir o
aceite operacional do Incremento 4: revisar métricas e limites operacionais,
confirmar retenção/limpeza de temporários e executar homologação controlada na
infraestrutura alvo. Até esse aceite, a Fase 6 permanece aberta e a aplicação
não deve publicar automaticamente em redes sociais após renderizar.

### Verificação da fundação

A fundação foi validada com 147 testes unitários e 174 testes de integração,
incluindo determinismo nos três formatos, dimensões finais, validação de entrada,
isolamento entre organizações, imutabilidade de versões e unicidade da chave de
idempotência. Migration, lint, formatação, tipos e build de produção também
foram executados com sucesso.

## Fora do primeiro incremento

- Vídeo e áudio.
- Geração de imagem ou texto por IA.
- Editor livre semelhante a Canva ou Figma.
- Upload de HTML, CSS, SVG ativo ou fontes arbitrárias.
- Execução de código fornecido pelo usuário.
- Publicação automática logo após renderizar.

## Critério de conclusão da Fase 6

A fase termina quando um lote de 100 artes puder ser gerado e retomado de forma
reprodutível, com isolamento por tenant, consumo controlado, auditoria, ausência
de duplicação e arquivos finais disponíveis na biblioteca de mídia para revisão.
