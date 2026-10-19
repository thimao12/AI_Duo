import { Box, Text } from 'ink';
import { listCommands, listSkills, type SlashCommand, type Skill } from '../../../../server/src/extensions.ts';
import type { PanelProps } from '../panel-types.ts';
import { useLoader } from '../util.ts';
import Panel from '../widgets/Panel.tsx';
import SelectList from '../widgets/SelectList.tsx';

type Entry = { kind: 'skill'; skill: Skill } | { kind: 'command'; command: SlashCommand };

const HINTS = [['↑↓', 'chọn'], ['Esc', 'đóng']] as const;

const SCOPE = { project: 'dự án', user: 'người dùng' } as const;

/** The skills and custom slash commands found for a project, as one list. */
export async function loadEntries(cwd: string): Promise<Entry[]> {
  const [skills, commands] = await Promise.all([listSkills(cwd), listCommands(cwd)]);
  return [...skills.map((skill): Entry => ({ kind: 'skill', skill })), ...commands.map((command): Entry => ({ kind: 'command', command }))];
}

const keyOf = (e: Entry) => (e.kind === 'skill' ? `skill:${e.skill.name}` : `command:${e.command.name}`);
const labelOf = (e: Entry) => (e.kind === 'skill' ? e.skill.name : `/${e.command.name}`);
const descOf = (e: Entry) => {
  const item = e.kind === 'skill' ? e.skill : e.command;
  return `${e.kind === 'skill' ? 'skill' : 'lệnh'} · ${SCOPE[item.scope]}${item.description ? ` · ${item.description}` : ''}`;
};

/** /skills: skills (SKILL.md) and custom slash commands (.ai-duo/commands) the agents and the chat can use. */
export default function SkillsPanel({ cwd, onClose }: Readonly<PanelProps>) {
  const loaded = useLoader(() => loadEntries(cwd));
  const entries = loaded.data ?? [];
  return (
    <Panel title="Skills và lệnh tuỳ chỉnh" subtitle={cwd} hints={HINTS} error={loaded.error} onClose={onClose}>
      <Box flexDirection="column">
        <SelectList
          items={entries}
          getKey={keyOf}
          getLabel={labelOf}
          getDescription={descOf}
          onCancel={onClose}
          emptyText={loaded.loading ? 'Đang tải…' : 'Chưa có skill hay lệnh nào.'}
          maxHeight={10}
        />
        <Text dimColor>Skill: thư mục có SKILL.md trong .claude/skills, .agents/skills (dự án hoặc ~); gõ $tên trong tin nhắn để đính kèm cho mọi agent. Lệnh: file .md trong .ai-duo/commands, dùng $ARGUMENTS cho phần gõ thêm.</Text>
      </Box>
    </Panel>
  );
}
