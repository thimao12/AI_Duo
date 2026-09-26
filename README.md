# AI Duo – Claude × Codex

App web local để **Claude Code** và **Codex** cùng làm việc với nhau. App gọi 2 CLI ở chế độ headless (`claude -p`, `codex exec`), nên dùng luôn subscription/đăng nhập sẵn có trên máy, không cần API key.

## Chế độ

| Mode | Luồng |
|---|---|
| **Debate** | Cả 2 đề xuất song song → review chéo N vòng (mỗi con kết thúc bằng `VERDICT: AGREE/REVISE`) → dừng sớm nếu cả 2 cùng AGREE → judge viết **giải pháp cuối**. Agent chỉ được đọc (read-only). |
| **Pair** | Coder sửa code trong repo → Reviewer đọc diff + chạy test → trả JSON `APPROVE / CHANGES_REQUESTED` trong code block → coder sửa tiếp (resume đúng session) → lặp tới khi approve hoặc hết số vòng. Verdict không hợp lệ bị coi là yêu cầu sửa; nếu reviewer ghi file, phiên không thể được duyệt và danh sách file được gửi cho coder. **Không tự commit.** |

Pair chỉ chạy một phiên tại một repo tại một thời điểm. Nếu repo đã có phiên pair đang chạy, API trả `409` cho yêu cầu mới.

## Chạy

**App desktop (cửa sổ riêng, không cần browser):**

```bash
pnpm install
pnpm desktop        # build rồi mở cửa sổ AI Duo
pnpm desktop:dist   # đóng gói → desktop/release/AI-Duo-Setup-x.y.z.exe (cài đặt) và AI-Duo-x.y.z-portable.exe
```

Bản desktop lưu lịch sử phiên ở `%APPDATA%\AI Duo\runs` và prompt ở `%APPDATA%\AI Duo\prompts`. Prompt ở đây sửa được, và app chỉ chép file prompt nào chưa có, nên phần bạn đã sửa sẽ không bị ghi đè.

Link trong output agent mở thư mục và các file `.md`, `.txt`, `.log`, `.json`, `.diff`, `.patch`, `.csv`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.svg` hoặc `.pdf` bằng ứng dụng mặc định. Các loại file khác chỉ mở Explorer và chọn file.

**Chế độ dev (chạy trong browser, hot reload):**

```bash
pnpm dev            # server :8787 + web :5173 → mở http://localhost:5173
```

API chỉ nhận request có `Host` là `localhost` hoặc `127.0.0.1`; request có `Origin` phải cùng origin với server hoặc thuộc `AI_DUO_DEV_ORIGINS` (mặc định `http://localhost:5173,http://127.0.0.1:5173`). `POST /api/runs` yêu cầu `Content-Type: application/json`.

Yêu cầu: `claude` và `codex` có trong PATH và đã đăng nhập. Có thể đặt đường dẫn khác qua `CLAUDE_BIN` / `CODEX_BIN`.

Lượt của vai thinker/reviewer có câu trả lời rỗng sẽ báo lỗi. Dòng JSONL dài hơn 64 MB sẽ dừng lượt; cảnh báo giới hạn Claude vẫn được hiển thị.

Smoke test 2 adapter (1 turn + 1 turn resume mỗi CLI): `pnpm --filter server test:agents`

Kiểm tra parser JSONL, trạng thái adapter và thông báo lỗi: `pnpm --filter server test:agent-parsers`

Kiểm tra cách mở link file trong desktop: `pnpm --filter server test:desktop-links`

## Quyền của agent

| Vai | Claude | Codex |
|---|---|---|
| thinker (debate) | chỉ Read/Grep/Glob/Web | `-s read-only` |
| coder | `acceptEdits` + Bash/Edit/Write | `-s workspace-write` |
| reviewer | Bash/Read, cấm Edit/Write | `-s workspace-write` + được dặn không sửa file |

Pair mode chụp snapshot working tree lúc bắt đầu (dùng index tạm, không đụng vào staging của bạn), nên diff cuối chỉ chứa thay đổi do agent tạo ra, kể cả khi repo đang có sẵn thay đổi chưa commit.

## Cấu trúc

- `server/src/agents/` – adapter cho từng CLI (parse JSONL, resume session, kill cả cây process khi huỷ)
- `server/src/modes/` – orchestrator `debate.ts`, `pair.ts`
- `server/src/prompts/*.md` – prompt template, sửa trực tiếp được, không cần restart
- `web/src/` – React UI (stream qua SSE)
- `desktop/` – Electron: `main.mjs` chạy server (bundle bằng esbuild) ngay trong app và mở cửa sổ; `build.mjs` chuẩn bị `dist/`
- `data/runs/*.json` – lịch sử các phiên
