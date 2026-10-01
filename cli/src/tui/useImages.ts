import { useRef, useState } from 'react';
import type { ClipboardReader } from './clipboard.ts';
import { LIMIT_NOTE, loadImageFile, MAX_IMAGES, attachmentFromBytes, type ImageAttachment, type LoadResult } from './images.ts';

export const NO_IMAGE_NOTE = 'No image on the clipboard. Copy an image, or paste/drop an image file path.';
export const SHELL_IMAGE_NOTE = 'Image paste is not available in shell mode.';

/** What happened to a pasted path: attached, or plain text (insert it), or refused with a note. */
export type PathOutcome = { kind: 'attached' } | { kind: 'text' } | { kind: 'rejected'; note: string };

export interface ImageAttachments {
  images: readonly ImageAttachment[];
  /** Always the latest list, also within one tick (the render state lags behind). */
  ref: { readonly current: readonly ImageAttachment[] };
  /** Reads the clipboard; resolves to a notice, or null when an image was attached. */
  pasteClipboard(): Promise<string | null>;
  /** Attaches the image at an absolute path the user pasted. */
  pastePath(file: string): Promise<PathOutcome>;
  /** Removes the newest chip; false when there is none. */
  removeLast(): boolean;
  clear(): void;
  /** Puts a list back (a send that was refused). */
  replace(images: readonly ImageAttachment[]): void;
}

/** The image chips of the composer. State is mirrored in a ref like the editor's, so quick key bursts see each other. */
export function useImageAttachments(read: ClipboardReader): ImageAttachments {
  const [images, setImages] = useState<readonly ImageAttachment[]>([]);
  const ref = useRef<readonly ImageAttachment[]>([]);
  const reading = useRef(false);
  const put = (next: readonly ImageAttachment[]) => {
    ref.current = next;
    setImages(next);
  };

  /** Adds a loaded image; returns the notice when it is refused. */
  const add = (result: LoadResult): string | null => {
    if (!result.ok) return result.error;
    if (ref.current.length >= MAX_IMAGES) return LIMIT_NOTE;
    put([...ref.current, result.image]);
    return null;
  };

  const pastePath = async (file: string): Promise<PathOutcome> => {
    const loaded = await loadImageFile(file);
    if (!loaded) return { kind: 'text' };
    const note = add(loaded);
    return note ? { kind: 'rejected', note } : { kind: 'attached' };
  };

  const pasteClipboard = async (): Promise<string | null> => {
    if (ref.current.length >= MAX_IMAGES) return LIMIT_NOTE;
    if (reading.current) return 'Still reading the clipboard…';
    reading.current = true;
    try {
      const result = await read();
      if (result.kind === 'error') return result.message;
      if (result.kind === 'none') return NO_IMAGE_NOTE;
      if (result.kind === 'file') {
        const outcome = await pastePath(result.path);
        if (outcome.kind === 'attached') return null;
        return outcome.kind === 'rejected' ? outcome.note : NO_IMAGE_NOTE;
      }
      return add(attachmentFromBytes(result.bytes, result.name, 'clipboard'));
    } finally {
      reading.current = false;
    }
  };

  const removeLast = (): boolean => {
    if (ref.current.length === 0) return false;
    put(ref.current.slice(0, -1));
    return true;
  };

  return { images, ref, pasteClipboard, pastePath, removeLast, clear: () => put([]), replace: put };
}
