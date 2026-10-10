# 02 — Especificação de requisitos

Convenção: **RF** = requisito funcional, **RNF** = requisito não funcional. Prioridade MoSCoW (**M**ust, **S**hould, **C**ould).
Cada requisito aponta para onde está implementado e testado (seção 4: rastreabilidade).

## 1. Requisitos funcionais

### Conta e perfil
| ID | Requisito | Prior. |
|---|---|---|
| RF-01 | Qualquer pessoa pode se cadastrar com nome, e-mail e senha, aceitando os Termos e a Política de Privacidade. O município é opcional | M |
| RF-02 | Login com e-mail e senha. A sessão persiste entre visitas sem guardar token em `localStorage` | M |
| RF-03 | A pessoa insere, troca e remove a **foto de perfil** (JPEG/PNG/WebP/HEIC, até 5 MB) | M |
| RF-04 | A pessoa edita o nome e o município | S |
| RF-05 | A pessoa baixa todos os seus dados (portabilidade) e exclui a conta (eliminação) | M |
| RF-06 | Troca de senha encerra as outras sessões | S |

### Consulta de rotas
| ID | Requisito | Prior. |
|---|---|---|
| RF-10 | A origem e o destino são informados por busca (pontos e endereços), pela localização do aparelho ou com um toque no mapa | M |
| RF-11 | A consulta lista **todas as linhas** que atendem o trajeto (todas as possibilidades), não só a mais rápida | M |
| RF-12 | **Cada opção tem uma cor diferente**, usada igualmente no mapa e na lista | M |
| RF-13 | Cada opção mostra a **quilometragem** total (caminhada + ônibus) | M |
| RF-14 | Cada opção mostra o **tempo total** e o **horário de chegada ao destino** | M |
| RF-15 | Cada opção mostra o **tempo de espera de cada ônibus** (próximas chegadas) no ponto de embarque, indicando a fonte: ao vivo (GPS), estimado (GPS momentaneamente indisponível) ou programado | M |
| RF-16 | Os **horários são atualizados em tempo real**, com contagem regressiva local e nova consulta periódica | M |
| RF-17 | **O ônibus aparece como uma imagem que percorre a linha no mapa** em tempo real, no sentido da via | M |
| RF-18 | Trajetos curtos oferecem a opção "a pé" | C |
| RF-19 | Viagens com baldeação (OpenTripPlanner) | S (fase 2) |

### Rotas salvas e compartilhamento
| ID | Requisito | Prior. |
|---|---|---|
| RF-20 | A pessoa salva uma opção de rota | M |
| RF-21 | A pessoa organiza as rotas em **categorias** que ela mesma cria, renomeia e exclui. Excluir uma categoria não apaga as rotas | M |
| RF-22 | A pessoa dá **nome personalizado aos pontos** da rota (origem, embarque, desembarque, destino) e pode voltar ao nome original | M |
| RF-23 | Na rota salva, "Ver horários agora" refaz a consulta em tempo real | M |
| RF-24 | A pessoa **compartilha** a rota por link (com validade) e WhatsApp, e pode revogar o link | M |
| RF-25 | Quem recebe o link vê a rota sem precisar de conta e, com conta, pode salvá-la para si | M |

## 2. Requisitos não funcionais

| ID | Categoria | Requisito | Como verificamos |
|---|---|---|---|
| RNF-01 | Desempenho | `GET /api/plan` com p95 ≤ 400 ms (sem OTP) e ≤ 1,2 s (com OTP) | Teste de carga k6 ([07](07-plano-de-testes.md)) |
| RNF-02 | Latência do tempo real | GPS recebido → ícone atualizado no cliente em ≤ 2 s (p95), sem contar o intervalo do próprio feed | Métrica `rt_publish_lag` |
| RNF-03 | Escalabilidade | 3.000 veículos a 1 leitura a cada 10 s, com margem de 5× (1.500 msg/s); 50 mil conexões SSE simultâneas por escala horizontal | Teste de carga |
| RNF-04 | Disponibilidade | 99,5% mensal na consulta. Se o tempo real cair, a consulta continua com horário programado | SLO + alertas ([08](08-implantacao-e-operacao.md)) |
| RNF-05 | Resiliência a GPS | Ruído e saltos não movem o ônibus para fora da via nem para trás. Sem sinal por até 5 min, a posição é estimada e sinalizada | Testes unitários `tracker`, `eta`, `VehicleAnimator` |
| RNF-06 | Acessibilidade | WCAG 2.1 AA / eMAG: contraste, teclado, leitores de tela, cor nunca é o único canal (número da linha sempre visível) | Checklist + axe |
| RNF-07 | Segurança | OWASP ASVS nível 2 nos fluxos de autenticação. Senhas com Argon2id. Rotação de refresh token com detecção de reuso. Sem IDOR | Testes de integração `auth`, `saved-routes` |
| RNF-08 | Privacidade | LGPD: minimização, finalidade, autoatendimento de direitos, EXIF/GPS removido das fotos | [06](06-seguranca-e-lgpd.md) + testes `me` |
| RNF-09 | Custo | Nenhuma API paga por requisição no caminho crítico (tiles, geocodificação e roteamento próprios) | Revisão de arquitetura |
| RNF-10 | Compatibilidade | Navegadores das 2 últimas versões e Android Go. Layout a partir de 360 px | Testes manuais em dispositivos |
| RNF-11 | Dados | Troca de versão do GTFS sem indisponibilidade (transação única) | Teste do loader |
| RNF-12 | Observabilidade | Logs estruturados sem dados pessoais. Métricas por feed (publicados, rejeitados por motivo) | Logs do ingestor |

