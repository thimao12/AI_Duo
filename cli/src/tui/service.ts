import { RunService } from '../../../server/src/service.ts';

let instance: RunService | undefined;

/** The one RunService of this process (created on first use), shared by the shell and the panels. */
export function getService(): RunService {
  instance ??= new RunService({ app: 'cli' });
  return instance;
}
