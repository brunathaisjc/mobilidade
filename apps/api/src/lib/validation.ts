import { z } from 'zod';

export const uuid = z.string().uuid();
export const lat = z.coerce.number().min(-90).max(90);
export const lon = z.coerce.number().min(-180).max(180);
/** Texto livre digitado pelo usuário: aparado, sem caracteres de controle. */
export const userText = (min: number, max: number) =>
  z.string().trim().min(min).max(max).refine((s) => !/[\u0000-\u001f\u007f]/.test(s), 'caracteres inválidos');
