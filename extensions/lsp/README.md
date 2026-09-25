# Poly

存檔即時 lint／format，背後是 `poly lsp` daemon；加上沒有 CI 對應物的編輯器便利功能。編輯器與
CI 跑的是同一個 binary、同一份設定，所以本機存檔跟 pipeline 的結果一定一致。

編輯器便利功能不需要 daemon，binary 沒起來它們照樣能用。那些功能**預設全關**，一項一項在設定裡
打開——裝了不會讓你的編輯器多出任何你沒要的東西。

## 格式化與 lint

- **Format**：Format Document／`editor.formatOnSave`，加上批次命令 Format
  File／Folder／Workspace／Git Repo／Git Changed Files。**Format Selection** 只交回落在選取
  範圍內的變更。專案有 `.editorconfig` 就直接沿用縮排、行寬、行尾空白與檔尾換行，包括
  poly 不格式化的檔案（`.ini`、Makefile……）。
- **`Poly: Format Document`**（`shift+alt+f`，Linux `ctrl+shift+i`）：格式化目前的檔案，
  **任何開關都擋不住**——Format 開關與 `poly.format.enabled` 都不算數。formatter 跟內建
  Format Document 挑的是同一個（這個語言的預設 formatter）。這組按鍵本來就是 Format Document
  的，poly 接手只為了讓開關擋不到它。
- **Lint**：存檔即時 diagnostics 進 Problems panel；`Poly: Lint (poly check)` 在終端跑完整
  CLI。內嵌 ruff、selene、sqruff，其餘（shellcheck、actionlint、hadolint……）受管下載並以
  sha256 驗證；專案自己的 biome／eslint 優先。
  - **三個工具讀不了單一 buffer**，所以跑的是整個範圍：golangci-lint 一個 Go module、
    cargo clippy 一個 workspace、tflint 一個目錄。它們比單檔 linter 慢，答案是存檔後幾秒才到。
- **`Poly: Analyze Dead Code`**：Go／TypeScript／JavaScript／Python 的整體可達性分析，
  工具各自來自該語言的 toolchain（deadcode／knip／vulture），poly 不代裝。範圍是專案不是檔案。
- **`Poly: Minify`**：把當前 buffer 壓成一行，涵蓋 JSON／JSONC、CSS、HTML、XML、
  JavaScript／TypeScript。只移除空白與註解，不改名、不折常數、不刪分支。唯一例外是 CSS：
  壓縮印表機同時會把值寫成最短等價形式（`blue` → `#00f`）。YAML／TOML 不處理（換行有意義）。
  刻意不進 format-on-save——它是格式化的反向。
- **狀態列的 Format／Lint 兩個總開關**：關掉的不只 poly，是整個編輯器。
  - **Format**（`Poly: Toggle Formatting`）：存檔／打字／貼上時格式化、存檔時的 code action
    （organizeImports 之類）、行尾空白與結尾換行、poly 自己的所有改寫，**包括其他 extension
    自帶的各語言預設**——golang.go 的 `[go]` 存檔格式化、Pylance 的 `[python]` 打字格式化，
    只改全域設定的開關擋不到這些。
  - **Lint**（`Poly: Toggle Linting`）：poly 的 lint 與 Unicode 高亮，加上已安裝的 ruff、Go 存檔時的
    lint／vet、rust-analyzer 存檔時的 check、Code Spell Checker、autocorrect、ESLint、
    ShellCheck、Stylelint、Pylint、Flake8。編譯與型別錯誤不是 lint，照常顯示。
  - 再按一次，每一項**還原成原本的樣子**；關著的時候你自己改過的設定不會被蓋掉。只寫使用者
    設定，不動專案的 `.vscode/settings.json`——那裡若還開著什麼，開關的提示會列出來。
  - 從命令面板跑內建的 Format Document 時，其他 extension 的 formatter 照樣有效（那是你要求
    的）；poly 自己的要用上面的 `Poly: Format Document`。markdownlint 與 gremlins 沒有關閉的
    設定，關不到。
- **規則說明**：SQL 的波浪線上 hover 會顯示 sqruff 該條規則的全文（編在 binary 裡，離線可讀）；
  其他工具走規則代碼上的超連結。
- **Protobuf**（`.proto`）由 buf 處理，格式化免設定。**lint 只在有 `buf.yaml` 的 module 裡跑**，
  否則會大聲跳過。
