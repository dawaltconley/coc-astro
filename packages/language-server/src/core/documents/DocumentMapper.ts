import { generatedPositionFor, originalPositionFor, TraceMap } from '@jridgewell/trace-mapping';
import type ts from 'typescript';
import {
	CodeAction,
	ColorPresentation,
	CompletionItem,
	Diagnostic,
	FoldingRange,
	Hover,
	InsertReplaceEdit,
	LocationLink,
	Position,
	Range,
	SelectionRange,
	SymbolInformation,
	TextDocumentEdit,
	TextEdit,
} from 'vscode-languageserver';
import { DocumentSnapshot, ScriptTagDocumentSnapshot } from '../../plugins/typescript/snapshots/DocumentSnapshot';
import { getLineOffsets, offsetAt, positionAt, TagInformation } from './utils';

export interface DocumentMapper {
	/**
	 * Map the generated position to the original position
	 * @param generatedPosition Position in fragment
	 */
	getOriginalPosition(generatedPosition: Position): Position;

	/**
	 * Map the original position to the generated position
	 * @param originalPosition Position in parent
	 */
	getGeneratedPosition(originalPosition: Position): Position;

	/**
	 * Returns true if the given original position is inside of the generated map
	 * @param pos Position in original
	 */
	isInGenerated(pos: Position): boolean;

	/**
	 * Get document URL
	 */
	getURL(): string;

	/**
	 * Implement this if you need teardown logic before this mapper gets cleaned up.
	 */
	destroy?(): void;
}

/**
 * Does not map, returns positions as is.
 */
export class IdentityMapper implements DocumentMapper {
	constructor(private url: string, private parent?: DocumentMapper) {}

	getOriginalPosition(generatedPosition: Position): Position {
		if (this.parent) {
			generatedPosition = this.getOriginalPosition(generatedPosition);
		}

		return generatedPosition;
	}

	getGeneratedPosition(originalPosition: Position): Position {
		if (this.parent) {
			originalPosition = this.getGeneratedPosition(originalPosition);
		}

		return originalPosition;
	}

	isInGenerated(position: Position): boolean {
		if (this.parent && !this.parent.isInGenerated(position)) {
			return false;
		}

		return true;
	}

	getURL(): string {
		return this.url;
	}

	destroy() {
		this.parent?.destroy?.();
	}
}

/**
 * Maps positions in a fragment relative to a parent.
 */
export class FragmentMapper implements DocumentMapper {
	private lineOffsetsOriginal = getLineOffsets(this.originalText);
	private lineOffsetsGenerated = getLineOffsets(this.tagInfo.content);

	constructor(private originalText: string, private tagInfo: TagInformation, private url: string) {}

	getOriginalPosition(generatedPosition: Position): Position {
		const parentOffset = this.offsetInParent(
			offsetAt(generatedPosition, this.tagInfo.content, this.lineOffsetsGenerated)
		);
		return positionAt(parentOffset, this.originalText, this.lineOffsetsOriginal);
	}

	private offsetInParent(offset: number): number {
		return this.tagInfo.start + offset;
	}

	getGeneratedPosition(originalPosition: Position): Position {
		const fragmentOffset = offsetAt(originalPosition, this.originalText, this.lineOffsetsOriginal) - this.tagInfo.start;
		return positionAt(fragmentOffset, this.tagInfo.content, this.lineOffsetsGenerated);
	}

	isInGenerated(pos: Position): boolean {
		const offset = offsetAt(pos, this.originalText, this.lineOffsetsOriginal);
		return offset >= this.tagInfo.start && offset <= this.tagInfo.end;
	}

	getURL(): string {
		return this.url;
	}
}

export class SourceMapDocumentMapper implements DocumentMapper {
	constructor(protected traceMap: TraceMap, protected sourceUri: string, private parent?: DocumentMapper) {}

	getOriginalPosition(generatedPosition: Position): Position {
		if (this.parent) {
			generatedPosition = this.parent.getOriginalPosition(generatedPosition);
		}

		if (generatedPosition.line < 0) {
			return { line: -1, character: -1 };
		}

		const mapped = originalPositionFor(this.traceMap, {
			line: generatedPosition.line + 1,
			column: generatedPosition.character,
		});

		if (!mapped) {
			return { line: -1, character: -1 };
		}

		if (mapped.line === 0) {
			// eslint-disable-next-line no-console
			console.log('Got 0 mapped line from', generatedPosition, 'col was', mapped.column);
		}

		return {
			line: (mapped.line || 0) - 1,
			character: mapped.column || 0,
		};
	}

