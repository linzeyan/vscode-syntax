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

## 授權

MIT，見 VSIX 內的 `LICENSE`。
