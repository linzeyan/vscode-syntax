# Poly LSP

透過 `poly lsp` daemon 提供統一 lint/format：

- **Format**：右鍵 Format Document／`editor.formatOnSave`；批次命令
  （Format File / Folder / Workspace / Git Repo / Git Changed Files）。
- **Format Selection**：格整份文件，但只交回落在選取範圍內的變更，所以結果永遠是
  `poly fmt` 會寫的東西。跨在選取邊界上的一整塊變更會整塊套用——那一塊裡沒有可以切開
  的對齊點。`editor.formatOnSaveMode: modifications` 走同一條路。
- **`.editorconfig`**：打字時的 tab 寬度與 tab／空白選擇，以及存檔時的行尾空白、檔尾
  換行、行尾字元。**包括 poly 不格式化的檔案**（`.ini`、Makefile……）——poly 會格的
  檔案交給 formatter，不會兩邊同時改一次存檔。答案與 `poly fmt` 出自同一次解析，所以
  打字時的行為跟存檔後的結果不會各說各話。`charset` 與 `max_line_length` 不處理。
- **Lint**：存檔即時 diagnostics（shellcheck／hadolint／actionlint／ruff／
  selene／sqruff，以及專案內的 biome／eslint）；`Poly: Lint (poly check)`
  在終端跑完整 CLI，輸出與 CI 一致。
- **`Poly: Minify JSON`**：把當前 JSON／JSONC buffer 壓成一行（移除空白與註解，
  保留 key 順序與字串內容）。命令面板執行。刻意不進 format-on-save：它是格式化的
  反向，下一次 `poly fmt` 就會還原。CLI 對應 `poly minify <路徑>`。
- 專案內工具（biome／prettier／eslint／rustfmt）優先於內嵌引擎，與團隊 CI
  對齊；外部工具受管下載並以 sha256 lock 驗證。
- rust／go／c／c++／swift／terraform 也能格式化（走各自的 toolchain），但不會
  自動搶走 rust-analyzer／gopls／clangd 的預設 formatter——用
  「Format Document With...」選 Poly 即可。
- **Protobuf**（`.proto`）由 buf 處理：格式化免設定，開箱即用。**lint 只在 buf
  module 裡跑**——`.proto` 上方要有 `buf.yaml`，否則會大聲跳過。這不是保守：沒有
  module 時 buf 會拿當前工作目錄當根目錄，`PACKAGE_DIRECTORY_MATCH` 就會對完全正常
  的 package 亂噴，而且噴什麼取決於你從哪個目錄執行。導航、補全與 hover 另外由
  `poly.languageServers`（預設關閉）控制，打開後走的是同一支 buf。
- Jupyter notebook（`.ipynb`）由 ruff 整份處理：cell 內的 Python 會被格式化與
  檢查，outputs／markdown cell 原樣保留。VSCode 的 notebook editor 不走 LSP
  文字文件，所以要用批次命令（Format Folder／Workspace）或 `poly fmt`。

## 語言功能（`poly.languageServers`，預設關閉）

打開之後，poly 把請求轉給**專案自己 toolchain 裡的** language server——gopls、
rust-analyzer、clangd、sourcekit-lsp、terraform-ls、lua-language-server，以及 poly
自己代管的 buf。poly 不實作任何一行語意分析（A6），只做路由，所以答案的品質是那些
server 的，不是 poly 的。

轉的是：hover、definition／typeDefinition／implementation／declaration、
**references**、documentSymbol、completion、rename、code action、signatureHelp、
documentHighlight、foldingRange、selectionRange，以及 **inlay hints**、
**call hierarchy**、**type hierarchy**、**server 自己的命令**。註冊哪些由 server
自己宣告什麼決定——poly 不會替它宣稱一個它沒有的能力。

### 重構為什麼要靠「server 自己的命令」

