import { spawn } from 'node:child_process';

const healthUrl = 'http://127.0.0.1:3000/health';

try {
  const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1500) });
  if (response.ok) {
    console.log('DeepsProxy já está disponível em http://127.0.0.1:3000');
    process.exit(0);
  }
} catch {
  // The proxy is not running yet; launch it below.
}

const node = process.execPath;
const child = spawn(node, ['node_modules/tsx/dist/cli.mjs', 'src/index.ts'], {
  cwd: process.cwd(),
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
});

child.once('error', (error) => {
  console.error(`Não foi possível iniciar o DeepsProxy: ${error.message}`);
  process.exitCode = 1;
});

child.unref();

for (let attempt = 0; attempt < 30; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 1000));

  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1000) });
    if (response.ok) {
      console.log('DeepsProxy iniciado em http://127.0.0.1:3000');
      process.exit(0);
    }
  } catch {
    // Keep waiting while the server starts.
  }
}

console.error('O DeepsProxy não respondeu em até 30 segundos.');
process.exit(1);
