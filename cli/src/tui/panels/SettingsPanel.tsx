import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { detectCli, type CliDetection } from '../../../../server/src/routes/cli-settings.ts';
import { getCliSettings, setCliSettings } from '../../../../server/src/settings.ts';
import type { CliSettings } from '../../../../server/src/types.ts';
import type { PanelProps } from '../panel-types.ts';
import { errText, modelIds, paint, safeCatalog, useLoader } from '../util.ts';
import Confirm from '../widgets/Confirm.tsx';
import Form, { type FormField } from '../widgets/Form.tsx';
import Panel from '../widgets/Panel.tsx';

type Agent = 'claude' | 'codex';
const AGENTS: readonly Agent[] = ['claude', 'codex'];
const LABEL: Record<Agent, string> = { claude: 'Claude', codex: 'Codex' };

export type SettingsValues = Record<string, string>;
export type Detector = (agent: Agent) => Promise<CliDetection>;

const splitList = (text: string): string[] => text.split(/[,\n]/).map((part) => part.trim()).filter(Boolean);

/** Text values of every field, from the stored settings. */
export function toValues(cli: CliSettings): SettingsValues {
  const values: SettingsValues = {
    turnTimeoutMin: cli.turnTimeoutMin === undefined ? '' : String(cli.turnTimeoutMin),
    testCommand: cli.testCommand ?? '',
  };
  for (const agent of AGENTS) {
    const config = cli[agent];
    values[`${agent}.binPath`] = config.binPath ?? '';
    values[`${agent}.extraArgs`] = (config.extraArgs ?? []).join(', ');
    values[`${agent}.env`] = Object.entries(config.env ?? {}).map(([key, value]) => `${key}=${value}`).join('\n');
    values[`${agent}.defaultModel`] = config.defaultModel ?? '';
    values[`${agent}.defaultEffort`] = config.defaultEffort ?? '';
  }
  return values;
}

/** KEY=VALUE per line into an object, or the first malformed line as a message. */
export function parseEnv(text: string): Record<string, string> | string {
  const env: Record<string, string> = {};
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const eq = line.indexOf('=');
    if (eq < 1) return `Biến môi trường "${line}" phải có dạng KEY=VALUE.`;
    env[line.slice(0, eq).trim()] = line.slice(eq + 1);
  }
  return env;
}

/** The object the server validates and saves, or a message when a field cannot even be parsed. */
export function toInput(values: SettingsValues): { cli: Record<string, unknown> } | string {
  const cli: Record<string, unknown> = {};
  for (const agent of AGENTS) {
    const env = parseEnv(values[`${agent}.env`] ?? '');
    if (typeof env === 'string') return `${LABEL[agent]}: ${env}`;
    cli[agent] = {
      binPath: values[`${agent}.binPath`].trim(),
      extraArgs: splitList(values[`${agent}.extraArgs`]),
      env,
      defaultModel: values[`${agent}.defaultModel`].trim(),
      defaultEffort: values[`${agent}.defaultEffort`].trim(),
    };
  }
  const timeout = values.turnTimeoutMin.trim();
  if (timeout) cli.turnTimeoutMin = Number(timeout);
  cli.testCommand = values.testCommand.trim();
  return { cli };
}

function agentFields(agent: Agent, values: SettingsValues, models: string): FormField[] {
  const at = (name: string) => values[`${agent}.${name}`] ?? '';
  return [
    { id: `${agent}.binPath`, label: 'Đường dẫn CLI', kind: 'text', value: at('binPath'), placeholder: 'tự tìm trên PATH', section: LABEL[agent], hint: 'Đường dẫn tuyệt đối tới file chạy được; để trống = tự tìm.' },
    { id: `${agent}.extraArgs`, label: 'Tham số thêm', kind: 'text', value: at('extraArgs'), placeholder: 'không có', hint: 'Cách nhau bằng dấu phẩy.' },
    { id: `${agent}.env`, label: 'Biến môi trường', kind: 'multiline', value: at('env'), placeholder: 'không có', hint: 'Mỗi dòng một KEY=VALUE.' },
    { id: `${agent}.defaultModel`, label: 'Model mặc định', kind: 'text', value: at('defaultModel'), placeholder: 'theo CLI', hint: `Gợi ý: ${models || 'không có'}` },
    { id: `${agent}.defaultEffort`, label: 'Effort mặc định', kind: 'text', value: at('defaultEffort'), placeholder: 'theo CLI' },
  ];
}

