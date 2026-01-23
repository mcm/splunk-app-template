import { execSync } from 'child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import { default as os } from 'os';
import { default as path } from 'path';

import type { RsbuildPlugin } from '@rsbuild/core';

export type PluginSplunkOptions = {
  message?: string;
  appId: string;
};

const makeSplunkView = (appId: string, viewName: string) => {
  return `<?xml version="1.0"?>\n<view template="${appId}:/templates/${viewName}.html" type="html"></view>`;
}

export const pluginSplunk = (options: PluginSplunkOptions): RsbuildPlugin => ({
  name: 'splunk-plugin',

  setup(api) {
    api.modifyHTMLTags(({ headTags, bodyTags }) => {
      /*
       Splunk serves app pages through Mako templates. Asset URLs must be wrapped in
       `make_url()` so Splunk can prepend its root endpoint and locale segment at render
       time. Both `src` (scripts) and `href` (stylesheets, icons) need wrapping.
       */
      const wrapAssetUrls = (tag: { attrs?: Record<string, unknown> }) => {
        if (typeof tag.attrs?.src === "string") {
          tag.attrs.src = "${make_url('" + tag.attrs.src + "')}"
        }
        if (typeof tag.attrs?.href === "string") {
          tag.attrs.href = "${make_url('" + tag.attrs.href + "')}"
        }
      }

      headTags.forEach(wrapAssetUrls)
      bodyTags.forEach(wrapAssetUrls)

      return {headTags, bodyTags}
    })

    api.modifyRsbuildConfig((config) => {
      /*
       The objective here is to rewrite the paths so that `root` points to the static
       directory and then adjust everything else from there
       */
      let rootDistPath = 'dist';
      if (config.output?.distPath) {
        if (typeof config.output.distPath == "string") {
          rootDistPath = config.output.distPath
        } else {
          rootDistPath = config.output.distPath.root || 'dist'
        }
      }
      
      if (config.output === undefined) config.output = {}
      config.output.distPath = {
        root: `${rootDistPath}/appserver/static`,
        html: '../templates',
        favicon: '../../static',
        js: 'js',
        css: 'css',
      }

      if (config.output.copy) {
        if (!Array.isArray(config.output.copy)) {
          if (typeof config.output.copy == "string") {
            config.output.copy = [config.output.copy];
          } else {
            config.output.copy = config.output.copy.patterns
          }
        }

        config.output.copy = config.output.copy.map((copy) => {
          let from, to;

          if (typeof copy == "string") {
            from = copy;
            to = "../../";
          } else {
            from = copy.from;
            to = `../../${copy.to}` || "../../"
          }

          return {from, to}
        })
      }
    })

    api.processAssets(
      { stage: 'additional' },
      ({ assets, sources, compilation }) => {
        let temporaryDirectory;
        try {
          temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "rsbuild-pluginSplunk-"));

          execSync(`pip3.9 install -qqq --disable-pip-version-check -t ${temporaryDirectory}/lib -r requirements.txt`)

          const packageFiles = readdirSync(temporaryDirectory, { recursive: true, withFileTypes: true });
          for (const packageFileEnt of packageFiles) {
            if (!(packageFileEnt.isFile() || packageFileEnt.isSymbolicLink())) continue;
            const fsFilePath = path.join(packageFileEnt.parentPath, packageFileEnt.name);

            if (
              fsFilePath.endsWith(".pyc") ||
              fsFilePath.includes("__pycache__") ||
              fsFilePath.includes(".dist-info") ||
              fsFilePath.includes(".egg-info")) continue;
            
            const packageFile = path.relative(temporaryDirectory, fsFilePath);
            
            const assetPath = `../../${packageFile}`;
            // `continue`, not `return` — a single already-emitted asset must skip only itself.
            // Returning here would abandon every remaining Python package file, silently
            // shipping a truncated lib/ directory.
            if (assetPath in assets) continue;

            // console.log(packageFile);
            const data = readFileSync(fsFilePath);

            compilation.emitAsset(assetPath, new sources.RawSource(data));
          };
        } finally {
          if (temporaryDirectory) {
            rmSync(temporaryDirectory, { recursive: true, force: true });
          }
        }

        // execSync(`pip3.9 install -r requirements.txt`);
        // const pythonPackages = JSON.parse(execSync(`pip3.9 list --local --format=json`).toString());
        // pythonPackages.forEach((pythonPackage: {name: string}) => {
        //   const packageFiles = execSync(`pip3.9 show --files ${pythonPackage.name}`).toString();
        //   packageFiles.split("\n").forEach(async (packageFile) => {
        //     packageFile = packageFile.trim();
        //     if (packageFile.endsWith(".pyc") || packageFile.includes("__pycache__") || packageFile.includes(".dist-info")) return;
        //     const assetPath = `../../lib/${packageFile}`;
        //     if (assetPath in assets) return;

        //     const data = await readFile()
        //     // compilation.emitAsset(assetPath, new sources.RawSource())
        //   })
        // })
      }
    )

    api.processAssets(
      { stage: 'derived' },
      ({ assets, sources, compilation, environment }) => {
        const { config } = environment;
        if (config.source.entry === undefined) return;

        // Create dashboards to load each entry point
        Object.keys(config.source.entry).forEach((key) => {
          // path is relative to distPath, which is appserver/static
          const assetPath = `../../default/data/ui/views/${key}.xml`;
          if (assetPath in assets) return;
          compilation.emitAsset(assetPath, new sources.RawSource(makeSplunkView(options.appId, key)));
        })

        // If appIconAlt/appIconAlt_2x don't exist, reuse the main icon
        // path is relative to distPath, which is appserver/static
        const appIcon = `../../static/appIcon.png`;
        const appIcon2x = `../../static/appIcon_2x.png`;
        const appIconAlt = `../../static/appIconAlt.png`;
        const appIconAlt2x = `../../static/appIconAlt_2x.png`;
        if (appIcon in assets) {
          if (!(appIconAlt in assets)) compilation.emitAsset(appIconAlt, assets[appIcon]);
          if (!(appIcon2x in assets)) compilation.emitAsset(appIcon2x, assets[appIcon])
          if (!(appIconAlt2x in assets)) compilation.emitAsset(appIconAlt2x, assets[appIcon2x]);
        }
      },
    );

    api.processAssets({ stage: 'optimize' }, ({ assets, compilation }) => {
      const realDistPath = path.resolve(api.context.distPath, "../../");

      Object.keys(assets).forEach((assetPath) => {
        const normalizedAssetPath = path.relative(realDistPath, path.resolve(api.context.distPath, assetPath));
        if (normalizedAssetPath.startsWith("local/") || normalizedAssetPath == "metadata/local.meta") {
          compilation.deleteAsset(assetPath);
        }

        if (normalizedAssetPath.startsWith("bin/") || normalizedAssetPath.startsWith("lib")) {
          if (normalizedAssetPath.endsWith(".pyc") || normalizedAssetPath.includes("__pycache__") || normalizedAssetPath.includes(".dist-info")) {
            compilation.deleteAsset(assetPath);
          }
        }
      })
    })
  },
});