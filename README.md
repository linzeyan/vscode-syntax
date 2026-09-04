# Poly

用「三個 VSCode extension ＋ 一個 CLI」取代為了各語言 highlight／lint／format 而
安裝的一大堆零散 extension。編輯器與 CI 共用同一個 binary、同一份設定，所以本機存
檔跟 pipeline 的結果一定一致。

| 產出物                  | 職責                                                         |
| ----------------------- | ------------------------------------------------------------ |
| `poly-syntax-highlight` | 多語言 syntax highlighting，**接管全部 VSCode 內建語言文法** |
| `poly-lsp`              | 存檔即時 lint／format，批次命令；背後是 `poly lsp` daemon    |
| `poly-editor`           | 編輯器端便利功能，沒有 CI 對應物的那些；不需要 poly binary   |
| `poly`                  | 單一 binary CLI，供 CI、pre-commit、終端批次使用             |

三個 extension 同版號一起發版，但彼此不相依：poly-lsp 可以單獨裝，poly-editor 連
poly binary 都不需要。分開是因為失敗模式不同——poly-lsp 的 daemon 沒起來就整個失效，
而它的 VSIX 是分平台六份，純 TypeScript 的功能沒有理由跟著被打包六次，也沒有理由讓
只想要 lint／format 的人一起收下。

## 功能

### poly-syntax-highlight — highlighting

- **151 個文法**：接管 49 個 VSCode 內建語言，另加 44 個內建沒有的語言
  （HCL／Terraform、nginx、zig、dotenv、protobuf、mermaid、caddyfile、systemd
  unit、jsonnet、just、nix、cabal、dune、ssh_config、CSV/TSV rainbow…）。
- 來源共 93 條、27 個 pinned 上游 repo；只有 CSV／TSV／ssh_config 三個是自產的
  （上游要嘛不存在，要嘛沒有授權檔）。
- 輸出標準 TextMate scope，**任何現有 color theme 直接生效**，不自帶配色。
- 部分語言改採比內建更好的社群文法（如 rust 用 dustypomerleau/rust-syntax）。
- 文法一律以 pinned commit 從上游 repo／marketplace VSIX 同步，不手改。
- **零執行期程式碼**，不佔 extension host 資源。

### poly-lsp — 編輯器整合

- **Format**：Format Document／`editor.formatOnSave`，加上批次命令 Format
  File／Folder／Workspace／Git Repo／Git Changed Files。專案有 `.editorconfig`
  的話直接沿用，縮排與行寬不必再抄一份到 `poly.toml`。
- **Format Selection**：只格式化選取的範圍，其餘的行原封不動。
- **Lint**：存檔即時 diagnostics 進 Problems panel；`Poly: Lint (poly check)`
  在終端跑完整 CLI。
- **`Poly: Minify JSON`**：把當前 JSON／JSONC buffer 壓成一行。刻意**不**進
  format-on-save——它是格式化的反向操作，`poly fmt` 下一次就會把它還原。改動以編輯器
  edit 送出而非寫檔，所以 undo 是一個按鍵，未存檔的 buffer 也能用。
- **規則說明**：滑鼠移到 SQL 的波浪線上會顯示 sqruff 該條規則的 anti-pattern／
  best-practice 全文。sqruff 沒有文件站可連，那份說明編在 binary 裡，版本精確、
  離線可讀。其他工具有自己的規則頁，走規則代碼上的超連結。
