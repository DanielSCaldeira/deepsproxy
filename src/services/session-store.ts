import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext } from 'playwright';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
type SessionSnapshot = Omit<Awaited<ReturnType<BrowserContext['storageState']>>, 'origins'> & { origins: Array<{
  origin: string; localStorage: Array<{ name: string; value: string }>;
  indexedDB?: Array<{ name: string; stores: Array<{ name: string; keyPath?: string; keyPathArray?: string[];
    records: Array<{ key?: unknown; keyEncoded?: unknown; value?: unknown; valueEncoded?: unknown }>; [key: string]: unknown }>; [key: string]: unknown }>;
}> };

export function getProfileDirectory(): string {
  if (!process.env.PROVIDER_PROFILE_DIR && process.env.PROVIDER === 'gemini') return path.resolve(projectRoot, process.env.GEMINI_PROFILE_DIR || 'gemini_profile');
  return path.resolve(projectRoot, process.env.PROVIDER_PROFILE_DIR || (process.env.PROVIDER === 'grok' ? process.env.GROK_PROFILE_DIR || 'grok_profile' : process.env.PROVIDER === 'claude' ? process.env.CLAUDE_PROFILE_DIR || 'claude_profile' : process.env.PROVIDER === 'perplexity' ? process.env.PERPLEXITY_PROFILE_DIR || 'perplexity_profile' : process.env.PROVIDER === 'cohere' ? process.env.COHERE_PROFILE_DIR || 'cohere_profile' : process.env.PROVIDER === 'ernie' ? process.env.ERNIE_PROFILE_DIR || 'ernie_profile' : process.env.PROVIDER === 'copilot' ? process.env.COPILOT_PROFILE_DIR || 'copilot_profile' : process.env.PROVIDER === 'kimi' ? process.env.KIMI_PROFILE_DIR || 'kimi_profile' : process.env.PROVIDER === 'mistral' ? process.env.MISTRAL_PROFILE_DIR || 'mistral_profile' : process.env.PROVIDER === 'quillbot' ? process.env.QUILLBOT_PROFILE_DIR || 'quillbot_profile' : process.env.PROVIDER === 'meta' ? process.env.META_PROFILE_DIR || 'meta_profile' : process.env.PROVIDER === 'chatgpt' ? process.env.CHATGPT_PROFILE_DIR || 'chatgpt_profile' : process.env.PROVIDER === 'qwen' ? process.env.QWEN_PROFILE_DIR || 'qwen_profile' : process.env.DEEPSEEK_PROFILE_DIR || 'deepseek_profile'));
}

