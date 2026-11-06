// Runs the test suite against a throwaway profile so tests never read or write
// the real deepseek_profile/qwen_profile (block state, telemetry, sessions).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const directory = mkdtempSync(path.join(tmpdir(), 'proxy-ia-test-'));
const env = {
  ...process.env,
  DEEPSEEK_PROFILE_DIR: path.join(directory, 'deepseek'),
  CHATGPT_PROFILE_DIR: path.join(directory, 'chatgpt'),
  QWEN_PROFILE_DIR: path.join(directory, 'qwen'),
  META_PROFILE_DIR: path.join(directory, 'meta'),
  DEEPSPROXY_DISABLE_TELEMETRY_PERSIST: '1',
};
delete env.PROVIDER_PROFILE_DIR;
const files = process.argv.slice(2);
const result = spawnSync(process.execPath, [path.join(root, 'node_modules/tsx/dist/cli.mjs'), '--test', '--test-force-exit', ...(files.length ? files : ['src/**/*.test.ts'])], { cwd: root, env, stdio: 'inherit' });
rmSync(directory, { recursive: true, force: true });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
