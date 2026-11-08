"use client";
// Fumadocs' default dialog over the static client: the browser fetches the index the build
// exported at /api/search and searches it locally. No Algolia, no Orama Cloud, no query leaves the page.
import { useDocsSearch } from "fumadocs-core/search/client";
import { staticClient } from "fumadocs-core/search/client/orama-static";
import {
  SearchDialog,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogHeader,
  SearchDialogIcon,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogOverlay,
  type SharedProps,
} from "fumadocs-ui/components/dialog/search";
import { useMemo } from "react";

export default function StaticSearchDialog(props: SharedProps) {
  const client = useMemo(() => staticClient({ from: "/api/search" }), []);
  const search = useDocsSearch({ client });
  return (
    <SearchDialog {...search} {...props}>
      <SearchDialogOverlay />
      <SearchDialogContent>
        <SearchDialogHeader>
          <SearchDialogIcon />
          <SearchDialogInput />
          <SearchDialogClose />
        </SearchDialogHeader>
        <SearchDialogList />
      </SearchDialogContent>
    </SearchDialog>
  );
}
