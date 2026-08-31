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

### 縮排上色

把每一層縮排的空白塗上底色，四色循環。VSCode 內建的 `editor.guides.indentation`
畫的是線，回答「這個 block 從哪開始」；上色回答的是另一個問題——「我現在在第幾層」，
那是深巢狀 YAML 與 Python 裡真正會問的。

**填不滿一層的空白另外標色**，因為那正是「縮排改到一半」的樣子，而它在其他任何地方
都看不出來。層寬取編輯器解析後的 `tabSize`（語言、檔案、`editor.detectIndentation`
都算進去了），所以跟你眼睛看到的寬度一致。

`poly.indentTint.enabled` 可關。顏色是 theme color，用
`workbench.colorCustomizations` 蓋 `poly.indentLevel1`～`4` 與 `poly.indentPartial`。

只畫**可見範圍**——整份檔案的每一層縮排是幾千個 range，而沒有人在看它們。

### Gutter 圖片預覽

某一行提到的圖片檔存在的話，就在該行的 gutter 放一張縮圖。路徑先相對於該檔案自己的
目錄找，再相對 workspace root 找（所以 `./logo.png` 與寫成 server 絕對路徑的
`/assets/logo.png` 都會中）。

刻意不寫語法解析器：markdown、HTML、CSS 與一個純字串各有各的寫法，而**檔案存不存在
才是真正的過濾器**。認錯一次的代價是一個 `stat`，漏掉一次的代價是這個功能。

`poly.imagePreview.enabled` 可關。

### TODOs 檢視

檔案總管裡多一個 TODOs 面板，列出整個 workspace 的 `TODO`／`FIXME`／`HACK`／`XXX`／
`BUG`（`poly.todo.tags` 可改）。點一條就跳到那一行那一欄。

- 規則只有「大寫、整個字」。再聰明就得認得每種語言的註釋語法，而**認錯的後果是有標記
  卻沒被列出來**——那比多列一個寫在字串裡的還糟。
- 只在面板真的顯示時才掃描；存檔會重掃。沒開這個面板的 session 不該替它付錢。
- 掃描有上限（4000 個檔案、單檔 512 KB），而且**上限有講出來**：面板標題會寫
  「stopped at 4000 files」，所以「清單很短」跟「清單被截斷」不會長得一樣。
- 排除規則沿用你已經設好的 `files.exclude` 與 `search.exclude`。

## 授權

MIT，見 VSIX 內的 `LICENSE`。
