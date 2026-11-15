import { createApp } from './src/server.ts';
import { createStore } from './src/store.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const store = createStore();
  const server = createApp(store);
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') reject(new Error('could not bind an ephemeral port'));
      else resolve(address.port);
    });
  });

  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (envUrl === undefined || envUrl === '') {
    // Standalone mode: serve on $PORT when set, otherwise the ephemeral port.
    const standalonePort = Number.parseInt(process.env.PORT ?? '', 10);
    if (Number.isFinite(standalonePort) && standalonePort > 0) {
      server.close();
      const standalone = createApp(store);
      standalone.listen(standalonePort, '127.0.0.1', () => {
        // eslint-disable-next-line no-console
        console.log(`github-core-clone listening on http://127.0.0.1:${standalonePort}`);
      });
      return;
    }
    // eslint-disable-next-line no-console
    console.log(`github-core-clone listening on http://127.0.0.1:${port}`);
    return;
  }

  // Trial mode: register, then poll /done until the suite is over.
  const registerUrl = `${envUrl.replace(/\/+$/, '')}/register`;
  const doneUrl = `${envUrl.replace(/\/+$/, '')}/done`;
  const register = await fetch(registerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ port }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!register.ok) {
    throw new Error(`register failed: HTTP ${register.status}`);
  }
  for (;;) {
    await sleep(500);
    try {
      const response = await fetch(doneUrl, { signal: AbortSignal.timeout(10_000) });
      if (response.ok) {
        const body = (await response.json()) as { done?: boolean };
        if (body.done === true) break;
      }
    } catch {
      // A transient env hiccup must not kill the entry; keep polling.
    }
  }
  server.close();
  process.exit(0);
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
