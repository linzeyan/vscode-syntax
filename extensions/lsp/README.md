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
- 背景檢查 GitHub Releases，有新版就自己下載安裝，只問要不要重新載入視窗。

## 語言功能（預設關閉）

`poly.languageServers` 打開後，poly 把 hover、definition、references、outline、completion、
rename、code action、inlay hint、call/type hierarchy、semantic tokens 等路由給**專案自己
toolchain 裡的** language server：gopls、rust-analyzer、clangd、sourcekit-lsp、terraform-ls、
lua-language-server、bash-language-server，以及 poly 代抓的 buf 與 arity。

poly 不實作任何一行語意分析，只做路由，所以品質就是那支 server 的品質。server 一律從 PATH
找，找不到就說一聲；WSL 裡不找 `/mnt/c` 這類 Windows 磁碟上的目錄。改完要重新載入視窗。

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
- **markdown preview 的其他圖表**（設定）：fence 語言為 `nomnoml`、`flowchart`／`flow`、
  `sequence`、`vega`、`vega-lite`、`markmap`、`excalidraw`（scene 的 JSON），同 MarkNote。畫不出來時
  原始碼留著，錯誤訊息寫在下面。`plantuml`／`puml`／`uml` 見下面的 PlantUML，`drawio` 見 draw.io。
- **GitHub 樣式的 preview**（設定）：Markdown Preview Github Styling 的樣式與三個設定，
  那個 extension 還裝著時 poly 讓開。

### DBML

- **`DBML to SQL`／`SQL to DBML`**：DBML 轉成 PostgreSQL／MySQL／SQL Server／Oracle 的
  SQL，或從 PostgreSQL／MySQL／SQL Server／Snowflake／Oracle 的 SQL 反推 DBML。轉的是
  編輯器裡的內容，未存檔的修改也算；語法錯誤會指出行與欄。

### 簡繁轉換

- **`簡體轉繁體`／`繁體轉簡體`**，以及各一個「含台灣用詞」的版本：有選取轉選取（每一段），沒有
  就轉整份，一次 undo 復原。OpenCC 的詞組字典；含台灣用詞的那一對會換用語（软件 ↔ 軟體），
  另一對只換字；繁體是台灣字形（裡、著）。取代 cipchk.zh-hans-tt-hant-vscode。

### AutoCorrect

取代 huacnlee.autocorrect，`poly.autocorrect.enabled` 打開才有，用的是它自己的 wasm 引擎：

- 中日韓文字與英數之間補空白、全半形標點、`.autocorrectrc` 裡的詞彙拼寫，開檔與打字時就標出來，
  每條一個 quick fix。
- 手動存檔時整份修正；自動存檔與「儲存但不格式化」不會。`AutoCorrect: Format Document` 手動跑。
- 讀 workspace 資料夾的 `.autocorrectrc` 與 `.autocorrectignore`（加上 `.gitignore`），改了立即
  生效，拿掉一條規則也是；multi-root 每個資料夾各自一份。
- 狀態列的 Lint／Format 開關連它一起關。那個 extension 還裝著時 poly 讓開，不重複報、不重複改。

### PlantUML

jebbs.plantuml 的替代，命令、設定與匯出路徑都照它的（設定在 `poly.plantuml.*`，名稱同它的
`plantuml.*`）。

- **`Preview Current PlantUML Diagram`**（`alt+d`，PlantUML 檔）：游標所在的那張圖畫在旁邊，
  邊打邊更新，游標移到另一張圖就跟過去。縮放、拖曳、分頁、貼齊邊緣、複製成圖片，操作同它。
- **匯出**：`Export Current PlantUML Diagram`、`Export PlantUML Diagrams in This File`、
  `Export Workspace PlantUML Diagrams`（檔案總管的資料夾右鍵也有）。12 種格式，多頁的圖一頁一檔；
  檔名與 `out/` 底下的資料夾結構和它一樣，原本匯出的檔案會被原地覆寫，不會多出一份。
- **URL**：`Generate URL for Current PlantUML Diagram` 與整份檔案的版本，需要 `poly.plantuml.server`；
  本機 `!include` 的檔案會先展開再編碼，server 讀不到你的磁碟。
