export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Recurso') => new HttpError(404, 'not_found', `${what} não encontrado`);
export const forbidden = () => new HttpError(403, 'forbidden', 'Acesso negado');
export const unauthorized = (msg = 'Autenticação necessária') => new HttpError(401, 'unauthorized', msg);
export const conflict = (msg: string) => new HttpError(409, 'conflict', msg);
export const badRequest = (msg: string) => new HttpError(400, 'bad_request', msg);
