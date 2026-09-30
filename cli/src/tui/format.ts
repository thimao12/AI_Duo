import type { AgentUsage, UsageWindow } from '../../../server/src/types.ts';

/** Vietnamese formatters for usage windows and run lists (same wording as the web app). */

const pad = (n: number) => String(n).padStart(2, '0');
export const clock = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** "Reset 14:59 hôm nay", "Reset 09:00 ngày mai" or "Reset Th 5 03/10 09:00" for far resets. */
export function formatReset(iso: string, now = new Date()): string {
  const at = new Date(iso);
  const dayDiff = Math.round((startOfDay(at) - startOfDay(now)) / 86_400_000);
  if (dayDiff === 0) return `Reset ${clock(at)} hôm nay`;
  if (dayDiff === 1) return `Reset ${clock(at)} ngày mai`;
  const weekday = at.toLocaleDateString('vi-VN', { weekday: 'short' });
  return `Reset ${weekday} ${pad(at.getDate())}/${pad(at.getMonth() + 1)} ${clock(at)}`;
}

/** "còn 1g 20p", "còn 45p", "còn 2n 3g". */
export function formatRemaining(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((new Date(iso).getTime() - now) / 60_000));
  if (minutes < 60) return `còn ${minutes}p`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `còn ${hours}g ${minutes % 60}p`;
  return `còn ${Math.floor(hours / 24)}n ${hours % 24}g`;
}

/** "Hết hạn 01:18 T6 23/10". */
export function formatExpiry(iso: string): string {
  const at = new Date(iso);
  const weekday = at.toLocaleDateString('vi-VN', { weekday: 'short' });
  return `Hết hạn ${clock(at)} ${weekday} ${pad(at.getDate())}/${pad(at.getMonth() + 1)}`;
}

/** A window whose reset time already passed and that was not just measured live has no trustworthy number. */
export function isExpiredWindow(win: UsageWindow, live: boolean, now = Date.now()): boolean {
  if (live) return false;
  if (win.stale === true) return true;
  return win.resetsAt !== undefined && new Date(win.resetsAt).getTime() <= now;
}

export const isLive = (usage: AgentUsage) => usage.live === true || usage.source === 'live';

/** "trực tiếp", "từ log lúc 14:05" or "từ lần chạy lúc 14:05". */
export function sourceLabel(usage: AgentUsage): string {
  if (isLive(usage)) return 'trực tiếp';
  const base = usage.source === 'codex-session-log' ? 'từ log' : 'từ lần chạy';
  return usage.updatedAt ? `${base} lúc ${clock(new Date(usage.updatedAt))}` : base;
}

export const clampPercent = (value: number) => Math.min(100, Math.max(0, Math.round(value)));

/** Text bar of `width` cells: "▰▰▰▱▱▱". */
export function textBar(percent: number, width = 20): string {
  const filled = Math.round((clampPercent(percent) / 100) * width);
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

/** green below 75, amber from 75, red from 90. */
export function barColor(percent: number): string {
  if (percent >= 90) return 'red';
  if (percent >= 75) return 'yellow';
  return 'green';
}

/** "vừa xong", "5 phút trước", "2 giờ trước", "3 ngày trước". */
export function relativeTime(ms: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - ms) / 60_000));
  if (minutes < 1) return 'vừa xong';
  if (minutes < 60) return `${minutes} phút trước`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} giờ trước`;
  return `${Math.floor(hours / 24)} ngày trước`;
}