- **語言伺服器（預設關閉）**：`poly.languageServers` 打開後，poly 會啟動專案自己
  toolchain 裡的 language server，把 hover、go-to-definition、declaration、type
  definition、implementation、references、outline、completion、signature help、
  symbol highlight、folding、expand selection、rename、code action 路由給它。目前七個：
  gopls（Go）、rust-analyzer（Rust）、clangd（C／C++）、sourcekit-lsp（Swift）、terraform-ls
  （Terraform）、lua-language-server（Lua）、buf（Protobuf）。poly **不實作**這些功能，
  server 一律從 PATH 找，找不到就說一聲——所以品質就是那支 server 的品質。
  **buf 是唯一的例外**，poly 會代抓：其他 server 都得配合建置專案的 toolchain（gopls 讀
  go.mod 的 Go 版本、rust-analyzer 要編譯該 crate 的 rustc），而 `.proto` 背後沒有建置，
  buf 也早就是 poly 釘死版本代抓的 protobuf formatter／linter，所以 protobuf 不必先裝
  任何東西。實際能用
  哪幾項由 server 自己宣告，十四項裡：clangd 與 rust-analyzer 給滿 14、gopls 13、
  sourcekit-lsp 12、lua-language-server 12、buf 10、terraform-ls 只有 7。有一個例外值得知道：
  Swift 的 Go to Declaration 會失敗，Go to Definition 正常。**code action 只給燈泡那
  些**：`editor.codeActionsOnSave` 跑的 `source.*` 一律不轉，否則會跟 poly 的格式化在
  同一次存檔搶同一段程式碼；代價是 gopls 的「Source Action…」選單在 poly 下是空的。
  **poly 自己的 lint 不會因此消失**：server 的診斷是跟 poly 的合併，不是取代，所以
  lua 的 selene 與 swift 的 swiftlint 照常回報。預設關閉是因為它會跟你八成已經裝了
  的官方 extension 重疊，要用請先移除那個 extension。改完要重新載入視窗。
- **`poly.languageServerLogs`（預設開啟）**：把 language server 自己的 stderr 轉進
  Poly 輸出面板。clangd 與 terraform-ls 每個請求寫一行，嫌吵就關掉——關掉是整份丟棄，
  不是去叫各家 server 安靜（有些根本沒這種旗標）。poly 自己的訊息（server 不在 PATH、
  啟動就掛）不受影響。
- **專案內工具優先**：偵測到專案的 biome／prettier／eslint／rustfmt 就用它們，
  避免和團隊 CI 結果不一致。
- 背景檢查 GitHub Releases（預設 7 天一次，可調可關），一鍵更新裝了的那幾個
  extension——沒裝的不會被順手裝上，那不是更新。

### poly-editor — 編輯器便利功能

沒有 CI 對應物的那些功能住在這裡，跟 poly binary 完全無關，所以裝不裝、要不要更新
都可以單獨決定。

- **`Poly: Copy Path with Line Numbers`**：複製 `路徑:行號`；選取多行時是
  `路徑:42-51`。VSCode 內建的 Copy Relative Path 只到路徑為止，`:42` 是唯一的差別，
  但那一截才是重點——`src/lib.rs:42` 正是 `rg` 印的、CI annotation 連過去的、終端機
  能點的，也是 poly 自己診斷輸出的形狀。預設沒綁快捷鍵，命令面板與編輯器右鍵都有。
- **`Poly: Insert Table of Contents`**：在游標處插入 markdown 目錄，用註釋標記框住，
  再跑一次就地更新。錨點照 VSCode 自己的 slug 規則產生，所以連結一定跳得到；front
  matter 與 code block 裡的 `#` 不會被誤認成標題。
- **`Poly: Toggle Bold` ／ `Toggle Italic`**：`cmd/ctrl+b`、`cmd/ctrl+i`，只在
  markdown 檔生效。產生 `**bold**` 與 `_italic_`——就是 `poly fmt` 正規化出來的那兩種，
  不會被下一次存檔改掉。
- **`Poly: Extract Variable` ／ `Inline Variable`**：`cmd/ctrl+alt+v`、
  `cmd/ctrl+alt+shift+v`，每個語言都通用。內建的 `editor.action.refactor` 開的是一張選單，
  而你要的那一項每個 server 講法都不同（`Extract variable`／`Extract into variable`／
  `Extract subexpression to variable`／`Extract to constant in enclosing scope`），快捷鍵
  綁不到任何一個。poly 問的是 LSP 標準的 `refactor.extract`／`refactor.inline` kind，
  過濾掉 `Extract function` 那種不是變數的，剛好一項就直接套用。做事的是語言自己的 server。