- **`Extract PlantUML Source from Image`**：從 PlantUML 匯出的 PNG 取回原始碼。
- **補全與參數提示**：PlantUML 的關鍵字與 skinparam（取自 jar 本身，再補上內建清單）、
  `!define` 巨集與它的參數、圖裡已經出現過的名字。
- **大綱**：每張圖一項，寫在 markdown、Java、Python 等檔的註解裡的也算。
- **檢查**：同名的圖是錯誤（匯出時後一張蓋掉前一張），沒命名的是警告
  （`poly.plantuml.lintDiagramNoName` 可關）。
- **markdown preview**（`poly.markdownDiagrams.enabled`）：fence 語言為 `plantuml`／`puml`／`uml`。有設
  `poly.plantuml.server` 時交給 server，否則在本機用 Java 畫——後者是 jebbs.plantuml 做不到的。

jar 由 poly 下載（MIT 版 PlantUML，版本釘在 poly 裡；`poly.toml` 的 `[tools] plantuml` 可改指向
別的 jar）。Java 要自己裝，不在 PATH 上就設 `poly.plantuml.java`；`poly.plantuml.render` 設成
`PlantUMLServer` 則完全不需要 Java。MIT 版不含 ditaa，要畫 ditaa 就把 `[tools] plantuml` 指向
GPL 版的 jar。jebbs.plantuml 還裝著時，補全、大綱、檢查與 markdown fence 交給它，`alt+d` 也讓給它。

### Excalidraw

pomdtr.excalidraw-editor 的替代：`.excalidraw`、`.excalidraw.json`、`.excalidraw.svg`、
`.excalidraw.png` 用 Excalidraw 開。編輯頁面由它的原始碼重新建置（Excalidraw 0.18.1），存出來的
檔案與它的相同；設定在 `poly.excalidraw.*`，名稱同它的 `excalidraw.*`。

- **存成圖片的圖**：`.excalidraw.svg`／`.excalidraw.png` 存的是圖片本身，scene 嵌在裡面：
  放進文件直接能看，再開還能編輯。`poly.excalidraw.image` 決定圖片的倍率、背景與深色。
- **標題列按鈕**：Excalidraw 裡可開原始檔（`.excalidraw`、`.excalidraw.svg`）或圖片
  （`.excalidraw.png`），文字編輯器裡的 scene 檔則可切回 Excalidraw；按住 `alt` 開在側邊。
  命令面板也有。
- **`New Excalidraw Scene`**：File > New File 裡也有。
- **元件庫**：預設存在 VSCode 裡，所有工作區共用；`poly.excalidraw.workspaceLibraryPath`
  指向工作區裡的檔案，就跟著專案走。libraries.excalidraw.com 的元件庫可以直接加進開著的編輯器。
- **主題與語言**：`poly.excalidraw.theme` 為 `light`、`dark`，或 `auto` 跟著 VSCode；
  `Excalidraw Color Theme` 邊選邊預覽。`poly.excalidraw.language` 不設就跟著 VSCode 的顯示語言。
- **git 比較**：舊版那一側唯讀。

介面與手寫字型打包在 extension 裡；中文用的 Xiaolai 與 Liberation Sans 要用到時才從 esm.sh
下載，同 pomdtr。和它不同的地方都是修掉它的 bug：`exportWithBackground` 關掉沒作用、日文／
韓文／捷克文的介面變英文、存檔沒等寫完就回報完成、revert 之後畫面還是舊的、未存檔的新圖在
VSCode 重開後變空白。pomdtr.excalidraw-editor 還裝著時，兩者都登記為預設編輯器，VSCode 會請你
選一個。

### draw.io

hediet.vscode-drawio 的替代：`.drawio`、`.dio`、`.drawio.svg`、`.dio.svg`、`.drawio.png`、
`.dio.png` 用 draw.io 開。draw.io（31.5.2）打包在 extension 裡，不必連網；存出來的檔案與它的
相同，設定在 `poly.drawio.*`，名稱同它的 `hediet.vscode-drawio.*`。

