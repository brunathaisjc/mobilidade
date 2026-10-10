# ADR 0003 — Mapa com MapLibre, tiles e geocodificação próprios

- **Status:** aceita · **Data:** 2026-10-10

## Contexto
Um serviço estadual gratuito com dezenas de milhares de usuários diários faz centenas de milhares de carregamentos de mapa e buscas de endereço por dia. APIs comerciais cobram por carregamento ou requisição, com custo variável e difícil de orçar no setor público, além de criarem dependência de fornecedor.

## Decisão
- **MapLibre GL JS** (open source, fork do Mapbox GL v1) no cliente.
- **Tiles vetoriais OSM de Goiás** gerados com Planetiler em **PMTiles**, servidos por bucket + CDN (sem servidor de tiles dinâmico).
- **Photon** (OSM) para geocodificação, com **cache de 7 dias no Redis**. Pontos de ônibus são buscados no próprio PostGIS.
- Em desenvolvimento, estilo público OpenFreeMap (sem chave). Em qualquer ambiente, **estilo de contingência** local se o mapa base falhar: rotas, pontos e ônibus continuam visíveis.

## Alternativas
- **Google Maps Platform / Mapbox:** qualidade alta e zero operação, mas custo recorrente proporcional ao uso e termos que restringem cache.
- **Raster tiles do OSM.org:** a política de uso proíbe tráfego de produção desse porte.

## Consequências
+ Custo fixo e previsível (armazenamento + banda), dados sob controle do estado.
+ Funciona com o mapa base fora do ar.
− Operação de atualização mensal do OSM (automatizável). A qualidade do geocodificador depende do OSM local; incentivar o mapeamento colaborativo de endereços em Goiás.
