export interface DraftImage {
  name: string;
  dataUrl: string;
}

const DB_NAME = 'ai-duo-drafts';
const STORE_NAME = 'composer';
const DRAFT_KEY = 'images';
let pendingWrite: Promise<void> = Promise.resolve();

function openDraftDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadDraftImages(): Promise<DraftImage[]> {
  await pendingWrite;
  const db = await openDraftDb();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(DRAFT_KEY);
      request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

async function writeDraftImages(images: DraftImage[]): Promise<void> {
  const db = await openDraftDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put(images, DRAFT_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('Image draft save was aborted'));
    });
  } finally {
    db.close();
  }
}

export function saveDraftImages(images: DraftImage[]): Promise<void> {
  const snapshot = images.map((image) => ({ ...image }));
  const write = pendingWrite.then(() => writeDraftImages(snapshot));
  pendingWrite = write.catch(() => {});
  return write;
}
