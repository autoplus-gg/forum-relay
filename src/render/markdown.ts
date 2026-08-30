import type { Root, RootContent } from "mdast";
import { type DefaultTreeAdapterMap, parseFragment } from "parse5";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

export interface MediaToken {
	alt: string;
	end: number;
	start: number;
	url: string;
}

export function parseGitHubMarkdown(source: string, repositoryUrl: string) {
	const root = unified().use(remarkParse).use(remarkGfm).parse(source);
	return {
		root,
		media: collectMedia(root, repositoryUrl)
	};
}

export function parseRenderedHtmlMediaUrls(html: string) {
	const urls: string[] = [];
	collectHtmlMediaUrls(parseFragment(html).childNodes, urls);
	return urls;
}

function collectMedia(root: Root, repositoryUrl: string) {
	const media: MediaToken[] = [];
	visit(root.children, (node) => {
		if (node.type === "image" && node.position?.start.offset !== undefined && node.position.end.offset !== undefined) {
			media.push({
				alt: node.alt ?? "",
				end: node.position.end.offset,
				start: node.position.start.offset,
				url: resolveRepositoryUrl(node.url, repositoryUrl)
			});
			return;
		}

		if (node.type === "html" && node.position?.start.offset !== undefined && node.position.end.offset !== undefined) {
			const image = parseHtmlImage(node.value, repositoryUrl);
			if (image) {
				media.push({
					...image,
					end: node.position.end.offset,
					start: node.position.start.offset
				});
			}
		}
	});
	return media.sort((left, right) => left.start - right.start);
}

function visit(nodes: RootContent[], visitor: (node: RootContent) => void) {
	for (const node of nodes) {
		visitor(node);
		if ("children" in node) {
			visit(node.children, visitor);
		}
	}
}

function parseHtmlImage(html: string, repositoryUrl: string) {
	const fragment = parseFragment(html);
	const image = findImage(fragment.childNodes);
	if (!image) {
		return undefined;
	}
	const src = image.attrs.find((attribute) => attribute.name.toLocaleLowerCase("en-US") === "src")?.value;
	if (!src) {
		return undefined;
	}
	const alt = image.attrs.find((attribute) => attribute.name.toLocaleLowerCase("en-US") === "alt")?.value ?? "";
	return { alt, url: resolveRepositoryUrl(src, repositoryUrl) };
}

function findImage(nodes: DefaultTreeAdapterMap["node"][]): DefaultTreeAdapterMap["element"] | undefined {
	for (const node of nodes) {
		if (isElement(node) && node.tagName.toLocaleLowerCase("en-US") === "img") {
			return node;
		}
		if ("childNodes" in node) {
			const nested = findImage(node.childNodes);
			if (nested) {
				return nested;
			}
		}
	}
	return undefined;
}

function collectHtmlMediaUrls(nodes: DefaultTreeAdapterMap["node"][], urls: string[]) {
	for (const node of nodes) {
		if (isElement(node) && node.tagName.toLocaleLowerCase("en-US") === "img") {
			const source = node.attrs.find((attribute) => attribute.name.toLocaleLowerCase("en-US") === "src")?.value;
			if (source) {
				urls.push(source);
			}
		}
		if ("childNodes" in node) {
			collectHtmlMediaUrls(node.childNodes, urls);
		}
	}
}

function isElement(node: DefaultTreeAdapterMap["node"]): node is DefaultTreeAdapterMap["element"] {
	return "tagName" in node && "attrs" in node;
}

function resolveRepositoryUrl(value: string, repositoryUrl: string) {
	try {
		return new URL(value, `${repositoryUrl.replace(/\/+$/, "")}/`).toString();
	} catch {
		return value;
	}
}
