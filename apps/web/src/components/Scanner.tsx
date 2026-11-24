import { useEffect, useRef, useState } from 'react';
import { Alert } from './ui';

interface Detector { detect(v: CanvasImageSource): Promise<{ rawValue: string }[]> }
declare global {
  interface Window { BarcodeDetector?: new (o: { formats: string[] }) => Detector }
}

/** Lecture de QR avec la caméra arrière : détecteur natif du navigateur s'il existe, sinon jsQR (chargé à la demande). */
export function Scanner({ onCode, paused }: { onCode: (code: string) => void; paused: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string>();
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const cb = useRef(onCode);
  cb.current = onCode;

  useEffect(() => {
    let stream: MediaStream | undefined;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) { setError("La caméra n'est pas disponible sur cet appareil ou ce navigateur."); return; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 960 } }, audio: false });
      } catch {
        setError("Accès à la caméra refusé. Autorisez la caméra dans le navigateur, ou utilisez la saisie manuelle.");
        return;
      }
      const el = video.current;
      if (!el || stop) return;
      el.srcObject = stream;
      await el.play().catch(() => undefined);
      const native = window.BarcodeDetector ? new window.BarcodeDetector({ formats: ['qr_code'] }) : null;
      const jsqr = native ? null : (await import('jsqr')).default;
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const tick = async () => {
        if (stop) return;
        try {
          if (!pausedRef.current && el.readyState >= 2 && el.videoWidth) {
            if (native) {
              const found = await native.detect(el);
              if (found[0]?.rawValue) cb.current(found[0].rawValue);
            } else if (jsqr && ctx) {
              const scale = Math.min(1, 560 / el.videoWidth);
              canvas.width = Math.round(el.videoWidth * scale); canvas.height = Math.round(el.videoHeight * scale);
              ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
              const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
              const code = jsqr(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
              if (code?.data) cb.current(code.data);
            }
          }
        } catch { /* image perdue : on réessaie au tour suivant */ }
        timer = setTimeout(tick, 150);
      };
      void tick();
    })();
    return () => { stop = true; clearTimeout(timer); stream?.getTracks().forEach((t) => t.stop()); };
  }, []);

  if (error) return <Alert tone="warn">{error}</Alert>;
  return (
    <div className="scan-box">
      <video ref={video} muted playsInline aria-label="Aperçu de la caméra" />
      <div className="reticle" aria-hidden="true" />
    </div>
  );
}
