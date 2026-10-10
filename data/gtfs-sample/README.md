# GTFS de amostra (sintético)

Os arquivos `.txt` deste diretório são **gerados** e não versionados:

```bash
pnpm --filter @mobigo/api exec tsx src/scripts/generate-sample-gtfs.ts
```

Os marcos usam coordenadas aproximadas de locais reais de Goiânia, mas **linhas, horários e pontos são fictícios**.
Servem para desenvolvimento, testes automatizados e demonstração até a assinatura do acordo de dados
com a CMTC/operadoras (ver `docs/01-visao-do-produto.md`).
