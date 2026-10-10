# ADR 0007 — Previsão de chegada (ETA) e resiliência a falhas de GPS

- **Status:** aceita · **Data:** 2026-10-10

## Contexto
O GPS de ônibus urbanos tem ruído de dezenas de metros, reflexos em prédios (saltos de centenas de metros), perda de sinal (túneis, falhas de modem) e, em muitos sistemas, não informa a viagem (`trip_id`). A velocidade instantânea oscila entre 0 (ponto, semáforo) e 15 m/s, o que torna instável a ETA baseada em "distância ÷ velocidade".

## Decisão
1. **Limpeza no ingestor** (`VehicleTracker`): projeção no shape; descarte se o desvio for > 120 m ou o avanço > 30 m/s; nunca andar para trás; descarte de duplicadas; velocidade suavizada (EWMA α=0,3); inferência de sentido sem `trip_id`.
2. **ETA = tempo programado de percurso da posição real até o ponto** (interpolação dos `offset_s` do padrão) **− idade da leitura**. O GTFS já embute os tempos de parada e o perfil da via. O GPS corrige "onde o ônibus está", e a programação estima "quanto falta".
3. **Estados de confiança**, iguais no servidor e no cliente (`packages/shared/src/eta.ts`):
   - `realtime`: leitura ≤ 60 s;
   - `estimated`: 60 s a 5 min, posição extrapolada (velocidade típica limitada a 2,5–16 m/s);
   - acima de 5 min: o veículo é descartado e vale o horário `scheduled`.
4. **Sem duplicidade**: viagens rastreadas não reaparecem como programadas. Com GPS sem `trip_id`, horários programados anteriores ao último ônibus rastreado são considerados cobertos.
5. **Animação no cliente**: âncora + extrapolação por até 25 s + suavização exponencial (τ=0,8 s); correções > 600 m reposicionam o ícone.

## Evolução
Substituir os tempos programados por **tempos de percurso históricos** por trecho e faixa horária, calculados do `vehicle_positions` (Timescale *continuous aggregates*), e incorporar `TripUpdates` das operadoras.

## Consequências
+ Previsão estável, sem "pular", e degradação explícita para o usuário (rótulos "ao vivo", "estimado", "programado").
− Em trânsito muito atípico (acidente), a ETA programada subestima o atraso até o GPS mostrar o ônibus parado. Mitigado pela atualização a cada 30 s e pela evolução para tempos históricos.
