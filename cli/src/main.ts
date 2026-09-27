// env.ts must be evaluated first: the server modules read AI_DUO_* variables when they load.
import './env.ts';
import { main } from './commands.ts';

try {
  const code = await main(process.argv.slice(2));
  // Let piped stdout drain before exiting (exit() can cut off pending writes on POSIX pipes).
  await new Promise<void>((resolve) => process.stdout.write('', () => resolve()));
  process.exit(code);
} catch (err) {
  console.error(err);
  process.exit(1);
}
