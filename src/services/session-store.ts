import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext } from 'playwright';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

export function getProfileDirectory(): string {
  return path.resolve(projectRoot, process.env.DEEPSEEK_PROFILE_DIR || 'deepseek_profile');
}

// Prevent the login window and the API browser from overwriting each other's profile.
export async function lockProfile(): Promise<() => Promise<void>> {
  const directory = getProfileDirectory();
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
      throw new Error('O perfil DeepSeek está em uso. Aguarde o login ou encerre o outro processo do proxy.');
    }
  }
  throw new Error('Não foi possível reservar o perfil DeepSeek. Tente novamente.');
}

function sessionFile(): string {
  return path.join(getProfileDirectory(), '.auth-state.json');
}

export async function isProfileInUse(): Promise<boolean> {
  try {
    const owner = Number(await fs.readFile(path.join(getProfileDirectory(), '.runtime.lock'), 'utf8'));
    if (!Number.isInteger(owner) || owner <= 0 || owner === process.pid) return false;
    process.kill(owner, 0);
    return true;
  } catch {
    return false;
  }
}

export async function hasSavedSession(): Promise<boolean> {
  return fs.access(sessionFile()).then(() => true, () => false);
}

export async function restoreSession(browser: BrowserContext): Promise<boolean> {
  if (!await hasSavedSession()) return false;
  await browser.setStorageState(sessionFile());
  return true;
}

export async function saveSession(browser: BrowserContext): Promise<void> {
  const state = await browser.storageState({ indexedDB: true });
  const file = sessionFile();
  const temporary = `${file}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
  await fs.rename(temporary, file);
}
