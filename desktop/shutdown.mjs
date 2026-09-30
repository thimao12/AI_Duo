/** Save and stop active runs before quitting, with a bounded wait for hung processes. */
export async function stopRunsAndQuit(abortAll, quit, { timeoutMs = 8000, reportError = console.error } = {}) {
  let timer;
  try {
    const timeout = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); });
    await Promise.race([Promise.resolve().then(abortAll), timeout]);
  } catch (err) {
    reportError('Failed to stop AI Duo runs:', err);
  } finally {
    clearTimeout(timer);
    quit();
  }
}
