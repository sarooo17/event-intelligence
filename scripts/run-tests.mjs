import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const timeoutMs = Number(process.env.TEST_FILE_TIMEOUT_MS ?? 60000);
const tests = (await readdir('test'))
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => `test/${name}`);

for (const file of tests) {
  console.log(`\n=== ${file} ===`);

  const child = spawn(process.execPath, ['--test', file], {
    stdio: 'inherit',
    env: process.env,
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    console.error(`\nTEST_FILE_TIMEOUT: ${file} exceeded ${timeoutMs}ms`);
    child.kill('SIGTERM');

    const hardKill = setTimeout(() => child.kill('SIGKILL'), 5000);
    hardKill.unref?.();
  }, timeoutMs);
  timer.unref?.();

  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => {
      if (timedOut) {
        resolve(124);
        return;
      }
      if (signal) {
        console.error(`Test process terminated by signal ${signal}: ${file}`);
        resolve(1);
        return;
      }
      resolve(exitCode ?? 1);
    });
  });

  clearTimeout(timer);

  if (code !== 0) {
    process.exitCode = code;
    break;
  }
}
