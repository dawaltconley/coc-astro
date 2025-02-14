import {
	getLanguageService,
	HTMLDocument,
	Node,
	Position,
	Scanner,
	ScannerState,
	TokenType,
} from 'vscode-html-languageservice';
import type { AstroDocument } from './AstroDocument';
import { AstroMetadata } from './parseAstro';
import { isInsideExpression } from './utils';

const parser = getLanguageService();

/**
 * Parses text as HTML
 */
export function parseHtml(text: string, frontmatter: AstroMetadata): HTMLDocument {
	const preprocessed = preprocess(text, frontmatter);

	// We can safely only set getText because only this is used for parsing
	const parsedDoc = parser.parseHTMLDocument(<any>{ getText: () => preprocessed });

	return parsedDoc;
}

const createScanner = parser.createScanner as (
	input: string,
	initialOffset?: number,
	initialState?: ScannerState
) => Scanner;

/**
 * scan the text and remove any `>` or `<` that cause the tag to end short,
 */
function preprocess(text: string, frontmatter?: AstroMetadata) {
	let scanner = createScanner(text);
	let token = scanner.scan();
	let currentStartTagStart: number | null = null;
	const hasFrontmatter = frontmatter !== undefined;

	while (token !== TokenType.EOS) {
		const offset = scanner.getTokenOffset();

		if (
			hasFrontmatter &&
			(scanner.getTokenText() === '>' || scanner.getTokenText() === '<') &&
			offset < (frontmatter.content.firstNonWhitespaceOffset ?? 0)
		) {
			blankStartOrEndTagLike(offset, ScannerState.WithinContent);
		}

		if (token === TokenType.StartTagOpen) {
			currentStartTagStart = offset;
		}

		if (token === TokenType.StartTagClose) {
			if (shouldBlankStartOrEndTagLike(offset)) {
				blankStartOrEndTagLike(offset);
			} else {
				currentStartTagStart = null;
			}
		}

		if (token === TokenType.StartTagSelfClose) {
			currentStartTagStart = null;
		}

		// <Foo checked={a < 1}>
		// https://github.com/microsoft/vscode-html-languageservice/blob/71806ef57be07e1068ee40900ef8b0899c80e68a/src/parser/htmlScanner.ts#L327
		if (
			token === TokenType.Unknown &&
			scanner.getScannerState() === ScannerState.WithinTag &&
			scanner.getTokenText() === '<' &&
			shouldBlankStartOrEndTagLike(offset)
		) {
			blankStartOrEndTagLike(offset);
		}

		// TODO: Handle TypeScript generics inside expressions / Use the compiler to parse HTML instead?

		token = scanner.scan();
	}

	return text;

	function shouldBlankStartOrEndTagLike(offset: number) {
		// not null rather than falsy, otherwise it won't work on first tag(0)
		return currentStartTagStart !== null && isInsideExpression(text, currentStartTagStart, offset);
	}

	function blankStartOrEndTagLike(offset: number, state?: ScannerState) {
		text = text.substring(0, offset) + ' ' + text.substring(offset + 1);
		scanner = createScanner(text, offset, state ?? ScannerState.WithinTag);
	}
}

export interface AttributeContext {
	name: string;
	inValue: boolean;
	valueRange?: [number, number];
}

export function getAttributeContextAtPosition(document: AstroDocument, position: Position): AttributeContext | null {
	const offset = document.offsetAt(position);
	const { html } = document;
	const tag = html.findNodeAt(offset);

	if (!inStartTag(offset, tag) || !tag.attributes) {
		return null;
	}

	const text = document.getText();
	const beforeStartTagEnd = text.substring(0, tag.start) + preprocess(text.substring(tag.start, tag.startTagEnd));

	const scanner = createScanner(beforeStartTagEnd, tag.start);

	let token = scanner.scan();
	let currentAttributeName: string | undefined;
	const inTokenRange = () => scanner.getTokenOffset() <= offset && offset <= scanner.getTokenEnd();
	while (token != TokenType.EOS) {
		// adopted from https://github.com/microsoft/vscode-html-languageservice/blob/2f7ae4df298ac2c299a40e9024d118f4a9dc0c68/src/services/htmlCompletion.ts#L402
		if (token === TokenType.AttributeName) {
			currentAttributeName = scanner.getTokenText();

			if (inTokenRange()) {
				return {
					name: currentAttributeName,
					inValue: false,
				};
			}
		} else if (token === TokenType.DelimiterAssign) {
			if (scanner.getTokenEnd() === offset && currentAttributeName) {
				const nextToken = scanner.scan();

				return {
					name: currentAttributeName,
					inValue: true,
					valueRange: [offset, nextToken === TokenType.AttributeValue ? scanner.getTokenEnd() : offset],
				};
			}
		} else if (token === TokenType.AttributeValue) {
			if (inTokenRange() && currentAttributeName) {
				let start = scanner.getTokenOffset();
				let end = scanner.getTokenEnd();
				const char = text[start];

				if (char === '"' || char === "'") {
					start++;
					end--;
				}

				return {
					name: currentAttributeName,
					inValue: true,
					valueRange: [start, end],
				};
			}
			currentAttributeName = undefined;
		}
		token = scanner.scan();
	}

	return null;
}

function inStartTag(offset: number, node: Node) {
	return offset > node.start && node.startTagEnd != undefined && offset < node.startTagEnd;
}
