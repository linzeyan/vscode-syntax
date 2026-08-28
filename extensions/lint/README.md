# Poly Lint

透過 `poly lsp` daemon 提供統一 lint/format：

- **Format**：右鍵 Format Document／`editor.formatOnSave`；批次命令
  （Format File / Folder / Workspace / Git Repo / Git Changed Files）。
- **Lint**：存檔即時 diagnostics（shellcheck／hadolint／actionlint／ruff／
  selene／sqruff，以及專案內的 biome／eslint）；`Poly: Lint (poly check)`
  在終端跑完整 CLI，輸出與 CI 一致。
- 專案內工具（biome／prettier／eslint／rustfmt）優先於內嵌引擎，與團隊 CI
  對齊；外部工具受管下載並以 sha256 lock 驗證。
- rust／go／c／c++／swift／terraform 也能格式化（走各自的 toolchain），但不會
  自動搶走 rust-analyzer／gopls／clangd 的預設 formatter——用
  「Format Document With...」選 Poly 即可。
- Jupyter notebook（`.ipynb`）由 ruff 整份處理：cell 內的 Python 會被格式化與
  檢查，outputs／markdown cell 原樣保留。VSCode 的 notebook editor 不走 LSP
  文字文件，所以要用批次命令（Format Folder／Workspace）或 `poly fmt`。

## 更新

啟動後背景檢查 GitHub Releases（預設每 7 天至多一次；
`poly.updateCheck.intervalDays` 調整、`poly.updateCheck.enabled` 關閉），
或手動執行 `Poly: Check for Updates`。一鍵安裝會同時更新 poly-syntax。

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
  `%USERPROFILE%\.vscode\extensions\ricky.poly-lint-*\bin\poly.exe` →
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