- **跨檔案 next／previous change ＋ `Poly: Revert Selected Changes and Save`**：
  `cmd/ctrl+alt+z`／`cmd/ctrl+alt+a` 跳到上／下一個有改動的檔案並落在改動上，`alt+q`
  還原游標所在的 hunk 並存檔。VSCode 內建的是「同一個檔案裡的下一處改動」，跨檔案那
  一步沒有——而那是 review 一個 branch 時按最多次的一步。順序照路徑排，所以同一顆
  按鍵按兩次一定走同一條路。
- **縮排上色**：每層縮排的空白塗底色，四色循環；**填不滿一層的空白另外標色**，那正是
  「縮排改到一半」的樣子。內建的 indent guides 畫線回答「block 從哪開始」，上色回答的
  是「我在第幾層」。只畫可見範圍，顏色走 theme color。
- **Gutter 圖片預覽**：某行提到的圖檔存在就在 gutter 放縮圖。不寫語法解析器——
  markdown／HTML／CSS 各有寫法，而檔案存不存在才是真正的過濾器。
- **TODOs 檢視**：檔案總管多一個面板，列出整個 workspace 的 `TODO`／`FIXME`／`HACK`／
  `XXX`／`BUG`。只在面板顯示時才掃描，排除規則沿用 `files.exclude`／`search.exclude`，
  而且掃描上限會寫在標題上——「清單很短」跟「清單被截斷」不該長得一樣。

### poly — CLI

- **內嵌引擎**（免安裝、離線可用）：TypeScript／JavaScript、JSON／JSONC、
  Markdown、TOML、YAML、CSS／SCSS／LESS、HTML／Vue／Svelte／Astro／Jinja、
  Python、SQL、XML、GraphQL、Dockerfile。
- **外部工具**（受管下載）：shellcheck、shfmt、hadolint、actionlint、typos、
  ruff、tflint、gofumpt、golangci-lint、stylua、selene、swiftlint、buf
  （Protobuf 的格式化與 lint，同一支 binary 也是上面那個 language server）。版本釘死，
  每個平台的 sha256 都預先寫進 `poly-tools.lock`——下載對不上就直接失敗，而不是
  信任第一次抓到的東西。
- **只用專案 toolchain、不代裝**：rustfmt、clang-format、swift-format、
  terraform fmt。
- **Protobuf 的 lint 需要 buf module**：`.proto` 上方沒有 `buf.yaml` 就大聲跳過。
  沒有 module 時 buf 會拿當前工作目錄當根目錄，`PACKAGE_DIRECTORY_MATCH` 會對正常的
  package 亂噴，而且結果隨你從哪執行而變——會漂移的檢查比沒有檢查更糟（R5／A4）。
  格式化不受影響，`.proto` 一律格式化。
- **`poly minify [路徑...]`**：把 JSON／JSONC 就地壓成一行，移除空白與註解。走跟
  `poly fmt` 同一套 walk 與 `[format] exclude`，所以 CLI 與編輯器命令答案一致。
  獨立命令而不是 `poly fmt` 的旗標——兩者契約相反，`fmt` 是「符合專案風格」，而沒有
  人的風格是一行 40KB。不支援 `--strict`／`--format`／`--fail-on`（沒有 findings 可
  塑形，也沒有外部工具會缺席），拼對了卻無效的旗標一律拒絕。
- 工具解析順序：`poly.toml` 指定 → 專案內工具 → 內嵌引擎 → 受管下載 → PATH。

## 安裝

