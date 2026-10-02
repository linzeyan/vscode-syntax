// mhutchie.git-graph's own data layer, loaded from where VSCode installed it,
// so poly's Git Graph can be compared against the real thing rather than
// against a reading of it.
//
// Its licence allows using it but not distributing anything derived from it,
// which is why this loads the user's copy at run time and nothing of it is
// checked in. The vscode module is a stub of the dozen members its data layer
// touches, answering every setting with Git Graph's default.
"use strict";
const fs = require("fs");
const Module = require("module");
const os = require("os");
const path = require("path");

function installed() {
  const dir = path.join(os.homedir(), ".vscode", "extensions");
  const found = fs.existsSync(dir) ? fs.readdirSync(dir).filter((d) => d.startsWith("mhutchie.git-graph-")).sort() : [];
  if (found.length === 0) {
    throw new Error(`mhutchie.git-graph is not installed under ${dir}; the comparison needs it`);
  }
  return path.join(dir, found[found.length - 1]);
}

class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (listener) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    };
  }
  fire(value) {
    this.listeners.forEach((listener) => listener(value));
  }
  dispose() {}
}

const stub = {
  ViewColumn: {
    Active: -1,
    Beside: -2,
    One: 1,
    Two: 2,
    Three: 3,
    Four: 4,
    Five: 5,
    Six: 6,
    Seven: 7,
    Eight: 8,
    Nine: 9,
  },
  Uri: { file: (fsPath) => ({ fsPath, scheme: "file", toString: () => `file://${fsPath}` }) },
  EventEmitter,
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({ get: (_key, fallback) => fallback, inspect: () => undefined }),
  },
  window: {},
  env: {},
  commands: {},
};

function load() {
  const root = installed();
  const resolve = Module._resolveFilename;
  Module._resolveFilename = function(request, ...rest) {
    return request === "vscode" ? "vscode" : resolve.call(this, request, ...rest);
  };
  require.cache.vscode = { id: "vscode", filename: "vscode", loaded: true, exports: stub };
  const { DataSource } = require(path.join(root, "out", "dataSource.js"));
  const nothing = () => ({ dispose() {} });
  const logger = { log() {}, logCmd() {}, logError() {} };
  const version =
    /(\d+\.\d+\.\d+)/.exec(require("child_process").execFileSync("git", ["--version"], { encoding: "utf8" }))[1];
  const source = new DataSource({ path: "git", version }, nothing, nothing, logger);
  return { source, version: path.basename(root) };
}

module.exports = { load };