- **三種存法**：`.drawio`／`.dio` 存成四格縮排的 XML，以 XML 著色；`.drawio.svg`／`.drawio.png`
  存的是圖片本身，圖嵌在裡面，放進文件直接能看，再開還能編輯。用文字編輯器改 XML 時，開著的圖
  跟著變。
- **`Convert draw.io Diagram To...`**：在三種存法之間轉換，未存檔的修改也算；舊檔刪掉，新檔
  開起來。**`Export draw.io Diagram To...`** 另存一份 SVG、PNG 或 `.drawio`。
- **`New draw.io Diagram`**：File > New File 裡也有。
- **主題**：`draw.io Theme` 一次選介面（`poly.drawio.theme`）與深淺（`poly.drawio.appearance`，
  `automatic` 跟著 VSCode）。介面語言跟著 VSCode 的顯示語言。
- **圖形庫與 plugin**：`poly.drawio.customLibraries` 把 JSON、XML、URL 或檔案裡的圖形放進側欄，
  draw.io 自己存出的圖形庫檔也行。`poly.drawio.plugins` 載入 plugin：每個檔第一次執行、內容變了
  之後都會問你，答案記在使用者設定，工作區設定改不了。
- **code link**：節點連到程式碼。選取一段程式碼按 `shift+f3`（`Link Selected Code with draw.io Node`）
  連到圖上選著的節點；檔案總管的右鍵連整個檔案（命令面板上是目前的檔案）；`Link Symbol with draw.io Node`／
  `Link Workspace Symbol with draw.io Node` 連符號。status bar 的 Code Link 打開時，雙擊節點跳到它
  連的地方，沒連過而標籤寫 `#符號名` 的跳到那個符號。連結存在節點裡，格式同 hediet.vscode-drawio，
  兩邊畫的圖互通。
- **markdown preview**（`poly.markdownDiagrams.enabled`）：fence 語言為 `drawio`，內容是圖的 XML，
  畫第一頁。

`poly.drawio.offline` 關掉時改開 `poly.drawio.online-url` 的 draw.io（預設 embed.diagrams.net）；
這時 plugin、`poly.drawio.resizeImages` 與 code link 不作用，因為頁面在別的網域。和
hediet.vscode-drawio 不同的地方都是修掉它的 bug：revert 之後畫面還是舊的；draw.io 自己存出的
圖形庫檔讀不進來，連圖都畫不出來；code link 打開時雙擊節點什麼事都不發生；markdown 裡的圖少了
AWS、Cisco 這類圖示，preview 還說有內容被停用。它的 Live Share 共同編輯與 `local-storage` 設定
沒有做。兩者都裝著時，VSCode 會請你選預設的編輯器。

### Markdown 匯出

yzane.markdown-pdf 的替代：markdown 匯出成 PDF、HTML、PNG、JPEG。轉換的程式碼取自它（2.2.0），
匯出的檔案與它的相同；設定在 `poly.markdownPdf.*`，名稱同它的 `markdown-pdf.*`。

- **`Export Markdown (pdf)`**，以及 html、png、jpeg、全部四種各一個命令；
  `Export Markdown (settings.json)` 匯出 `poly.markdownPdf.type` 列的格式。markdown 檔的右鍵選單也有。
- **存檔時轉換**：`poly.markdownPdf.convertOnSave`，`convertOnSaveExclude` 以正規表示式排除檔名。
- **內容**：語法上色（highlight.js 的佈景主題任選）、KaTeX 數學式、PlantUML（交給
  `poly.markdownPdf.plantumlServer`）、mermaid（從 `poly.markdownPdf.mermaidServer` 載入）、`:::` 容器、
  任務清單、以 markdown-it-include 的語法引入別的檔，front matter 可覆寫其中幾項設定。原始 HTML 預設照 GitHub 的
  規則清掉危險標籤（`poly.markdownPdf.sanitize`）。
- **版面**：PDF 的紙張、方向、邊界、頁首頁尾 HTML、頁碼範圍與背景；PNG／JPEG 可只截一塊。

