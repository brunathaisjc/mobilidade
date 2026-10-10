import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = await buildApp(config);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    app.log.info({ signal }, 'encerrando');
    await app.close();
    process.exit(0);
  });
}

await app.listen({ port: config.PORT, host: config.HOST });
