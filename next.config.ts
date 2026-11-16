import type { NextConfig } from "next";
import { socketBase } from "./src/lib/socketUrl";

// With no separate socket address the sockets use the page's own address, which 'self' already allows.
const socketUrl = socketBase(process.env.NEXT_PUBLIC_SOCKET_URL);
const socketSources = socketUrl ? ` ${socketUrl} ${socketUrl.replace(/^http/, "ws")}` : "";
const dev = process.env.NODE_ENV !== "production";

// Next.js emits small inline scripts for hydration, so script-src needs 'unsafe-inline'
// (a nonce setup would remove that). Everything else is locked to the page's own origin.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  `connect-src 'self'${socketSources}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const config: NextConfig = {
  // a separate build folder lets `npm run share` build while the dev server is running
  distDir: process.env.NEXT_DIST_DIR || ".next",
  poweredByHeader: false,
  agentRules: false,
  async headers() {
    return [
      {
        // not for /images/: that route sends its own, stricter headers for uploaded pictures
        source: "/((?!images/).*)",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default config;