PDF、PNG、JPEG 由 Chrome 印出：`poly.markdownPdf.executablePath` 有設就用它，否則找已安裝的 Chrome
或 Edge。都沒有時，第一次匯出才下載 Chrome for Testing（約 180 MB），版本固定為 puppeteer 測過的那一版，
核對雜湊值後才解開；只有 macOS arm64 與 Windows x64 有。和 yzane.markdown-pdf 不同的地方：emoji
畫成字元，而不是它內附的 Apple 圖片，沒有對應字元的名稱（`:octocat:` 之類）照原樣留著；它下載的是當下
最新的 Chrome，而且一啟動就下載；存檔時轉換改了設定不必重開 VSCode，轉的是存檔的那個檔而不是畫面前面
那個；markdown 家族（prompt、instructions 等）也能匯出；資料夾名稱含 `.md` 時它寫不出檔。兩者都裝著時，
poly 的命令不放進右鍵選單。

### CodeSnap

adpyke.codesnap 的替代：選取的程式碼拍成一張 PNG，照 VSCode 的顏色與字型畫在 macOS 風格的視窗裡。
頁面取自它（1.3.4），拍出的圖與它的相同；設定在 `poly.codeSnap.*`，名稱同它的 `codesnap.*`。

- **`CodeSnap 📸`**：命令面板或編輯器的右鍵選單，頁面開在旁邊，選取改了頁面跟著換。
- **快門**：存成 PNG；`poly.codeSnap.shutterAction` 設成 `copy` 則複製到剪貼簿。在頁面裡按複製一律
  是複製圖片。
- **外觀**：背景色、陰影、留白、圓角、視窗按鈕與標題、行號（可照檔案裡的行數），圖片可只含視窗、
  背景透明。這些設定也能寫在語言區塊（如 `[python]`）裡。

頁面拿到上色的程式碼，靠的是 VSCode 的 Copy With Syntax Highlighting，所以頁面開著時，每次選取都會
蓋掉剪貼簿，和它一樣。和 adpyke.codesnap 不同的地方：取消存檔之後，下一次存檔仍從上一張圖的位置開始，
它則忘了那個位置；存檔失敗會顯示錯誤。兩者都裝著時，poly 的命令不放進右鍵選單。

### 貼上圖片

mushan.vscode-paste-image 的替代：剪貼簿裡的圖片存成 PNG 放在正在編輯的檔案旁邊，並插入指向它的連結。
讀剪貼簿的腳本取自它（1.0.4）；設定在 `poly.pasteImage.*`，名稱與預設值同它的 `pasteImage.*`。

- **`Paste Image`**（`cmd+alt+shift+i`／`ctrl+alt+shift+i`）：有選取文字就拿它當檔名並取代它，否則照
  `defaultName`（moment.js 的格式）以貼上的時間命名。markdown 家族插入 markdown 的圖片語法，AsciiDoc
  插入 `image::路徑[]`，其他檔案只插入路徑。同名的圖已經存在時先問要不要蓋掉。
- **位置與寫法**：`path` 是存放的資料夾，`basePath` 是插入的路徑從哪算起（留空插入絕對路徑），都可用
  `${currentFileDir}`、`${projectRoot}`、`${currentFileName}`、`${currentFileNameWithoutExt}`。路徑可加前後綴、
  編碼空格或整段 URL 編碼；`insertPattern` 自訂插入的整段文字；`showFilePathConfirmInputBox` 存檔前先問完整
  路徑或只問檔名。
- **讀剪貼簿**：macOS 用 osascript，Windows 用 PowerShell，Linux 要先裝 xclip。

和 mushan.vscode-paste-image 不同的地方：鍵換成 `cmd+alt+shift+i`，因為它的 `cmd+alt+v` 就是 Extract Variable
的鍵；唯讀的編輯器裡按了不作用；markdown 家族（prompt、instructions 等）也插入圖片語法，它只認 `markdown`；
`${projectRoot}` 是檔案所在的工作區資料夾，沒開資料夾時是檔案所在的資料夾，它則一律用第一個資料夾，沒開
資料夾時變成名為 `undefined` 的資料夾；檔名框裡填相對路徑時從檔案所在的資料夾算起；Windows 上蓋掉較大的
舊圖時不會留下舊檔的尾巴；圖寫不出來時會說，它則什麼都不做；訊息的措辭不同，並寫出 poly 的設定名稱。
兩者都裝著時各用各的鍵，都能用；別的擴充綁了 `cmd+alt+shift+i` 時 poly 讓出來。

