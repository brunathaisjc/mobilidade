/**
 * Ícone do ônibus visto de cima, apontando para o norte (o mapa gira o ícone pelo rumo da via).
 * Gerado em SVG por cor do itinerário: nítido em qualquer densidade de tela e sem arquivos extras.
 */
export function busSvg(color: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <circle cx="32" cy="32" r="30" fill="white" fill-opacity="0.92" stroke="${color}" stroke-width="3"/>
  <path d="M32 5 L38 13 H26 Z" fill="${color}"/>
  <rect x="21" y="14" width="22" height="38" rx="5" fill="${color}" stroke="#ffffff" stroke-width="2"/>
  <rect x="24" y="17" width="16" height="7" rx="2" fill="#ffffff" fill-opacity="0.95"/>
  <rect x="24" y="27" width="16" height="3" rx="1" fill="#ffffff" fill-opacity="0.7"/>
  <rect x="24" y="33" width="16" height="3" rx="1" fill="#ffffff" fill-opacity="0.7"/>
  <rect x="24" y="39" width="16" height="3" rx="1" fill="#ffffff" fill-opacity="0.7"/>
  <rect x="24" y="46" width="16" height="3" rx="1" fill="#ffffff" fill-opacity="0.95"/>
</svg>`;
}

export function loadBusImage(color: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image(64, 64);
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(busSvg(color))}`;
  });
}
