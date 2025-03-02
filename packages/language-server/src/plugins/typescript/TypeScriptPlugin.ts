import type { TSXResult } from '@astrojs/compiler/types';
import {
	CancellationToken,
	CodeAction,
	CodeActionContext,
	CompletionContext,
	DefinitionLink,
	Diagnostic,
	FileChangeType,
	FoldingRange,
	Hover,
	InlayHint,
	Location,
	Position,
	Range,
	ReferenceContext,
	SemanticTokens,
	SignatureHelp,
	SignatureHelpContext,
	SymbolInformation,
	TextDocumentContentChangeEvent,
	WorkspaceEdit,
} from 'vscode-languageserver';
import type { ConfigManager, LSTypescriptConfig } from '../../core/config';
import type { AstroDocument } from '../../core/documents';
import type { AppCompletionItem, AppCompletionList, OnWatchFileChangesParam, Plugin } from '../interfaces';
import astro2tsx from './astro2tsx';
import { CodeActionsProviderImpl } from './features/CodeActionsProvider';
import { CompletionItemData, CompletionsProviderImpl } from './features/CompletionsProvider';
import { DefinitionsProviderImpl } from './features/DefinitionsProvider';
import { DiagnosticsProviderImpl } from './features/DiagnosticsProvider';
import { DocumentSymbolsProviderImpl } from './features/DocumentSymbolsProvider';
import { FileReferencesProviderImpl } from './features/FileReferencesProvider';
import { FoldingRangesProviderImpl } from './features/FoldingRangesProvider';
import { HoverProviderImpl } from './features/HoverProvider';
import { ImplementationsProviderImpl } from './features/ImplementationsProvider';
import { InlayHintsProviderImpl } from './features/InlayHintsProvider';
import { FindReferencesProviderImpl } from './features/ReferencesProvider';
import { RenameProviderImpl } from './features/RenameProvider';
import { SemanticTokensProviderImpl } from './features/SemanticTokenProvider';
import { SignatureHelpProviderImpl } from './features/SignatureHelpProvider';
import { TypeDefinitionsProviderImpl } from './features/TypeDefinitionsProvider';
import type { LanguageServiceManager } from './LanguageServiceManager';
import { getScriptKindFromFileName, isAstroFilePath, isFrameworkFilePath } from './utils';

export class TypeScriptPlugin implements Plugin {
	__name = 'typescript';

	private configManager: ConfigManager;
	private readonly languageServiceManager: LanguageServiceManager;

	private readonly codeActionsProvider: CodeActionsProviderImpl;
	private readonly completionProvider: CompletionsProviderImpl;
	private readonly hoverProvider: HoverProviderImpl;
	private readonly fileReferencesProvider: FileReferencesProviderImpl;
	private readonly definitionsProvider: DefinitionsProviderImpl;
	private readonly typeDefinitionsProvider: TypeDefinitionsProviderImpl;
	private readonly implementationsProvider: ImplementationsProviderImpl;
	private readonly referencesProvider: FindReferencesProviderImpl;
	private readonly signatureHelpProvider: SignatureHelpProviderImpl;
	private readonly diagnosticsProvider: DiagnosticsProviderImpl;
	private readonly documentSymbolsProvider: DocumentSymbolsProviderImpl;
	private readonly inlayHintsProvider: InlayHintsProviderImpl;
	private readonly semanticTokensProvider: SemanticTokensProviderImpl;
	private readonly foldingRangesProvider: FoldingRangesProviderImpl;
	private readonly renameProvider: RenameProviderImpl;

	private readonly ts: typeof import('typescript/lib/tsserverlibrary');

	constructor(configManager: ConfigManager, languageServiceManager: LanguageServiceManager) {
		this.configManager = configManager;
		this.languageServiceManager = languageServiceManager;
		this.ts = languageServiceManager.docContext.ts;

		this.codeActionsProvider = new CodeActionsProviderImpl(this.languageServiceManager, this.configManager);
		this.completionProvider = new CompletionsProviderImpl(this.languageServiceManager, this.configManager);
		this.hoverProvider = new HoverProviderImpl(this.languageServiceManager);
		this.fileReferencesProvider = new FileReferencesProviderImpl(this.languageServiceManager);
		this.definitionsProvider = new DefinitionsProviderImpl(this.languageServiceManager);
		this.typeDefinitionsProvider = new TypeDefinitionsProviderImpl(this.languageServiceManager);
		this.implementationsProvider = new ImplementationsProviderImpl(this.languageServiceManager);
		this.referencesProvider = new FindReferencesProviderImpl(this.languageServiceManager);
		this.signatureHelpProvider = new SignatureHelpProviderImpl(this.languageServiceManager);
		this.diagnosticsProvider = new DiagnosticsProviderImpl(this.languageServiceManager);
		this.documentSymbolsProvider = new DocumentSymbolsProviderImpl(this.languageServiceManager);
		this.semanticTokensProvider = new SemanticTokensProviderImpl(this.languageServiceManager);
		this.inlayHintsProvider = new InlayHintsProviderImpl(this.languageServiceManager, this.configManager);
		this.foldingRangesProvider = new FoldingRangesProviderImpl(this.languageServiceManager);
		this.renameProvider = new RenameProviderImpl(this.languageServiceManager, this.configManager);
	}

	async doHover(document: AstroDocument, position: Position): Promise<Hover | null> {
		if (!(await this.featureEnabled(document, 'hover'))) {
			return null;
		}

		return this.hoverProvider.doHover(document, position);
	}

	async prepareRename(document: AstroDocument, position: Position): Promise<Range | null> {
		return this.renameProvider.prepareRename(document, position);
	}

