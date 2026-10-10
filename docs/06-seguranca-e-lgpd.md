# 06 — Segurança da informação e LGPD

## 1. Modelo de ameaças (STRIDE resumido)

| Ameaça | Vetor | Controle implementado |
|---|---|---|
| **S**poofing — roubo de conta | Senha vazada, força bruta | Argon2id (OWASP: m=19 MiB, t=2), *rate limit* de 10/min nos endpoints de autenticação, mensagem única para e-mail inexistente ou senha errada, tempo de resposta igualado com um *hash dummy* |
| Spoofing — sequestro de sessão | XSS lendo o token, cookie copiado | Access token só em memória (15 min); refresh em cookie `httpOnly; Secure; SameSite=Strict; Path=/api/auth`; **rotação com detecção de reuso** (reuso revoga toda a família) |
| **T**ampering — alterar dados de outra pessoa | IDOR (trocar o ID na URL) | Toda consulta e alteração filtra por `user_id` no SQL; respostas 404 indistinguíveis; testes automatizados de IDOR |
| **R**epudiation | — | Logs estruturados com `reqId`; `terms_version` e `terms_accepted_at` registrados |
| **I**nformation disclosure — localização na foto | EXIF com GPS | Foto re-encodada em WebP pelo `sharp`, **todos os metadados descartados** (testado) |
| Information disclosure — rota compartilhada | Link revela endereço e identidade | Mostra só o primeiro nome do dono; token de 128 bits não enumerável; expiração e revogação |
| Information disclosure — logs | Token ou senha nos logs | `redact` de `authorization`, `cookie` e `set-cookie`; corpo das requisições não é registrado |
| **D**enial of service | Rajadas, upload grande, "imagem-bomba" | *Rate limit* global e por rota (Redis), `bodyLimit` de 256 KB, upload ≤ 5 MB, `limitInputPixels` de 40 MP |
| DoS — upload malicioso | Arquivo que não é imagem com `Content-Type` de imagem | Validação pelo conteúdo (`sharp.metadata`), não pelo cabeçalho (testado) |
| **E**levation of privilege | Injeção SQL | 100% de consultas parametrizadas; nomes de tabelas do loader são constantes |
| Path traversal no storage | Chave de arquivo manipulada | Chaves geradas pelo servidor; validação `^[a-zA-Z0-9/_.-]+$` e bloqueio de `..` |

Outros controles: cabeçalhos de segurança (`helmet`, CSP no Nginx, `frame-ancestors 'none'`), CORS restrito à origem do front-end, validação de entrada com Zod em todas as rotas, texto livre sem caracteres de controle, coordenadas restritas ao território de Goiás.

### Pendências para produção
- [ ] Verificação de e-mail e recuperação de senha por e-mail (token de uso único, 30 min).
- [ ] Login com **gov.br** (OpenID Connect) como alternativa, o que reduz senhas próprias.
- [ ] WAF/CDN com proteção contra bots no `/auth/*` e no `/plan`.
- [ ] Varredura de dependências (Dependabot/`pnpm audit`) e SAST no CI.
- [ ] Teste de intrusão independente antes do lançamento.
- [ ] Segredos em cofre (Vault/Secret Manager); rotação do `JWT_SECRET` com chave dupla (kid).

## 2. LGPD — inventário de dados pessoais (registro das operações, art. 37)

| Dado | Finalidade | Base legal (art. 7º / 11) | Onde fica | Quem acessa | Retenção |
|---|---|---|---|---|---|
| Nome, e-mail | Identificar a conta, contato sobre o serviço | Execução de serviço a pedido do titular (art. 7º, V) — ou execução de política pública (art. 7º, III; art. 23) se o operador for órgão público | PostgreSQL | Titular; suporte mediante chamado | Até a exclusão da conta |
| Hash da senha | Autenticação | Idem | PostgreSQL | Ninguém (irreversível) | Idem |
| Foto de perfil | Personalização | Consentimento, pelo ato de enviar (art. 7º, I) | Object storage | Titular (URL não indexada) | Até troca/remoção/exclusão |
| Município (opcional) | Estatística agregada de demanda | Consentimento (campo opcional) | PostgreSQL | Relatórios agregados (n ≥ 30) | Até a exclusão |
| Rotas e pontos salvos | Funcionalidade pedida | Execução de serviço (art. 7º, V) | PostgreSQL | Titular; quem recebe link ativo | Até a exclusão |
| IP e logs de acesso | Segurança, Marco Civil (art. 15) | Obrigação legal (art. 7º, II) | Logs | Equipe de operação | 6 meses |

**Não coletamos**: CPF, data de nascimento, histórico de buscas, localização contínua do aparelho. A localização é usada só no instante em que a pessoa toca em "usar minha localização" e não é enviada ao servidor além da própria consulta. Não há rastreadores de publicidade.

> **Dado sensível por inferência:** rotas salvas como "Casa → Clínica de hemodiálise" podem revelar dado de saúde (art. 5º, II). Mitigação: os dados ficam visíveis só para o titular, não há uso secundário, o compartilhamento é opt-in por rota e os relatórios agregados não incluem nomes de pontos personalizados.

## 3. Direitos do titular (art. 18) — autoatendimento

| Direito | Como |
|---|---|
| Confirmação e acesso | Tela de perfil; `GET /api/me/export` |
| Correção | `PATCH /api/me`; renomear pontos e rotas |
| Portabilidade | Download JSON em `/perfil` → "Baixar meus dados" |
| Eliminação | `/perfil` → "Excluir minha conta" (`DELETE /api/me`, em cascata, com remoção da foto) |
| Revogação do consentimento | Remover a foto, limpar o município, revogar links |
| Informação sobre compartilhamento | Política de privacidade; sem compartilhamento com terceiros |

## 4. Relatório de impacto (RIPD) — roteiro

Recomendado antes do lançamento, pelo porte (base estadual) e pela possibilidade de inferir rotina e endereço:
1. Descrição do tratamento (este documento, seção 2).
2. Necessidade e proporcionalidade: campos opcionais e minimização.
3. Riscos: reidentificação por rota casa→trabalho, vazamento de base, uso secundário.
4. Medidas: seção 1, criptografia em trânsito (TLS 1.2+) e em repouso (disco do banco e object storage), backups cifrados, acesso administrativo com MFA e trilha de auditoria.
5. Parecer do encarregado (DPO).

## 5. Resposta a incidentes

1. **Detecção**: alertas de pico de 401/429, logins de muitos IPs para uma mesma conta, reuso de refresh token (log `warn`).
2. **Contenção**: revogar todas as sessões (`UPDATE refresh_tokens SET revoked_at = now()`), girar o `JWT_SECRET` (invalida todos os access tokens em ≤ 15 min), bloquear IPs no WAF.
3. **Avaliação**: escopo e titulares afetados.
4. **Comunicação**: ANPD e titulares em prazo razoável quando houver risco ou dano relevante (art. 48, com o prazo da regulamentação vigente da ANPD).
5. **Lições aprendidas**: *post-mortem* sem culpados e ADR, se houver mudança de arquitetura.
