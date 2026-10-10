import { pathToFileURL } from 'node:url';

/**
 * true quando o módulo foi executado diretamente (`node arquivo.js` / `tsx arquivo.ts`).
 * Compara URLs normalizadas: funciona no Windows (C:\…) e com espaços no caminho.
 */
export const isMain = (moduleUrl: string) =>
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === moduleUrl;