- **Jupyter notebook**（`.ipynb`）由內嵌的 ruff 整份處理，outputs 與 markdown cell 原樣保留。
  VSCode 的 notebook editor 不走 LSP 文字文件，所以要用批次命令或 `poly fmt`。
- 背景檢查 GitHub Releases，一鍵更新。

## 語言功能（預設關閉）

`poly.languageServers` 打開後，poly 把 hover、definition、references、outline、completion、
rename、code action、inlay hint、call/type hierarchy、semantic tokens 等路由給**專案自己
toolchain 裡的** language server：gopls、rust-analyzer、clangd、sourcekit-lsp、terraform-ls、
lua-language-server、bash-language-server，以及 poly 代抓的 buf 與 arity。

poly 不實作任何一行語意分析，只做路由，所以品質就是那支 server 的品質。server 一律從 PATH
找，找不到就說一聲。改完要重新載入視窗。

**已經有官方 extension 的語言，poly 讓開**：裝了 Go（golang.go）、rust-analyzer、clangd 或
C/C++、Swift、HashiCorp Terraform、Lua（sumneko）、Bash IDE、Buf 的那幾個語言，poly 不啟動
自己那支 server，同一個語言不會有兩支在跑、兩份 hover。裝上或移除那個 extension 時 poly
自己重新分配，不用重新載入視窗。

存檔時會跑的 `source.*` code action 不轉（會跟 poly 的格式化搶同一段程式碼），燈泡裡的照常。

## 編輯器便利功能

### markdown

- **Enter 接續清單**：接出同一層的下一項，**有序清單號碼遞增**，任務項接出 `- [ ]`，
  **空的項目按 Enter 結束清單**（往外退一層）。markdown 家族與 yaml 都有。
- **Tab／Shift+Tab 調整清單層級**：游標在內容起點或更左邊時生效，一層是 `poly fmt` 正規化
  出來的那一欄（`- x` 是 2、`1. x` 是 3），不是 `editor.tabSize`。其餘情況原樣還給編輯器，
  包含 Copilot 的 inline suggestion。
- **`Toggle Bold`／`Toggle Italic`**：產生 `**bold**` 與 `_italic_`，也就是 `poly fmt`
  正規化出來的那兩種，不會被下一次存檔改掉。
- **`Insert Table of Contents`**：在游標處插入目錄，用註釋標記框住，再跑一次就地更新。
  錨點照 VSCode 自己的 slug 規則產生。
- **markdown preview 的 mermaid 圖表**（設定）：VSCode 1.135 起內建就有，屆時 poly 自動讓開。

### 導航與 CodeLens

- **`Copy Path with Line Numbers`**：複製 `路徑:行號`，多行選取是 `路徑:42-51`。就是 `rg`
  印的、CI annotation 連過去的、終端機點得動的那個形狀。
- **引用與實作 CodeLens**（設定）：每個宣告一行 `11 refs`；interface 多一顆 `3 impls`，
  具體型別多一顆 `1 interface`，方法寫在型別外面的語言（Go）再多一顆 `4 methods`。
  數字全部來自該語言已註冊的 provider，poly 只數與畫。
  - `N refs`、`N impls`、`N methods` 點下去都一樣：只有一筆就直接跳過去，多筆開檔案總管裡的
    **References** 面板。那是 poly 自己的樹，
    每一列除了原始碼還帶**行號**與**它落在哪個符號裡**（`method Handle`、`func main`）——
    內建的 `references-view` 兩欄都沒有，而別人的樹加不了欄位。
  - **數字會留到下次**：存在 `$XDG_CACHE_HOME/poly/refs/`（沒設就是 `~/.cache/poly/refs/`），
    一個專案一個小 JSON 檔。重開視窗時先畫上次的數字，同時在背景重新問 language server，
    數字變了就更新，所以專案在視窗關著時改過也會被更正。已刪除的檔案與宣告會順手清掉，
    一個月沒開的專案整個檔案刪除。
- **`run | debug` CodeLens**（設定）：程式進入點上方一行。`run` 存檔後在一個叫 `Poly Run`
  的終端機裡下命令（go → `go run .`、rust → `cargo run`、python → `python3 檔名`、
  shell → shebang 指定的直譯器），不經過 debugger；要先編譯的 C／C++／Java／C# 只畫
  `debug`。poly 沒有 debugger，`debug` 交給你已經裝的 debug extension。