	async rename(document: AstroDocument, position: Position, newName: string): Promise<WorkspaceEdit | null> {
		return this.renameProvider.rename(document, position, newName);
	}

	async getFoldingRanges(document: AstroDocument): Promise<FoldingRange[] | null> {
		return this.foldingRangesProvider.getFoldingRanges(document);
	}

	async getSemanticTokens(
		document: AstroDocument,
		range?: Range,
		cancellationToken?: CancellationToken
	): Promise<SemanticTokens | null> {
		if (!(await this.featureEnabled(document, 'semanticTokens'))) {
			return null;
		}

		return this.semanticTokensProvider.getSemanticTokens(document, range, cancellationToken);
	}

	async getDocumentSymbols(document: AstroDocument): Promise<SymbolInformation[]> {
		if (!(await this.featureEnabled(document, 'documentSymbols'))) {
			return [];
		}

		const symbols = await this.documentSymbolsProvider.getDocumentSymbols(document);

		return symbols;
	}

	async getCodeActions(
		document: AstroDocument,
		range: Range,
		context: CodeActionContext,
		cancellationToken?: CancellationToken
	): Promise<CodeAction[]> {
		if (!(await this.featureEnabled(document, 'codeActions'))) {
			return [];
		}

		return this.codeActionsProvider.getCodeActions(document, range, context, cancellationToken);
	}

	async getCompletions(
		document: AstroDocument,
		position: Position,
		completionContext?: CompletionContext,
		cancellationToken?: CancellationToken
	): Promise<AppCompletionList<CompletionItemData> | null> {
		if (!(await this.featureEnabled(document, 'completions'))) {
			return null;
		}

		const completions = await this.completionProvider.getCompletions(
			document,
			position,
			completionContext,
			cancellationToken
		);

		return completions;
	}

	async resolveCompletion(
		document: AstroDocument,
		completionItem: AppCompletionItem<CompletionItemData>,
		cancellationToken?: CancellationToken
	): Promise<AppCompletionItem<CompletionItemData>> {
		return this.completionProvider.resolveCompletion(document, completionItem, cancellationToken);
	}

	async getInlayHints(document: AstroDocument, range: Range): Promise<InlayHint[]> {
		return this.inlayHintsProvider.getInlayHints(document, range);
	}

	async fileReferences(document: AstroDocument): Promise<Location[] | null> {
		return this.fileReferencesProvider.fileReferences(document);
	}

	async getDefinitions(document: AstroDocument, position: Position): Promise<DefinitionLink[]> {
		return this.definitionsProvider.getDefinitions(document, position);
	}

	async getTypeDefinitions(document: AstroDocument, position: Position): Promise<Location[] | null> {
		return this.typeDefinitionsProvider.getTypeDefinitions(document, position);
	}

	async getImplementation(document: AstroDocument, position: Position): Promise<Location[] | null> {
		return this.implementationsProvider.getImplementation(document, position);
	}

	async findReferences(
		document: AstroDocument,
		position: Position,
		context: ReferenceContext
	): Promise<Location[] | null> {
		return this.referencesProvider.findReferences(document, position, context);
	}

	async getDiagnostics(document: AstroDocument, cancellationToken?: CancellationToken): Promise<Diagnostic[]> {
		if (!(await this.featureEnabled(document, 'diagnostics'))) {
			return [];
		}

		return this.diagnosticsProvider.getDiagnostics(document, cancellationToken);
	}

	async onWatchFileChanges(onWatchFileChangesParas: OnWatchFileChangesParam[]): Promise<void> {
		let doneUpdateProjectFiles = false;

		for (const { fileName, changeType } of onWatchFileChangesParas) {
			const scriptKind = getScriptKindFromFileName(fileName, this.ts);

			if (scriptKind === this.ts.ScriptKind.Unknown && !isFrameworkFilePath(fileName) && !isAstroFilePath(fileName)) {
				continue;
			}

			if (changeType === FileChangeType.Created && !doneUpdateProjectFiles) {
				doneUpdateProjectFiles = true;
				await this.languageServiceManager.updateProjectFiles();
			} else if (changeType === FileChangeType.Deleted) {
				await this.languageServiceManager.deleteSnapshot(fileName);
			} else if (!isAstroFilePath(fileName)) {
				// Content updates for Astro files are handled through the documentManager and the 'documentChange' event
				await this.languageServiceManager.updateExistingNonAstroFile(fileName);
			}
		}
	}

	async updateNonAstroFile(fileName: string, changes: TextDocumentContentChangeEvent[], text?: string): Promise<void> {
		await this.languageServiceManager.updateExistingNonAstroFile(fileName, changes, text);
	}

	async getSignatureHelp(
		document: AstroDocument,
		position: Position,
		context: SignatureHelpContext | undefined,
		cancellationToken?: CancellationToken
	): Promise<SignatureHelp | null> {
		return this.signatureHelpProvider.getSignatureHelp(document, position, context, cancellationToken);
	}

	getTSXForDocument(document: AstroDocument): TSXResult {
		return astro2tsx(document.getText(), document.getURL());
	}

	/**
	 * @internal Public for tests only
	 */
	public getSnapshotManager(fileName: string) {
		return this.languageServiceManager.getSnapshotManager(fileName);
	}

	private async featureEnabled(document: AstroDocument, feature: keyof LSTypescriptConfig) {
		return (
			(await this.configManager.isEnabled(document, 'typescript')) &&
			(await this.configManager.isEnabled(document, 'typescript', feature))
		);
	}
}
