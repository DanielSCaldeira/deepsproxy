import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext } from 'playwright';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

export function getProfileDirectory(): string {
  return path.resolve(projectRoot, process.env.PROVIDER_PROFILE_DIR || (process.env.PROVIDER === 'claude' ? process.env.CLAUDE_PROFILE_DIR || 'claude_profile' : process.env.PROVIDER === 'perplexity' ? process.env.PERPLEXITY_PROFILE_DIR || 'perplexity_profile' : process.env.PROVIDER === 'chatgpt' ? process.env.CHATGPT_PROFILE_DIR || 'chatgpt_profile' : process.env.PROVIDER === 'qwen' ? process.env.QWEN_PROFILE_DIR || 'qwen_profile' : process.env.DEEPSEEK_PROFILE_DIR || 'deepseek_profile'));
}

export function createSessionStore(directory: string) {
  // Prevent the login window and the API browser from overwriting each other's profile.
  async function lockProfile(): Promise<() => Promise<void>> {
    await fs.mkdir(directory, { recursive: true });
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
    await browser.setStorageState(sessionFile());
    return true;
  }

  async function saveSession(browser: BrowserContext): Promise<void> {
    const state = await browser.storageState({ indexedDB: true });
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
