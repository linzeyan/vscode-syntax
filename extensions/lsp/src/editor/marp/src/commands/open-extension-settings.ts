import { commands } from 'vscode'

export const command = 'poly.marp.openExtensionSettings'

export default async function openExtensionSettings() {
  await commands.executeCommand(
    'workbench.action.openSettings',
    '@ext:ricky.poly-lsp poly.marp',
  )
}
