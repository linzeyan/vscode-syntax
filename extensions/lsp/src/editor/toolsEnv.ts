import * as vscode from "vscode";

/**
 * The `poly.tools` setting, in the environment variable poly reads it from
 * (EDITOR_TOOLS in poly-core), for every poly this extension starts: the
 * daemon, the PlantUML jar lookup, and the commands it types into a terminal.
 *
 * Set even when empty, so a POLY_TOOLS the editor itself was started with
 * cannot stand in for settings that say nothing.
 */
export function toolsEnv(): { POLY_TOOLS: string } {
  const tools = vscode.workspace.getConfiguration("poly").get<Record<string, unknown>>("tools") ?? {};
  return {
    POLY_TOOLS: Object.entries(tools)
      // settings.json is hand-edited and the schema only warns; poly would
      // refuse the whole variable over one number.
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      // A JSON string is a TOML basic string, escapes included.
      .map(([name, value]) => `${JSON.stringify(name)} = ${JSON.stringify(value)}`)
      .join("\n"),
  };
}
