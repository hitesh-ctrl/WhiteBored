import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import security from "eslint-plugin-security";

const config = [
  ...nextVitals,
  ...nextTs,
  security.configs.recommended,
  { ignores: [".next*/**", "src/generated/**", "node_modules/**", "next-env.d.ts", "logs/**"] },
  // Test code reads untyped socket payloads on purpose.
  { files: ["tests/**/*.ts"], rules: { "@typescript-eslint/no-explicit-any": "off" } },
];
export default config;
