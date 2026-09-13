// ESLint flat config. Core rules + `no-restricted-imports` boundaries:
//
//   src/ui/      may not import from src/server/ or src/mcp/ (it talks HTTP only).
//   src/mcp/     may not import from src/server/ or src/ui/ (it talks HTTP only,
//                so Claude Code can run it without the daemon's module graph).
//   src/server/  may not import from src/ui/ or src/mcp/.
//   src/shared/  may not import React or node-only modules.

import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "data/**", "node_modules/**", "tools/**", "**/*.d.ts"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        window: "readonly",
        document: "readonly",
        console: "readonly",
        process: "readonly",
        fetch: "readonly",
        EventSource: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "off",
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  // Relative imports only (`../server/x.ts`), so package paths like
  // `@modelcontextprotocol/sdk/server/mcp.js` are not caught.
  {
    files: ["src/ui/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { regex: "^\\.{1,2}/(.*/)?server/", message: "UI talks to the daemon over HTTP only." },
            { regex: "^\\.{1,2}/(.*/)?mcp/", message: "UI must not import the MCP server." },
          ],
        },
      ],
    },
  },
  {
    files: ["src/mcp/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^\\.{1,2}/(.*/)?server/",
              message: "MCP talks to the daemon over HTTP only, never the process directly.",
            },
            { regex: "^\\.{1,2}/(.*/)?ui/", message: "MCP must not import the UI." },
          ],
        },
      ],
    },
  },
  {
    files: ["src/server/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { regex: "^\\.{1,2}/(.*/)?ui/", message: "Server must not import the UI." },
            { regex: "^\\.{1,2}/(.*/)?mcp/", message: "Server must not import the MCP server." },
          ],
        },
      ],
    },
  },
  {
    files: ["src/shared/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["react", "react-dom"], message: "Shared must not depend on React." },
            {
              group: ["node:*", "fs", "path", "child_process"],
              message: "Shared is runtime-neutral.",
            },
            { regex: "^\\.{1,2}/(.*/)?(server|ui|mcp)/", message: "Shared imports nothing." },
          ],
        },
      ],
    },
  },
  {
    files: ["src/server/main.ts", "src/mcp/main.ts", "test/**"],
    rules: { "no-console": "off" },
  },
  {
    files: ["**/*.test.{ts,tsx}"],
    rules: { "no-restricted-imports": "off" },
  },
);