export function settingsFields(values: SettingsValues): FormField[] {
  const catalog = safeCatalog();
  return [
    ...agentFields('claude', values, modelIds(catalog, 'claude').join(', ')),
    ...agentFields('codex', values, modelIds(catalog, 'codex').join(', ')),
    { id: 'turnTimeoutMin', label: 'Timeout mỗi lượt', kind: 'text', value: values.turnTimeoutMin, placeholder: 'mặc định (phút)', section: 'Chung', hint: 'Số phút, từ 1 đến 240.' },
    { id: 'testCommand', label: 'Lệnh test', kind: 'text', value: values.testCommand, placeholder: 'không có', hint: 'Lệnh mà reviewer chạy để kiểm tra.' },
  ];
}

function detectionText(agent: Agent, d: CliDetection | undefined): string {
  if (!d) return `${LABEL[agent]}: đang dò…`;
  if (d.error && !d.version) return `${LABEL[agent]}: ${d.error}`;
  const source = d.source === 'none' ? '' : ` · ${d.source}`;
  const path = d.resolvedPath ? ` · ${d.resolvedPath}` : '';
  return `${LABEL[agent]}: ${d.version ?? '?'}${source}${path}`;
}

function DetectLines({ detections }: Readonly<{ detections: Partial<Record<Agent, CliDetection>> }>) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>Đang dùng:</Text>
      {AGENTS.map((agent) => (
        <Text key={agent} wrap="truncate-end" color={detections[agent]?.version ? paint('green') : paint('yellow')}>{detectionText(agent, detections[agent])}</Text>
      ))}
    </Box>
  );
}

function useDetections(detector: Detector, refreshKey: number) {
  const [detections, setDetections] = useState<Partial<Record<Agent, CliDetection>>>({});
  useEffect(() => {
    let live = true;
    Promise.all(AGENTS.map((agent) => detector(agent).catch((): undefined => undefined))).then((found) => {
      if (live) setDetections({ claude: found[0], codex: found[1] });
    });
    return () => {
      live = false;
    };
  }, [detector, refreshKey]);
  return detections;
}

interface EditorProps {
  initial: CliSettings;
  detector: Detector;
  onClose: () => void;
}

function SettingsEditor({ initial, detector, onClose }: Readonly<EditorProps>) {
  const [baseline, setBaseline] = useState(() => toValues(initial));
  const [values, setValues] = useState(baseline);
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [confirming, setConfirming] = useState(false);
  const [saves, setSaves] = useState(0);
  const detections = useDetections(detector, saves);
  const dirty = JSON.stringify(values) !== JSON.stringify(baseline);

  const save = async () => {
    setNotice(undefined);
    const input = toInput(values);
    if (typeof input === 'string') {
      setError(input);
      return;
    }
    try {
      const saved = await setCliSettings(input.cli);
      if (typeof saved === 'string') {
        setError(saved);
        return;
      }
      const next = toValues(saved);
      setBaseline(next);
      setValues(next);
      setError(undefined);
      setNotice('Đã lưu.');
      setSaves((n) => n + 1);
    } catch (err) {
      setError(errText(err));
    }
  };

  const cancel = () => (dirty ? setConfirming(true) : onClose());
  return (
    <Panel title="Cài đặt CLI" subtitle={dirty ? 'Có thay đổi chưa lưu' : undefined} error={error} hints={[['↑↓', 'chọn'], ['Enter', 'sửa'], ['s', 'lưu'], ['Esc', 'đóng']]}>
      {confirming ? (
        <Confirm message="Bỏ các thay đổi chưa lưu và đóng?" onYes={onClose} onNo={() => setConfirming(false)} />
      ) : (
        <Form fields={settingsFields(values)} onChange={(id, value) => setValues((v) => ({ ...v, [id]: value }))} onSave={() => void save()} onCancel={cancel} maxRows={9} />
      )}
      {notice ? <Text color={paint('green')}>{notice}</Text> : null}
      <DetectLines detections={detections} />
    </Panel>
  );
}

export interface SettingsPanelProps extends PanelProps {
  /** Replaces the real CLI detection (tests). */
  detector?: Detector;
}

/** /settings: per-CLI binary, extra arguments, environment, default model/effort, plus timeout and test command. */
export default function SettingsPanel({ onClose, detector = detectCli }: Readonly<SettingsPanelProps>) {
  const loaded = useLoader(() => getCliSettings());
  if (!loaded.data) {
    return (
      <Panel title="Cài đặt CLI" onClose={onClose} error={loaded.error} hints={[['Esc', 'đóng']]}>
        <Text color={paint('gray')}>Đang tải…</Text>
      </Panel>
    );
  }
  return <SettingsEditor initial={loaded.data} detector={detector} onClose={onClose} />;
}
