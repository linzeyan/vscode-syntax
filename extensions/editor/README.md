# Poly Editor

編輯器端的便利功能，**沒有 CI 對應物**的那些——所以它們不在
[poly-lsp](https://github.com/linzeyan/vscode-syntax/tree/main/extensions/lsp) 裡：
poly-lsp 的失敗模式是「daemon 沒起來就整個失效」，而且它的 VSIX 是分平台六份，
純 TypeScript 的功能沒有理由被打包六次。

這個 extension 不需要 poly binary，也不需要 poly-lsp。

## 功能

### Poly: Copy Path with Line Numbers

複製 `路徑:行號`。有選取多行時是 `路徑:42-51`，否則是游標所在的 `路徑:42`。
路徑相對於 workspace folder，一律用 `/`。

VSCode 內建的 **Copy Relative Path** 只到路徑為止，`:42` 是唯一的差別——但那一截
才是重點：`src/lib.rs:42` 正是 `rg` 印的形狀、CI annotation 連過去的形狀、終端機
能點的形狀，也是 poly 自己的診斷輸出的形狀。貼出來的參照跟這些工具吃的是同一個
契約，讀的人不必先翻譯。

命令面板或編輯器右鍵選單都可以叫它。預設沒有綁快捷鍵——要的話自己在
`keybindings.json` 綁 `poly.copyPathWithLine`。

### Poly: Insert Table of Contents

在游標處插入目錄，並用 `<!-- poly:toc -->` ／ `<!-- /poly:toc -->` 兩個標記把它框起來，
所以再跑一次是**就地更新**而不是又插一份。列 H2 到 H6——H1 是文件標題，目錄就在它下面，
不需要一條連回自己的連結。

- 錨點用的是 **VSCode 自己的 slug 規則**（照它 markdown preview 出貨的那份轉寫），
  所以連結在寫它的那個編輯器裡一定跳得到。GitHub 的規則很接近但不完全相同（差在某些
  全形標點），兩邊都要能跳的文件請用 ASCII 標題。
- YAML front matter 裡的 `#` 是註釋、fenced code block 裡的 `#` 是程式碼，兩者都不會
  被當成標題。
- 不會在存檔時自動更新。目錄什麼時候變，你自己說了算。

### Poly: Toggle Bold ／ Toggle Italic

`cmd/ctrl+b` 與 `cmd/ctrl+i`，只在 markdown 檔生效（所以 `cmd+b` 在其他檔案照樣是
VSCode 的側邊欄開關）。沒有選取時作用於游標所在的單字。

產生的是 `**bold**` 與 `_italic_`——正是 `poly fmt` 對 markdown 正規化出來的那兩種，
所以按下去的結果不會被下一次存檔改掉。

## 授權

MIT，見 VSIX 內的 `LICENSE`。
