# 01 — Visão do produto

| Campo | Valor |
|---|---|
| Produto | **Mobi GO** — planejamento de viagens de ônibus com tempo real para o estado de Goiás |
| Versão do documento | 1.0 (outubro/2026) |
| Situação | Proposta de projeto; MVP técnico implementado neste repositório |
| Público | Patrocinadores, gestão de transporte, equipe técnica, controle interno |

## 1. Contexto

O transporte coletivo em Goiás tem sistemas de porte muito diferentes:

- **Região Metropolitana de Goiânia (RMTC):** é a maior rede do estado. O Portal da Transparência do estado informa cerca de **19 municípios atendidos, ~295 linhas, ~7 mil pontos de parada e 23 terminais**. A gestão é da CMTC, e a operação é de concessionárias como a Metrobus (Eixo Anhanguera) e consórcios privados. Já existe um aplicativo oficial de consulta, o **SiMRmtc**.
- **Sistemas municipais**, como os de Anápolis, Rio Verde (que tem um app próprio com localização dos veículos), Luziânia e Catalão.
- **Linhas intermunicipais** reguladas pela AGR.

Esses sistemas não têm hoje uma experiência única. Não encontramos **feed GTFS público** confirmado para a RMTC nem para os sistemas do interior, e os dados de GPS ficam nos centros de controle de cada operadora.

## 2. Problema

> "Quero saber **qual ônibus pego**, **quando ele chega no meu ponto** e **quanto tempo vou levar**, e quero **guardar e mandar esse caminho** para quem precisa."

Hoje a pessoa usuária:
1. não vê todas as linhas que servem o mesmo trajeto (por exemplo, duas linhas passam pela mesma avenida);
2. não sabe quanto vai esperar em cada ônibus;
3. não confia em previsões que "pulam" ou somem quando o GPS falha;
4. não consegue organizar trajetos recorrentes (trabalho, escola, consultas) nem compartilhá-los com familiares.

## 3. Objetivos e indicadores

| Objetivo | Indicador (KPI) | Meta 12 meses após o lançamento |
|---|---|---|
| Reduzir a incerteza da espera | Erro absoluto mediano da previsão de chegada (ônibus a até 10 min) | ≤ 90 s |
| Adoção | Usuários ativos mensais na RMTC | ≥ 10% dos passageiros diários |
| Confiabilidade | Disponibilidade da consulta de rotas | ≥ 99,5% ao mês |
| Cobertura | Viagens programadas com GPS rastreado em operação | ≥ 90% |
| Inclusão | Conformidade WCAG 2.1 AA / eMAG nas telas principais | 100% dos critérios A e AA |
| Custo | Custo de APIs de mapas de terceiros por consulta | ≈ R$ 0 (infraestrutura própria — ADR 0003) |

## 4. Personas

| Persona | Necessidade principal | Implicação no produto |
|---|---|---|
| **Joana, 34, diarista em Aparecida de Goiânia** | Faz o mesmo trajeto todo dia, com celular de entrada e plano de dados limitado | Rotas salvas, consulta em um toque, pouco consumo de dados (SSE com lotes, *polling* econômico) |
| **Seu Antônio, 68, aposentado em Anápolis** | Vai a consultas médicas e enxerga mal | Contraste alto, fonte grande, alvos de toque ≥ 44 px, nomes personalizados ("Posto de saúde") |
| **Lucas, 20, estudante da UFG** | Tem várias opções de linha e quer a mais rápida agora | Lista de todas as linhas com cores e espera ao vivo de cada ônibus |
| **Mariana, 41, mãe** | Quer mandar à filha o trajeto da escola | Compartilhamento por link e WhatsApp, sem a filha precisar de conta |
| **Analista da CMTC** | Quer entender a demanda e a qualidade do GPS | Dados agregados e anonimizados; métricas de qualidade de feed |

## 5. Escopo

