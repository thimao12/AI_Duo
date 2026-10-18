# AI Duo – Claude, Codex và Antigravity

App web local để **Claude Code**, **Codex** và **Antigravity** cùng làm việc. App gọi CLI ở chế độ headless (`claude -p`, `codex exec`, `agy`), nên dùng đăng nhập sẵn có trên máy, không cần API key. Router tự chọn Claude/Codex; bạn có thể chọn Antigravity bằng tay.

## Chế độ

| Mode | Luồng |
|---|---|
| **Tự động** (`mode: "auto"`) | Router phân loại task (loại việc + độ khó), rồi chọn Pair/Debate, AI nào code, và model + mức reasoning cho **từng vai trò**, ưu tiên ít token nhất mà vẫn đủ tốt. Luật từ khoá chạy trước (miễn phí); chỉ khi luật không chắc mới gọi Haiku ở chế độ tối giản (~1k token). Model điền tay ở "Tùy chọn nâng cao" luôn thắng router. Danh mục model nằm ở `server/src/router/catalog.ts`, có thể ghi đè bằng file JSON qua `AI_DUO_ROUTER_CATALOG`. |
| **Debate** | Cả 2 đề xuất song song → review chéo N vòng (mỗi con kết thúc bằng `VERDICT: AGREE/REVISE`) → dừng sớm nếu cả 2 cùng AGREE → judge viết **giải pháp cuối**. Agent chỉ được đọc (read-only). |
| **Pair** | Coder sửa code trong repo → Reviewer đọc diff + chạy test → trả JSON `APPROVE / CHANGES_REQUESTED` trong code block → coder sửa tiếp (resume đúng session) → lặp tới khi approve hoặc hết số vòng. Verdict không hợp lệ bị coi là yêu cầu sửa; nếu reviewer ghi file, phiên không thể được duyệt và danh sách file được gửi cho coder. **Không tự commit.** |

Mỗi repo chỉ chạy một phiên Code/Plan tại một thời điểm, **kể cả giữa các tiến trình** (web, desktop, CLI). Khóa là file JSON trong `<AI_DUO_DATA_DIR>/locks/`, đặt tên theo hash của Git toplevel đã chuẩn hóa (ngoài Git – chỉ Plan được phép – là thư mục làm việc), nên hai đường dẫn khác nhau vào cùng repo tranh cùng một khóa. Yêu cầu mới bị từ chối (API `409`, CLI mã thoát `4`) kèm run ID, PID và ứng dụng đang giữ khóa. Khóa được nhả khi agent đã dừng và phiên đã lưu (xong, lỗi, dừng hoặc Ctrl+C). Khóa **không bao giờ tự bị xóa vì cũ**: nếu tiến trình giữ khóa chết đột ngột, chạy `ai-duo unlock` – lệnh chỉ gỡ khi PID đó không còn chạy trên máy này (`--force` khi chắc chắn, ví dụ PID đã bị chương trình khác dùng lại).

## Chạy

**App desktop (cửa sổ riêng, không cần browser):**

```bash
pnpm install
pnpm desktop        # build rồi mở cửa sổ AI Duo
pnpm desktop:dist   # đóng gói → desktop/release/AI-Duo-Setup-x.y.z.exe (cài đặt) và AI-Duo-x.y.z-portable.exe
```

Bản desktop lưu lịch sử phiên ở `%APPDATA%\AI Duo\runs` và prompt ở `%APPDATA%\AI Duo\prompts`. Prompt ở đây sửa được, và app chỉ chép file prompt nào chưa có, nên phần bạn đã sửa sẽ không bị ghi đè.

**CLI (`ai-duo`):**

```bash
pnpm cli:build                               # → cli/dist/ai-duo.mjs + cli/dist/prompts
node cli/dist/ai-duo.mjs doctor              # hoặc: cd cli && npm link → tự build và gọi `ai-duo` ở bất kỳ đâu
ai-duo doctor antigravity                    # chỉ kiểm tra agent được nêu (mặc định: cả ba)
ai-duo run "thêm nút xuất CSV" --mode plan   # chạy trong thư mục hiện tại (hoặc --cwd <dir>)
ai-duo run "…" --coder antigravity --reviewer codex --antigravity-model <model> --skip-auth-check
ai-duo runs                                  # phiên của repo hiện tại (--all: mọi thư mục)
ai-duo show <id> [--diff]                    ai-duo continue <id> "sửa thêm…"
pnpm cli run "…" --cwd <dir>                 # chạy thẳng từ source ở gốc repo, không cần build
```

Nếu `ai-duo` báo thiếu `dist/ai-duo.mjs`, chạy `pnpm cli:build` tại gốc repo rồi thử lại. Lệnh đã liên kết qua `npm link` dùng trực tiếp bản build trong `cli/dist`; build thất bại sẽ giữ lại bản đang có.

