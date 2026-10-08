// A manifest's settings as one flat table, `poly.marp.enableHtml` to its
// schema, which is how the diff tools hold poly's against upstream's.
//
// poly's are not stored that way: they are one object setting, `poly`, with
// the schema nested and every default in a single object beside it (see
// extensions/lsp/src/editor/settingsBlock.ts). So `poly` is unfolded here, each
// key given its default. A key inside it has no scope of its own -- the object
// has one -- so the tools compare no scopes.

/** Every setting in `contributes.configuration`, by its full dotted name. */
function settingsOf(contributes) {
  const flat = {};
  for (const group of [contributes.configuration].flat()) {
    for (const [key, spec] of Object.entries(group.properties ?? {})) {
      if (key === "poly") {
        unfold(spec.properties, spec.default, "poly.", flat);
      } else {
        flat[key] = spec;
      }
    }
  }
  return flat;
}

function unfold(props, defaults, prefix, flat) {
  for (const [name, node] of Object.entries(props)) {
    // A key has a description of its own; a group of keys has none.
    if (node.description !== undefined || node.markdownDescription !== undefined) {
      flat[prefix + name] = { ...node, default: defaults?.[name] };
    } else {
      unfold(node.properties ?? {}, defaults?.[name], `${prefix}${name}.`, flat);
    }
  }
}

/**
 * `getConfiguration().update(key, value, target)` inside a host, for poly's
 * keys too: VSCode refuses a key inside an object setting, so `poly.x.y`
 * writes the whole `poly` object at that scope, as a hand edit would. Any
 * other key is written as asked, so one suite serves both sides.
 *
 * poly writes its block into the user's settings.json as it activates, and
 * until that edit is saved the editor refuses any other write to the file. A
 * suite that sets a key straight after activation waits it out.
 */
async function update(vscode, key, value, target) {
  const config = vscode.workspace.getConfiguration();
  if (!key.startsWith("poly.")) {
    return config.update(key, value, target);
  }
  for (let tries = 1;; tries += 1) {
    try {
      return await config.update("poly", withKey(vscode, config, key, value, target), target);
    } catch (error) {
      if (tries === 20 || !String(error).includes("unsaved changes")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

function withKey(vscode, config, key, value, target) {
  const { Global, WorkspaceFolder } = vscode.ConfigurationTarget;
  const seen = config.inspect("poly");
  const current = target === Global || target === true
    ? seen?.globalValue
    : target === WorkspaceFolder
    ? seen?.workspaceFolderValue
    : seen?.workspaceValue;
  const root = JSON.parse(JSON.stringify(current ?? {}));
  const path = key.split(".").slice(1);
  let node = root;
  for (const part of path.slice(0, -1)) {
    node = node[part] = node[part] !== null && typeof node[part] === "object" ? node[part] : {};
  }
  if (value === undefined) {
    delete node[path.at(-1)];
  } else {
    node[path.at(-1)] = value;
  }
  return root;
}

module.exports = { settingsOf, update };