- **protobuf → 生成的 Go**（設定）：`.proto` 的 `message`／`enum` 上方 `go type`，
  `service` 上方 `go server`／`go client`，`rpc` 上方 `N impls`。點下去跟引用 lens 一樣：
  一筆直接跳、多筆開 **References** 面板，編輯器停在 `.proto` 上。認 protoc-gen-go 與
  protoc-gen-go-grpc 的命名規則；生成檔不在 workspace 裡就不畫。
- **跨檔案 next／previous change**：跳到上／下一個有改動的檔案並落在改動上。內建的只到
  「同一個檔案裡的下一處」。`Revert Selected Changes and Save` 還原游標所在的 hunk 並存檔。

### 編輯

- **Postfix completion**（設定）：`err.if` 展開成 `if err != nil { }`（Go）、`if (err) { }`
  （TS）、`if err:`（Python）。go／rust／swift／ts／js／python／lua／c／cpp 都有。這是文字
  重排不是分析，排在 language server 的答案後面。
- **`Extract Variable`／`Inline Variable`**：每個語言都通用——問的是 LSP 標準的
  `refactor.extract`／`refactor.inline` kind，做事的是該語言的 server。內建的
  `editor.action.refactor` 開的是選單，而選單裡那一項每個 server 講法都不同，快捷鍵綁不到。
- **`Move to New File`／`Change Signature`／`Implement Interface`**：同一個形狀再三個，
  從命令面板叫。Change Signature 游標要在參數上；Implement Interface 要先有一個編不過的
  斷言（Go 是 `var _ Shape = Triangle{}`）。

### 檢視

- **縮排上色**（設定）：每層縮排的空白塗底色，四色循環，**填不滿一層的空白另外標色**。
  內建的 indent guides 回答「block 從哪開始」，上色回答「我在第幾層」。
- **Gutter 圖片預覽**（設定）：某行提到的圖檔存在就在 gutter 放縮圖。
- **Unicode 高亮**（設定）：gremlins 的替代。不可見字元、雙向控制字元、不是 U+0020 的空白、
  en dash 與彎引號這類冒充 ASCII 的字元，**所有檔案都標、邊打邊標**：gutter 記號、捲軸刻度、
  字元本身加底色（沒有寬度的加框），行尾寫出字元名稱（同一行重複的只寫一次），hover 說明
  為什麼標它。等級照 gremlins（error／warning／info），顏色是 `poly.unicodeError`／
  `poly.unicodeWarning`／`poly.unicodeInfo` 三個佈景主題色，在 `workbench.colorCustomizations`
  改。em dash 不標。
  - Problems 裡的同一批字元是 lint 規則 `poly/unicode-*`，存檔時才跑；`poly: ignore` 與
    `poly.toml` 管那邊，管不到高亮。
- **TODOs 檢視**（設定）：檔案總管多一個面板，列出整個 workspace 的 `TODO`／`FIXME`／
  `HACK`／`XXX`／`BUG`。只在面板顯示時才掃描，排除規則沿用 `files.exclude`／`search.exclude`。
- **`Syntax Colors for This Language`**：列出目前這個檔的文法能產生的全部 TextMate scope，
  做成一份可以直接複製的 `editor.tokenColorCustomizations.textMateRules`。顏色欄位是
  `#RRGGBB` 佔位字串，所以整份貼上去不會改變任何顏色。

## 快捷鍵

| 命令                               | mac               | Windows／Linux                      | 何時生效            |
| ---------------------------------- | ----------------- | ----------------------------------- | ------------------- |
| `Poly: Format Document`            | `shift+alt+f`     | `shift+alt+f`／Linux `ctrl+shift+i` | 有 formatter 的檔案 |
| `Poly: Minify`                     | `cmd+alt+m`       | `ctrl+alt+m`                        | 能 minify 的語言    |
| `Toggle Bold`                      | `cmd+b`           | `ctrl+b`                            | markdown 家族       |
| `Toggle Italic`                    | `cmd+i`           | `ctrl+i`                            | markdown 家族       |
| `Continue List`                    | `enter`           | `enter`                             | markdown 家族、yaml |
| `Indent List Item`                 | `tab`             | `tab`                               | markdown 家族       |
| `Outdent List Item`                | `shift+tab`       | `shift+tab`                         | markdown 家族       |
| `Extract Variable`                 | `cmd+alt+v`       | `ctrl+alt+v`                        | 編輯器有焦點        |
| `Inline Variable`                  | `cmd+alt+shift+v` | `ctrl+alt+shift+v`                  | 編輯器有焦點        |
| `Go to Next Changed File`          | `cmd+alt+z`       | `ctrl+alt+z`                        | 有 git              |
| `Go to Previous Changed File`      | `cmd+alt+a`       | `ctrl+alt+a`                        | 有 git              |
| `Revert Selected Changes and Save` | `alt+q`           | `alt+q`                             | 有 git、檔案        |