CLI chạy trực tiếp trên cùng lõi `RunService` với server (routing, kiểm tra agent, khóa repo, Plan → Code), không cần server đang chạy. Cần Node ≥ 22 và CLI của các agent được chọn: mặc định là Claude và Codex; nếu chọn Antigravity thì cần `agy` (hoặc đặt `AGY_BIN`). Code cần Git; Plan có thể chạy ngoài Git. Tiến độ in ra `stderr`, kết quả cuối ra `stdout` (`--json` cho máy đọc); không có TTY hoặc có `NO_COLOR` thì bỏ màu. Mã thoát: `0` xong · `1` phiên lỗi · `2` yêu cầu sai · `3` kiểm tra agent thất bại · `4` repo đang bị khóa · `130` bị hủy.

- Trước khi tạo phiên (sau routing, trước lượt model đầu tiên), CLI/server kiểm tra từng agent sẽ dùng: tìm binary, chạy `--version`, và kiểm tra đăng nhập bằng `claude auth status` / `codex login status` (không gọi model). Chưa đăng nhập hoặc đăng nhập kiểu tính tiền theo API → dừng ngay. Nếu phiên bản CLI không báo được trạng thái đăng nhập → “không xác minh được”, cần `--skip-auth-check` (API: `skipAuthCheck: true`) để chạy tiếp. `ai-duo doctor` in đường dẫn, phiên bản, trạng thái đăng nhập, thư mục dữ liệu và các khóa.
- Điểm quyết định: có TTY thì CLI hỏi (Plan: `approve` / `refine` kèm góp ý / `stop`; Code: `continue` / `stop`; phải gõ lựa chọn rõ ràng). **Không có TTY thì mọi điểm quyết định mặc định là stop**, trừ khi có cờ: `--plan-decision=approve|stop` cho Plan (approve chuyển sang Code, được sửa file, nên không bao giờ là mặc định) và `--pair-extra-rounds=N` cho Code (mặc định `0`; mỗi lần cấp 2 vòng, không vượt quá N). Plan chạy được ngoài Git, nhưng duyệt kế hoạch sẽ chuyển sang Code (cần Git): khi đó “approve” bị từ chối kèm hướng dẫn `git init`, kế hoạch vẫn chờ để sửa/dừng, còn `--plan-decision=approve` ngoài Git bị từ chối ngay từ đầu (mã thoát `2`). Nếu stdin đóng trong lúc đang hỏi, CLI báo `stdin closed; cannot collect decision`, trả lời stop rồi kết thúc bình thường.
- **Chọn agent:** `--coder` / `--reviewer` nhận `claude`, `codex`, `antigravity` hoặc `auto`. Chọn tay thì bỏ qua router; chỉ chọn một bên thì bên kia theo cặp mặc định (Claude ↔ Codex, Antigravity ↔ Claude; Plan không có `--reviewer` thì agent tự review kế hoạch). Lựa chọn tay được giữ khi Plan chuyển sang Code và khi `continue` không nêu agent; `--coder auto` cho router chọn lại. Router không bao giờ tự chọn Antigravity. Trong chat: `/model` có thêm Reviewer, chọn "Tự động" (hoặc `x`) thì lượt sau được định tuyến lại.
- **Antigravity (`agy`):** chạy headless với `--input-format/--output-format stream-json`, luôn kèm `--mode plan` cho lượt chỉ đọc và `--mode accept-edits` cho lượt được sửa file; `extraArgs` không được ghi đè mode, định dạng, hội thoại hay prompt. `agy` không có lệnh kiểm tra đăng nhập nên luôn hiện “chưa xác minh” – chạy cần `--skip-auth-check` (`/skip-auth` trong chat); lỗi đăng nhập thật trong lượt chạy được báo kèm hướng dẫn chạy `agy` để đăng nhập lại. Đầu vào stream-json chỉ nhận văn bản, nên tin nhắn có ảnh gửi tới Antigravity bị từ chối trước khi chạy. Công cụ cần duyệt bị headless từ chối mềm (lượt vẫn kết thúc, thông báo trên stderr) và được hiển thị lại. Kiểm tra thật trên máy (gọi model, tốn hạn mức): `pnpm --filter server test:antigravity-headless`.
- **Cuộn trong chat toàn màn hình:** con lăn chuột cuộn thread. Nếu terminal vẫn đổi con lăn thành ↑/↓, các phím này cuộn khi ô nhập trống và không gọi lại prompt cũ; dùng **Ctrl+P/Ctrl+N** để xem prompt trước/sau. Khi ô nhập có chữ, ↑/↓ chỉ di chuyển giữa các dòng; chế độ inline vẫn hỗ trợ ↑/↓ gọi lịch sử. Khi bật mouse reporting, giữ **Shift** để kéo chọn văn bản; `AI_DUO_MOUSE=0` tắt mouse reporting. PageUp/PageDown, Ctrl/Alt+↑/↓, Home/End vẫn cuộn như trước. Khi thoát, chế độ chuột được tắt và alternate scroll (DECSET 1007) được khôi phục: XTRESTORE nếu terminal hỗ trợ, hoặc theo giá trị terminal trả lời qua DECRQM; terminal không hỗ trợ cả hai thì 1007 giữ trạng thái tắt.
- Ctrl+C hủy cây tiến trình agent, lưu phiên ở trạng thái `cancelled` và nhả khóa; nhấn lần nữa để thoát ngay (khi đó khóa còn lại tới khi `ai-duo unlock`). Chỉ hủy được từ chính terminal đang chạy; web/desktop hiển thị phiên đó đang chạy (theo checkpoint trên đĩa) nhưng không dừng được nó.

