# mushan.vscode-paste-image's clipboard scripts

`mac.applescript`, `pc.ps1` and `linux.sh` are `res/` from the marketplace's
[mushan.vscode-paste-image](https://github.com/mushanshitiancai/vscode-paste-image) 1.0.4 VSIX. An extension has no API
for an image on the clipboard, so each platform's own tool reads it: `osascript`, PowerShell's `System.Windows.Clipboard`,
`xclip`.

`mac.applescript` is the VSIX's copy, UTF-16 with a byte order mark, not the repository's: the two differ in encoding, and
the VSIX's is the one users ran. `pc.ps1` and `linux.sh` are byte for byte the repository's at
`fb795320aedea24a03e5c7d43d1059e4080277b3`.

MIT (`LICENSE.txt`, from the repository).

`out/src/extension.js` is not here. poly's version of it is `../pasteImage.ts` and `../pasteImagePaths.ts`.

The files are kept as upstream wrote them, so that a new release can be diffed in. `poly.toml` leaves them out of poly's
own formatting and lint for the same reason. Only one line differs:

- `pc.ps1` opens the file with `Create` rather than `OpenOrCreate`. `OpenOrCreate` does not truncate, so replacing an
  image with a smaller one left the old one's tail on the end of the file.
