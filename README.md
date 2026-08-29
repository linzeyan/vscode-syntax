# Poly

用「兩個 VSCode extension ＋ 一個 CLI」取代為了各語言 highlight／lint／format 而
安裝的一大堆零散 extension。編輯器與 CI 共用同一個 binary、同一份設定，所以本機存
檔跟 pipeline 的結果一定一致。

| 產出物                  | 職責                                                         |
| ----------------------- | ------------------------------------------------------------ |
| `poly-syntax-highlight` | 多語言 syntax highlighting，**接管全部 VSCode 內建語言文法** |
| `poly-lsp`              | 存檔即時 lint／format，批次命令；背後是 `poly lsp` daemon    |
| `poly`                  | 單一 binary CLI，供 CI、pre-commit、終端批次使用             |

## 功能

### poly-syntax-highlight — highlighting

- **151 個文法**：接管 49 個 VSCode 內建語言，另加 44 個內建沒有的語言
  （HCL／Terraform、nginx、zig、dotenv、protobuf、mermaid、caddyfile、systemd
  unit、jsonnet、just、nix、cabal、dune、ssh_config、CSV/TSV rainbow…）。
- 來源共 93 條、27 個 pinned 上游 repo；只有 CSV／TSV／ssh_config 三個是自產的
  （上游要嘛不存在，要嘛沒有授權檔）。
- 輸出標準 TextMate scope，**任何現有 color theme 直接生效**，不自帶配色。
- 部分語言改採比內建更好的社群文法（如 rust 用 dustypomerleau/rust-syntax）。
- 文法一律由 `tools/grammar-sync.py` 從上游 repo／marketplace VSIX 以 pinned
  commit 同步，`grammars/sources.json` 是單一真相；CI 有 drift gate 擋手改。
- **零執行期程式碼**，不佔 extension host 資源。

### poly-lsp — 編輯器整合

- **Format**：Format Document／`editor.formatOnSave`，加上批次命令 Format
  File／Folder／Workspace／Git Repo／Git Changed Files。
- **Lint**：存檔即時 diagnostics 進 Problems panel；`Poly: Lint (poly check)`
  在終端跑完整 CLI。
- **規則說明**：滑鼠移到 SQL 的波浪線上會顯示 sqruff 該條規則的 anti-pattern／
  best-practice 全文。sqruff 沒有文件站可連，那份說明編在 binary 裡，版本精確、
  離線可讀。其他工具有自己的規則頁，走規則代碼上的超連結。
- **語言伺服器（預設關閉）**：`poly.languageServers` 打開後，poly 會啟動專案自己
  toolchain 裡的 language server，把 hover、go-to-definition、type definition、
  implementation、references、outline、completion 路由給它。目前六個：gopls（Go）、
  rust-analyzer（Rust）、clangd（C／C++）、sourcekit-lsp（Swift）、terraform-ls
  （Terraform）、lua-language-server（Lua）。poly **不實作**這些功能也不代裝
  server——只從 PATH 找，找不到就說一聲——所以品質就是那支 server 的品質。實際能用
  哪幾項由 server 自己宣告：terraform-ls 只給五項，sourcekit-lsp 六項。預設關閉是
  因為它會跟你八成已經裝了的官方 extension 重疊，要用請先移除那個 extension。改完
  要重新載入視窗。
- **`poly.languageServerLogs`（預設開啟）**：把 language server 自己的 stderr 轉進
  Poly 輸出面板。clangd 與 terraform-ls 每個請求寫一行，嫌吵就關掉——關掉是整份丟棄，
  不是去叫各家 server 安靜（有些根本沒這種旗標）。poly 自己的訊息（server 不在 PATH、
  啟動就掛）不受影響。
- **專案內工具優先**：偵測到專案的 biome／prettier／eslint／rustfmt 就用它們，
  避免和團隊 CI 結果不一致。
