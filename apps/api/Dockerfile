# Imagem única da API e dos workers (ingestor, simulador): o comando define o papel do contêiner.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @mobigo/api...
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @mobigo/shared build && pnpm --filter @mobigo/api build \
 && pnpm deploy --filter @mobigo/api --prod --legacy /out \
 && cp -r apps/api/dist /out/dist

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app/apps/api
COPY --from=build /out /app/apps/api
COPY db /app/db
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s CMD node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
