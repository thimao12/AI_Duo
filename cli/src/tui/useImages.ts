import { useRef } from 'react';
import type { ClipboardReader } from './clipboard.ts';
import { attachmentFromBytes, loadImageFile, type ImageAttachment, type LoadResult } from './images.ts';

export const NO_IMAGE_NOTE = 'No image on the clipboard. Copy an image, or paste/drop an image file path.';
export const SHELL_IMAGE_NOTE = 'Image paste is not available in shell mode.';

/** An image was read, or the text is no image (insert it as text), or there is a notice to show. */
export type Loaded = { kind: 'image'; image: ImageAttachment } | { kind: 'text' } | { kind: 'note'; note: string };

const fromResult = (result: LoadResult): Loaded => (result.ok ? { kind: 'image', image: result.image } : { kind: 'note', note: result.error });

/** Reads the image file at an absolute path the user pasted; `text` when it is not an image file. */
export async function loadPath(file: string): Promise<Loaded> {
  const loaded = await loadImageFile(file);
  return loaded ? fromResult(loaded) : { kind: 'text' };
}

export interface ImageLoader {
  /** Reads the clipboard (an image, or a copied image file). Never `text`. */
  readClipboard(): Promise<Loaded>;
}

/**
 * Clipboard access of the composer. The attachments themselves live in the editor state (next to the
 * text and its tokens), so quick key bursts and drafts see them together.
 */
export function useImageLoader(read: ClipboardReader): ImageLoader {
  const reading = useRef(false);
  const readClipboard = async (): Promise<Loaded> => {
    if (reading.current) return { kind: 'note', note: 'Still reading the clipboard…' };
    reading.current = true;
    try {
      const result = await read();
      if (result.kind === 'error') return { kind: 'note', note: result.message };
      if (result.kind === 'none') return { kind: 'note', note: NO_IMAGE_NOTE };
      if (result.kind === 'file') {
        const loaded = await loadPath(result.path);
        return loaded.kind === 'text' ? { kind: 'note', note: NO_IMAGE_NOTE } : loaded;
      }
      return fromResult(attachmentFromBytes(result.bytes, result.name, 'clipboard'));
    } finally {
      reading.current = false;
    }
  };
  return { readClipboard };
}
