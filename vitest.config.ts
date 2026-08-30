import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./src", import.meta.url))
		}
	},
	test: {
		include: ["tests/**/*.test.ts"],
		coverage: {
			exclude: ["src/adapters/**", "src/app.ts", "src/cli.ts", "src/deploy-commands.ts", "src/index.ts", "src/smoke.ts"],
			include: ["src/**/*.ts"],
			provider: "istanbul",
			thresholds: {
				// Keep an honest whole-core baseline. The previous gate measured only 18 domain lines.
				branches: 25,
				functions: 40,
				lines: 28,
				statements: 28,
				"src/domain/**/*.ts": {
					branches: 90,
					lines: 90
				},
				"src/github/webhook.ts": {
					branches: 45,
					lines: 70
				},
				"src/labels/**/*.ts": {
					branches: 85,
					lines: 90
				},
				"src/render/**/*.ts": {
					branches: 50,
					lines: 70
				}
			}
		}
	}
});
