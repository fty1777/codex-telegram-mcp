// Build the self-contained package that Git marketplace installations copy.
// Run from a checkout after `bun install --frozen-lockfile`.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const repo = resolve(import.meta.dir, ".."), output = join(repo, "plugins/telegram");
const built = await Bun.build({
  entrypoints: [join(repo, "bun/cli.ts")],
  target: "bun",
  minify: true,
  metafile: true,
});
if (!built.success) throw new AggregateError(built.logs, "Plugin build failed");
const source = await built.outputs[0].text();
if (source.includes(repo)) throw Error("Plugin bundle contains a build-machine path");
writeFileSync(join(output, "bridge.js"), source);
const manifestPath = join(output, ".codex-plugin/plugin.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.version = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
for (const name of ["LICENSE", "NOTICE"]) copyFileSync(join(repo, name), join(output, name));
mkdirSync(join(output, "licenses"), { recursive: true });
for (const name of readdirSync(join(repo, "licenses")))
  copyFileSync(join(repo, "licenses", name), join(output, "licenses", name));
// Preserve license and notice texts for dependencies actually present in the bundle.
const packages = new Set<string>();
for (const input of Object.keys(built.metafile!.inputs)) {
  const absolute = resolve(repo, input);
  const dependencyRoot = join(repo, "node_modules") + "/";
  if (!absolute.startsWith(dependencyRoot)) continue;
  let directory = dirname(absolute);
  while (directory.startsWith(dependencyRoot)) {
    if (existsSync(join(directory, "package.json"))) {
      // Nested export folders may have their own { type: module } package.json.
      const metadata = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
      if (metadata.name) { packages.add(directory); break; }
    }
    directory = dirname(directory);
  }
}
const notices = [...packages].sort().map((directory) => {
  const metadata = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  const names = readdirSync(directory).filter((name) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name)).sort();
  if (!names.length) throw Error(`Missing dependency license: ${metadata.name}`);
  return `${metadata.name}@${metadata.version}\n${names.map((name) => readFileSync(join(directory, name), "utf8").trim()).join("\n\n")}`;
});
writeFileSync(join(output, "THIRD_PARTY_NOTICES.txt"), notices.join("\n\n" + "=".repeat(72) + "\n\n") + "\n");
console.log(`Built Telegram plugin ${manifest.version} (${Buffer.byteLength(source)} bytes)`);
