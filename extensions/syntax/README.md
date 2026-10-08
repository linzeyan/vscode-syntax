# Poly Syntax Highlight

156 份 syntax highlighting 文法，一個 extension。輸出標準 TextMate scope，任何 VSCode
color theme 直接生效。唯一的執行期程式碼是更新檢查，平常不做任何事。

## 涵蓋

- **接管 49 個 VSCode 內建語言**：多數與內建同源，更新節奏由 poly 控制；rust 改用
  dustypomerleau/rust-syntax，scope 比內建細。
- **另加 49 個內建沒有的語言**：HCL／Terraform、nginx、zig、toml、go template、dotenv、
  protobuf、mermaid、svelte、graphql、jsonnet、just、nix、cabal、dune、ocaml、elixir、
  erlang、haskell、scala、caddyfile、systemd unit、apacheconf、ssh_config、jinja 家族、
  Solidity／Cairo／Vyper、DBML（含 snippets 與檔案圖示）、PlantUML（含 snippets），以及 csv／tsv 的 rainbow 欄位上色。

完整清單在 `package.json` 的 `contributes.languages`；授權與各文法釘住的 commit 在
THIRD-PARTY-NOTICES.md。文法一律從上游 repo／marketplace VSIX 以 pinned commit 同步，不手改。

## markdown 清單自動接續

在清單項目上按 Enter 接出同一層的下一項（`-`／`*`／`+`、`1.`／`1)`、`- [ ]`、`>`），內建
沒有這個行為。同一份規則也套用在 `SKILL.md`、`*.prompt.md`、`*.instructions.md`、
`.claude/agents/**` 這些 VSCode 1.120 起不再算 `markdown` 的檔案上。

號碼不會遞增，空項目按 Enter 也不會結束清單——語言設定檔只能接一段固定文字。**裝了
Poly（poly-lsp）的話 Enter 由它接管**，兩者都有。

## 配色與開關

poly 不帶配色：文法只替 token 取名（scope），顏色是主題給的。

要改某個 scope 的顏色：裝了 Poly（poly-lsp）的話，settings.json 的 `poly` 區塊裡 `syntaxColors` 是一張
scope → 顏色的表，`Poly: Set Syntax Color` 從目前這個檔的全部 scope 挑一個寫進去。這個
extension 本身不帶設定——它沒有執行期程式碼能把設定套到主題上——所以只裝它的話，用 VSCode
本來就有的 `editor.tokenColorCustomizations.textMateRules`，scope 名稱用內建的
`Developer: Inspect Editor Tokens and Scopes` 查（一次一個，游標下的那個）。

**沒有「只關掉某一份文法」的開關**：VSCode 的文法是靜態註冊的，沒有任何 contribution point
能在執行期停用其中一份。唯一的關法是停用整個 extension；poly 不做按了沒作用的假開關。

## 設定與更新

背景檢查 GitHub Releases，有新版就提示一鍵更新。

| 設定                                   | 預設   | 作用                         |
| -------------------------------------- | ------ | ---------------------------- |
| `poly.syntax.updateCheck.enabled`      | `true` | 背景檢查新版                 |
| `poly.syntax.updateCheck.intervalDays` | `7`    | 檢查間隔，`0` 是每次啟動都查 |

跟 Poly（poly-lsp）的 `poly.updateCheck.*` 各自獨立。兩個都裝的話，哪一邊先發現新版就一起
更新兩個（同版號發佈），同一個視窗裡另一邊不會再問同一個版本。

## 授權

各文法保留上游授權，完整清單見 THIRD-PARTY-NOTICES.md（由同步管線產生，含 pin 版本）。
