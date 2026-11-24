import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

/** Matrice de modules (true = noir) d'un texte, niveau de correction M. */
export function qrMatrix(text: string, level: 'L' | 'M' | 'Q' = 'M'): boolean[][] {
  const qr = qrcode(0, level);
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

/** QR en SVG vectoriel : un seul tracé, bords nets (lisible sur papier thermique comme à l'écran), zone de silence incluse. */
export function QrCode({ value, label = 'QR code du ticket', quiet = 4 }: { value: string; label?: string; quiet?: number }) {
  const { path, size } = useMemo(() => {
    const m = qrMatrix(value);
    let d = '';
    m.forEach((row, y) => {
      let x = 0;
      while (x < row.length) {
        if (!row[x]) { x++; continue; }
        let w = 1;
        while (x + w < row.length && row[x + w]) w++;
        d += `M${x + quiet} ${y + quiet}h${w}v1h-${w}z`;
        x += w;
      }
    });
    return { path: d, size: m.length + quiet * 2 };
  }, [value, quiet]);
  return (
    <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges" data-testid="qr">
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
