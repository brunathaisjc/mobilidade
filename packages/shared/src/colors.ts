/**
 * Paleta categórica para diferenciar itinerários no mapa e na lista.
 *
 * Critérios: distinguíveis entre si (inclusive para deuteranopia/protanopia — por isso a ordem
 * intercala azul/laranja/roxo/verde), contraste ≥ 3:1 contra o fundo claro do mapa e contra branco
 * (texto branco nos "chips" de linha). A cor nunca é o único canal: cada opção também tem número
 * e nome da linha (WCAG 1.4.1).
 */
export const ITINERARY_PALETTE = [
  '#1f6feb', // azul
  '#d1490b', // laranja queimado
  '#8250df', // roxo
  '#1a7f37', // verde
  '#bf3989', // magenta
  '#0f7b8a', // petróleo
  '#9a6700', // mostarda escuro
  '#cf222e', // vermelho
  '#4b5fc2', // índigo
  '#6e7781', // cinza (reserva)
] as const;

/** Atribui uma cor distinta a cada itinerário; acima de 10 opções, repete com padrão tracejado. */
export function colorForIndex(index: number): { color: string; dashed: boolean } {
  const n = ITINERARY_PALETTE.length;
  return { color: ITINERARY_PALETTE[index % n]!, dashed: index >= n };
}
