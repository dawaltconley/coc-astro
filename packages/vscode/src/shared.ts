import {
	commands,
	ConfigurationChangeEvent,
	ExtensionContext,
	TextDocument,
  DidChangeTextDocumentParams,
  TextDocumentContentChange,
	// TextDocumentChangeEvent,
	// ViewColumn,
	window,
	workspace,
} from 'coc.nvim';
import { BaseLanguageClient, LanguageClientOptions } from 'vscode-languageclient';
import * as fileReferences from './features/fileReferences';

// Files we want to watch for file updates, this only includes files where we actually care
// about the content, so HTML components and Markdown files are not included
const supportedFileExtensions = [
	'astro',
	'cjs',
	'mjs',
	'js',
	'jsx',
	'cts',
	'mts',
	'ts',
	'tsx',
	'json',
	'vue',
	'svelte',
] as const;

export function getInitOptions(env: 'node' | 'browser', typescript: any): LanguageClientOptions {
	return {
		documentSelector: [{ scheme: 'file', language: 'astro' }],
		synchronize: {
			fileEvents: workspace.createFileSystemWatcher(
				`{${supportedFileExtensions.map((ext) => `**/*.${ext}`).join(',')}}`,
				false,
				false,
				false
			),
		},
		initializationOptions: {
			typescript,
			environment: env,
		},
	};
}

export function commonActivate(context: ExtensionContext, client: BaseLanguageClient, tsVersion: any) {
	workspace.onDidChangeConfiguration((e: ConfigurationChangeEvent) =>
		tsVersion.onDidChangeConfiguration(e, context, client)
	);

	// Restart the language server if any critical files that are outside our jurisdiction got changed (tsconfig, jsconfig etc)
	workspace.onDidSaveTextDocument(async (doc: TextDocument) => {
		const fileName = doc.uri.split(/\/|\\/).pop() ?? doc.uri;
		if ([/^tsconfig\.json$/, /^jsconfig\.json$/].some((regex) => regex.test(fileName))) {
			await restartClient(false);
		}
	});

	// Handle unsaved changes for non-Astro files like TypeScript does
	// workspace.onDidChangeTextDocument((params: DidChangeTextDocumentParams) => {
	// 	if (
	// 		supportedFileExtensions.filter((ext) => ext !== 'astro').some((ext) => params.textDocument.uri.endsWith(ext))
	// 	) {
	// 		// Partial updates are only supported for files TypeScript natively understand. For svelte and vue files, we'll
	// 		// instead send the full text and recreate a snapshot server-side with the new content
	// 		const supportPartialUpdate = !['vue', 'svelte'].includes(params.document.languageId);
	// 		getLSClient().sendNotification('$/onDidChangeNonAstroFile', {
	// 			uri: params.textDocument.uri,
	// 			...(supportPartialUpdate
	// 				? {
	// 						changes: params.contentChanges.map((c: TextDocumentContentChange) => ({
	// 							range: {
	// 								start: { line: c.range.start.line, character: c.range.start.character },
	// 								end: { line: c.range.end.line, character: c.range.end.character },
	// 							},
	// 							text: c.text,
	// 						})),
	// 				  }
	// 				// : { text: params.document.getText() }),
	// 				: { text: fs.readFileSync(params.textDocument.uri) }),
	// 		});
	// 	}
	// });

	context.subscriptions.push(
		commands.registerCommand('astro.restartLanguageServer', async (showNotification = true) => {
			await restartClient(showNotification);
		}),
		commands.registerCommand('astro.showTSXOutput', async () => {
			const content = await getLSClient().sendRequest<string | undefined>(
				'$/getTSXOutput',
				window.activeTextEditor?.document.uri.toString()
			);

			if (content) {
				const document = await workspace.openTextDocument({ content, language: 'typescriptreact' });

				await window.showTextDocument(document, {
					preview: true,
					viewColumn: ViewColumn.Beside,
				});
			} else {
				window.showErrorMessage("Could not open the current document's TSX output");
			}
		}),
		commands.registerCommand('astro.selectTypescriptVersion', () => tsVersion.selectVersionCommand(context, client)),
		commands.registerCommand('astro.findFileReferences', () =>
			fileReferences.findFileReferences(window.activeTextEditor?.document.uri, getLSClient())
		)
	);

	let restartingClient = false;
	async function restartClient(showNotification: boolean) {
		if (restartingClient) {
			return;
		}

		restartingClient = true;

		await client.stop();
		await client.start();

		if (showNotification) {
			window.showInformationMessage('Astro language server restarted.');
		}

		restartingClient = false;
	}

	function getLSClient() {
		return client;
	}
}