其餘命令沒有預設快捷鍵，從命令面板叫，或自己在 `keybindings.json` 綁：
`poly.formatFile`／`formatPath`／`formatWorkspace`／`formatGitRepo`／`formatGitChanged`、
`poly.lintPath`、`poly.analyzeDeadCode`、`poly.toggleFormat`、`poly.toggleLint`、`poly.createGoWork`、
`poly.checkForUpdates`、`poly.showOutput`、`poly.copyPathWithLine`、`poly.insertTableOfContents`、
`poly.runFile`、`poly.moveToNewFile`、`poly.changeSignature`、`poly.implementInterface`、
`poly.syntaxColors`、`poly.refreshTodos`。

## 設定

| 設定                              | 預設     | 作用                                                                          |
| --------------------------------- | -------- | ----------------------------------------------------------------------------- |
| `poly.serverPath`                 | `""`     | 改用指定路徑的 poly binary，空字串是用內附的那支                              |
| `poly.lintOnSave`                 | `true`   | 開檔與存檔時跑 lint，改了立即生效；Lint 開關也寫這一項                        |
| `poly.format.enabled`             | `true`   | 關掉後 poly 的改寫都不動作（`Poly: Format Document` 除外）；Format 開關也寫它 |
| `poly.deadCodeCodeLens.enabled`   | `false`  | 每個 Go／TS／JS／Python 檔第一行上方一條 `analyze dead code`                  |
| `poly.languageServers`            | `false`  | 把語言功能路由給下游 server（見上），改完要重新載入視窗                       |
| `poly.languageServerLogs`         | `true`   | 下游 server 的 stderr 轉進 Poly 輸出面板                                      |
| `poly.memoryLog`                  | `false`  | 每開關一個檔寫一行 daemon 握著什麼（RSS、文件數、各快取）                     |
| `poly.updateCheck.enabled`        | `true`   | 背景檢查新版                                                                  |
| `poly.updateCheck.intervalDays`   | `7`      | 檢查間隔，`0` 是每次啟動都查                                                  |
| `poly.indentTint.enabled`         | `false`  | 縮排上色                                                                      |
| `poly.imagePreview.enabled`       | `false`  | gutter 圖片縮圖                                                               |
| `poly.unicodeHighlight.enabled`   | `false`  | 不可見與冒充 ASCII 的字元（gremlins 的替代）                                  |
| `poly.referencesCodeLens.enabled` | `false`  | `N refs`／`N impls`／`N methods`                                              |
| `poly.protobufCodeLens.enabled`   | `false`  | `.proto` → 生成的 Go                                                          |
| `poly.runCodeLens.enabled`        | `false`  | `run \| debug`                                                                |
| `poly.markdownMermaid.enabled`    | `false`  | preview 裡畫 mermaid                                                          |
| `poly.postfixCompletion.enabled`  | `false`  | `.if`／`.for` 之類的展開                                                      |
| `poly.todo.enabled`               | `false`  | 檔案總管的 TODOs 面板                                                         |
| `poly.todo.tags`                  | 五個標籤 | TODOs 面板找哪些字                                                            |

markdown 的 Enter／Tab／粗體斜體與 `Copy Path with Line Numbers`、重構命令沒有開關：它們
只在你按下去時才做事。每一項的完整說明在 VSCode 的設定頁（英文與正體中文都有）。專案層的
格式化與工具設定寫在 `poly.toml`，不在這裡——見專案根目錄的 README。

## Log

兩個輸出面板：**Poly** 是 daemon 的（啟動、每次 lint／format、下游 server 的 stderr），
**Poly Editor** 是編輯器功能的（lens 為什麼沒畫之類，細節在 debug 層級，用 `Developer: Set Log
Level` 打開）。兩者都會寫到磁碟上，回報問題時附 `Developer: Open Extension Logs Folder` 打開的
那個資料夾就夠了。

## 設計理由

搬到 `dev_docs/vscode-syntax`。這裡只寫結論。