- 背景檢查 GitHub Releases（預設 7 天一次，可調可關），一鍵同時更新兩個 extension。

### poly — CLI

- **內嵌引擎**（免安裝、離線可用）：TypeScript／JavaScript、JSON／JSONC、
  Markdown、TOML、YAML、CSS／SCSS／LESS、HTML／Vue／Svelte／Astro／Jinja、
  Python、SQL、XML、GraphQL、Dockerfile。
- **外部工具**（受管下載）：shellcheck、shfmt、hadolint、actionlint、typos、
  ruff、tflint、gofumpt、golangci-lint、stylua、selene、swiftlint。版本釘死，
  每個平台的 sha256 都預先寫進 `poly-tools.lock`——下載對不上就直接失敗，而不是
  信任第一次抓到的東西。上游有新版時由 weekly 的 `tool-sync.yml` 開 PR。
- **只用專案 toolchain、不代裝**：rustfmt／clippy、clang-format／clang-tidy、
  swift-format、terraform fmt。
- 工具解析順序：`poly.toml` 指定 → 專案內工具 → 內嵌引擎 → 受管下載 → PATH。

## 安裝

需要 VSCode 1.85 以上。從
[Releases](https://github.com/linzeyan/vscode-syntax/releases/latest) 下載，
兩個 VSIX 都裝：

1. `poly-syntax-highlight-<版本>.vsix` — 通用，不分平台。
2. `poly-lsp-<平台>-<版本>.vsix` — **要挑對平台**，內含對應的 poly binary：
   `darwin-arm64`、`darwin-x64`、`linux-arm64`、`linux-x64`、`win32-arm64`、
   `win32-x64`。

安裝方式：VSCode 側邊欄 Extensions → 右上角 `...` → **Install from VSIX...** →
選檔案 → 重新載入視窗。或用命令列：

```sh
code --install-extension poly-syntax-highlight-0.5.0.vsix
code --install-extension poly-lsp-darwin-arm64-0.5.0.vsix
```

之後的版本由 poly-lsp 自己提示更新，不必再手動抓。

### 從 0.5.0 以前升上來

兩個 extension 在 0.6.0 改了名字（`poly-lint` → `poly-lsp`、`poly-syntax` →
`poly-syntax-highlight`）。換名字等於換 extension id，所以新版是**另一個**
extension，內建的更新提示接不上——舊的會留著，兩個 formatter 搶同一批語言。

```sh
code --uninstall-extension ricky.poly-lint
code --uninstall-extension ricky.poly-syntax
```

再檢查 `settings.json`：如果裡面有 `"editor.defaultFormatter": "ricky.poly-lint"`
（曾經點過 format-on-save 提示的話就會有），要改成 `"ricky.poly-lsp"`。留著舊
值不會報錯，只會指向一個不存在的 extension，然後格式化安靜地不動作。

### 只要 CLI

不必裝 extension。macOS／Linux：

```sh
curl -fsSL https://raw.githubusercontent.com/linzeyan/vscode-syntax/main/install.sh | sh
```

Windows（PowerShell）：

```powershell
irm https://raw.githubusercontent.com/linzeyan/vscode-syntax/main/install.ps1 | iex
```

腳本挑對平台、對 `SHA256SUMS` 驗 sha256、把 binary 放進 `~/.local/bin`
（Windows 是 `%LOCALAPPDATA%\Programs\poly`，並寫進使用者 PATH）。要換位置或釘
版本就設環境變數——`irm | iex` 沒辦法傳參數，所以兩邊都認得：

```sh
POLY_VERSION=0.5.0 POLY_INSTALL_DIR=~/bin sh install.sh
```

Windows on ARM 上會裝 arm64 版，即使腳本本身跑在 x64 模擬層裡（從 ssh 或某些
終端機啟動時會發生，此時 `PROCESSOR_ARCHITECTURE` 說的是 process 不是機器）。

要自己來的話，Release 另附獨立 binary（`poly-darwin-arm64`、`poly-linux-x64`、
`poly-win32-arm64.exe` …）：

```sh
curl -fsSLO https://github.com/linzeyan/vscode-syntax/releases/latest/download/poly-darwin-arm64
xattr -d com.apple.quarantine ./poly-darwin-arm64   # 瀏覽器下載才需要
chmod +x poly-darwin-arm64 && mv poly-darwin-arm64 /usr/local/bin/poly
```

`SHA256SUMS` 一併發佈，可先驗再用。Windows 上未簽章的 `poly.exe` 可能被
SmartScreen 擋，處理方式見
[extensions/lsp/README.md](extensions/lsp/README.md#疑難排解)。

### 在 GitHub Actions 裡用

```yaml
- uses: linzeyan/vscode-syntax@v0
- run: poly check --strict .
```

`@v0` 會跟著最新的 release 走。要釘死版本就寫 `with: { version: "0.5.0" }`——poly
會改寫檔案，所以新版本自己跑進來有可能把綠的分支變紅。

Action 做三件事：抓對應平台的 binary、對 `SHA256SUMS` 驗 sha256、放進 PATH。順便
快取 poly 之後會下載的外部 linter（`with: { cache: false }` 可關）——冷跑一次
`poly check` 在 lint 任何東西之前要先抓幾十 MB 的 shellcheck、ruff。

### 在容器裡用

```sh
docker run --rm -v "$PWD:/work" ghcr.io/linzeyan/poly check --strict .
```

`linux/amd64` 與 `linux/arm64` 都有。tag 有 `latest`、`0.5.0`、`0.5`；pre-release
不會動到 `latest`。image 裡的 binary 就是 release 附的那一支，不是另外編的。

外部 linter 快取在 `/cache`，CI 裡掛個 volume 上去就不用每次重抓：

```sh
docker run --rm -v "$PWD:/work" -v poly-cache:/cache ghcr.io/linzeyan/poly check .
```

### 驗證裝好了

```sh
poly tools          # 列出每個外部工具解析到哪裡
poly fmt --check .  # 對整個 repo 做 dry-run
```

在編輯器裡開一個 `.rs` 檔，`Developer: Inspect Editor Tokens and Scopes`，把游標
放在 `->` 上——scope 含 `keyword.operator.arrow.skinny.rust` 就代表 poly 的文法
生效了（內建文法沒有這個 scope）。

## CLI 用法

```sh
poly fmt <paths...>            # 就地格式化
poly fmt --check <paths...>    # 只回報，不改檔（CI 用）
poly check <paths...>          # 跑 lint
poly check --strict <paths...> # 工具缺席時視為錯誤，而不是跳過（fmt 也吃）
poly fmt --changed             # 只處理 git 變更的檔案（pre-commit 用）
poly tools list                # 工具解析狀態
poly tools install [tool...]   # 預先抓好受管工具（離線環境先在有網路的機器跑）
poly lsp                       # 給編輯器用的 LSP daemon
poly --help                    # 完整說明
poly --version                 # 版本（確認 PATH 上是哪一支）
```

`fmt` 與 `check` 共用五個旗標：`--format` 決定 stdout 的形狀（見下），`--compact`
每個問題只印一行，`--no-ignore` 連 git 忽略的檔案也處理，`--hidden` 連點開頭的
檔案／目錄也處理，`--strict` 讓「工具找不到」變成錯誤而不是跳過該檔。`--check`
只有 `fmt` 認得——`check` 本來就不寫檔，給它 `--check` 會直接報錯而不是靜默忽略。

`--strict` 值得特別說：預設情況下 gofumpt 或 swift-format 沒裝，poly 會在 stderr
說一聲然後跳過那些檔案，exit code 不受影響。這對「不是每台機器都裝了每套
toolchain」是對的預設，但 CI 需要的是相反的答案——`--strict` 就是那個開關。

### 什麼算失敗：`--fail-on`

poly 預設對**任何**問題都 exit 1，連 `info` 等級的錯字也算。要放寬就設嚴重度門檻：

```sh
poly check --fail-on warning .   # info／hint 照樣回報，但不擋
poly check --fail-on error .     # 只有語法錯誤等級才擋
poly check --fail-on never .     # 純報告，永遠 exit 0
```

`--fail-on=warning` 與 `--fail-on warning` 都認得。低於門檻的問題**還是會印出來**，
summary 會加註 `(N below fail-on)`，所以綠色的 run 有輸出不會被誤讀成 bug。

寫進 `poly.toml` 才能讓編輯器與 CI 同一套標準，而且兩邊可以不同——「沒格式化要擋，
錯字不用」是很常見的政策：

```toml
[format]
fail-on = "warning" # 未格式化是 warning，所以 "error" 等於讓格式化只是建議

[lint]
fail-on = "error" # typos 報 info、多數 linter 報 warning、語法錯誤報 error
```

旗標壓過設定檔。這**不是** Rust 的 `-D warnings`——那個旗標存在是因為 Rust 的
warning 預設不會 fail，poly 是相反的問題。

Exit code：`0` 乾淨、`1` 有差異或違規、`2` 執行錯誤。`--help` 與 `--version` 放在
哪個位置都認得（`poly fmt --help` 跟 `poly --help` 一樣）；`--help` 走 stdout、
exit 0，指令打錯則是同一份說明走 stderr、exit 2。

說明文字有英文與正體中文兩版，看系統 locale（`LC_ALL`／`LC_MESSAGES`／`LANG`），
`POLY_LANG=en` 或 `POLY_LANG=zh-TW` 可強制指定——CI 要讓 log 語言固定時用它。只有
說明文字翻譯：診斷紀錄的格式是給 script 解析的契約，而且訊息有一半來自只講英文的
上游工具，翻譯嚴重度只會弄壞所有消費端。

### 輸出格式

不管問題是哪個 linter 或 formatter 找到的，`fmt` 與 `check` 都印同一種紀錄，走
stdout：

```text
src/app.py:1:8: warning [ruff/F401] `os` imported but unused
    fix   Remove unused import: `os`
    docs  https://docs.astral.sh/ruff/rules/unused-import
deploy.sh:4:8: info [shellcheck/SC2086] Double quote to prevent globbing and word splitting.
    fix   shellcheck can rewrite this automatically
    docs  https://www.shellcheck.net/wiki/SC2086
schema.sql:1:1: warning [poly/unformatted] file is not formatted
    fix   run `poly fmt`
```

第一行是完整紀錄：`路徑:行:欄: 嚴重度 [工具/規則] 說明`，永遠只有一行且前綴固定，
所以 `rg`、CI annotation script、終端機的檔案連結都吃得下。後面縮排的 `fix`／`docs`
只在該工具真的有給時才出現——多數 linter 只說哪裡錯、把怎麼修留給文件，poly 不替它
們編造。`--compact` 會把縮排行全部拿掉。

編輯器裡是同一份資訊：`fix` 併進 Problems 的訊息（LSP 沒有對應欄位），`docs` 變成
規則代碼上的超連結，用字與 CLI 完全相同。

錯誤（parse 失敗、工具缺席、引擎不接受的設定）也是同一種紀錄，嚴重度 `error`、規則
`poly/format`，位置指在 parser 停下來的地方；引擎畫的 code frame 縮排接在後面，一個
問題仍然只佔一行有錨點的輸出。

### 換個形狀：`--format`

`--format` 只改 stdout 的形狀，**不改判定結果**——exit code 與 stderr 的 summary
在四種形狀下完全一樣。

| 值               | 用途                                   |
| ---------------- | -------------------------------------- |
| `text`           | 上面那種紀錄，預設                     |
| `json`           | 單一份文件，欄位齊全，不必再從文字解析 |
| `table`          | 對齊的欄位，掃過去用                   |
| `table_markdown` | 貼進 PR 留言或 `$GITHUB_STEP_SUMMARY`  |

```sh
poly check --format table .
```

```text
FILE         SEVERITY  RULE               MESSAGE
lint.py:1:8  warning   ruff/F401          `os` imported but unused
run.sh:2:6   info      shellcheck/SC2086  Double quote to prevent globbing and word splitting.
```

`json` 是給 pipeline 的。位置是 1-based（跟紀錄一致），`message` 完整保留（含引擎畫的
code frame），`fix` 是跟終端機、編輯器一字不差的同一句話，`fatal` 直接告訴你這一筆在
當前 `--fail-on` 下算不算擋——消費端不用重寫嚴重度排序：

```jsonc
{
  "version": 1,
  "command": "check",
  "issues": [
    {
      "file": "lint.py",
      "line": 1,
      "col": 8,
      "end_line": 1,
      "end_col": 10,
      "severity": "warning",
      "tool": "ruff",
      "rule": "F401",
      "message": "`os` imported but unused",
      "fix": "Remove unused import: `os`",
      "docs": "https://docs.astral.sh/ruff/rules/unused-import",
      "fatal": true
    }
  ],
  "summary": { "issues": 1, "fatal": 1, "tools_ran": 6, "tools_missing": [], "tools_failed": [] }
}
```

`version` 只在欄位改變意義或消失時才加，新增欄位不動它。stdout 只有這份文件，
`poly check --format json . | jq` 不會被 stderr 的 summary 弄髒。

兩種 table 只有四欄，不含 `fix`／`docs`——一列必須是一行，而一整欄的 URL 比其他三欄
加起來還寬。`table_markdown` 把 docs 連結掛在規則名上，不多佔寬度。要完整資訊用
`text` 或 `json`。`--compact` 只對 `text` 有意義，配其他形狀會直接報錯。

放進 GitHub Actions：

```yaml
- run: poly check --format table_markdown . >> "$GITHUB_STEP_SUMMARY"
```

poly 自己的 CI 就是這樣做的：`--format json` 餵給 [`tools/ci-annotate.py`](tools/ci-annotate.py)
產生逐行的 annotation，`--format table_markdown` 直接進 job summary。兩者都是公開可見的，
不像 job log 需要 token。

## 設定

`poly.toml` 是選用的。完全沒有設定檔時，語言用內建副檔名表判斷，格式化用各引擎
預設值，走訪檔案時尊重 git 會尊重的忽略檔——`.gitignore`、`.ignore`、
`.git/info/exclude`，以及 `core.excludesFile`（沒設就是
`$XDG_CONFIG_HOME/git/ignore`），沿路每一層祖先目錄的都算。跟 git 一樣，全域忽略
檔只在 git repo 裡生效。點開頭的檔案與目錄預設跳過，`.github/` 例外（workflow 是原
始碼，actionlint 就是為它接的）。

`--no-ignore` 關掉前一段的忽略檔，`--hidden` 讓走訪進入點開頭的路徑；`.git/` 兩者
都進不去，物件庫不是原始碼。用在要檢查的正好是被藏起來的東西：generated code、
vendored tree、`.config/` 底下的專案腳本。

專案的原始碼本來就住在點開頭目錄時，改用設定檔而不是旗標，這樣編輯器與 CI 看到的
檔案集合才一致：

```toml
[walk]
include-hidden = true
```

兩者都只能把範圍放寬、不能收窄；要收窄請用 `exclude`。`poly.toml` 的 `exclude` 不受
`--no-ignore`／`--hidden` 影響——那是專案自己說「別碰」，跟 VCS 說「別追蹤」是兩件
事。

要覆蓋預設值時，專案層的真相放 repo 根目錄的 `poly.toml`，CLI 與 extension 都讀
它，保證編輯器與 CI 行為一致：

```toml
[languages.map] # 副檔名 ↔ 語言
"*.tpl" = "jinja"

[format]
exclude = ["vendor/**", "**/*.generated.ts"]

[format.python] # 每語言可調的三個選項
line-width = 100
indent-width = 4
use-tabs = false

[lint]
exclude = ["third_party/**"]

[lint.per-file-ignores] # 只關掉某條規則，檔案照樣 lint
"tests/fixtures/**" = ["ruff/F401"]
"vendor/*.sh" = ["shellcheck/*"] # tool/* 是整支工具

[walk]
include-hidden = false # 預設；true 會連點開頭的路徑一起走（.git/ 仍然跳過）

[tools] # 指定路徑、釘版本，或設 "off" 關掉
shellcheck = "C:/tools/shellcheck.exe"
tflint = "off"
```

`[lint.per-file-ignores]` 的規則代碼就是輸出裡印的那個——看到
`[ruff/F401]` 就複製 `ruff/F401`，沒有第二套語法要查。它與 `exclude` 的差別是範圍：
exclude 讓整個檔案不進 lint，per-file-ignores 只拿掉那一條，同一個檔的其他問題照
報。少了工具名的 `"F401"` 會讓 poly.toml 解析失敗，而不是安靜地什麼都沒關掉。編輯
器與 CI 讀同一份設定，所以關掉的規則在 Problems 裡也不會出現。

語言伺服器只認 VSCode settings 的 `poly.languageServers`，不進 `poly.toml`——那是
「這台機器上我要不要讓 poly 接管 Go」的個人偏好，CI 根本不跑 `poly lsp`，寫進專案設定
只會讓兩邊看到一個對方不在乎的鍵（A4）。server 一律從 PATH 找，poly 永遠不代裝：它必須
跟蓋出這個專案的 toolchain 對得上，poly 選版本就是 poly 選錯版本。找不到會在
`Poly` 輸出頻道說一聲，不會靜默沒作用。

`[format.<lang>]` 只認 `line-width`（1–1000）／`indent-width`（1–16）／`use-tabs`
三個鍵，拼錯或超出範圍都會直接讓解析失敗而不是靜默忽略；只作用於內嵌引擎，走外部
工具的語言請用該工具自己的設定檔。VSCode settings 只放個人偏好
（`poly.serverPath`、`poly.lintOnSave`、`poly.updateCheck.*`）。

完整的鍵、可填的值、每個引擎的預設值都寫在
[poly.example.toml](poly.example.toml) 裡——那份檔案有測試綁著，不會跟程式碼走散。

## 從原始碼建置

```sh
cargo build --release --manifest-path cli/Cargo.toml   # → cli/target/release/poly
(cd extensions/lsp && pnpm install && pnpm run build) # extension bundle
(cd extensions/lsp && pnpm test)                      # 真 extension host E2E
pip install pyyaml && python tools/grammar-sync.py     # 重新同步文法
python tools/tool-sync.py --check                      # 驗證外部工具 pin（離線）
python tools/tool-sync.py --update                     # 跟上游對一次版本（需網路）
```

`.vscode/settings.json` 已把 `poly.serverPath` 指向 `cli/target/release/poly`，
所以在本 repo 裡按 F5 就會用剛建好的 binary。

## 授權

poly 自身的程式碼為 MIT，全文見 [LICENSE](LICENSE)（一併附在每個 release、兩個
VSIX 與 container image 裡）。內嵌文法與相依套件各自保留上游授權，完整清單見兩份
`THIRD-PARTY-NOTICES.md`（由同步管線自動產生，含 pinned 版本）。授權允許清單由
`tools/grammar-sync.py` 與 `tools/third-party-notices.py` 在 CI 強制執行：
permissive 授權加 MPL-2.0，GPL／AGPL／SSPL 與無 permissive 選項的 LGPL 一律擋下。
