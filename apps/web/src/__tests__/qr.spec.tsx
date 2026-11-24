import { describe, expect, it } from 'vitest';
import jsQR from 'jsqr';
import { QR_VERSION, encodeTicketQr, packTicketPayload } from '@transport/shared';
import { qrMatrix } from '../components/QrCode';

describe('QR du ticket', () => {
  it('un vrai QR signé (≈190 caractères) se relit à l\'identique depuis la matrice dessinée', () => {
    const payload = packTicketPayload({ version: QR_VERSION, tenantId: crypto.randomUUID(), keyId: crypto.randomUUID(), ticketId: crypto.randomUUID(), number: 1234, tripId: crypto.randomUUID(), departureAt: 1_800_000_000, price: 6500, seats: 2 });
    const text = encodeTicketQr(payload, new Uint8Array(64).map((_, i) => (i * 7) % 256));
    const m = qrMatrix(text);
    const scale = 6, quiet = 4, n = m.length + quiet * 2, size = n * scale;
    const data = new Uint8ClampedArray(size * size * 4).fill(255);
    m.forEach((row, y) => row.forEach((dark, x) => {
      if (!dark) return;
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        const i = (((y + quiet) * scale + dy) * size + (x + quiet) * scale + dx) * 4;
        data[i] = data[i + 1] = data[i + 2] = 0;
      }
    }));
    expect(jsQR(data, size, size)?.data).toBe(text);
  });
  it('reste d\'une taille lisible sur papier thermique 58 mm (au plus 65 modules de côté)', () => {
    const text = 'x'.repeat(200);
    expect(qrMatrix(text).length).toBeLessThanOrEqual(65);
  });
});
