// The two pieces of Home that are not copied from a source: the video placeholder and the buttons.
import { buttonVariants } from "fumadocs-ui/components/ui/button";
import Link from "next/link";

export const GITHUB_URL = "https://github.com/ivanmolto/wakeless";

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
      <Link href="/quickstart" className={buttonVariants({ variant: "primary" })}>
        Quickstart
      </Link>
      <Link href="/how-it-works" className={buttonVariants({ variant: "secondary" })}>
        How it works
      </Link>
      <a href={GITHUB_URL} className={buttonVariants({ variant: "secondary" })}>
        GitHub
      </a>
    </div>
  );
}