### 資料預覽

RandomFractalsInc.vscode-data-preview 的替代：資料檔開成可排序、篩選、分組、樞紐的表格，也能換成圖表。頁面取自
它（2.3.0），表格與圖表是 Perspective 0.4，同它的；設定在 `poly.dataPreview.*`，名稱同它的 `data.preview.*`。

- **`Preview Data`**／**`Preview Data on Side`**：編輯器標題的按鈕、檔案總管與分頁的右鍵選單都有，命令面板也
  叫得到。讀得懂的格式：JSON（可有註解與尾逗號）、JSON Lines、JSON5、HJSON、YAML、CSV／TSV、Markdown 表格、
  properties／ini／env、Excel（xlsx、xlsb、xls、xlsm）、ODS、Arrow、Avro、Parquet。物件攤平成 key／value
  兩欄；一個檔有多張工作表或多個 Markdown 表格時，工具列可切換。存檔後預覽跟著重讀。
- **`Preview Remote Data`**：輸入 http(s) 網址預覽網路上的檔。
- **工具列**：篩選後的資料另存成 CSV、Markdown、JSON 家族、YAML、properties、Excel 或 Arrow；表格的欄位、
  排序與圖表存成 `.config`，之後再載入；也能開原始檔或另一個資料檔。
- **設定**：`theme` 選表格的配色（`dark`、`light`、較緊湊的 `dense.*`、`vaporwave`）；`create.json.files` 與
  `create.json.schema` 讓 Arrow、Avro、Parquet、Excel 檔預覽時在旁邊寫出 `.json` 與 `.schema.json`，已經存在的
  不覆蓋；`openSavedFileEditor` 決定另存後要不要開那個檔。

和 RandomFractalsInc.vscode-data-preview 不同的地方：不綁快捷鍵（它的 `ctrl+shift+r` 是 VSCode 的 Refactor）；
頁面不從網路載入任何東西；每個視窗第一個預覽的表格不再是空白的；`light` 與 `dense.light` 真的套上亮色，它要
的樣式表並不存在；改了主題，開著的預覽跟著換；物件裡的 `false`、`0` 與空字串照樣列出，它會漏掉；按鈕與選單只
出現在副檔名讀得懂的檔，它的樣式會把 `vite.config.ts`、`x.mdx` 也算進去；圖表只有 d3fc，Highcharts 不能商用
所以不附，`charts.plugin` 與 `log.level` 兩項設定沒有；頁面只能開預覽或檔案，不能叫任意命令；讀不了的二進位
檔會說，它則一聲不吭；不在網址旁寫檔。兩者都裝著時，poly 的按鈕、選單與命令讓出來。

### Swagger 預覽

arjun.swagger-viewer 的替代：Swagger 2.0 與 OpenAPI 3.0／3.1 的 JSON、YAML 檔以 Swagger UI 預覽，邊打邊更新。
頁面取自它（3.2.0），Swagger UI 也是同一版（5.30.3）；設定在 `poly.swaggerViewer.*`，名稱同它的
`swaggerViewer.*`。

- **`Preview Swagger`**（`shift+alt+p`）：預覽開在第二欄。檔案總管裡 JSON、YAML 檔的右鍵選單也有。
- **`Preview Swagger from URL`**：輸入網址，抓下來預覽。
- **Swagger/OpenAPI Files**：檔案總管裡的清單，列出工作區裡的 spec（略過 `node_modules`），點一下就預覽。
- **檢查**：JSON 檔照 Swagger 2.0 或 OpenAPI 3.0 的 schema 標出錯誤；YAML 檔要另外裝 redhat.vscode-yaml。
- **伺服器**：預覽是本機 `defaultHost`、`defaultPort` 上的頁面（被占用就往後找），嵌在分頁裡；
  `previewInBrowser` 改在瀏覽器開。status bar 的 Swagger Viewer 關掉伺服器，已開的預覽照樣更新。

