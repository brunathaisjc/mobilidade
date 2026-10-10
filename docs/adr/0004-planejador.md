# ADR 0004 — Planejador interno de linhas diretas + OpenTripPlanner

- **Status:** aceita · **Data:** 2026-10-10

## Contexto
O requisito central é mostrar **todas as linhas que servem o trajeto** com a espera de cada ônibus. Planejadores multimodais (OTP, R5) otimizam e devolvem poucas opções "ótimas", nem sempre todas as linhas equivalentes. Baldeações também são necessárias, mas não em todos os trajetos.

## Decisão
- **Planejador interno de linhas diretas (`DirectPlanner`)** sobre PostGIS: pontos a até ~615 m (800 m × fator de desvio 1,3) da origem e do destino, cruzados com os padrões de parada (embarque antes do desembarque). Devolve o **melhor par de pontos por linha/sentido**, ou seja, todas as alternativas diretas, cada uma enriquecida com GPS.
- **OpenTripPlanner 2.x (`OtpPlanner`)** quando `OTP_URL` está configurado: baldeação e caminhada pela malha viária real. Cada trecho de ônibus é enriquecido com as mesmas chegadas em tempo real. Se o OTP falhar, a API **volta automaticamente** ao planejador direto.
- Caminhada no planejador direto: distância em linha reta × 1,3 e 1,2 m/s (conservador, inclui idosos e PcD).

## Alternativas
- **Só OTP:** dependência de um componente pesado (grafo de vários GB em memória) para o caso mais comum, sem garantia de listar todas as linhas.
- **RAPTOR próprio:** é o caminho certo para baldeações em escala, mas o OTP já implementa (RAPTOR) com qualidade de produção.

## Consequências
+ O MVP funciona sem OTP; o OTP entra na Fase 2 sem mudar o contrato da API.
− A caminhada estimada em linha reta pode subestimar trajetos com barreiras (rodovias, rios). O OTP corrige isso.
