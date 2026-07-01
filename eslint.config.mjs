import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";

export default tseslint.config(
	...obsidianmd.configs.recommended,
	{
		files: ["src/**/*.ts"],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: {
				project: "./tsconfig.json",
			},
			globals: {
				...globals.node,
				...globals.browser,
				NodeJS: "readonly",
			},
		},
		rules: {
			"obsidianmd/ui/sentence-case": [
				"error",
				{
					brands: [
						"Open Anything",
						"Obsidian",
						"Claude Code",
						"Spotlight",
						"iTerm",
						"Warp",
						"Windows Terminal",
						"PowerShell",
						"GNOME Terminal",
						"Konsole",
						"kitty",
						"alacritty",
						"Python",
						"JavaScript",
						"GitHub",
					],
				},
			],
		},
	}
);
