import 'fake-indexeddb/auto';
import { afterEach } from 'vitest';

afterEach(async () => {
  if (typeof localStorage === 'undefined') return; // tests exécutés sous Node (sans navigateur simulé)
  const { cleanup } = await import('@testing-library/react');
  cleanup();
  localStorage.clear();
});
