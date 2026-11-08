import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { ReactNode } from "react";
import { GITHUB_URL } from "@/components/home";
import { source } from "@/lib/source";

/** The two wordmarks from brand/: near-black ink on the light theme, off-white ink on the dark one. */
function Wordmark() {
  return (
    <>
      <img src="/brand/wordmark/wordmark-light.svg" alt="Wakeless" width={116} height={32} className="dark:hidden" />
      <img src="/brand/wordmark/wordmark-dark.svg" alt="Wakeless" width={116} height={32} className="hidden dark:block" />
    </>
  );
}

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout tree={source.getPageTree()} nav={{ title: <Wordmark /> }} githubUrl={GITHUB_URL}>
      {children}
    </DocsLayout>
  );
}
