import { abortAll, startServer } from './app.ts';

const port = Number(process.env.PORT || 8787);
const { url } = await startServer({ port });
console.log(`ai-duo server on ${url}`);

// Kill running agents when the server stops, and let each run save and release its repository lock.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    const timeout = new Promise((resolve) => setTimeout(resolve, 8000));
    void Promise.race([abortAll(), timeout]).finally(() => process.exit(0));
  });
}
