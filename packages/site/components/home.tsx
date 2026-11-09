// Shared by the landing and the docs: the wordmark, the GitHub link, and the two pieces of
// the docs overview page that are not copied from a source (the video embed, buttons).
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

/** The demo video (task 14.2): the id comes from the README's link; privacy-enhanced host, no autoplay. */
export function DemoVideo({ id }: { id: string }) {
  return (
    <iframe
      className="not-prose my-6 aspect-video w-full rounded-xl border border-fd-border"
      src={`https://www.youtube-nocookie.com/embed/${id}`}
      title="Wakeless demo video"
      loading="lazy"
      allow="encrypted-media; fullscreen; picture-in-picture"
      referrerPolicy="strict-origin-when-cross-origin"
      allowFullScreen
    />
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
