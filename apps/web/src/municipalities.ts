/**
 * Municípios goianos mais populosos (código IBGE de 7 dígitos). Em produção, carregar a lista completa
 * (246 municípios) da API de localidades do IBGE no build: /api/v1/localidades/estados/52/municipios.
 */
export const MUNICIPALITIES = [
  { ibge: '5208707', name: 'Goiânia' },
  { ibge: '5201405', name: 'Aparecida de Goiânia' },
  { ibge: '5201108', name: 'Anápolis' },
  { ibge: '5218805', name: 'Rio Verde' },
  { ibge: '5200258', name: 'Águas Lindas de Goiás' },
  { ibge: '5212501', name: 'Luziânia' },
  { ibge: '5221858', name: 'Valparaíso de Goiás' },
  { ibge: '5220454', name: 'Senador Canedo' },
  { ibge: '5221403', name: 'Trindade' },
  { ibge: '5208004', name: 'Formosa' },
  { ibge: '5205109', name: 'Catalão' },
  { ibge: '5211503', name: 'Itumbiara' },
  { ibge: '5211909', name: 'Jataí' },
] as const;