燈泡裡的東西大多不是一份編輯，而是一個**命令**——gopls 的每一個 code action 都是。
所以 `Extract declarations to new file`（`gopls.extract_to_new_file`）、
`Change signature`（`gopls.change_signature`）這些能不能用，取決於 poly 有沒有把
`workspace/executeCommand` 轉下去。**0.9.0 之前沒有**，點下去毫無反應也沒有錯誤訊息。
現在 poly 照每個 server 自己宣告的命令清單註冊，依命令名稱路由。

存檔時會跑的三族 code action（`source.organizeImports`／`source.fixAll`／
`source.formatAll`）poly 不轉——VSCode 在 formatter **之前**跑它們，等於讓 gopls 的
organizeImports 跟 poly 的 gofumpt 在同一次存檔搶著改同一段 import。其餘的 `source.*`
（`Browse documentation`、`Add test`、`Split package`……）照常出現在燈泡裡。

### Inlay hints 要另外開

**gopls 預設不出 inlay hint**，而且它是跟 client 要設定的（`workspace/configuration`
的 `gopls` 區段），所以要在 `settings.json` 裡開：

```jsonc
{
  "gopls": {
    "hints": {
      "assignVariableTypes": true,
      "compositeLiteralFields": true,
      "constantValues": true,
      "parameterNames": true,
      "rangeVariableTypes": true
    }
  }
}
```

rust-analyzer 與 clangd 的 hint 預設是開的，不必動。

### 一個 window 開多個 Go 專案：`Poly: Create go.work for the Open Go Modules`

**跨 module 的引用只有在有 `go.work` 時才找得到。** 實測 gopls 1.26，兩個 module
當成兩個 workspace folder、`appb` 用 `replace` 指向 `liba`，問誰呼叫 `liba.Hello`：

| 情境                              | 結果       |
| --------------------------------- | ---------- |
| 兩個 module ＋ replace，只開 liba | 找不到     |
| 兩個 module ＋ replace，兩邊都開  | 找不到     |
| 上面兩個 module ＋ `go.work`      | **找得到** |

原因是 gopls 每個 module 建一個 view，reference 搜尋不出那個 view。`go.work` 才讓兩者
變成同一個 build——而且它**不必是 workspace folder**，放在共同父目錄就行，gopls 會
往上走去找。

這個命令就是把 window 裡所有 `go.mod` 找出來、算出共同父目錄、跑 `go work init`／
`use`。**寫檔前一定會問**，而且對話框寫明完整路徑，因為那個父目錄通常在你開的資料夾
**外面**。寫完會重啟 language server（外面的檔案編輯器不會 watch，所以不能等通知）。
需要 `go` 在 PATH 上——gopls 本來就要它。

## 更新

啟動後背景檢查 GitHub Releases（預設每 7 天至多一次；
`poly.updateCheck.intervalDays` 調整、`poly.updateCheck.enabled` 關閉），
或手動執行 `Poly: Check for Updates`。一鍵安裝會同時更新 poly-syntax-highlight。

### 從 0.5.0 以前升上來

這個 extension 0.6.0 前叫 `poly-lint`（另一個叫 `poly-syntax`）。id 換了就是新
extension，只能手動裝。

0.5.0 的更新提示還是會跳，但按下 Install 必定失敗（它找的是 `poly-syntax-0.9.0.vsix`
這個已經不存在的檔名），而且錯誤訊息會說「The VSIX files were downloaded」——
其實一個都沒下載，所以「Show Files」也沒東西可看。那段程式碼凍在已安裝的 0.5.0
裡，改不了。

舊的得自己移除，否則兩個 formatter 搶同一批語言：

```sh
code --uninstall-extension ricky.poly-lint
code --uninstall-extension ricky.poly-syntax
```

`settings.json` 裡若有 `"editor.defaultFormatter": "ricky.poly-lint"`，改成
`"ricky.poly-lsp"`。留著舊值不會報錯，只是指向不存在的 extension，格式化會安靜
地不動作。

