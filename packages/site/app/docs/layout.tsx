import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { ReactNode } from "react";
import { GITHUB_URL, Wordmark } from "@/components/home";
import { source } from "@/lib/source";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout tree={source.getPageTree()} nav={{ title: <Wordmark />, url: "/" }} githubUrl={GITHUB_URL}>
      {children}
    </DocsLayout>
  );
}