## 3. Histórias de usuário e critérios de aceite

### HU-01 — Ver todas as linhas e a espera de cada ônibus (RF-11 a RF-16)
**Como** passageira, **quero** ver todas as linhas que me levam ao destino com a espera de cada ônibus **para** escolher a melhor agora.

```gherkin
Cenário: duas linhas atendem o mesmo trajeto
  Dado que as linhas 101 e 102 passam na Praça A rumo ao Terminal Praça da Bíblia
  Quando eu consulto de "Praça A (Campinas)" para "Terminal Praça da Bíblia"
  Então vejo duas opções, uma da linha 101 e outra da 102
  E cada opção tem uma cor diferente no mapa e na lista
  E cada opção mostra distância em km, duração total e horário de chegada
  E cada opção lista os próximos ônibus em ordem crescente de espera

Cenário: ônibus rastreado por GPS
  Dado que um ônibus da linha 101 está a 1 km do meu ponto, com leitura de GPS de 5 s atrás
  Quando eu consulto a rota
  Então esse ônibus aparece como "ao vivo" com espera calculada a partir da posição real

Cenário: GPS do ônibus para de responder
  Dado que o último GPS do ônibus tem mais de 60 s e menos de 5 min
  Então a espera continua sendo exibida como "estimado (sem sinal de GPS)"
  E após 5 min sem sinal o ônibus deixa de aparecer e vale o horário programado

Cenário: feriado
  Dado que 24/10 é feriado municipal em Goiânia
  Quando consulto às 8h desse dia
  Então os intervalos seguem a tabela de domingo
```

### HU-02 — Ônibus andando no mapa (RF-17)
```gherkin
Cenário: animação contínua
  Dado uma opção de rota selecionada
  Quando chegam posições de GPS a cada 5–15 s
  Então o ícone do ônibus se move continuamente sobre o traçado, girado no sentido da via
  E correções do GPS são suavizadas, sem saltos
  E com GPS indisponível o ícone fica semitransparente
```

### HU-03 — Organizar e nomear (RF-20 a RF-22)
```gherkin
Cenário: salvar com categoria nova e nome personalizado
  Dado que estou logada e vendo uma opção de rota
  Quando salvo criando a categoria "Trabalho" e chamo a origem de "Casa"
  Então a rota aparece em "Minhas rotas" na aba "Trabalho"
  E a origem aparece como "Casa", com o nome original entre parênteses

Cenário: privacidade entre contas
  Dado uma rota salva por Maria
  Quando João tenta ler, renomear, excluir ou compartilhar essa rota pelo ID
  Então recebe 404
```

### HU-04 — Compartilhar (RF-24, RF-25)
```gherkin
Cenário: link público
  Dado que compartilhei uma rota
  Quando alguém sem conta abre o link
  Então vê o nome da rota, os pontos com os nomes que dei e apenas o meu primeiro nome
  E não vê meu e-mail nem minha foto

Cenário: revogação
  Quando eu desativo o link
  Então quem abrir o link vê "Este link expirou ou foi desativado"
```

## 4. Matriz de rastreabilidade

| Requisito | API | Tela | Teste automatizado |
|---|---|---|---|
| RF-01, RF-02 | `POST /api/auth/register`, `/login`, `/refresh` | `/cadastro`, `/entrar` | `apps/api/test/auth.test.ts` |
| RF-03 | `PUT/DELETE /api/me/avatar` | `/perfil` | `apps/api/test/me.test.ts` (WebP 512 px, EXIF removido, arquivo falso recusado) |
| RF-05 | `GET /api/me/export`, `DELETE /api/me` | `/perfil` | `me.test.ts` |
| RF-11 a RF-15 | `GET /api/plan` | `/` | `apps/api/test/plan.test.ts` |
| RF-15 (GPS) | `planner/arrivals.ts` | `/` | `plan.test.ts`, `packages/shared/src/eta.test.ts` |
| RF-17 | `GET /api/realtime/stream`, `GET /api/shapes/:id` | mapa | `apps/web/src/map/VehicleAnimator.test.ts` |
| RF-21, RF-22 | `/api/categories`, `/api/saved-routes/*` | `/rotas` | `apps/api/test/saved-routes.test.ts` |
| RF-24, RF-25 | `/api/saved-routes/:id/shares`, `/api/shared/:token` | `/r/:token` | `saved-routes.test.ts` |
| RNF-05 | `realtime/tracker.ts` | — | `apps/api/src/realtime/tracker.test.ts` |
| RNF-11 | `scripts/load-gtfs.ts` | — | `test/global-setup.ts` (carga real em toda execução) |
