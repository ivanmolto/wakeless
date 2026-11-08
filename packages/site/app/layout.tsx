import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import SearchDialog from "@/components/search";
import "./global.css";

export const metadata: Metadata = {
  title: { template: "%s · Wakeless", default: "Wakeless" },
  // The tagline is the README's first sentence; Home renders the same line from the README.
  description: "An agent's paid tool calls are its plan, and on today's x402 rails the plan leaks at three layers.",
  icons: {
    icon: [
      { url: "/brand/favicon/favicon.svg", type: "image/svg+xml" },
      { url: "/brand/favicon/favicon.ico", sizes: "16x16 32x32 48x48" },
    ],
    apple: "/brand/app-icon/icon-512-dark.png",
  },
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <RootProvider search={{ SearchDialog }}>{children}</RootProvider>
      </body>
    </html>
  );
}