	getGeneratedPosition(originalPosition: Position): Position {
		if (this.parent) {
			originalPosition = this.parent.getGeneratedPosition(originalPosition);
		}

		const mapped = generatedPositionFor(this.traceMap, {
			line: originalPosition.line + 1,
			column: originalPosition.character,
			source: this.sourceUri,
		});

		if (!mapped) {
			return { line: -1, character: -1 };
		}

		const result = {
			line: (mapped.line || 0) - 1,
			character: mapped.column || 0,
		};

		if (result.line < 0) {
			return result;
		}

		return result;
	}

	isInGenerated(position: Position): boolean {
		if (this.parent && !this.isInGenerated(position)) {
			return false;
		}

		const generated = this.getGeneratedPosition(position);
		return generated.line >= 0;
	}

	getURL(): string {
		return this.sourceUri;
	}
}

export class ConsumerDocumentMapper extends SourceMapDocumentMapper {
	constructor(traceMap: TraceMap, sourceUri: string, private nrPrependesLines: number) {
		super(traceMap, sourceUri);
	}

	getOriginalPosition(generatedPosition: Position): Position {
		return super.getOriginalPosition(
			Position.create(generatedPosition.line - this.nrPrependesLines, generatedPosition.character)
		);
	}

	getGeneratedPosition(originalPosition: Position): Position {
		const result = super.getGeneratedPosition(originalPosition);
		result.line += this.nrPrependesLines;
		return result;
	}

	isInGenerated(): boolean {
		// always return true and map outliers case by case
		return true;
	}
}

export function mapRangeToOriginal(fragment: Pick<DocumentMapper, 'getOriginalPosition'>, range: Range): Range {
	// DON'T use Range.create here! Positions might not be mapped
	// and therefore return negative numbers, which makes Range.create throw.
	// These invalid position need to be handled
	// on a case-by-case basis in the calling functions.
	const originalRange = {
		start: fragment.getOriginalPosition(range.start),
		end: fragment.getOriginalPosition(range.end),
	};

	// Range may be mapped one character short - reverse that for "in the same line" cases
	if (
		originalRange.start.line === originalRange.end.line &&
		range.start.line === range.end.line &&
		originalRange.end.character - originalRange.start.character === range.end.character - range.start.character - 1
	) {
		originalRange.end.character += 1;
	}

	return originalRange;
}

export function mapRangeToGenerated(fragment: DocumentMapper, range: Range): Range {
	return Range.create(fragment.getGeneratedPosition(range.start), fragment.getGeneratedPosition(range.end));
}

export function mapCompletionItemToOriginal(
	fragment: Pick<DocumentMapper, 'getOriginalPosition'>,
	item: CompletionItem
): CompletionItem {
	if (!item.textEdit) {
		return item;
	}

	return {
		...item,
		textEdit: mapEditToOriginal(fragment, item.textEdit),
	};
}

export function mapHoverToParent(fragment: Pick<DocumentMapper, 'getOriginalPosition'>, hover: Hover): Hover {
	if (!hover.range) {
		return hover;
	}

	return { ...hover, range: mapRangeToOriginal(fragment, hover.range) };
}

export function mapObjWithRangeToOriginal<T extends { range: Range }>(
	fragment: Pick<DocumentMapper, 'getOriginalPosition'>,
	objWithRange: T
): T {
	return { ...objWithRange, range: mapRangeToOriginal(fragment, objWithRange.range) };
}

export function mapInsertReplaceEditToOriginal(
	fragment: Pick<DocumentMapper, 'getOriginalPosition'>,
	edit: InsertReplaceEdit
): InsertReplaceEdit {
	return {
		...edit,
		insert: mapRangeToOriginal(fragment, edit.insert),
		replace: mapRangeToOriginal(fragment, edit.replace),
	};
}