**Dữ liệu dùng chung:** web (`pnpm dev`), desktop và CLI mặc định dùng chung `%APPDATA%\AI Duo\runs` (macOS: `~/Library/Application Support/AI Duo`, Linux: `~/.config/AI Duo`), nên phiên tạo bằng CLI mở được trong web/desktop và ngược lại. CLI dùng prompt ở `%APPDATA%\AI Duo\prompts` và chỉ chép các template còn thiếu, như desktop. `AI_DUO_DATA_DIR` và `AI_DUO_PROMPTS_DIR` luôn được ưu tiên. Trước đây `pnpm dev` lưu ở `data/runs` trong repo; để tiếp tục dùng lịch sử cũ, đặt `AI_DUO_DATA_DIR=<repo>/data/runs`, hoặc chép các file `*.json` (và thư mục `images/`) sang `%APPDATA%\AI Duo\runs`.

Link trong output agent mở thư mục và các file `.md`, `.txt`, `.log`, `.json`, `.diff`, `.patch`, `.csv`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.svg` hoặc `.pdf` bằng ứng dụng mặc định. Các loại file khác chỉ mở Explorer và chọn file.

**Thư mục dự án được phép:** `AI_DUO_ALLOWED_ROOTS` là một mảng JSON gồm các đường dẫn tuyệt đối tới thư mục có sẵn. Server, desktop và CLI đọc cấu hình khi khởi động; thay đổi biến này cần khởi động lại. Nếu không đặt, chỉ thư mục mặc định và các thư mục con được phép: web dùng nơi gọi `pnpm dev`, desktop dùng thư mục home, CLI dùng nơi gọi `ai-duo` (`AI_DUO_DEFAULT_CWD` ghi đè thư mục mặc định). Chọn thư mục trên giao diện hoặc truyền `--cwd` chỉ chọn trong phạm vi này. Symlink/junction trỏ ra ngoài bị từ chối; Code cần cả Git root nằm trong phạm vi để snapshot không đọc repo cha. Lịch sử ngoài phạm vi vẫn xem được nhưng không thể chạy tiếp hoặc chuyển Plan sang Code.

Ví dụ PowerShell, cho phép các dự án trong thư mục `Mao`:

```powershell
$env:AI_DUO_ALLOWED_ROOTS = '["C:/Users/Admin/Desktop/Mao"]'
pnpm dev             # hoặc pnpm desktop / pnpm cli run "…" --cwd <dir>
```

Trên macOS/Linux: `export AI_DUO_ALLOWED_ROOTS='["/home/me/projects"]'` rồi chạy ứng dụng. Mọi thư mục cấu hình phải tồn tại; JSON sai hoặc đường dẫn tương đối làm ứng dụng dừng khởi động. Mảng rỗng `[]` không cho chạy dự án nào.

**Chế độ dev (chạy trong browser, hot reload):**

```bash
pnpm dev            # server :8787 + web :5173 → mở http://localhost:5173
```

API chỉ nhận request có `Host` là `localhost` hoặc `127.0.0.1`; request có `Origin` phải cùng origin với server hoặc thuộc `AI_DUO_DEV_ORIGINS` (mặc định `http://localhost:5173,http://127.0.0.1:5173`). `POST /api/runs` yêu cầu `Content-Type: application/json`.

Yêu cầu: `claude` và `codex` có trong PATH và đã đăng nhập. Bản cài npm dùng shim `.cmd` được chạy trực tiếp bằng Node, không qua `cmd.exe`; nếu không tìm thấy Node trên PATH, bản desktop dùng Electron làm Node runtime. Có thể đặt đường dẫn khác qua `CLAUDE_BIN` / `CODEX_BIN`. Nếu shim `.cmd` không trỏ được tới file JavaScript, app sẽ báo đường dẫn shim và yêu cầu đặt biến tương ứng.

