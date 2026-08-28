# Poly Syntax

統一 syntax highlighting 文法包（批次 1：25 語言）。文法一律從上游 repo／marketplace VSIX
以 pinned 版本同步（`grammars/sources.json` 為單一真相，`tools/grammar-sync.py` 產生本
extension 的 syntaxes 與 contributes），任何 VSCode color theme 直接生效。

## 涵蓋

- **接管內建**（與內建同源、由 poly 控制更新節奏）：swift、c#、lua、go、c、c++/cuda、
  xml/xsl、yaml、markdown（另加清單自動接續）、sql、dockerfile、shellscript；
  rust 採社群強化文法（dustypomerleau/rust-syntax）。
- **新增語言**：HCL、Terraform、nginx、zig、toml、go template（含 go/html/markdown
  injection）、dotenv、protobuf、mermaid（含 markdown code block injection）、svelte、
  graphql（含 js/ts/vue/svelte/python 內 gql template injection）、csv/tsv（rainbow 欄位上色）。

## 驗證覆蓋是否生效

開啟 `.rs` 檔 → `Developer: Inspect Editor Tokens and Scopes` → 游標放在 `->` 上，
scopes 應含 `keyword.operator.arrow.skinny.rust`（內建文法無此 scope）。

## 更新

poly-syntax 本身零執行期程式碼，更新提示由 poly-lint 代管（兩者同版號發佈、
一鍵同時更新）。只安裝 poly-syntax 的使用者請自行從 GitHub Releases 下載新版
VSIX 安裝。

## 授權

各文法保留上游授權，完整清單見隨附的 THIRD-PARTY-NOTICES.md（由同步管線自動產生，含 pin 版本）。
