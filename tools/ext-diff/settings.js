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

module.exports = { settingsOf };
