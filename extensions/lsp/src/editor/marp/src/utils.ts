import { AbortController as AbortControllerShim } from 'abort-controller'
import fetchPonyfill from 'fetch-ponyfill'
import { ConfigurationChangeEvent, TextDocument, Uri, workspace } from 'vscode'

export const _fetchPonyfillInstance = fetchPonyfill()

interface FetchOption {
  timeout?: number
}

export const frontMatterRegex = /^(-{3,}\s*$\n)([\s\S]*?)^(\s*[-.]{3})/m

export const marpDirectiveRegex = /^(marp\s*: +)(.*)\s*$/m

export const detectFrontMatter = (markdown: string): string | undefined => {
  const m = markdown.match(frontMatterRegex)
  return m?.index === 0 ? m[2] : undefined
}

export const detectMarpDocument = (doc: TextDocument): boolean =>
  doc.languageId === 'markdown' && detectMarpFromMarkdown(doc.getText())

export const detectMarpFromMarkdown = (markdown: string): boolean => {
  if (!marpConfiguration().get<boolean>('enabled', true)) return false

  const frontmatter = detectFrontMatter(markdown)
  if (!frontmatter) return false

  const matched = marpDirectiveRegex.exec(frontmatter)
  return matched ? matched[2] === 'true' : false
}

export const fetch = (url: string, { timeout = 5000 }: FetchOption = {}) => {
  const controller = new AbortControllerShim() as AbortController
  const timeoutCallback = setTimeout(() => controller.abort(), timeout)

  return _fetchPonyfillInstance
    .fetch(url, { signal: controller.signal })
    .then((res) => {
      if (!res.ok) throw new Error(`Failed fetching ${url} (${res.status})`)
      return res.text()
    })
    .finally(() => {
      clearTimeout(timeoutCallback)
    })
}

export const marpConfiguration = () =>
  workspace.getConfiguration('poly.marp')

// poly: Poly's settings are one `poly` object, and the editor reports a change
// anywhere in it as a change to `poly` alone, so `affectsConfiguration` cannot
// tell `poly.marp.html` from any other key. This compares the section's value
// with the one this caller saw last -- call it on every event.
export const watchSetting = (section: string) => {
  let last = JSON.stringify(workspace.getConfiguration().get(section))
  return (e: ConfigurationChangeEvent) => {
    if (!e.affectsConfiguration('poly')) return false
    const now = JSON.stringify(workspace.getConfiguration().get(section))
    const changed = now !== last
    last = now
    return changed
  }
}

export const mathTypesettingConfiguration = () => {
  const conf = marpConfiguration().get<'off' | 'katex' | 'mathjax'>(
    'mathTypesetting',
  )
  return conf ?? 'mathjax'
}

export const textEncoder = new globalThis.TextEncoder()
export const textDecoder = new globalThis.TextDecoder()

export const readFile = async (target: Uri) =>
  textDecoder.decode(await workspace.fs.readFile(target))

export const writeFile = (target: Uri, text: string) =>
  workspace.fs.writeFile(target, textEncoder.encode(text))

export const unlink = (target: Uri) =>
  workspace.fs.delete(target, { useTrash: false })

export const hasToString = (
  target: unknown,
): target is { toString(): string } => {
  switch (typeof target) {
    case 'object':
      return typeof target?.toString === 'function'
    case 'bigint':
    case 'boolean':
    case 'function':
    case 'number':
    case 'string':
    case 'symbol':
      return true
  }
  return false
}
