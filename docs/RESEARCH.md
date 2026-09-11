# Pesquisa inicial --- 11/09/2026

## Postiz

Projeto self-hosted de scheduling social, com calendário, analytics,
equipe, biblioteca de mídia e múltiplos canais. A documentação pública
inclui API e o repositório usa monorepo. Licença AGPL-3.0. Decisão
inicial: estudar profundamente antes de reconstruir
conectores/agendamento; não incorporar código até revisão de licença.

## Remotion

Framework React para vídeo programático e batch rendering. Possui Agent
Skills. Há termos próprios de licença em certos usos comerciais. Decisão
inicial: forte candidato para render de vídeo, condicionado à licença.

## n8n

Plataforma self-hosted/fair-code de automação com grande ecossistema.
Decisão inicial: útil para automações periféricas, não como core
transacional.

## TikTok

A documentação oficial atual confirma Content Posting API / Direct Post
e suporte a publicação de vídeos e fotos. Implementação deve seguir os
requisitos e revisão atuais da plataforma.

## Meta

Antes da Fase 3, o agente deve reler a documentação oficial vigente e
registrar requisitos, scopes e review em ADR; não congelar detalhes de
API neste pacote.


## Auditoria com fontes — 11/09/2026

A pesquisa inicial acima é complementada por
[decisões e fontes](discovery/DECISIONS.md) e pela
[matriz de APIs](discovery/API-MATRIX.md). A confirmação de vídeo/foto no
TikTok não implica elegibilidade: as diretrizes Direct Post conflitam com
um utilitário restrito às contas administradas pela equipe. A verificação
Meta permanece parcial, com indisponibilidade de páginas oficiais registrada.
Skills oficiais Vercel/Remotion foram avaliadas; nenhuma foi instalada.