## 開發設定

平台 VSIX 已內嵌 poly binary；開發時以 `poly.serverPath` 指向自建執行檔
（相對路徑以工作區根目錄解析；本 repo 的 `.vscode/settings.json` 已指向
`cli/target/release/poly`）。

## 疑難排解

### daemon 沒起來

狀態列出現紅底 `Poly`，格式化與 diagnostics 全部失效。點狀態列或執行
`Poly: Show Log` 看實際錯誤，再對照下面幾節。想手動確認 binary 能不能跑，
在終端機執行 `<poly 路徑> tools`——會列出每個外部工具的解析狀態。

### 狀態列出現黃底 `Poly`：binary 與 extension 版本不符

daemon 有起來，但接到的 poly 不是這個 extension 出貨的那一支。VSIX 裡兩者是綁在
一起發版的，所以會不一致只有兩種原因：`poly.serverPath` 指向舊的本機 build，或
PATH 上有另一支 poly 排在前面。功能不會壞，但新版才有的行為會安靜地不出現。

點狀態列看 log，第一行就寫著實際解析到哪支、它回報什麼版本。自己確認：

```sh
<poly 路徑> --version   # 應該與 extension 版本相同
```

沒有輸出代表那支 poly 舊到還沒有 `--version`（0.3.0 以前）。

### Windows SmartScreen／Defender

內嵌的 `poly.exe` 未簽章，首次執行可能被擋。

- 解除封鎖：檔案總管開
  `%USERPROFILE%\.vscode\extensions\ricky.poly-lsp-*\bin\poly.exe` →
  內容 → 一般 → 勾「解除封鎖」。
- 已被隔離：Windows 安全性 → 防毒與威脅防護 → 保護歷程記錄 → 允許。
- 企業用 AppLocker／WDAC 全面封鎖未簽章執行檔時無法自行解除：Release 有獨立的
  `poly-win32-x64.exe`／`poly-win32-arm64.exe`，請 IT 放到核可位置後用
  `poly.serverPath` 指過去。

### macOS Gatekeeper

VSCode 自己解壓的 VSIX 內容通常不帶 quarantine 屬性；若你是**手動**下載
`poly-darwin-*` 來用，瀏覽器會標記它：

```sh
xattr -d com.apple.quarantine ./poly-darwin-arm64 && chmod +x ./poly-darwin-arm64
```

### Proxy／防火牆

兩條網路路徑各自獨立，設定的地方不同：

1. **更新檢查**（擴充套件 → `api.github.com`）：走 VSCode extension host 的
   網路堆疊，設 VSCode 的 `http.proxy`。不需要就把
   `poly.updateCheck.enabled` 設 `false`。
2. **受管工具下載**（poly binary → `github.com`／`objects.githubusercontent.com`）：
   poly 自己讀 `HTTPS_PROXY`／`HTTP_PROXY`／`ALL_PROXY`（大小寫皆可）與
   `NO_PROXY`。**它不讀 Windows 系統 proxy 設定，也不支援 SOCKS**，所以環境變數
   要在啟動 VSCode 之前就設好，VSCode 內的 `http.proxy` 對它無效。

**TLS 攔截（企業 MITM proxy）**：poly 用 rustls 搭內建 root store，不讀作業系統
憑證庫，因此私有 CA 一定驗證失敗。這種環境不要依賴受管下載——自行安裝工具後在
`poly.toml` 指路徑，或關掉個別工具：

```toml
[tools]
shellcheck = "C:/tools/shellcheck.exe"
tflint = "off"
```

**完全離線**：在有網路的機器跑 `poly tools install`，把快取目錄整包複製過去
（Windows `%LOCALAPPDATA%\poly\tools`，其餘平台 `~/.cache/poly/tools`）。
工具缺席時 `poly check` 會明講跳過了哪些、不會靜默放行；CI 要擋就加 `--strict`
把「跳過」升級成錯誤。
