import {
  PAYLOAD_LENGTH, QrFormatError, TicketQrPayload, decodeTicketQr, encodeTicketQr, fromBase64Url, packTicketPayload, toBase64Url, unpackTicketPayload,
} from './index';

const payload: TicketQrPayload = {
  version: 1,
  tenantId: '3ad12e42-418f-4cbd-8f17-0b7fd8be2569',
  keyId: '11111111-2222-4333-8444-555555555555',
  ticketId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  number: 123456,
  tripId: '01234567-89ab-4def-8123-456789abcdef',
  departureAt: 1_798_790_400,
  price: 16_000,
  seats: 2,
};

describe('QR des tickets', () => {
  it('encode et décode en Base64 URL pour toutes les tailles', () => {
    for (let n = 0; n <= 70; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) % 256);
      const text = toBase64Url(bytes);
      expect(text).toMatch(/^[A-Za-z0-9_-]*$/);
      expect([...fromBase64Url(text)]).toEqual([...bytes]);
    }
  });
  it('est identique à Base64 URL de Node (sans remplissage)', () => {
    const bytes = Uint8Array.from({ length: 142 }, (_, i) => (i * 91) % 256);
    expect(toBase64Url(bytes)).toBe(Buffer.from(bytes).toString('base64url'));
  });
  it('empaquette et dépaquette la charge utile sans perte', () => {
    const bytes = packTicketPayload(payload);
    expect(bytes).toHaveLength(PAYLOAD_LENGTH);
    expect(unpackTicketPayload(bytes)).toEqual(payload);
  });
  it('produit un QR compact (moins de 200 caractères) et le relit', () => {
    const sig = Uint8Array.from({ length: 64 }, (_, i) => i);
    const qr = encodeTicketQr(packTicketPayload(payload), sig);
    expect(qr.length).toBeLessThan(200);
    const decoded = decodeTicketQr(qr);
    expect(decoded.payload).toEqual(payload);
    expect([...decoded.signature]).toEqual([...sig]);
  });
  it('refuse les QR illisibles', () => {
    expect(() => decodeTicketQr('pas un qr!')).toThrow(QrFormatError);
    expect(() => decodeTicketQr('AAAA')).toThrow(QrFormatError);
    const bad = packTicketPayload({ ...payload });
    bad[0] = 9;
    expect(() => unpackTicketPayload(bad)).toThrow(/Version/);
    expect(() => packTicketPayload({ ...payload, price: -1 })).toThrow(QrFormatError);
    expect(() => packTicketPayload({ ...payload, seats: 0 })).toThrow(QrFormatError);
  });
});
