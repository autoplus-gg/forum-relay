export {};

declare global {
	namespace NodeJS {
		interface ProcessEnv {
			DB_FILE_NAME?: string;
			DB_AUTH_TOKEN?: string;
			DB_AUTH_TOKEN_FILE?: string;
			DISCORD_TOKEN?: string;
			DISCORD_TOKEN_FILE?: string;
			GITHUB_APP_ID?: string;
			GITHUB_APP_ID_FILE?: string;
			GITHUB_PRIVATE_KEY_BASE64?: string;
			GITHUB_PRIVATE_KEY_PATH?: string;
			GITHUB_WEBHOOK_SECRET?: string;
			GITHUB_WEBHOOK_SECRET_FILE?: string;
			HOST?: string;
			LOG_LEVEL?: string;
			PORT?: string;
			TICKETPM_TOKEN?: string;
			TICKETPM_TOKEN_FILE?: string;
		}
	}
}
