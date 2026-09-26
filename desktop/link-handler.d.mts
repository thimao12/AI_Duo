type LinkShell = {
  openExternal(url: string): unknown;
  openPath(path: string): unknown;
  showItemInFolder(path: string): void;
};

export function openAgentLink(
  raw: string,
  appUrl: string,
  dependencies: { statSync(path: string): { isDirectory(): boolean }; shell: LinkShell },
): void;
