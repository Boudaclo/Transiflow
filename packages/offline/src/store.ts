export type StoreName = 'kv' | 'ranges' | 'sales' | 'validations' | 'tickets' | 'keys';

const wrap = <T>(r: IDBRequest<T>): Promise<T> => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

/** Accès IndexedDB minimal, sans dépendance. Tout ce que le poste doit survivre à un redémarrage y est écrit. */
export class OfflineStore {
  private db?: Promise<IDBDatabase>;
  constructor(private readonly factory: IDBFactory, private readonly name: string) {}

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((res, rej) => {
      const r = this.factory.open(this.name, 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        db.createObjectStore('kv');
        db.createObjectStore('ranges', { keyPath: 'id', autoIncrement: true });
        db.createObjectStore('sales', { keyPath: 'ticketId' });
        db.createObjectStore('validations', { keyPath: 'clientId' });
        db.createObjectStore('tickets', { keyPath: 'id' });
        db.createObjectStore('keys', { keyPath: 'id' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return this.db;
  }

  async get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
    return wrap<T | undefined>((await this.open()).transaction(store).objectStore(store).get(key));
  }
  async getAll<T>(store: StoreName): Promise<T[]> {
    return wrap<T[]>((await this.open()).transaction(store).objectStore(store).getAll());
  }
  async put(store: StoreName, value: unknown, key?: IDBValidKey): Promise<void> {
    await wrap((await this.open()).transaction(store, 'readwrite').objectStore(store).put(value, key));
  }
  /** Remplace tout le contenu d'un magasin en une seule transaction. */
  async replaceAll(store: StoreName, values: unknown[]): Promise<void> {
    const db = await this.open();
    await new Promise<void>((res, rej) => {
      const tx = db.transaction(store, 'readwrite');
      const os = tx.objectStore(store);
      os.clear();
      for (const v of values) os.put(v);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error);
    });
  }
  /** Plusieurs lectures et écritures atomiques (tout ou rien). `fn` ne doit attendre que des requêtes IndexedDB. */
  async atomic<T>(stores: StoreName[], fn: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    const db = await this.open();
    return new Promise<T>((res, rej) => {
      const tx = db.transaction(stores, 'readwrite');
      let out: T;
      tx.oncomplete = () => res(out);
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error ?? new Error('Transaction annulée'));
      fn(tx).then((v) => { out = v; }, (e) => { try { tx.abort(); } catch { /* déjà terminée */ } rej(e); });
    });
  }
  static request = wrap;
}
