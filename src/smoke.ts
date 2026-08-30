import { API, GatewayIntentBits } from "@discordjs/core";
import { REST } from "@discordjs/rest";
import { App } from "@octokit/app";
import { ChannelType } from "discord-api-types/v10";
import { normalizeConfig } from "@/config/normalize.js";
import { readRuntimeEnvironment } from "@/core/environment.js";
import config from "../config/config.js";

async function main() {
	const environment = readRuntimeEnvironment(process.env);
	const normalized = normalizeConfig(config);
	const discord = new API(new REST({ version: "10" }).setToken(environment.discordToken));
	const currentUser = await discord.users.getCurrent();
	const github = new App({
		appId: environment.githubAppId,
		privateKey: environment.githubPrivateKey,
		webhooks: { secret: environment.githubWebhookSecret }
	});
	const app = await github.octokit.request("GET /app");

	for (const [mappingKey, mapping] of Object.entries(normalized.mappings)) {
		const channel = await discord.channels.get(mapping.forumChannelId);
		if (channel.type !== ChannelType.GuildForum) {
			throw new Error(`Smoke mapping "${mappingKey}" does not target a Discord Forum.`);
		}
		const installation = await github.octokit.request("GET /repos/{owner}/{repo}/installation", {
			owner: mapping.repository.owner,
			repo: mapping.repository.name
		});
		const octokit = await github.getInstallationOctokit(installation.data.id);
		await octokit.request("GET /repos/{owner}/{repo}", {
			owner: mapping.repository.owner,
			repo: mapping.repository.name
		});
	}

	console.log(
		JSON.stringify({
			discordBot: currentUser.username,
			gatewayIntents: GatewayIntentBits.Guilds | GatewayIntentBits.GuildMessages | GatewayIntentBits.MessageContent,
			githubApp: app.data?.name ?? "unavailable",
			mappings: Object.keys(normalized.mappings).length,
			ok: true
		})
	);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
