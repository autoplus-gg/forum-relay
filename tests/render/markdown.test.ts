import { describe, expect, it } from "vitest";
import { parseRenderedHtmlMediaUrls } from "@/render/markdown.js";

describe("GitHub rendered Markdown", () => {
	it("extracts authenticated image URLs in document order", () => {
		expect(
			parseRenderedHtmlMediaUrls(`
				<p><img alt="first" src="https://private-user-images.githubusercontent.com/1/first.png?jwt=one"></p>
				<div><a href="https://example.com"><img src="https://github.com/user-attachments/assets/second"></a></div>
			`)
		).toEqual([
			"https://private-user-images.githubusercontent.com/1/first.png?jwt=one",
			"https://github.com/user-attachments/assets/second"
		]);
	});
});
