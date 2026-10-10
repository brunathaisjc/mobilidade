import { createHash, randomBytes } from 'node:crypto';

/** Token opaco com 256 bits de entropia, seguro para URL. */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export const sha256 = (value: string) => createHash('sha256').update(value).digest();