和 arjun.swagger-viewer 不同的地方：spec 裡引用別的檔的 `$ref` 會併進預覽，被引用的檔改了預覽也跟著變——
它宣稱支援，但每次都失敗，頁面拿到的是原文；預覽網址帶隨機 token，伺服器只給 Swagger UI 的檔，它的網址
是檔案路徑的雜湊，整個 `node_modules` 都拿得到；`defaultPort` 每次啟動伺服器時讀，它只在啟動時讀一次；
從檔案總管預覽 JSON 檔時照 JSON 解析，它當成 YAML。和它一樣的地方：OpenAPI 3.1 的 YAML 檔照 3.0 的
schema 檢查，頁面一律是亮色。兩者都裝著時，poly 讓出 `shift+alt+p`，右鍵選單與清單只留它的；JSON 檔的
schema 則兩邊都會套。

### Marp 投影片

marp-team.marp-vscode 的替代：front matter 寫了 `marp: true` 的 Markdown 以 Marp 投影片預覽與匯出。原始碼
取自它（3.6.1），Marp Core 與 Marp CLI 也是它鎖定的版本（4.4.0、4.5.0）；設定在 `poly.marp.*`，名稱同它的
`markdown.marp.*`。

- **預覽**：VSCode 內建的 Markdown 預覽直接畫成投影片：主題（default、gaia、uncover，以及 `themes` 設定的
  自訂主題）、分頁、頁首頁尾、背景圖、MathJax 或 KaTeX 數學式。沒有 `marp: true` 的 Markdown 照常預覽。
- **Directive**：front matter 與 HTML 註解裡的 directive 名稱加粗上色（global 的另加斜體，顏色是
  `poly.marpDirectiveKeyForeground`），滑鼠停上去有說明，打字時補全名稱與值（主題、尺寸、`paginate`、
  `math`、轉場）。
- **檢查**：沒有的主題與尺寸、重複的 global directive、已失效的 `$` 前綴、用圖片語法設顏色、用了數學式卻
  沒寫 `math` directive，多半附快速修正。
- **`Export Marp Slide Deck...`**：匯出 HTML、PDF、PPTX、PNG、JPEG（圖片只有第一張）或講者備忘稿文字檔，
  預設類型是 `exportType`。PDF 可加大綱與備忘稿註解，PPTX 可匯出成可編輯的（要另裝 LibreOffice）。
  瀏覽器用已安裝的 Chrome、Edge 或 Firefox。Copilot Chat 裡是 `#polyExportMarp` 工具。
- **`Toggle Marp for Current Markdown`**、**`New Untitled Marp Markdown`**（`File > New File` 裡的 Marp
  Markdown），以及編輯器標題列 Marp 按鈕開出的 `Show Marp Commands...`。

和 marp-team.marp-vscode 不同的地方：它舊版的 `enableHtml`、`chromePath` 不支援，改用 `html`、
`browserPath`；命令與 Copilot Chat 工具的名稱都帶 poly。poly 在不信任的工作區整個停用，所以連預覽也沒有，
它則只停用匯出，並忽略工作區裡的 `html` 與 `themes` 設定；也沒有網頁版（vscode.dev）。和它一樣的地方：
投影片內容超出範圍的警告（`diagnostics.slideContentOverflow`）在目前的 VSCode 上兩者都不會出現，它借用的
預覽內部通道已經不在了。兩者都裝著時，poly 整個讓出，預覽、檢查與命令都只有它的。

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
- **語法顏色**（設定 `poly.syntaxColors`）：設定畫面裡一張 scope → 顏色的表，例如 `comment` →
  `#6A9955 italic`；刪掉一項就回到 theme 的顏色。poly 把它複製進
  `editor.tokenColorCustomizations`（主題只讀那裡），成為名為 `poly.syntaxColors` 的 rule，
  你自己寫的 rule 與各 theme 專屬的設定原樣保留。有 semantic tokens 的語言要另改
  `editor.semanticTokenColorCustomizations`。