需要 VSCode 1.85 以上。從
[Releases](https://github.com/linzeyan/vscode-syntax/releases/latest) 下載：

1. `poly-syntax-highlight-<版本>.vsix` — 通用，不分平台。
2. `poly-lsp-<平台>-<版本>.vsix` — **要挑對平台**，內含對應的 poly binary：
   `darwin-arm64`、`darwin-x64`、`linux-arm64`、`linux-x64`、`win32-arm64`、
   `win32-x64`。
3. `poly-editor-<版本>.vsix` — 通用，**可選**。編輯器便利功能，不含 binary。

安裝方式：VSCode 側邊欄 Extensions → 右上角 `...` → **Install from VSIX...** →
選檔案 → 重新載入視窗。或用命令列：

```sh
code --install-extension poly-syntax-highlight-0.9.0.vsix
code --install-extension poly-lsp-darwin-arm64-0.9.0.vsix
code --install-extension poly-editor-0.9.0.vsix
```

之後的版本由 poly-lsp 自己提示更新，不必再手動抓——它只更新你已經裝了的那幾個。

### 從 0.5.0 以前升上來

兩個 extension 在 0.6.0 改了名字（`poly-lint` → `poly-lsp`、`poly-syntax` →
`poly-syntax-highlight`）。換名字等於換 extension id，所以新版是**另一個**
extension，只能手動裝。

0.5.0 的更新提示還是會跳，但按下 Install 一定失敗，而且訊息會騙你：

> Poly: automatic install failed (Error: release has no asset
> poly-syntax-0.9.0.vsix). The VSIX files were downloaded — install them
> manually via "Extensions: Install from VSIX".

其實一個檔都沒下載（它在第一個找不到的 asset 就放棄了），所以「Show Files」按下
去也沒有東西。這段程式碼凍在已安裝的 0.5.0 裡，改不了。照下面手動做：

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
POLY_VERSION=0.9.0 POLY_INSTALL_DIR=~/bin sh install.sh
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

`@v0` 會跟著最新的 release 走。要釘死版本就寫 `with: { version: "0.9.0" }`——poly
會改寫檔案，所以新版本自己跑進來有可能把綠的分支變紅。

Action 做三件事：抓對應平台的 binary、對 `SHA256SUMS` 驗 sha256、放進 PATH。順便
快取 poly 之後會下載的外部 linter（`with: { cache: false }` 可關）——冷跑一次
`poly check` 在 lint 任何東西之前要先抓幾十 MB 的 shellcheck、ruff。

### 在容器裡用

```sh
docker run --rm -v "$PWD:/work" ghcr.io/linzeyan/poly check --strict .
```

`linux/amd64` 與 `linux/arm64` 都有。tag 有 `latest`、`0.9.0`、`0.9`；pre-release
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
poly deadcode [路徑]           # 從 main 走不到的 Go 函式（見下）
poly lsp                       # 給編輯器用的 LSP daemon
poly --help                    # 完整說明
poly --version                 # 版本（確認 PATH 上是哪一支）
```

`fmt` 與 `check` 共用的旗標裡，這五個值得說明：`--format` 決定 stdout 的形狀（見
下），`--compact` 每個問題只印一行，`--no-ignore` 連 git 忽略的檔案也處理，
`--hidden` 連點開頭的檔案／目錄也處理，`--strict` 讓「工具找不到」變成錯誤而不是
跳過該檔。`--check` 只有 `fmt` 認得——`check` 本來就不寫檔，給它 `--check` 會直接
報錯而不是靜默忽略。

`--strict` 值得特別說：預設情況下 gofumpt 或 swift-format 沒裝，poly 會在 stderr
說一聲然後跳過那些檔案，exit code 不受影響。這對「不是每台機器都裝了每套
toolchain」是對的預設，但 CI 需要的是相反的答案——`--strict` 就是那個開關。

### `poly deadcode`：從 `main` 走不到的 Go 函式

跟 `poly check` 分開，因為它回答的是另一個問題。golangci-lint 的 `unused` 問「這個
package 裡有沒有人提到它」，所以**匯出的函式對它永遠不算 unused**——package 外可能有
人用。`deadcode` 從所有進入點建 call graph，問「有沒有任何執行路徑會跑到它」，那才是
刪掉一段程式碼之前要問的問題。代價是它要花一次 build 的時間，而且對 library 來說每個
匯出的 API 都會是「死的」（呼叫者在別人的 repo 裡）——所以它是你去問的，不是存檔時自
動跑的，也不進 CI gate。

**跨 module 靠 `go.work`**：有 go.work 的話分析從 workspace 根開始，`liba` 裡只被 `appb`
呼叫的函式就是活的；沒有 go.work，`liba` 根本不在 build list 裡。這是 `Poly: Create
go.work for the Open Go Modules` 那個命令的第二個用途。

工具本身跟著 Go toolchain 走，poly 不代裝：

```sh
go install golang.org/x/tools/cmd/deadcode@latest
poly deadcode .            # 目前 module，或它上面那個 go.work 的全部 module
```

編輯器裡是 `Poly: Analyze Dead Code (Go)`，在終端跑同一行。

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

## 設定

### 要自己在 `settings.json` 設的

poly **不寫使用者的 `settings.json`**（A8），所以下面這些必須自己來。少了它們，功能是
接好的，只是畫面上什麼都不會出現：

```jsonc
{
  // 語言功能（definition／references／inlay hints／call hierarchy…）預設是關的。
  "poly.languageServers": true,
  // gopls 出貨時 inlay hint 全關，而且開關是它跟 client 要的（workspace/configuration
  // 的 gopls 區段）。rust-analyzer 與 clangd 預設就開，不必動。
  "gopls": {
    "hints": {
      "assignVariableTypes": true,
      "compositeLiteralFields": true,
      "constantValues": true,
      "parameterNames": true,
      "rangeVariableTypes": true
    }
  },
  // 點 `N refs`／`N impl` CodeLens 時開 peek 還是開 References 面板。預設 "peek"。
  "references.preferredLocation": "view"
}
```

### `poly.toml`

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

「要不要開語言伺服器」只認 VSCode settings 的 `poly.languageServers`，不進
`poly.toml`——那是「這台機器上我要不要讓 poly 接管 Go」的個人偏好，CI 根本不跑
`poly lsp`，寫進專案設定只會讓兩邊看到一個對方不在乎的鍵。server 一律從 PATH 找，poly
永遠不代裝：它必須跟蓋出這個專案的 toolchain 對得上，poly 選版本就是 poly 選錯版本。
找不到會在 `Poly` 輸出頻道說一聲，不會靜默沒作用。

**「用哪一支」則是專案的事，寫在 `[tools]` 裡**，用 poly 啟動它的那個名字
（`gopls`、`rust-analyzer`、`clangd`、`sourcekit-lsp`、`terraform-ls`、
`lua-language-server`、`buf`）：`rust-analyzer = "off"` 只關掉 Rust 的語言功能而不動
其他語言，`rust-analyzer = "/opt/rust-glancer"` 換成別的實作。版本號不是這裡的合法值
——這些跟著專案 toolchain 走，poly 不下載。

`[format.<lang>]` 只認 `line-width`（1–1000）／`indent-width`（1–16）／`use-tabs`
三個鍵，拼錯或超出範圍都會直接讓解析失敗而不是靜默忽略；只作用於內嵌引擎，走外部
工具的語言請用該工具自己的設定檔。VSCode settings 只放個人偏好
（`poly.serverPath`、`poly.lintOnSave`、`poly.updateCheck.*`）。

專案已經有 `.editorconfig` 的話什麼都不用做：內嵌引擎會沿用它的 `indent_style`／
`indent_size`／`max_line_length`，這三個鍵剛好就是上面那三個 knob，不是另一套要維護
的設定表面。`[format.<lang>]` 寫過的鍵逐鍵壓過它，所以 poly.toml 設 `line-width`、
`.editorconfig` 設縮排時兩邊都算數。引擎吃不下的值（例如 XML 沒有 `line-width`）在
這裡是安靜丟掉，而不像寫在 poly.toml 裡會讓解析失敗——`.editorconfig` 是寫給這個 repo
用過的每一個編輯器看的，不是寫給 poly 的，為了它拒絕格式化整個專案只會讓人以為是
poly 壞了。走外部工具的語言不經過這條路，那些工具自己就會讀 `.editorconfig`。

編輯器那半也一併沿用：打字時的 tab 寬度、存檔時的行尾空白與檔尾換行、行尾字元，
連 poly 不格式化的檔案（`.ini`、Makefile……）都算。`charset` 與 `max_line_length`
不處理。

完整的鍵、可填的值、每個引擎的預設值都寫在
[poly.example.toml](poly.example.toml) 裡。

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
