import { Box, Text, useInput } from 'ink';
import { tone } from '../theme.ts';

/** y/Enter confirms, n/Esc declines. */
export default function Confirm({ message, onYes, onNo }: Readonly<{ message: string; onYes: () => void; onNo: () => void }>) {
  useInput((input, key) => {
    if (input.toLowerCase() === 'y' || key.return) onYes();
    else if (input.toLowerCase() === 'n' || key.escape) onNo();
  });
  return (
    <Box flexDirection="column">
      <Text color={tone('yellow')}>{message}</Text>
      <Text dimColor>y đồng ý · n / Esc huỷ</Text>
    </Box>
  );
}
