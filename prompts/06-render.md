# Prompt --- Render em lote

Implemente templates parametrizados para imagens 1:1, 4:5 e 9:16.
Entrada: planilha validada + template + assets. Saída: assets
versionados e vinculados ao ContentBatch/Post.

Antes de criar renderer de vídeo, avalie Remotion e Agent Skills
oficiais/existentes; registre licença e decisão. Render pesado deve
rodar no worker, nunca bloquear API. Inclua limites de concorrência,
timeout, limpeza de temporários e testes determinísticos.