- **`Set Syntax Color`**：從目前這個檔的文法的全部 scope 挑一個，輸入 `#C586C0` 或
  `#C586C0 italic`，寫進 `poly.syntaxColors`；留空刪掉那一項。
- **`Syntax Colors for This Language`**：同一份 scope 清單整份列出，做成可以直接複製的
  `poly.syntaxColors` 片段。顏色欄位是 `#RRGGBB` 佔位字串，所以整份貼上去不會改變任何顏色。

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

`Extract Variable`、`Inline Variable`、上／下一個變更檔與 `Revert Selected Changes and Save`
的鍵若已被你裝的別的擴充綁走（例如 mushan.vscode-paste-image 的 `cmd+alt+v`、quicktype 的
`cmd+alt+shift+v`、Rewrap 的 `alt+q`），poly 會讓出來，Poly Editor 輸出面板記一行讓給了誰；
命令面板照樣叫得到。要搶回來，在 `keybindings.json` 綁對應的 `poly.*` 命令。只有 web 版
（沒有桌面版程式）的擴充 poly 看不到，照樣會被蓋過。

其餘命令沒有預設快捷鍵，從命令面板叫，或自己在 `keybindings.json` 綁：
`poly.formatFile`／`formatPath`／`formatWorkspace`／`formatGitRepo`／`formatGitChanged`、
`poly.lintPath`、`poly.analyzeDeadCode`、`poly.toggleFormat`、`poly.toggleLint`、`poly.createGoWork`、
`poly.checkForUpdates`、`poly.showOutput`、`poly.copyPathWithLine`、`poly.insertTableOfContents`、
`poly.runFile`、`poly.moveToNewFile`、`poly.changeSignature`、`poly.implementInterface`、
`poly.syntaxColors`、`poly.setSyntaxColor`、`poly.refreshTodos`、`poly.toTraditionalChinese`／
`toSimplifiedChinese`／`toTraditionalChineseTaiwan`／`toSimplifiedChineseTaiwan`、`poly.autocorrectDocument`。

## 設定

