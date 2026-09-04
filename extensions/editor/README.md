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

### 引用計數 CodeLens

每個宣告上方一行 `11 refs`／`1 ref`／`no refs`，點下去開引用清單。interface 與它的
方法再多一顆 `1 impl`／`3 impls`／`no impls`，點下去列出實作它的型別。

**poly 不做任何分析。** 它問編輯器要 `vscode.executeReferenceProvider` 的結果，編輯器
去問該語言已經註冊的 provider——Go 的話那就是 poly-lsp 前面那層轉給 gopls 的 proxy——
poly 只負責數與畫。所以這不是「poly 實作了引用搜尋」，是把手上已經有的答案交出去。

副作用是它**與語言無關**：任何有 reference provider 的語言都會亮。VSCode 內建只有
TypeScript 有這個 lens，其他語言都沒有。

- **每個語言都有，沒有名單**（2026-09-04 起）。以前是一份寫死的語言 id 清單，而那份清單
  是在猜你裝了什麼——python、typescript、java 全都有好好的 reference provider，卻被漏在
  外面。現在改成直接問：拿檔案裡前三個宣告去問一次 `executeReferenceProvider`，一個位置
  都答不出來就整份檔案不畫。`includeDeclaration: true` 之下，**會回答的 provider 至少會
  回宣告自己**，所以「零個位置」＝「沒人註冊」，而不是「沒人引用」——後者值得一條
  `no refs`，前者只值得閉嘴。TS／JS 現在也有了：VSCode 自己那條預設是關的，漏掉它們等於
  大多數人根本看不到 lens；真的兩條都開就會看到兩個數字，那是看得見也關得掉的。
- 只算**檔案自己的宣告與它們的方法**，函式裡的區域變數不算：那些的引用本來就在畫面上，
  一個區域變數一條 lens 只會把真正該看的埋掉。struct field 也不算——「誰寫這個欄位」
  跟「這個型別到底有沒有人用」是兩個問題。
- 數字**不含宣告自己**。`executeReferenceProvider` 是帶 `includeDeclaration: true` 問的，
  不扣掉的話沒人用的東西會顯示成 `1 ref`——而那正是這個計數最該讓人看見的一種。
- 點下去開 peek 還是開 References 面板，由 VSCode 自己的
  `references.preferredLocation`（`peek`／`view`）決定，不是 poly 選的。要圖上那種樹狀
  面板就設成 `"view"`。
- **`N impl` 只掛在 interface 與 interface 的成員上。** 一顆 lens 只掛一個命令，所以
  `1 ref | 1 impl` 其實是兩顆共用同一行的 lens。問一個普通 function「有幾個型別滿足它」
  沒有答案，整份檔案掛滿 `no impls` 等於沒說話；而「interface，或它底下的成員」在 Go 的
  interface、Rust 的 trait、Java／TypeScript 的 interface 都成立。
- `poly.referencesCodeLens.enabled` 可關（兩種 lens 一起）。編輯器只解析**看得見**的那幾條
  lens，所以成本是「畫面上幾個宣告」而不是「檔案裡幾個宣告」。

### Postfix completion

在句尾打 `.` 再打關鍵字：`err.if` 展開成 `if err != nil { }`（Go）、`if (err) { }`
（TypeScript）、`if err:`（Python）。涵蓋 go／rust／swift／typescript／javascript
（含 react 變體）／python／lua／c／cpp——**每個有敘述句的語言**。資料格式沒有，JSON 裡
`if` 沒有東西可以展開。

- **這是文字重排，不是語意分析。** poly 只讀 `.` 左邊那串字元、把它塞進模板、交給編輯器
  自己的 snippet 引擎——跟隔壁那個 markdown 粗體切換同一種東西。它不知道 `err` 是不是
  error、有沒有型別、展開之後編不編得過。**那份無知正是重點**：正因為什麼都不知道，同一
  份表才蓋得住每個語言，而這也是它跟「語言功能」的分界（01 A6 擋的是分析，不是模板）。
