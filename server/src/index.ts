import { abortAll, startServer } from './app.ts';

const port = Number(process.env.PORT || 8787);
const { url } = await startServer({ port });
console.log(`ai-duo server on ${url}`);

// Kill running agents when the server stops.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    abortAll();
    setTimeout(() => process.exit(0), 500);
  });
}
