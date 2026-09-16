import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { pluginVue } from '@rsbuild/plugin-vue';

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
  packageJson.splunkApp.appResourcesRoot = "./resources"
}

if (packageJson.splunkApp.appBackendRoot === undefined) {
  packageJson.splunkApp.appBackendRoot = "./backend"
}

/*
 TypeScript infers the shape of `splunkApp` from whatever this package.json happens to contain,
 so settings that are legitimately optional - and therefore usually absent - look like errors.
 This restates them as optional rather than each read having to assert.
 */
/*
 `description` and `author` are ordinary npm fields rather than `splunkApp` ones: they are not
 Splunk-specific, and `splunkApp` should hold only what Splunk actually needs. They feed
 `[launcher]` in the generated app.conf.
 */
const pkg = packageJson as typeof packageJson & { description?: string };
// npm allows `author` as either a string or `{ name, email, url }`.
const rawAuthor: unknown = (packageJson as { author?: unknown }).author;
const appAuthor =
  typeof rawAuthor === 'string' ? rawAuthor : (rawAuthor as { name?: string } | undefined)?.name;

const splunkApp = packageJson.splunkApp as typeof packageJson.splunkApp & {
  pythonBin?: string;
  handlers?: Record<string, string | { script: string; app?: string }>;
  jobs?: Record<string, string>;
  jobScheme?: string;
};

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
          // `package.json` is watched because `splunkApp` drives conf generation: without it,
          // changing a view label or adding a job leaves the watcher building the previous
          // configuration indefinitely, with no sign that anything is stale.
          "package.json",
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
    template: './splunkapp/template.html',
    title: packageJson.splunkApp.appTitle || 'Splunk App'
  },
  output: {
    assetPrefix: `/static/app/${packageJson.splunkApp.appId}/`,
    cleanDistPath: {
      keep: [/dist\/local\//, /dist\/metadata\/local.meta/]
    },
    copy: [
      // The template's own Splunk resources: `bin/persistconn.py`, `bin/splunkapp.py`,
      // `default/app.conf`, `metadata/default.meta`. Not somewhere an app normally edits.
      { from: packageJson.splunkApp.appResourcesRoot, to: './' },
      // Your backend. Every .py under `backend/` lands in the app's `bin/`, which is the only
      // directory Splunk puts on `sys.path` for a REST handler or a modular input.
      { from: packageJson.splunkApp.appBackendRoot, to: './bin' }
    ]
  },
  plugins: [
    pluginReact(),
    pluginVue(),
    pluginSplunk({
      appId: splunkApp.appId,
      appTitle: splunkApp.appTitle,
      appVersion: pkg.version,
      appDescription: pkg.description,
      appAuthor,
      appResourcesRoot: splunkApp.appResourcesRoot,
      appBackendRoot: splunkApp.appBackendRoot,
      pythonBin: process.env.SPLUNK_APP_PYTHON || splunkApp.pythonBin,
      targetPlatform: splunkApp.targetPlatform,
      targetPythonVersion: splunkApp.targetPythonVersion,
      views: splunkApp.views,
      handlers: splunkApp.handlers,
      jobs: splunkApp.jobs,
      jobScheme: splunkApp.jobScheme,
      defaultIcon: splunkApp.defaultIcon,
      minSplunkVersion: splunkApp.minSplunkVersion,
    }),
  ],
  source: {
    entry: {
      home: './frontend/pages/home.tsx'
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