### 5.1 Dentro do MVP (implementado)
- Cadastro aberto a qualquer pessoa, login, sessão segura, **foto de perfil**.
- Consulta de rota com **todas as linhas diretas** que servem origem → destino, cada uma com **cor própria**, **quilometragem**, **tempo total e horário de chegada**, **espera** e **próximos ônibus** de cada linha, com indicação de previsão ao vivo, estimada ou programada.
- **Ônibus animado** que percorre o traçado da linha no mapa em tempo real.
- **Rotas salvas em categorias**, com **nomes personalizados nos pontos**.
- **Compartilhamento** por link e WhatsApp, revogável, com página pública e opção "salvar na minha conta".
- Direitos LGPD de autoatendimento: exportar dados e excluir conta.
- Ingestão de **GTFS** e **GTFS-Realtime**, com simulador para desenvolvimento.

### 5.2 Fase 2 em diante (ver [09-roadmap.md](09-roadmap.md))
- Viagens com baldeação e caminhada pela malha viária (OpenTripPlanner, já com adaptador pronto).
- Alertas de serviço, notificações ("seu ônibus está a 5 min"), PWA offline.
- Linhas intermunicipais (AGR) e demais municípios.
- Painel de gestão para órgãos gestores.

### 5.3 Fora de escopo
- Venda de passagem ou recarga de cartão (integração futura com o sistema de bilhetagem, se houver interesse).
- Despacho e controle operacional da frota (responsabilidade das operadoras e do CCO).

## 6. Partes interessadas

| Parte | Interesse | Papel |
|---|---|---|
| Governo do Estado de Goiás (secretaria responsável por mobilidade) | Serviço digital ao cidadão | Patrocinador |
| CMTC / órgãos gestores municipais | Qualidade da informação ao usuário | Dono dos dados de planejamento (GTFS) |
| Operadoras / concessionárias | Menos reclamações; operação já monitorada | Fornecedoras do GPS (AVL) |
| AGR | Linhas intermunicipais | Fonte de dados na fase 3 |
| Passageiros | Previsibilidade | Usuários finais |
| Encarregado de dados (DPO) / ANPD | Conformidade com a LGPD | Governança |

## 7. Premissas e riscos

| # | Risco | Prob. | Impacto | Mitigação |
|---|---|---|---|---|
| R1 | **Não há feed GTFS/GTFS-RT público.** A obtenção depende de acordo com a CMTC e as operadoras | Alta | Alto | Fase 0 dedicada ao acordo de dados (termo de cooperação). Arquitetura com **adaptadores de fonte** (`PositionSource`) para aceitar APIs proprietárias de AVL. Simulador para desenvolver sem bloqueio |
| R2 | Feeds de GPS **sem `trip_id`** (comum em AVL) | Alta | Médio | Inferência de sentido por shape e movimento ([tracker.ts](../apps/api/src/realtime/tracker.ts)); ETA por padrão de parada |
| R3 | Qualidade do GPS (ruído, perda de sinal, saltos) | Alta | Médio | Projeção no traçado, descarte de outliers e *dead reckoning* (ADR 0007) |
| R4 | Custo de APIs de mapas e rotas de terceiros em escala estadual | Média | Alto | Tiles, geocodificador e roteador próprios (ADRs 0003 e 0004) |
| R5 | Picos de acesso (chuva, greve, Enem) | Média | Alto | Estado em Redis, API sem estado e escalável horizontalmente, *rate limit* e degradação graciosa |
| R6 | Dados pessoais (fotos, rotas casa→trabalho revelam endereço) | Média | Alto | Minimização, EXIF removido, compartilhamento só com primeiro nome, exclusão em autoatendimento ([06](06-seguranca-e-lgpd.md)) |
| R7 | Confusão com o app oficial existente (SiMRmtc) | Média | Médio | Definir com a CMTC se o Mobi GO evolui o canal oficial ou o complementa (decisão de governança, Fase 0) |

## 8. Fontes

- Governo de Goiás — *Governo de Goiás compila informações sobre transporte no Portal da Transparência*: https://goias.gov.br/metrobus/?p=8414
- Governo de Goiás — *RMTC reformula aplicativo e amplia interação com usuários do transporte*: https://goias.gov.br/metrobus/?p=1530
- Jornal Opção — *Rio Verde conquista 1º lugar do Estado em inovação pelo transporte público*: https://www.jornalopcao.com.br/ultimas-noticias/rio-verde-conquista-1o-lugar-do-estado-em-inovacao-pelo-transporte-publico-741122/
- AGR — *61 linhas do transporte intermunicipal*: https://goias.gov.br/agr/61-linhas-do-transporte-intermunicipal/
