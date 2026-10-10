/**
 * Armazenamento de arquivos de usuário (fotos de perfil).
 * Produção: bucket S3-compatível atrás de CDN; desenvolvimento: disco local servido em /media.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Config } from '../config.js';

export interface Storage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
  publicUrl(key: string): string;
  /** Diretório local a servir estaticamente (só no driver local). */
  readonly localRoot?: string;
}

const SAFE_KEY = /^[a-zA-Z0-9/_.-]+$/;
function assertKey(key: string) {
  if (!SAFE_KEY.test(key) || key.includes('..')) throw new Error(`chave de armazenamento inválida: ${key}`);
}

export function createStorage(cfg: Config): Storage {
  if (cfg.STORAGE_DRIVER === 's3') {
    if (!cfg.S3_BUCKET || !cfg.S3_PUBLIC_URL) throw new Error('S3_BUCKET e S3_PUBLIC_URL são obrigatórios com STORAGE_DRIVER=s3');
    const s3 = new S3Client({ region: cfg.S3_REGION, endpoint: cfg.S3_ENDPOINT, forcePathStyle: Boolean(cfg.S3_ENDPOINT) });
    const bucket = cfg.S3_BUCKET;
    const base = cfg.S3_PUBLIC_URL.replace(/\/$/, '');
    return {
      async put(key, body, contentType) {
        assertKey(key);
        await s3.send(new PutObjectCommand({
          Bucket: bucket, Key: key, Body: body, ContentType: contentType,
          // Chaves são imutáveis (nome aleatório por upload): cache longo é seguro.
          CacheControl: 'public, max-age=31536000, immutable',
        }));
      },
      async delete(key) {
        assertKey(key);
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      },
      publicUrl: (key) => `${base}/${key}`,
    };
  }
  const root = resolve(cfg.STORAGE_DIR);
  return {
    localRoot: root,
    async put(key, body) {
      assertKey(key);
      const path = join(root, key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
    },
    async delete(key) {
      assertKey(key);
      await rm(join(root, key), { force: true });
    },
    publicUrl: (key) => `/media/${key}`,
  };
}