export function createSessionStore(directory: string) {
  let persistentProfile = false;
  // Prevent the login window and the API browser from overwriting each other's profile.
  async function lockProfile(): Promise<() => Promise<void>> {
    await fs.mkdir(directory, { recursive: true });
    persistentProfile = (await Promise.all(['Preferences', 'Local Storage', 'IndexedDB'].map(name =>
      fs.access(path.join(directory, 'Default', name)).then(() => true, () => false)))).some(Boolean);
    const file = path.join(directory, '.runtime.lock');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await fs.open(file, 'wx', 0o600);
        await handle.writeFile(String(process.pid));
        await handle.close();
        return async () => { await fs.unlink(file).catch(() => undefined); };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const owner = Number(await fs.readFile(file, 'utf8').catch(() => ''));
        if (!Number.isInteger(owner) || owner <= 0) {
          throw new Error('O perfil está sendo inicializado por outro processo. Tente novamente.');
        }
        try {
          process.kill(owner, 0);
        } catch (probeError) {
          if ((probeError as NodeJS.ErrnoException).code === 'ESRCH') {
            await fs.unlink(file).catch(() => undefined);
            continue;
          }
        }
        throw new Error('O perfil está em uso. Aguarde o login ou encerre o outro processo do proxy.');
      }
    }
    throw new Error('Não foi possível reservar o perfil. Tente novamente.');
  }

  function sessionFile(): string {
    return path.join(directory, '.auth-state.json');
  }

  const interactiveMarker = path.join(directory, '.interactive-login.pending');
  async function beginInteractiveLogin(): Promise<void> {
    await fs.writeFile(interactiveMarker, 'pending\n', { mode: 0o600 });
  }

  async function isProfileInUse(): Promise<boolean> {
    try {
      const owner = Number(await fs.readFile(path.join(directory, '.runtime.lock'), 'utf8'));
      if (!Number.isInteger(owner) || owner <= 0 || owner === process.pid) return false;
      process.kill(owner, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function hasSavedSession(): Promise<boolean> {
    return fs.access(sessionFile()).then(() => true, () => false);
  }

  async function restoreSession(browser: BrowserContext): Promise<boolean> {
    // A worker may restart between the human login and snapshot validation.
    // Preserve its newer persistent profile instead of replaying older state.
    if (await fs.access(interactiveMarker).then(() => true, () => false)) return false;
    if (!await hasSavedSession()) return false;
    // The persistent browser can contain refreshed cookies/tokens newer than
    // the last export. Replaying that export would roll back a valid login.
    if (persistentProfile) return false;
    const state = JSON.parse(await fs.readFile(sessionFile(), 'utf8'));
    let invalidRecords = 0;
    for (const origin of state.origins || []) for (const db of origin.indexedDB || []) for (const store of db.stores || []) {
      store.records = store.records.filter((record: any) => {
        if (record.value === null && record.valueEncoded === undefined) record.valueEncoded = { v: 'null' };
        const keyMissing = store.keyPath === undefined && store.keyPathArray === undefined && record.key == null && record.keyEncoded === undefined;
        const valueMissing = !Object.hasOwn(record, 'value') && !Object.hasOwn(record, 'valueEncoded');
        if (keyMissing || valueMissing) { invalidRecords++; return false; }
        return true;
      });
    }
    if (invalidRecords) {
      // Old Playwright snapshots can omit falsy keys/values. Keep the exact
      // original; never invent a lost key or overwrite the last saved login.
      await fs.copyFile(sessionFile(), `${sessionFile()}.before-repair`, constants.COPYFILE_EXCL)
        .catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
      console.warn(`[session] Restoring valid state; ${invalidRecords} incomplete IndexedDB records retained in the backup.`);
    }
    await browser.setStorageState(state);
    return true;
  }

  async function saveSession(browser: BrowserContext): Promise<void> {
    const state = await browser.storageState({ indexedDB: true }) as SessionSnapshot;
    // Playwright 1.64's collector drops falsy trivial keys/values. Recover
    // those exact entries with a read-only transaction, without loading the
    // site's scripts or changing the active conversation.
    let repairPage: Awaited<ReturnType<BrowserContext['newPage']>> | undefined;
    try {
      for (const origin of state.origins) {
        const stores = (origin.indexedDB || []).flatMap(db => db.stores.map(store => ({ db, store })))
          .filter(({ store }) => store.records.some(record =>
            (!Object.hasOwn(record, 'value') && !Object.hasOwn(record, 'valueEncoded')) ||
            (store.keyPath === undefined && store.keyPathArray === undefined && record.key == null && record.keyEncoded === undefined)));
        if (!stores.length) continue;
        let snapshotPage = browser.pages().find(page => {
          try { return !page.isClosed() && new URL(page.url()).origin === origin.origin; } catch { return false; }
        });
        if (!snapshotPage) {
          if (!repairPage) {
            repairPage = await browser.newPage();
            await repairPage.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Session snapshot</title>' }));
          }
          await repairPage.goto(origin.origin, { waitUntil: 'domcontentloaded' });
          snapshotPage = repairPage;
        }
        for (const { db, store } of stores) {
          const records = await snapshotPage.evaluate(async ({ database, name }) => {
            const databaseRequest = indexedDB.open(database);
            const connection = await new Promise<IDBDatabase>((resolve, reject) => {
              databaseRequest.onsuccess = () => resolve(databaseRequest.result);
              databaseRequest.onerror = () => reject(new Error('Cannot read session database'));
            });
            try {
              const objectStore = connection.transaction(name, 'readonly').objectStore(name);
              const keys = objectStore.getAllKeys(), values = objectStore.getAll();
              const [allKeys, allValues] = await Promise.all([
                new Promise<IDBValidKey[]>((resolve, reject) => { keys.onsuccess = () => resolve(keys.result); keys.onerror = () => reject(new Error('Cannot read session keys')); }),
                new Promise<any[]>((resolve, reject) => { values.onsuccess = () => resolve(values.result); values.onerror = () => reject(new Error('Cannot read session values')); }),
              ]);
              return allKeys.map((key, i) => ({ key: key === 0 || key === '' ? key : undefined,
                falsy: allValues[i] == null || allValues[i] === false || allValues[i] === 0 || allValues[i] === '',
                value: allValues[i] === null ? { valueEncoded: { v: 'null' } } : allValues[i] === undefined ? { valueEncoded: { v: 'undefined' } } : { value: allValues[i] === false || allValues[i] === 0 || allValues[i] === '' ? allValues[i] : undefined } }));
            } finally { connection.close(); }
          }, { database: db.name, name: store.name });
          if (records.length !== store.records.length) throw new Error('Session database changed while saving; previous snapshot preserved.');
          store.records.forEach((record, i) => {
            if (store.keyPath === undefined && store.keyPathArray === undefined && record.key == null && record.keyEncoded === undefined) {
              if (records[i].key === undefined) throw new Error('Session key cannot be recovered; previous snapshot preserved.');
              record.key = records[i].key;
            }
            if (!Object.hasOwn(record, 'value') && !Object.hasOwn(record, 'valueEncoded')) {
              if (!records[i].falsy) throw new Error('Session value cannot be recovered; previous snapshot preserved.');
              Object.assign(record, records[i].value);
            }
          });
        }
      }
    } finally { await repairPage?.close(); }
    const file = sessionFile();
    const temporary = `${file}.tmp`;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await fs.rename(temporary, file);
    await fs.unlink(interactiveMarker).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }

  return { lockProfile, isProfileInUse, hasSavedSession, restoreSession, saveSession, beginInteractiveLogin };
}

export const lockProfile = () => createSessionStore(getProfileDirectory()).lockProfile();
export const isProfileInUse = () => createSessionStore(getProfileDirectory()).isProfileInUse();
export const hasSavedSession = () => createSessionStore(getProfileDirectory()).hasSavedSession();
export const restoreSession = (browser: BrowserContext) => createSessionStore(getProfileDirectory()).restoreSession(browser);
export const saveSession = (browser: BrowserContext) => createSessionStore(getProfileDirectory()).saveSession(browser);
