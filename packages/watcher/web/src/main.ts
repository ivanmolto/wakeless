import "./style.css";
import sideBySideJson from "../../../../docs/side-by-side.json";
import favicon from "../../../../brand/favicon.svg?url";
import wordmarkDark from "../../../../brand/wordmark-dark.svg?url";
import wordmarkLight from "../../../../brand/wordmark-light.svg?url";
import { latestLeakHeadline, parseSideBySide } from "./data.js";
import { renderPage } from "./render.js";

// Resolved at build time: an empty object when docs/leak/ holds no snapshot, and the strip is omitted.
const snapshots = import.meta.glob("../../../../docs/leak/snapshot-*.json", { eager: true, import: "default" });

const icon = document.createElement("link");
icon.rel = "icon";
icon.type = "image/svg+xml";
icon.href = favicon;
document.head.append(icon);

const root = document.getElementById("app");
if (root === null) throw new Error("#app is missing from index.html");
renderPage(root, parseSideBySide(sideBySideJson), latestLeakHeadline(snapshots), { wordmarkLight, wordmarkDark });
