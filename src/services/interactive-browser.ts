import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createSessionStore } from './session-store.ts';
import { createLogger } from '../utils/logger.ts';

const log = createLogger('interactive-browser');
const run = promisify(execFile);

export async function closeInteractiveWindow(pid: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid browser process');
  await run('/usr/local/bin/deepsproxy-close-browser', [String(pid)], { timeout: 5000, maxBuffer: 4096 });
}

/** The human browser stays inside the worker and its existing egress sandbox. */
export function interactiveWorkerArguments(profile: string, startUrl = 'https://chat.deepseek.com/'): string[] {
  return [
    `--user-data-dir=${profile}`, '--lang=pt-BR', '--accept-lang=pt-BR,pt', '--window-size=1280,900',
    // Match Playwright's storage configuration. Chromium 156 field trials may
    // select SQLite DOM storage, while Playwright otherwise opens LevelDB.
    '--disable-field-trial-config',
    // Match Playwright's Linux cookie store instead of depending on a desktop keyring.
    '--password-store=basic',
    '--no-first-run', '--no-default-browser-check', '--disable-background-mode', '--disable-dev-shm-usage',
    '--proxy-server=http://egress:3128', '--proxy-bypass-list=<-loopback>', '--disable-quic',
    startUrl,
  ];
}

export class InteractiveBrowser {
  private process?: { child: ChildProcess; closed: Promise<void> };
  constructor(private profile: string, private startUrl = 'https://chat.deepseek.com/') {}

  get running(): boolean {
    return !!this.process && this.process.child.exitCode === null && this.process.child.signalCode === null;
  }

  async start(): Promise<void> {
    if (this.running) return;
    await this.process?.closed;
    const session = createSessionStore(this.profile);
    const release = await session.lockProfile();
    let child: ChildProcess;
    try {
      await session.beginInteractiveLogin();
      // No shell, debugging endpoint or credential arguments. The user operates
      // this browser through the worker's existing authenticated VNC tunnel.
      child = spawn(chromium.executablePath(), interactiveWorkerArguments(this.profile, this.startUrl), { stdio: 'ignore' });
    } catch (error) { await release(); throw error; }
    const closed = new Promise<void>(resolve => {
      child.once('close', (code, signal) => {
        log.info('Interactive browser closed', { code, signal });
        void release().finally(resolve);
      });
    });
    this.process = { child, closed };
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      const deadline = Date.now() + 20_000;
      while (this.running) {
        try {
          await run('/usr/local/bin/deepsproxy-close-browser', ['--check', String(child.pid)], { timeout: 2000, maxBuffer: 4096 });
          break;
        } catch (error) {
          if ((error as { code?: unknown }).code !== 3) throw error;
          if (Date.now() >= deadline) throw new Error('A janela do navegador de login não ficou pronta. Use Recuperar navegador.');
          await delay(100);
        }
      }
      if (!this.running) throw new Error('O navegador de login encerrou ao iniciar. Use Recuperar navegador.');
      log.info('Interactive browser ready');
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    const current = this.process;
    if (!current) return;
    // Wait for Chromium to flush its own profile before the API opens it.
    // A timeout never kills the profile owner forcibly or unlocks a live profile.
    if (this.running) await closeInteractiveWindow(current.child.pid!);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        current.closed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('O navegador ainda está salvando a sessão. Aguarde e tente novamente.')), 15_000);
        }),
      ]);
      if (this.process === current) this.process = undefined;
    } finally { clearTimeout(timer); }
  }
}
