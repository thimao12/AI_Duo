import { Text } from 'ink';
import { useEffect, useState } from 'react';
import { tone, type Tone } from './theme.ts';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function Spinner({ color = 'cyan' }: Readonly<{ color?: Tone }>) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 100);
    return () => clearInterval(timer);
  }, []);
  return <Text color={tone(color)}>{FRAMES[frame]}</Text>;
}