export function mapEditToOriginal(
	fragment: Pick<DocumentMapper, 'getOriginalPosition'>,
	edit: TextEdit | InsertReplaceEdit
): TextEdit | InsertReplaceEdit {
	return TextEdit.is(edit) ? mapObjWithRangeToOriginal(fragment, edit) : mapInsertReplaceEditToOriginal(fragment, edit);
}

export function mapDiagnosticToGenerated(fragment: DocumentMapper, diagnostic: Diagnostic): Diagnostic {
	return { ...diagnostic, range: mapRangeToGenerated(fragment, diagnostic.range) };
}

export function mapColorPresentationToOriginal(
	fragment: Pick<DocumentMapper, 'getOriginalPosition'>,
	presentation: ColorPresentation
): ColorPresentation {
	const item = {
		...presentation,
	};

	if (item.textEdit) {
		item.textEdit = mapObjWithRangeToOriginal(fragment, item.textEdit);
	}

	if (item.additionalTextEdits) {
		item.additionalTextEdits = item.additionalTextEdits.map((edit) => mapObjWithRangeToOriginal(fragment, edit));
	}

	return item;
}

export function mapSymbolInformationToOriginal(
	fragment: Pick<DocumentMapper, 'getOriginalPosition'>,
	info: SymbolInformation
): SymbolInformation {
	return { ...info, location: mapObjWithRangeToOriginal(fragment, info.location) };
}

export function mapLocationLinkToOriginal(fragment: DocumentMapper, def: LocationLink): LocationLink {
	return LocationLink.create(
		def.targetUri,
		fragment.getURL() === def.targetUri ? mapRangeToOriginal(fragment, def.targetRange) : def.targetRange,
		fragment.getURL() === def.targetUri
			? mapRangeToOriginal(fragment, def.targetSelectionRange)
			: def.targetSelectionRange,
		def.originSelectionRange ? mapRangeToOriginal(fragment, def.originSelectionRange) : undefined
	);
}

export function mapTextDocumentEditToOriginal(fragment: DocumentMapper, edit: TextDocumentEdit) {
	if (edit.textDocument.uri !== fragment.getURL()) {
		return edit;
	}

	return TextDocumentEdit.create(
		edit.textDocument,
		edit.edits.map((textEdit) => mapObjWithRangeToOriginal(fragment, textEdit))
	);
}

export function mapCodeActionToOriginal(fragment: DocumentMapper, codeAction: CodeAction) {
	return CodeAction.create(
		codeAction.title,
		{
			documentChanges: codeAction.edit!.documentChanges!.map((edit) =>
				mapTextDocumentEditToOriginal(fragment, edit as TextDocumentEdit)
			),
		},
		codeAction.kind
	);
}

export function mapScriptSpanStartToSnapshot(
	span: ts.TextSpan,
	scriptTagSnapshot: ScriptTagDocumentSnapshot,
	tsSnapshot: DocumentSnapshot
) {
	const originalPosition = scriptTagSnapshot.getOriginalPosition(scriptTagSnapshot.positionAt(span.start));
	return tsSnapshot.offsetAt(tsSnapshot.getGeneratedPosition(originalPosition));
}

export function mapFoldingRangeToParent(fragment: DocumentMapper, foldingRange: FoldingRange): FoldingRange {
	// Despite FoldingRange asking for a start and end line and a start and end character, FoldingRanges
	// don't use the Range type, instead asking for 4 number. Not sure why, but it's not convenient
	const range = mapRangeToOriginal(
		fragment,
		Range.create(
			foldingRange.startLine,
			foldingRange.startCharacter || 0,
			foldingRange.endLine,
			foldingRange.endCharacter || 0
		)
	);

	return FoldingRange.create(
		range.start.line,
		range.end.line,
		foldingRange.startCharacter ? range.start.character : undefined,
		foldingRange.endCharacter ? range.end.character : undefined,
		foldingRange.kind
	);
}

export function mapSelectionRangeToParent(
	fragment: Pick<DocumentMapper, 'getOriginalPosition'>,
	selectionRange: SelectionRange
): SelectionRange {
	const { range, parent } = selectionRange;

	return SelectionRange.create(
		mapRangeToOriginal(fragment, range),
		parent && mapSelectionRangeToParent(fragment, parent)
	);
}
