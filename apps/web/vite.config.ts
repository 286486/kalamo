import { readdirSync, readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const root = new URL("../../", import.meta.url);
const fonts = new URL("packages/render/fonts/", root);

// NOTICE.txt: the repository NOTICE plus every licence beside the bundled fonts, verbatim (#254).
const notice: Plugin = {
  name: "kalamo-notice",
  apply: "build",
  generateBundle() {
    const licences = readdirSync(fonts)
      .filter((name) => name.startsWith("LICENSE"))
      .sort()
      .map(
        (name) =>
          `\n---\npackages/render/fonts/${name}\n\n${readFileSync(new URL(name, fonts), "utf8")}`,
      );
    this.emitFile({
      type: "asset",
      fileName: "NOTICE.txt",
      source: [
        "The licences of the npm packages compiled into this app are in /third-party-licenses.txt.\n\n",
        readFileSync(new URL("NOTICE", root), "utf8"),
        ...licences,
      ].join(""),
    });
  },
};

export default defineConfig({
  plugins: [react(), notice],
  build: { license: { fileName: "third-party-licenses.txt" } },
});
