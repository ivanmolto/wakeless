// Shared by the landing and the docs: the wordmark, the GitHub link, and the two pieces of
// the docs overview page that are not copied from a source (video placeholder, buttons).
import { buttonVariants } from "fumadocs-ui/components/ui/button";
import Link from "next/link";

export const GITHUB_URL = "https://github.com/ivanmolto/wakeless";

/** The two wordmarks from brand/: near-black ink on the light theme, off-white ink on the dark one. */
export function Wordmark() {
  return (
    <>
      <img src="/brand/wordmark/wordmark-light.svg" alt="Wakeless" width={116} height={32} className="dark:hidden" />
      <img src="/brand/wordmark/wordmark-dark.svg" alt="Wakeless" width={116} height={32} className="hidden dark:block" />
    </>
  );
}

/** Replaced by the unlisted embed in task 14.2. */
export function VideoPlaceholder() {
  return (
    <div
      role="img"
      aria-label="Video placeholder"
      className="not-prose my-6 flex aspect-video w-full items-center justify-center rounded-xl border border-fd-border text-fd-muted-foreground"
    >
      Video
    </div>
  );
}

export function HomeButtons() {
  return (
    <div className="not-prose flex flex-wrap gap-3">
      <Link href="/docs/quickstart" className={buttonVariants({ variant: "primary" })}>
        Quickstart
      </Link>
      <Link href="/docs/how-it-works" className={buttonVariants({ variant: "secondary" })}>
        How it works
      </Link>
      <a href={GITHUB_URL} className={buttonVariants({ variant: "secondary" })}>
        GitHub
      </a>
    </div>
  );
}
