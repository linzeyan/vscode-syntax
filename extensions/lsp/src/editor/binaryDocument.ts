/**
 * A drawing kept in a file that is not edited as text -- a PNG with the
 * drawing inside, or a scene the page rewrites whole -- for a custom editor:
 * the page replaces the bytes, and VSCode saves, reverts and backs them up.
 * The Excalidraw and draw.io editors both keep theirs here.
 */
import * as vscode from "vscode";

export class BinaryDocument implements vscode.CustomDocument {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly reverted = new vscode.EventEmitter<void>();
  /** The page still shows the edits a revert threw away; it has to reload. */
  readonly onDidRevert = this.reverted.event;
  private readonly disposed = new vscode.EventEmitter<void>();
  readonly onDidDispose = this.disposed.event;

  constructor(readonly uri: vscode.Uri, public content: Uint8Array) {}

  update(content: Uint8Array) {
    this.content = content;
    this.changed.fire();
  }

  async revert() {
    this.content = await vscode.workspace.fs.readFile(this.uri);
    this.reverted.fire();
  }

  // pomdtr's save did not wait for the write: VSCode marked the file saved
  // before it was, and a failed write went unreported.
  save() {
    return this.saveAs(this.uri);
  }

  async saveAs(destination: vscode.Uri) {
    await vscode.workspace.fs.writeFile(destination, this.content);
  }

  async backup(destination: vscode.Uri): Promise<vscode.CustomDocumentBackup> {
    await this.saveAs(destination);
    return {
      id: destination.toString(),
      delete: () => vscode.workspace.fs.delete(destination).then(undefined, () => undefined),
    };
  }

  dispose() {
    this.disposed.fire();
    this.changed.dispose();
    this.reverted.dispose();
    this.disposed.dispose();
  }
}

/** The document half of such an editor; the page is the subclass's. */
export abstract class BinaryEditorProvider implements vscode.CustomEditorProvider<BinaryDocument> {
  private readonly changed = new vscode.EventEmitter<vscode.CustomDocumentContentChangeEvent<BinaryDocument>>();
  readonly onDidChangeCustomDocument = this.changed.event;

  /** `blank` is what a new, untitled file starts as. */
  constructor(private readonly blank: Uint8Array) {}

  async openCustomDocument(uri: vscode.Uri, open: vscode.CustomDocumentOpenContext) {
    // The backup first: pomdtr checked for an untitled file before it, so an
    // unsaved new drawing came back empty after VSCode restarted.
    const content = open.backupId
      ? await vscode.workspace.fs.readFile(vscode.Uri.parse(open.backupId))
      : uri.scheme === "untitled"
      ? this.blank
      : await vscode.workspace.fs.readFile(uri);
    const document = new BinaryDocument(uri, content);
    const listener = document.onDidChange(() => this.changed.fire({ document }));
    document.onDidDispose(() => listener.dispose());
    return document;
  }

  abstract resolveCustomEditor(document: BinaryDocument, panel: vscode.WebviewPanel): Promise<void> | void;

  saveCustomDocument(document: BinaryDocument) {
    return document.save();
  }

  saveCustomDocumentAs(document: BinaryDocument, destination: vscode.Uri) {
    return document.saveAs(destination);
  }

  revertCustomDocument(document: BinaryDocument) {
    return document.revert();
  }

  backupCustomDocument(document: BinaryDocument, backup: vscode.CustomDocumentBackupContext) {
    return document.backup(backup.destination);
  }
}