| 設定                               | 預設      | 作用                                                                                   |
| ---------------------------------- | --------- | -------------------------------------------------------------------------------------- |
| `poly.serverPath`                  | `""`      | 改用指定路徑的 poly binary，空字串是用內附的那支                                       |
| `poly.lintOnSave`                  | `true`    | 開檔與存檔時跑 lint，改了立即生效；Lint 開關也寫這一項                                 |
| `poly.format.enabled`              | `true`    | 關掉後 poly 的改寫都不動作（`Poly: Format Document` 除外）；Format 開關也寫它          |
| `poly.deadCodeCodeLens.enabled`    | `false`   | 每個 Go／TS／JS／Python 檔第一行上方一條 `analyze dead code`                           |
| `poly.languageServers`             | `false`   | 把語言功能路由給下游 server（見上），改完要重新載入視窗                                |
| `poly.languageServerLogs`          | `true`    | 下游 server 的 stderr 轉進 Poly 輸出面板                                               |
| `poly.memoryLog`                   | `false`   | 每開關一個檔寫一行 daemon 握著什麼（RSS、文件數、各快取）                              |
| `poly.updateCheck.enabled`         | `true`    | 背景檢查新版，有就直接安裝                                                             |
| `poly.updateCheck.intervalDays`    | `7`       | 檢查間隔，`0` 是每次啟動都查                                                           |
| `poly.indentTint.enabled`          | `false`   | 縮排上色                                                                               |
| `poly.imagePreview.enabled`        | `false`   | gutter 圖片縮圖                                                                        |
| `poly.unicodeHighlight.enabled`    | `false`   | 不可見與冒充 ASCII 的字元（gremlins 的替代）                                           |
| `poly.referencesCodeLens.enabled`  | `false`   | `N refs`／`N impls`／`N methods`                                                       |
| `poly.protobufCodeLens.enabled`    | `false`   | `.proto` → 生成的 Go                                                                   |
| `poly.runCodeLens.enabled`         | `false`   | `run \| debug`                                                                         |
| `poly.markdownMermaid.enabled`     | `false`   | preview 裡畫 mermaid                                                                   |
| `poly.markdownDiagrams.enabled`    | `false`   | preview 裡畫 nomnoml／flowchart／sequence／vega／markmap／excalidraw／plantuml／drawio |
| `poly.markdownGithubStyle.enabled` | `false`   | preview 套 GitHub 樣式；`.colorTheme`／`.lightTheme`／`.darkTheme` 選配色              |
| `poly.postfixCompletion.enabled`   | `false`   | `.if`／`.for` 之類的展開                                                               |
| `poly.todo.enabled`                | `false`   | 檔案總管的 TODOs 面板                                                                  |
| `poly.todo.tags`                   | 五個標籤  | TODOs 面板找哪些字                                                                     |
| `poly.syntaxColors`                | `{}`      | scope → 顏色與樣式，蓋過 theme；只能設在使用者層級                                     |
| `poly.autocorrect.enabled`         | `false`   | AutoCorrect（huacnlee.autocorrect 的替代）                                             |
| `poly.autocorrect.enableLint`      | `true`    | AutoCorrect 的問題列進 Problems                                                        |
| `poly.autocorrect.formatOnSave`    | `true`    | 手動存檔時 AutoCorrect 整份修正                                                        |
| `poly.plantuml.*`                  | 同 jebbs  | PlantUML 的 Java、匯出、預覽、server 與檢查，20 項，見上面的 PlantUML                  |
| `poly.excalidraw.*`                | 同 pomdtr | Excalidraw 的主題、語言、元件庫與圖片，4 項，見上面的 Excalidraw                       |
| `poly.drawio.*`                    | 同 hediet | draw.io 的離線／線上、主題、樣式、圖形庫、plugin 與 code link，22 項，見上面的 draw.io |
| `poly.markdownPdf.*`               | 同 yzane  | 匯出的格式、位置、樣式、Chrome、PDF 版面與圖片範圍，43 項，見上面的 Markdown 匯出      |
| `poly.codeSnap.*`                  | 同 adpyke | 截圖的背景、陰影、視窗樣式、行號與快門動作，11 項，見上面的 CodeSnap                   |
| `poly.pasteImage.*`                | 同 mushan | 圖片存放的資料夾與檔名、插入的路徑與寫法、存檔前的檔名框，12 項，見上面的貼上圖片      |
| `poly.dataPreview.*`               | 同它的    | 表格的主題、二進位檔旁寫出 JSON 與 schema、存檔後開啟，4 項，見上面的資料預覽          |
| `poly.swaggerViewer.*`             | 同 arjun  | 預覽伺服器的主機與連接埠、在瀏覽器開、標題只列檔名與縮放，5 項，見上面的 Swagger 預覽  |
| `poly.marp.*`                      | 同 marp   | 預覽的換行、HTML、數學式與主題，匯出的格式與瀏覽器，15 項，見上面的 Marp 投影片        |

markdown 的 Enter／Tab／粗體斜體與 `Copy Path with Line Numbers`、重構命令沒有開關：它們
只在你按下去時才做事。每一項的完整說明在 VSCode 的設定頁（英文與正體中文都有）。專案層的
格式化與工具設定寫在 `poly.toml`，不在這裡——見專案根目錄的 README。

## Log

兩個輸出面板：**Poly** 是 daemon 的（啟動、每次 lint／format、下游 server 的 stderr），
**Poly Editor** 是編輯器功能的（lens 為什麼沒畫之類，細節在 debug 層級，用 `Developer: Set Log
Level` 打開）。兩者都寫到磁碟上，是 `Developer: Open Extension Logs Folder` 打開的資料夾裡
`ricky.poly-lsp/` 底下的 `Poly.log` 與 `Poly Editor.log`，回報問題時附這兩個檔就夠了。WSL、SSH 的
遠端視窗裡 poly-lsp 跑在遠端，這兩個檔也在遠端的 `~/.vscode-server/data/logs/` 底下，不在本機；拿不到
時從輸出面板匯出。

## 設計理由

搬到 `dev_docs/vscode-syntax`。這裡只寫結論。