- **表達式邊界是往左掃出來的**：成員鏈整條算、括號與字串整組算、遇到運算子就停。所以
  `x + foo(a, b)[0].if` 抓到的是 `foo(a, b)[0]`，不是前面那個 `x +`。
- **排在 language server 的答案後面**（`sortText`）。叫 `iffy` 的成員是關於程式的真答案，
  模板不是；要等你打到沒有成員能匹配，它才會浮上來。
- gopls 沒有 postfix completion，這是 Tooltitude 清單裡唯一一項「poly 代管的東西都不提供」
  的功能。`poly.postfixCompletion.enabled` 可關。

### Poly: Extract Variable ／ Inline Variable

`cmd/ctrl+alt+v` 把選取的運算式抽成變數，`cmd/ctrl+alt+shift+v` 把游標所在的變數 inline
回去。**每個語言都通用**，因為問的是 LSP 標準的 `refactor.extract`／`refactor.inline`
code action kind——真正做事的是該語言的 server，poly 只負責挑。

- **`editor.action.refactor` 本來就有，缺的是「直接到」。** 它開一張選單，選單內容每個語言
  不一樣，而你要的那一項每個 server 講法都不同：gopls 是 `Extract variable`、rust-analyzer
  是 `Extract into variable`、clangd 是 `Extract subexpression to variable`、TypeScript 是
  `Extract to constant in enclosing scope`。快捷鍵綁不到任何一個，所以那個手勢永遠是「三個
  按鍵加讀一次選單」。
- **會過濾掉不是變數的那些。** `refactor.extract` 同時也蓋 `Extract function`／
  `Extract method`；一個叫 Extract Variable 的命令安靜地抽出一個函式，比什麼都不做更糟。
  沒有任何一項提到變數時，才把同 kind 的全部列出來讓你選——沒量過的講法應該讓你多按一次，
  不該讓功能消失。
- 剛好只有一項就直接套用，多於一項才跳 QuickPick。
- 選取範圍是空的時候用游標所在的那個字。再寬就是 poly 在決定「運算式從哪裡開始」，那是語言
  的工作，不是 poly 的。

### 跨檔案 next／previous change ＋ Revert and Save

`cmd/ctrl+alt+z` 跳到下一個有改動的檔案，`cmd/ctrl+alt+a` 跳到上一個，`alt+q` 把游標
所在的那個 hunk 還原並存檔。

VSCode 內建的 **Go to Next/Previous Change**（`workbench.action.editor.nextChange`／
`previousChange`）處理的是「同一個檔案裡的下一處改動」；**跨檔案那一步沒有內建命令**，
而那正是 review 一個 branch 時按最多次的一步。要單檔的那組，直接在
`keybindings.json` 綁內建命令即可，這裡不重做。

- 順序是**路徑排序**，不是 git 回報的順序——同一顆按鍵按兩次得走同一條路，git 的順序
  不保證，而「下一個」有時候往回跳比沒有這個命令還糟。
- 游標所在的檔案**不必**在清單裡：從一個沒改動的檔案開始 review 是常態，所以會落在
  該方向上最近的那一個，而不是跳回清單開頭。
- 兩端都會繞回去。停在最後一個只會讓按鍵看起來壞掉，而且沒地方說明為什麼。
- 同一個檔案同時有 staged 與 unstaged 改動時只算一站。
- 開檔後會落在該檔的第一處（往回時是最後一處）改動上。剛開的檔案 quick diff 是非同步
  算出來的，所以這裡會短暫重試——否則第一次按下去會停在檔案開頭，那是我們唯一確定
  改動不在的地方。
- **Revert and Save** 是 `git.revertSelectedRanges` ＋存檔兩件內建動作合成一個手勢。
  只還原不存檔的話，真正算數的是下一次存檔，在那之前磁碟上的檔案跟編輯器裡看到的不一致。

需要內建的 git extension；它被停用時會講出來，不會靜靜地沒反應。

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
