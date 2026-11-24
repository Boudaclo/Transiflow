// @vitest-environment node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { serviceWorkerSource } from '../../scripts/pwa-plugin';
import { APP_NAME } from '../config';

const SRC = join(__dirname, '..');
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (f === '__tests__' ? [] : statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));

describe('PWA', () => {
  const sw = serviceWorkerSource('v1', ['/', '/assets/index-abc.js', '/assets/Controle-def.js']);
  it('pré-cache l\'application et chaque espace (même jamais visité) pour démarrer sans réseau', () => {
    expect(sw).toContain('/assets/Controle-def.js');
  });
  it('ne met jamais l\'API en cache (les données hors ligne vivent dans IndexedDB)', () => {
    expect(sw).toContain("url.pathname.startsWith('/api/')");
  });
  it('sert l\'index pré-caché quand une navigation échoue (hors ligne)', () => {
    expect(sw).toContain("caches.match('/')");
  });
  it('le nom du produit est une constante unique', () => {
    expect(APP_NAME).toBe('TransiFlow');
    const offenders = walk(SRC).filter((f) => f.endsWith('.tsx') || f.endsWith('.ts')).filter((f) => !f.endsWith('config.ts') && readFileSync(f, 'utf8').includes('TransiFlow'));
    expect(offenders).toEqual([]);
  });
});

describe('contraintes de design et d\'ergonomie', () => {
  const tokens = read('theme/tokens.css');
  const base = read('theme/base.css');
  it('tout le thème est dans tokens.css ; les composants n\'ont aucune couleur en dur', () => {
    for (const v of ['--c-primary', '--c-nav', '--c-bg', '--c-ok', '--c-warn', '--c-danger', '--r-md', '--sp-4', '--font']) expect(tokens).toContain(v);
    const hard = base.split('\n').filter((l) => /#[0-9a-fA-F]{3,8}\b/.test(l) && !l.includes('var(')).filter((l) => !/#000|#fff|#ffffff/i.test(l));
    expect(hard).toEqual([]);
  });
  it('cibles tactiles de 44 px et corps de texte de 16 px minimum', () => {
    expect(tokens).toMatch(/--tap:\s*44px/);
    expect(tokens).toMatch(/--fs-body:\s*1rem/);
    expect(base).toMatch(/\.btn \{[^}]*min-height: var\(--tap\)/);
    expect(base).toMatch(/\.input[^{]*\{[^}]*min-height: var\(--tap\)/);
    expect(base).toMatch(/body \{[^}]*font-size: var\(--fs-body\)/);
  });
  it('sur téléphone : barre du bas, tableaux en cartes empilées, une seule colonne', () => {
    const mobile = base.slice(base.indexOf('@media (max-width: 899px)'));
    expect(mobile).toContain('.bottombar { display: flex');
    expect(mobile).toContain('.rt td::before { content: attr(data-label)');
    expect(mobile).toMatch(/\.sale, \.grid-main, \.grid-2 \{ grid-template-columns: 1fr/);
  });
  it('aucune police externe, aucune image lourde, aucun Dakar, aucune connexion Google', () => {
    const all = [...walk(SRC), join(SRC, '..', 'index.html')].map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(/fonts\.googleapis/.test(all)).toBe(false);
    expect(/Dakar/.test(all)).toBe(false);
    expect(/Se connecter avec Google|Sign in with Google/i.test(all)).toBe(false);
    expect(/<img[^>]+src="https?:/.test(all)).toBe(false);
  });
  it('le ticket thermique est calé sur 58 mm', () => {
    expect(base).toContain('size: 58mm');
  });
});
