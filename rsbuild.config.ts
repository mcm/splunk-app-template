import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';

import { pluginSplunk } from './pluginSplunk.ts';
import packageJson from './package.json';

if (packageJson.splunkApp === undefined) {
  throw new Error("Missing `splunkApp` config in package.json");
}

// TODO: Validate appId
if (packageJson.splunkApp.appId === undefined && packageJson.name === undefined) {
  throw new Error("Missing `splunkApp.appId` in package.json");
} else if (packageJson.splunkApp.appId === undefined) {
  packageJson.splunkApp.appId = packageJson.name;
}

if (packageJson.splunkApp.appResourcesRoot === undefined) {
  packageJson.splunkApp.appResourcesRoot = "./resources/splunk"
}

export default defineConfig({
  dev: {
    assetPrefix: `/static/app/${packageJson.splunkApp.appId}`,
    client: {
      port: 8000,
      host: "localhost"
    },
    hmr: false,
    watchFiles: [
      {
        paths: [
          "pluginSplunk.ts",
          "rsbuild.config.ts"
        ],
        type: "reload-server"
      }
    ],
    writeToDisk: true
  },
  html: {
    inject: 'body',
    template: './src/template.html',
    title: packageJson.splunkApp.appTitle || 'Splunk App'
  },
  output: {
    assetPrefix: `/static/app/${packageJson.splunkApp.appId}/`,
    cleanDistPath: {
      keep: [/dist\/local\//, /dist\/metadata\/local.meta/]
    },
    copy: [
      { from: packageJson.splunkApp.appResourcesRoot, to: './' }
    ]
  },
  plugins: [
    pluginReact(),
    pluginSplunk({ appId: packageJson.splunkApp.appId }),
  ],
  source: {
    entry: {
      home: './src/pages/home.tsx'
    }
  },
  tools: {
    rspack: {
      watchOptions: {
        ignored: "**/*.md"
      }
    }
  }
});