Lượt của vai thinker/reviewer có câu trả lời rỗng sẽ báo lỗi. Dòng JSONL dài hơn 64 MB sẽ dừng lượt; cảnh báo giới hạn Claude vẫn được hiển thị.

Smoke test 2 adapter (1 turn + 1 turn resume mỗi CLI): `pnpm --filter server test:agents`

Kiểm tra parser JSONL, trạng thái adapter và thông báo lỗi: `pnpm --filter server test:agent-parsers`

Kiểm tra cách mở link file trong desktop: `pnpm --filter server test:desktop-links`

View phiên tự kết nối lại khi mất SSE; banner sẽ hiện trong lúc chờ server trả snapshot mới. Nếu phiên không tồn tại, app sẽ báo không tìm thấy thay vì tiếp tục thử kết nối.

## Quyền của agent

| Vai | Claude | Codex | Antigravity |
|---|---|---|---|
| thinker (Debate/Plan) | chỉ Read/Grep/Glob/Web | `-s read-only` | `--mode plan` (chỉ Plan) |
| coder | `acceptEdits` + Bash/Edit/Write | `-s workspace-write` | `--mode accept-edits` |
| reviewer | Bash/Read, cấm Edit/Write | `-s workspace-write` + được dặn không sửa file | `--mode plan` |

Pair mode chụp snapshot working tree lúc bắt đầu (dùng index tạm, không đụng vào staging của bạn), nên diff cuối chỉ chứa thay đổi do agent tạo ra, kể cả khi repo đang có sẵn thay đổi chưa commit.

## Cấu trúc

- `server/src/service.ts` – `RunService`: validation, routing, kiểm tra agent, khóa repo, vòng đời phiên, hủy và các quyết định; `app.ts` (HTTP) và `cli/` chỉ là lớp giao diện mỏng gọi vào đây
- `server/src/lock.ts` – khóa repo dùng chung giữa các tiến trình
- `server/src/agents/` – adapter cho từng CLI (parse JSONL, resume session, kill cả cây process khi huỷ, `check()` cho preflight)
- `server/src/modes/` – orchestrator `pair.ts` (Code), `plan.ts`, `debate.ts` (phiên cũ)
- `cli/` – lệnh `ai-duo` (`src/commands.ts`, hiển thị tiến độ `render.ts`, quyết định `decisions.ts`); `build.mjs` bundle bằng esbuild
- `server/src/prompts/*.md` – prompt template, sửa trực tiếp được, không cần restart
- `web/src/` – React UI (stream qua SSE)
- `desktop/` – Electron: `main.mjs` chạy server (bundle bằng esbuild) ngay trong app và mở cửa sổ; `build.mjs` chuẩn bị `dist/`
- `%APPDATA%\AI Duo\runs/*.json` – lịch sử các phiên (dùng chung, xem trên)

Kiểm tra: `pnpm --filter server test` (gồm `test:service` – RunService với agent giả, khóa giữa hai tiến trình) và `pnpm --filter ai-duo-cli test` (build rồi chạy bản build từ thư mục ngoài repo với `claude`/`codex` giả qua pipe, cùng các quyết định có TTY, stdin đóng và Ctrl+C).

Các phiên được lưu checkpoint khi tạo run và khi bắt đầu mỗi message. Nếu server khởi động lại bất ngờ, phiên và message đang chạy sẽ được hiển thị là gián đoạn trong lịch sử.

## SonarQube local

Cần Docker Desktop đang chạy với Linux containers và Node ≥ 22. SonarQube Community Build và PostgreSQL chạy trong stack `ai-duo-sonar`, chỉ mở dashboard trên máy này. Image được cố định bằng digest; dữ liệu nằm trong Docker volumes.

```bash
pnpm sonar:up       # khởi động, tạo project và token quét
pnpm sonar:scan     # quét mã nguồn và smoke tests của repo, đợi Quality Gate
pnpm sonar:status   # xem trạng thái và số issue còn mở
pnpm sonar:logs     # 100 dòng log gần nhất của server
pnpm sonar:down     # dừng stack, giữ nguyên dữ liệu
```

Dashboard: [AI Duo local](http://localhost:9000/dashboard?id=ai-duo-local). Đăng nhập `admin`, mật khẩu được tạo ngẫu nhiên trong `.local/sonar/credentials.json`. Thư mục này chứa mật khẩu/token và được Git bỏ qua. Kết quả tóm tắt của lần quét nằm trong `.local/sonar/analysis.json`.

`sonar:scan` trả mã thoát khác 0 nếu quét lỗi hoặc Quality Gate không đạt; kết quả đã tải lên vẫn xem được trên dashboard. Cấu hình quét là `sonar.local.properties`, được chọn riêng bởi `compose.sonar.yml`. Đây là project local độc lập với SonarCloud; phiên bản Community có thể báo bộ lỗi khác với check trên GitHub.
