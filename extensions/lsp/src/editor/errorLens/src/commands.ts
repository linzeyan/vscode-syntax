import { codeLensOnClickCommand } from 'src/commands/codeLensOnClickCommand';
import { copyProblemCodeCommand } from 'src/commands/copyProblemCodeCommand';
import { copyProblemMessageCommand } from 'src/commands/copyProblemMessageCommand';
import { disableLineCommand } from 'src/commands/disableLineCommand';
import { excludeProblemCommand } from 'src/commands/excludeProblemCommand';
import { findLinterRuleDefinitionCommand } from 'src/commands/findLinterRuleDefinitionCommand';
import { revealLineCommand } from 'src/commands/revealLineCommand';
import { searchForProblemCommand } from 'src/commands/searchForProblemCommand';
import { selectProblemCommand } from 'src/commands/selectProblemCommand';
import { statusBarCommand } from 'src/commands/statusBarCommand';
import { toggleEnabledLevels } from 'src/commands/toggleEnabledLevels';
import { toggleWorkspaceCommand } from 'src/commands/toggleWorkspaceCommand';
import { updateEverythingCommand } from 'src/commands/updateEverythingCommand';
import { $config } from 'src/extension';
import { vscodeUtils } from 'src/utils/vscodeUtils';
import { commands, type ExtensionContext } from 'vscode';

/**
 * All command ids contributed by this extensions.
 */
export const enum CommandId {
	// ──── User facing ───────────────────────────────────────────
	Toggle = 'poly.errorLens.toggle',
	ToggleError = 'poly.errorLens.toggleError',
	ToggleWarning = 'poly.errorLens.toggleWarning',
	ToggleInfo = 'poly.errorLens.toggleInfo',
	ToggleHint = 'poly.errorLens.toggleHint',
	ToggleInlineMessage = 'poly.errorLens.toggleInlineMessage',
	/** {@link toggleWorkspaceCommand} */
	ToggleWorkspace = 'poly.errorLens.toggleWorkspace',
	/** {@link copyProblemMessageCommand} */
	CopyProblemMessage = 'poly.errorLens.copyProblemMessage',
	/** {@link copyProblemCodeCommand} */
	CopyProblemCode = 'poly.errorLens.copyProblemCode',
	/** {@link selectProblemCommand} */
	SelectProblem = 'poly.errorLens.selectProblem',
	/** {@link findLinterRuleDefinitionCommand} */
	FindLinterRuleDefinition = 'poly.errorLens.findLinterRuleDefinition',
	/** {@link searchForProblemCommand} */
	SearchForProblem = 'poly.errorLens.searchForProblem',
	/** {@link disableLineCommand} */
	DisableLine = 'poly.errorLens.disableLine',
	/** {@link updateEverythingCommand} */
	UpdateEverything = 'poly.errorLens.updateEverything',
	// ──── Internal ──────────────────────────────────────────────
	/** {@link statusBarCommand} */
	StatusBarCommand = 'poly.errorLens.statusBarCommand',
	/** {@link revealLineCommand} */
	RevealLine = 'poly.errorLens.revealLine',
	/** {@link excludeProblemCommand} */
	ExcludeProblem = 'poly.errorLens.excludeProblem',
	/** {@link codeLensOnClickCommand} */
	CodeLensOnClick = 'poly.errorLens.codeLensOnClick',
}

/**
 * Register all commands contributed by this extension.
 */
export function registerAllCommands(context: ExtensionContext): void {
	// ────────────────────────────────────────────────────────────
	// ──── Global commands ───────────────────────────────────────
	// ────────────────────────────────────────────────────────────
	context.subscriptions.push(commands.registerCommand(CommandId.Toggle, () => {
		vscodeUtils.updateGlobalSetting('poly.errorLens.enabled', !$config.enabled);
	}));
	context.subscriptions.push(commands.registerCommand(CommandId.ToggleError, () => {
		toggleEnabledLevels('error', $config.enabledDiagnosticLevels);
	}));
	context.subscriptions.push(commands.registerCommand(CommandId.ToggleWarning, () => {
		toggleEnabledLevels('warning', $config.enabledDiagnosticLevels);
	}));
	context.subscriptions.push(commands.registerCommand(CommandId.ToggleInfo, () => {
		toggleEnabledLevels('info', $config.enabledDiagnosticLevels);
	}));
	context.subscriptions.push(commands.registerCommand(CommandId.ToggleHint, () => {
		toggleEnabledLevels('hint', $config.enabledDiagnosticLevels);
	}));
	context.subscriptions.push(commands.registerCommand(CommandId.ToggleInlineMessage, () => {
		vscodeUtils.toggleGlobalBooleanSetting('poly.errorLens.messageEnabled');
	}));
	context.subscriptions.push(commands.registerCommand(CommandId.ToggleWorkspace, toggleWorkspaceCommand));
	context.subscriptions.push(commands.registerCommand(CommandId.UpdateEverything, updateEverythingCommand));

	context.subscriptions.push(commands.registerCommand(CommandId.FindLinterRuleDefinition, findLinterRuleDefinitionCommand));
	context.subscriptions.push(commands.registerCommand(CommandId.SearchForProblem, searchForProblemCommand));
	context.subscriptions.push(commands.registerCommand(CommandId.CopyProblemCode, copyProblemCodeCommand));
	context.subscriptions.push(commands.registerCommand(CommandId.DisableLine, disableLineCommand));
	context.subscriptions.push(commands.registerCommand(CommandId.CopyProblemMessage, copyProblemMessageCommand));
	context.subscriptions.push(commands.registerCommand(CommandId.ExcludeProblem, excludeProblemCommand));
	// ────────────────────────────────────────────────────────────
	// ──── Text Editor commands ──────────────────────────────────
	// ────────────────────────────────────────────────────────────
	context.subscriptions.push(commands.registerTextEditorCommand(CommandId.SelectProblem, selectProblemCommand));
	// ────────────────────────────────────────────────────────────
	// ──── Internal commands ─────────────────────────────────────
	// ────────────────────────────────────────────────────────────
	context.subscriptions.push(commands.registerCommand(CommandId.CodeLensOnClick, codeLensOnClickCommand));
	context.subscriptions.push(commands.registerCommand(CommandId.RevealLine, revealLineCommand));
	context.subscriptions.push(commands.registerCommand(CommandId.StatusBarCommand, statusBarCommand));
}
