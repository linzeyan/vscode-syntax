# usernamehw.errorlens

`src/` and the gutter icons in `../../../media/errorLens/` are from
[usernamehw/vscode-error-lens](https://github.com/usernamehw/vscode-error-lens) v3.29.0 (commit
`d5805dc482dbb86133cd398606b20aa663441ffd`). `src/` is upstream's whole; its webpack and ESLint configuration stay
behind, and upstream has no tests. The icons are `img/`'s three sets, without the extension's own icon and its demo
picture. MIT (`LICENSE.txt`).

poly's side of it is `../errorLens.ts`, which decides when this loads, and `tsconfig.errorLens.json`, which checks it
with upstream's compiler options. The bundle is `dist/errorLens/extension.js`, built on its own so that nothing of it
loads until Error Lens is switched on or one of its commands is run.

The files are kept as upstream wrote them, so that a new release can be diffed in. `poly.toml` leaves them out of poly's
own formatting and lint for the same reason. What differs:

- Names. The settings are `poly.errorLens.*` rather than `errorLens.*` (`types.ts`'s `SettingsPrefix`, and the setting
  names written out in `commands.ts`, `commands/toggleEnabledLevels.ts`, `commands/toggleWorkspaceCommand.ts`,
  `decorations.ts` and `hover/hover.ts`), the commands `poly.errorLens.*` (`commands.ts`, where upstream's one
  lower-case `errorlens.toggleWorkspace` becomes `poly.errorLens.toggleWorkspace`) and the colors `poly.errorLens.*`
  (`decorations.ts`, `statusBar/statusBarIcons.ts`). With usernamehw.errorlens installed as well, the same names would
  collide, and VSCode refuses a second command by an id already taken. `types.ts`'s `ExtensionId` is poly's, so the
  "Show Settings" buttons search poly's settings.
- `activate` in `extension.ts` takes a second argument, `standAside`, and draws nothing while it returns true, and it
  returns the function that rereads the settings and redraws. That is how poly stands aside while usernamehw.errorlens
  is installed and enabled: upstream's own configuration listener redraws too, and it would draw again otherwise.
- `gutter.ts` reads the icons from `media/errorLens/` rather than `img/`.
- lodash is lodash-es, which poly already ships: `tsconfig.errorLens.json` and the build map `lodash/debounce` and
  `lodash/throttle` onto it, as they map the `src/...` imports onto this directory.

The manifest is upstream's, renamed, except:

- `poly.errorLens.enabled` is `false` until switched on, like the rest of poly's editor features, and comes first in its
  group.
- `errorLens.experimental` is left out. It is an empty object whose one key, `fixNotebookStaleProblems1`, appears in
  `types.ts` and nowhere else, so no value of it does anything.
- The commands have no `description`. VSCode shows it nowhere.
- Every description is poly's, in English and Traditional Chinese, and the demo links point at v3.29.0's docs rather than
  `master`. Upstream's descriptions of `delayMode`'s values are each one off: `new` clears the messages while typing
  and brings them back after the delay, `old` delays new problems and drops fixed ones at once, and `debounce` delays
  every update. poly's describe what the code does.
