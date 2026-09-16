import { execSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { default as os } from 'os';
import { default as path } from 'path';

import type { RsbuildPlugin } from '@rsbuild/core';

export type SplunkViewOptions = {
  /** Nav label. Defaults to a title-cased version of the entry name. */
  label?: string;
  /** Modern-navigation icon. See `NAV_ICONS` for the names Splunk 10.4 resolves. */
  icon?: string;
  /** Landing view for the app. Defaults to the first entry. */
  default?: boolean;
};

export type PluginSplunkOptions = {
  message?: string;
  appId: string;
  /** Per-entry nav/label configuration, keyed by `source.entry` name. */
  views?: Record<string, SplunkViewOptions>;
  /** Icon used for any entry that does not name its own. */
  defaultIcon?: string;
  /**
   * Oldest Splunk release this app must run on. Defaults to `10.4`.
   *
   * At `10.4` and above the build targets Splunk's first-party page template and ships no HTML
   * of its own. Below it, the build falls back to emitting an app-supplied Mako template, which
   * is the only thing pre-10.4 Splunk can load - and which App Inspect fails from 4.4.0 onward.
   * See `MODERN_VIEW_TEMPLATE` for what changes.
   */
  minSplunkVersion?: string;
  /**
   * Interpreter used to install `requirements.txt` into `dist/lib/`.
   *
   * Invoked as `<pythonBin> -m pip`, not as `pip3.9`: Splunk ships `$SPLUNK_HOME/bin/pip3.9`
   * with a build-time shebang (`/builds/home/splunk/bin/python3.9`) that does not exist in
   * the shipped image, so the console script cannot be executed directly.
   */
  pythonBin?: string;
  /**
   * Platform tag(s) the bundled Python packages must target, passed to pip as `--platform`.
   * Defaults to `manylinux2014_x86_64`. Set to `null` to install for the build host instead.
   */
  targetPlatform?: string | string[] | null;
  /** Python version tag for `--python-version`. Defaults to `3.9`. */
  targetPythonVersion?: string;
  /**
   * Scheduled jobs, as job name -> the Python module that declares it. Mirrors
   * `source.entry`: the key is the name, the value is where it lives.
   *
   *     jobs: { collect: './resources/splunk/bin/collect.py' }
   *
   * Each key must match a function decorated with `@scheduled` in that module. The schedule
   * itself lives on the decorator, not here - the build reads it back by importing the module.
   */
  jobs?: Record<string, string>;
  /**
   * REST handlers, as handler name -> the Python module that declares the ASGI app. Mirrors
   * `source.entry` and `jobs`: the key is the name, the value is where it lives.
   *
   *     handlers: { api: './backend/api.py' }
   *
   * The long form names the module attribute when it is not `app`:
   *
   *     handlers: { api: { script: './backend/api.py', app: 'application' } }
   *
   * `restmap.conf` and `web.conf` are generated from this plus the app's own `root_path` -
   * the build imports the module and reads it, the same way it reads `@scheduled`. So the
   * REST prefix is declared once, in Python, where the routes that use it are.
   */
  handlers?: Record<string, string | { script: string; app?: string }>;
  /**
   * Modular input scheme name for the generated job runner. Defaults to `appId`. Becomes
   * `bin/<scheme>.py` and the `[<scheme>://<job>]` stanza prefix in `inputs.conf`.
   */
  jobScheme?: string;
  /** Human-readable app name, used in generated scheme XML and spec files. */
  appTitle?: string;
  /**
   * App version, from `package.json`'s own `version`. Must be valid SemVer 2.0.0.
   *
   * Written to BOTH `[launcher] version` and `[id] version`, which Splunk requires to match
   * exactly - a mismatch is an App Inspect failure. One source means they cannot disagree.
   */
  appVersion?: string;
  /** `[launcher] description`, from `package.json`'s `description`. */
  appDescription?: string;
  /** `[launcher] author`, from `package.json`'s `author`. */
  appAuthor?: string;
  /** Where the template's own Splunk resources live - `bin/persistconn.py`,
   * `bin/splunkapp.py`, `default/app.conf`. Defaults to `./resources`. */
  appResourcesRoot?: string;
  /**
   * Where this app's backend Python lives. Everything under it is copied into the app's
   * `bin/`, and it is on `PYTHONPATH` when the build imports handler and job modules.
   * Defaults to `./backend`.
   */
  appBackendRoot?: string;
  /**
   * Stylesheet injected into every generated entry, so pages never import it themselves.
   * Relative to the project root. Pass `null` to inject nothing.
   */
  globalsCss?: string | null;
};

/*
 Remove everything under `root` except files matching `keep`, then prune directories left
 empty. `root` itself is never removed - in the dev container it is a volume mount point.

 This exists because the plugin repoints `output.distPath.root` at `appserver/static` so that
 asset URLs come out right, which means Rsbuild's own `cleanDistPath` only ever cleans that
 subtree. Everything the plugin emits alongside it - `lib/`, `bin/`, `default/`, `metadata/` -
 is written by path and would otherwise accumulate across builds. Stale files there are not
 cosmetic: a `lib/` carrying a compiled extension from a previous target ships a second,
 wrong-platform binary.
 */
const cleanDistDirectory = (root: string, keep: RegExp[]) => {
  if (!existsSync(root)) return;

  const clean = (directory: string): boolean => {
    let retained = false;

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        if (clean(fullPath)) {
          retained = true;
        } else {
          rmSync(fullPath, { recursive: true, force: true });
        }
        continue;
      }

      if (keep.some((pattern) => pattern.test(fullPath))) {
        retained = true;
      } else {
        rmSync(fullPath, { force: true });
      }
    }

    return retained;
  };

  clean(root);
}

/** Compiled extensions - the only files whose platform actually matters. */
const BINARY_EXTENSIONS = ['.so', '.pyd', '.dylib'];

type PythonDistribution = { name: string; version: string; distInfoDir: string };

/*
 Find installed distributions that shipped a compiled extension.

 Pure-Python packages are platform-agnostic, so re-fetching them would be wasted work. Only
 these need to be pulled again for the target platform.
 */
const findBinaryDistributions = (libDir: string): PythonDistribution[] => {
  if (!existsSync(libDir)) return [];

  const distributions: PythonDistribution[] = [];
  for (const entry of readdirSync(libDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith('.dist-info')) continue;

    const recordPath = path.join(libDir, entry.name, 'RECORD');
    if (!existsSync(recordPath)) continue;

    const recordedFiles = readFileSync(recordPath, 'utf8')
      .split('\n')
      .map((line) => line.split(',')[0])
      .filter(Boolean);

    if (!recordedFiles.some((file) => BINARY_EXTENSIONS.some((ext) => file.endsWith(ext)))) continue;

    // `pydantic_core-2.46.4.dist-info` -> name `pydantic_core`, version `2.46.4`
    const base = entry.name.slice(0, -'.dist-info'.length);
    const separator = base.lastIndexOf('-');
    if (separator < 1) continue;

    distributions.push({
      name: base.slice(0, separator),
      version: base.slice(separator + 1),
      distInfoDir: path.join(libDir, entry.name),
    });
  }
  return distributions;
}

/*
 Delete everything a distribution installed, using its own RECORD as the manifest.

 Necessary because the host and target wheels use different filenames
 (`_pydantic_core.cpython-39-x86_64-linux-gnu.so` vs `...-darwin.so`), so simply installing
 over the top would ship both binaries.
 */
const removeDistribution = (libDir: string, distribution: PythonDistribution) => {
  const recordPath = path.join(distribution.distInfoDir, 'RECORD');
  const recordedFiles = readFileSync(recordPath, 'utf8')
    .split('\n')
    .map((line) => line.split(',')[0])
    .filter(Boolean);

  for (const recordedFile of recordedFiles) {
    const target = path.resolve(libDir, recordedFile);
    // Never follow a RECORD entry back out of the install directory.
    if (!target.startsWith(path.resolve(libDir) + path.sep)) continue;
    rmSync(target, { force: true });
  }
  rmSync(distribution.distInfoDir, { recursive: true, force: true });
}

/*
 Icon names Splunk 10.4's modern navigation actually resolves. This is a much smaller set
 than the full `@splunk/react-icons` library the release notes point at - the nav bundle
 carries its own registry, and a name outside it silently degrades to a letter monogram
 rather than erroring. Warning at build time is the whole point of listing them here.

 Splunk normalises the attribute before lookup (lowercase, hyphens and spaces removed), so
 "Chart Line", "chart-line" and "chartLine" all resolve to "chartline".
 */
const NAV_ICONS = new Set([
  'bell', 'bookmark', 'bookshelf', 'chartcolumnpanel', 'chartgantt', 'chartgauge',
  'chartline', 'chartpanels', 'circlesfour', 'cog', 'cylinder', 'cylinderindex',
  'filechart', 'filemagnifier', 'filenode', 'forwarderuniversal', 'house', 'layerstriple',
  'layout', 'layoutoverview', 'magnifier', 'monitor', 'networkconnector', 'nodetopology',
  'organizernotebook', 'pulse', 'shieldkeyhole', 'star', 'tag',
]);

const normalizeIconName = (icon: string) => icon.trim().toLowerCase().replace(/[-\s]+/g, '');

const escapeXml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** `my-report_page` -> `My Report Page`, so an unlabelled entry still reads like a title. */
const titleCase = (viewName: string) =>
  viewName
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());

/*
 Splunk 10.4 ships a first-party page template written for third-party apps. Pointing a view at
 it means the app ships no HTML at all: Splunk resolves the bundle URL itself, by hard convention,
 from the view name - `appserver/static/pages/<viewname>.js`.

 This is the supported replacement for app-supplied Mako templates, which 10.4 deprecates and
 App Inspect fails outright from 4.4.0. `@splunk/create` made it the default in 11.0.0.

 Referencing it is safe even when an administrator sets `deactivate_custom_mako_templates`:
 that flag blocks only app-scoped template lookups, never first-party ones.

 It does not exist before 10.4, which is why `minSplunkVersion` exists at all.
 */
const MODERN_VIEW_TEMPLATE = 'pages/splunk_ui_app.html';
const MODERN_VIEW_MIN_VERSION = '10.4';

const parseVersion = (version: string) =>
  version.trim().split('.').map((part) => Number.parseInt(part, 10) || 0);

/** `10.4` >= `10.4` -> true; `10.2.6` >= `10.4` -> false. Missing segments count as zero. */
const atLeastVersion = (version: string, minimum: string) => {
  const actual = parseVersion(version);
  const required = parseVersion(minimum);
  for (let index = 0; index < Math.max(actual.length, required.length); index++) {
    const left = actual[index] || 0;
    const right = required[index] || 0;
    if (left !== right) return left > right;
  }
  return true;
}

/*
 Which interpreters each Splunk release actually ships. 10.0 has only 3.9; 10.2 and 10.4 ship
 3.9 and 3.13 side by side. Observed directly in the release containers, not inferred from docs.
 */
const splunkPythonVersions = (splunkVersion: string) =>
  atLeastVersion(splunkVersion, '10.2') ? ['3.9', '3.13'] : ['3.9'];

/*
 `python.required` pins the interpreter a script runs under. It arrived in 10.2 and is
 *silently* ignored before that - no warning, no error - so it must not be emitted below 10.2.

 Three traps make this worth deriving rather than configuring:

 - It restates `targetPythonVersion` in Splunk's vocabulary. The two disagreeing produces an app
   that passes vetting and then cannot import its own bundled binaries, so there is exactly one
   source of truth and this is not it.
 - An *invalid* value does not fall back to the default, it falls back to the NEWEST installed
   interpreter. A typo silently upgrades the app to 3.13 and breaks every compiled wheel in lib/.
 - Splunk reads it separately for scheme introspection and for execution, so it has to appear on
   the `[<scheme>]` stanza *and* on every `[<scheme>://<job>]` stanza or the two can disagree.

 `python.version = python3` rides alongside for 10.0, where it is the only one of the pair that
 does anything. Both resolve to 3.9 on all three releases, so emitting both is safe.
 */
const makePythonSettings = (_minSplunkVersion: string, targetPythonVersion: string) => [
  // `python.version` is what pre-10.2 Splunk reads, and App Inspect now calls it deprecated -
  // so both are emitted. Neither alone is sufficient across 10.0 to 10.4.
  'python.version = python3',
  // Emitted unconditionally, including for apps targeting 10.0 where the setting did not yet
  // exist. It was tempting to gate this on 10.2, but the spike showed pre-10.2 Splunk ignores
  // it *silently* - no warning, no error - so gating bought nothing and cost three App Inspect
  // future_failures ("Option python.required is required for Python modular inputs"), which
  // become hard failures at 4.4.0.
  `python.required = ${targetPythonVersion}`,
]

/*
 Set `key = value` inside `[stanza]` of a Splunk .conf file, preserving everything else -
 comments included, since the shipped conf files carry the explanation of why each setting is
 what it is. Appends the stanza or the key if either is missing.
 */
const setConfValue = (confText: string, stanza: string, key: string, value: string) => {
  const lines = confText.split('\n');
  const header = `[${stanza}]`;

  let stanzaStart = -1;
  let stanzaEnd = lines.length;
  for (let index = 0; index < lines.length; index++) {
    const trimmed = lines[index].trim();
    if (trimmed === header) {
      stanzaStart = index;
      continue;
    }
    if (stanzaStart >= 0 && /^\[.*\]$/.test(trimmed)) {
      stanzaEnd = index;
      break;
    }
  }

  if (stanzaStart < 0) {
    const separator = confText.endsWith('\n') ? '' : '\n';
    return `${confText}${separator}\n${header}\n${key} = ${value}\n`;
  }

  const assignment = new RegExp(`^\\s*${key}\\s*=`);
  for (let index = stanzaStart + 1; index < stanzaEnd; index++) {
    if (assignment.test(lines[index])) {
      lines[index] = `${key} = ${value}`;
      return lines.join('\n');
    }
  }

  // Back up over the blank lines that separate this stanza from the next, so the new key joins
  // the stanza's settings rather than floating just above the following header.
  let insertAt = stanzaEnd;
  while (insertAt > stanzaStart + 1 && lines[insertAt - 1].trim() === '') insertAt--;

  lines.splice(insertAt, 0, `${key} = ${value}`);
  return lines.join('\n');
}

const makeSplunkView = (template: string, label: string) => {
  return (
    `<?xml version="1.0"?>\n` +
    `<view template="${escapeXml(template)}" type="html">\n` +
    `  <label>${escapeXml(label)}</label>\n` +
    `</view>`
  );
}

const makeSplunkNav = (
  viewNames: string[],
  views: Record<string, SplunkViewOptions>,
  defaultIcon: string | undefined,
  warn: (message: string) => void,
) => {
  const explicitDefault = viewNames.find((name) => views[name]?.default);
  const defaultView = explicitDefault || viewNames[0];

  const items = viewNames.map((viewName) => {
    const view = views[viewName] || {};
    const icon = view.icon || defaultIcon;

    let iconAttr = '';
    if (icon) {
      const normalized = normalizeIconName(icon);
      if (!NAV_ICONS.has(normalized)) {
        warn(
          `nav icon "${icon}" for view "${viewName}" is not one Splunk's modern navigation ` +
          `recognises, so it will fall back to a letter monogram. Known icons: ` +
          `${[...NAV_ICONS].sort().join(', ')}`
        );
      }
      iconAttr = ` icon="${escapeXml(normalized)}"`;
    }

    const defaultAttr = viewName === defaultView ? ' default="true"' : '';
    return `  <view name="${escapeXml(viewName)}"${defaultAttr}${iconAttr} />`;
  });

  return `<?xml version="1.0"?>\n<nav>\n${items.join('\n')}\n</nav>`;
}

/*
 What `splunkapp.describe()` reports back. This is the app's own Python declarations - the
 `@scheduled` decorators and `collection()` calls - read out by importing the job modules at
 build time, so the generated conf cannot drift from the code.
 */
type JobDescription = {
  name: string;
  interval: string;
  index: string | null;
  sourcetype: string | null;
  description: string;
};

type CollectionDescription = {
  name: string;
  fields: Record<string, string>;
  lookup: boolean;
  undeclarable: string[];
};

type AppDescription = { jobs: JobDescription[]; collections: CollectionDescription[] };

/*
 What the handler probe reports back for one `[script:...]` stanza: read off the ASGI app
 object itself rather than restated in package.json, so the conf cannot drift from the routes.
 */
type HandlerDescription = {
  /** Module basename, which is both the file in `bin/` and the import name. */
  module: string;
  /** Attribute holding the ASGI app. */
  attr: string;
  /** `FastAPI(root_path=...)`. The single source of truth for where the handler is mounted. */
  rootPath: string;
  /** Union of the HTTP verbs the app's routes accept. */
  methods: string[];
};

const GENERATED_BY =
  '# Generated by pluginSplunk from this app\'s Python declarations. Do not edit - your\n' +
  '# changes will be overwritten on the next build. Change the declaration instead: the\n' +
  '# @scheduled decorator, the collection() call, or the ASGI app\'s root_path.\n' +
  '#\n' +
  '# Writing a file of this name by hand disables generation for it entirely, which is the\n' +
  '# escape hatch when you need a setting the build does not emit.\n';

/*
 The modular input script Splunk executes. It does nothing but arrange imports: `splunkapp`
 first because importing it is what puts the app's `lib/` on `sys.path`, then each job module
 so that its `@scheduled` decorators run and register, then hand off.

 Generated rather than written by hand because the import order is load-bearing and silently
 wrong-looking - a linter would move `import splunkapp` down among the others and break every
 third-party import in the app.
 */
const makeJobShim = (scheme: string, appTitle: string, jobModules: string[]) => {
  const imports = jobModules.map((module) => `import ${module}  # noqa: F401,E402`);
  return [
    '#!/usr/bin/env python',
    `# Modular input runner for scheme "${scheme}".`,
    GENERATED_BY.trimEnd(),
    '',
    'import sys',
    '',
    "# Must precede every import below it: splunkapp installs the app's lib/ directory onto",
    '# sys.path, and nothing bundled with the app can be imported until it has.',
    'import splunkapp',
    '',
    '# Imported for their side effect - each @scheduled decorator registers a job.',
    ...imports,
    '',
    'if __name__ == "__main__":',
    `    sys.exit(splunkapp.run(${JSON.stringify(appTitle)}))`,
    '',
  ].join('\n');
}

/*
 One stanza per job, plus the scheme stanza, plus a monitor for the job log.

 Splunk already monitors `var/log/splunk`, but that stock monitor sets no sourcetype, so the
 file gets an auto-learned name of the form `<basename>-too_small` and the logs are effectively
 unfindable. Naming the sourcetype here is the difference between having job logs and not.
 */
const makeInputsConf = (
  scheme: string,
  appId: string,
  jobs: JobDescription[],
  pythonSettings: string[],
) => {
  const sections = [GENERATED_BY.trimEnd(), '', `[${scheme}]`, ...pythonSettings, ''];

  for (const job of jobs) {
    if (job.description) sections.push(`# ${job.description}`);
    sections.push(`[${scheme}://${job.name}]`);
    sections.push(`interval = ${job.interval}`);
    if (job.index) sections.push(`index = ${job.index}`);
    if (job.sourcetype) sections.push(`sourcetype = ${job.sourcetype}`);
    sections.push('disabled = 0');
    // Repeated per stanza deliberately - Splunk resolves the interpreter separately for scheme
    // introspection and for execution, and warns loudly when the two disagree.
    sections.push(...pythonSettings);
    sections.push('');
  }

  sections.push(
    '# Job logs. Without an explicit sourcetype the stock var/log/splunk monitor auto-learns',
    `# one named "${appId}-too_small", which is not something anyone will find by searching.`,
    `[monitor://$SPLUNK_HOME/var/log/splunk/${appId}.log]`,
    'index = _internal',
    `sourcetype = ${appId}:log`,
    'disabled = 0',
    ''
  );

  return sections.join('\n');
}

/*
 The spec file is not documentation - it is how splunkd DISCOVERS the modular input.

 At startup splunkd reads every app's `README/inputs.conf.spec`, and for each scheme it finds
 there it runs `bin/<scheme>.py --scheme`. No spec, no discovery: the stanzas in inputs.conf
 parse fine, `btool` shows them, and the input simply never runs.

 Verified on 10.4.2: the scheme stanza must declare AT LEAST ONE SETTING. A spec containing
 only the stanza header and `*` description lines is silently skipped - no error anywhere, and
 `| rest /services/data/modular-inputs` just does not list the scheme. The stanza name itself
 does not matter (`<name>` and a concrete name behave identically); the presence of a
 `setting =` line does. So the real settings are documented here, which satisfies the parser
 and is useful in the inputs manager UI besides.
 */
const makeInputsSpec = (scheme: string, appTitle: string, jobs: JobDescription[]) => {
  const names = jobs.map((job) => job.name).join(', ') || 'none declared';
  return [
    GENERATED_BY.trimEnd(),
    '',
    `[${scheme}://<name>]`,
    `* A scheduled job for ${appTitle}.`,
    `* Declared jobs: ${names}.`,
    '*',
    '* The schedule lives on the @scheduled decorator in this app\'s Python source, and the',
    '* build regenerates the stanzas below from it. Editing a value here is overwritten on the',
    '* next build; change the decorator instead.',
    'interval = ',
    '* How often the job runs: seconds, or a five-field cron expression.',
    'index = ',
    '* Index the job\'s events are written to.',
    'sourcetype = ',
    '* Sourcetype the job\'s events are written as.',
    '',
  ].join('\n');
}

const makeCollectionsConf = (collections: CollectionDescription[]) => {
  const sections = [GENERATED_BY.trimEnd(), ''];
  for (const declared of collections) {
    sections.push(`[${declared.name}]`);
    // Rejects a scalar that does not match its declared type at write time rather than storing
    // it and surprising SPL later. Type enforcement applies only to scalars - an array stored
    // in a field of any declared type round-trips intact.
    sections.push('enforceTypes = true');
    for (const [fieldName, fieldType] of Object.entries(declared.fields)) {
      sections.push(`field.${fieldName} = ${fieldType}`);
    }
    sections.push('');
  }
  return sections.join('\n');
}

/*
 Lookup definitions for collections that asked for one with `collection(..., lookup=True)`.
 Opt-in because most collections are app state that never needs to appear in a search, and
 because shipping transforms.conf at all has a cost - see the caller.
 */
const makeTransformsConf = (collections: CollectionDescription[]) => {
  const sections = [GENERATED_BY.trimEnd(), ''];
  for (const declared of collections) {
    // `_key` first: it is the record's identity and the field a lookup is usually keyed on.
    const fields = ['_key', ...Object.keys(declared.fields)];
    sections.push(`[${declared.name}_lookup]`);
    sections.push('external_type = kvstore');
    sections.push(`collection = ${declared.name}`);
    sections.push(`fields_list = ${fields.join(', ')}`);
    sections.push('');
  }
  return sections.join('\n');
}

/*
 Build-time probe that reads each handler's ASGI app object.

 Written as its own script rather than added to `splunkapp.py`, because none of this is
 runtime behaviour - a handler module never imports `splunkapp`, it is ordinary FastAPI. The
 probe loads each module by file path (not by import name) so it works regardless of what is
 or is not on `sys.path`, and reports what the conf generators need.
 */
const HANDLER_PROBE = `
import importlib.util
import json
import os
import sys

with open(sys.argv[1]) as handle:
    handlers = json.load(handle)


def load_module(module_name, file_path):
    spec = importlib.util.spec_from_file_location(module_name, file_path)
    if spec is None or spec.loader is None:
        raise ImportError(file_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


described = {}
for name, entry in handlers.items():
    file_path = entry["script"]
    attr = entry["app"]
    module_name = os.path.splitext(os.path.basename(file_path))[0]

    module = load_module(module_name, file_path)
    if not hasattr(module, attr):
        raise SystemExit(
            "%s defines no attribute %r. A REST handler module must expose its ASGI "
            "application - usually 'app = FastAPI(...)'." % (file_path, attr)
        )
    asgi_app = getattr(module, attr)

    methods = set()
    for route in getattr(asgi_app, "routes", None) or []:
        route_methods = getattr(route, "methods", None)
        if route_methods:
            methods.update(route_methods)

    described[name] = {
        "module": module_name,
        "attr": attr,
        "rootPath": getattr(asgi_app, "root_path", "") or "",
        "methods": sorted(methods),
    }

print(json.dumps(described))
`;

/*
 splunkd routes `/services<match>/...` to the handler, and the ASGI app has to agree about
 where it is mounted or every route 404s one level down. `root_path` is where that agreement
 is declared, so `match` is derived from it rather than configured beside it.
 */
const restMatchFor = (name: string, rootPath: string) => {
  if (!rootPath.startsWith('/services/')) {
    throw new Error(
      `[splunk-plugin] REST handler "${name}" declares root_path "${rootPath}", but splunkd ` +
      `serves persistent handlers under /services. The build reads root_path to generate ` +
      `restmap.conf's "match", so it has to start with "/services/" - e.g. ` +
      `FastAPI(root_path="/services/my_app"). Without it the routes would be registered one ` +
      `level away from where splunkd sends the requests, and every one of them would 404.`
    );
  }
  return rootPath.slice('/services'.length).replace(/\/+$/, '');
}

/** Verbs splunkd will forward. Anything else in `methods` is rejected by web.conf itself. */
const EXPOSABLE_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

const exposedMethods = (methods: string[]) => {
  const declared = new Set(methods.map((method) => method.toUpperCase()));
  // GET always, so that a handler with no routes yet is still reachable enough to debug.
  declared.add('GET');
  return EXPOSABLE_METHODS.filter((method) => declared.has(method));
}

/*
 Registers each ASGI app as a persistent-connection REST handler.

 `scripttype = persist` with no `handler=` is load-bearing beyond style: it is the only reason
 this app is exempt from App Inspect's `check_rest_handler_python_executable_exists` and
 `check_script_restmap_conf_python_required`. A classic `handler=module.Class` handler brings
 both into scope.
 */
const makeRestmapConf = (handlers: Record<string, HandlerDescription>) => {
  const sections = [GENERATED_BY.trimEnd(), ''];

  for (const [name, handler] of Object.entries(handlers)) {
    sections.push(
      `# ${handler.module}.${handler.attr}, mounted at ${handler.rootPath}.`,
      `[script:${name}]`,
      `match                 = ${restMatchFor(name, handler.rootPath)}`,
      `script                = ${handler.module}.py`,
      `script.param          = ${handler.module}.${handler.attr}`,
      `driver                = persistconn.py`,
      `scripttype            = persist`,
      `requireAuthentication = true`,
      `passPayload           = base64`,
      `passHttpHeaders       = true`,
      `passHttpCookies       = true`,
      ''
    );
  }

  return sections.join('\n');
}

/*
 Exposes the handler's routes through splunkd's REST layer. `restmap.conf` alone is not
 enough - a stanza registered there but not exposed here is simply unreachable, and the two
 being separate files is the single easiest thing to half-do.

 The double asterisk is load-bearing: in a `pattern`, a single `*` matches exactly one path
 segment, so `<ns>/*` leaves `<ns>/gizmos/42/rename` unreachable. Only `**` spans separators,
 and it also covers the bare namespace, so one stanza exposes the whole handler.

 The failure mode hides, which is why it is worth stating: splunkd's management port (8089)
 does not consult web.conf at all. An under-exposed handler answers correctly there and 404s
 for every request that arrives through Splunk Web.

 `methods` is the union of the verbs the app's own routes declare. splunkd returns 405 for any
 verb omitted here, before the request reaches Python, so deriving it means adding a POST route
 needs no corresponding edit in conf either.
 */
const makeWebConf = (handlers: Record<string, HandlerDescription>) => {
  const sections = [GENERATED_BY.trimEnd(), ''];

  for (const [name, handler] of Object.entries(handlers)) {
    const namespace = restMatchFor(name, handler.rootPath).replace(/^\//, '');
    sections.push(
      `[expose:${name}]`,
      `pattern = ${namespace}/**`,
      `methods = ${exposedMethods(handler.methods).join(',')}`,
      ''
    );
  }

  return sections.join('\n');
}

/*
 The parts of app.conf the build owns outright - constants that are really build knowledge
 rather than app config, each with the reason it is what it is.

 Everything derived from package.json is stamped in afterwards rather than written here, so
 there is exactly one code path for a derived value whether this file was generated or supplied
 by hand. The stanzas are left empty on purpose for that stamping to fill.
 */
const makeAppConf = () => [
  '# Generated by pluginSplunk. `label`, `version`, `description`, `author`, `[id] name`,',
  '# `[package] id` and `[install] build` are derived from package.json and are re-stamped on',
  '# every build, so editing them here does nothing.',
  '#',
  '# Unlike the other generated conf, this file MERGES: write your own default/app.conf with',
  '# whatever else you need - setup_view, [triggers], docs links - and the derived values are',
  '# stamped into it rather than replacing it.',
  '',
  '[ui]',
  'is_visible = 1',
  '# setup_view = setup',
  '# Splunk 10 renders app pages in the user\'s chosen theme; declaring support is what lets a',
  '# dark-mode user see a dark page rather than a light one inside dark chrome.',
  'show_app_dark_theme = true',
  'supported_themes = light,dark',
  '',
  '[launcher]',
  '',
  '[id]',
  '',
  '[package]',
  '# Splunk Cloud stacks older than 8.2.2112 require [package] id for private-app install.',
  'check_for_updates = 0',
  '',
  '[install]',
  '# `is_configured = 1` is an App Inspect failure for Splunkbase submission - it claims the app',
  '# has already completed a setup step it has not.',
  'is_configured = 0',
  '',
].join('\n');

/*
 Default permissions for the app's knowledge objects.

 Two counterintuitive facts, both verified against App Inspect: shipping NO metadata directory
 passes, while shipping an EMPTY `default.meta` is a hard failure
 (`check_meta_default_write_access`) - so this file must have real content or not exist at all.
 And `write` must name roles rather than `*`, which is its own failure.

 `sc_admin` rides alongside `admin` because Splunk Cloud administrators hold the former, not the
 latter; including it also clears the `check_kos_are_accessible` warning.
 */
const makeDefaultMeta = () => [
  '# Generated by pluginSplunk. Do not edit - your changes will be overwritten on the next',
  '# build. Write your own metadata/default.meta to take this over completely.',
  '',
  '[]',
  'access = read : [ * ], write : [ admin, sc_admin ]',
  '',
  '# `export = system` makes this app\'s knowledge objects (lookups, saved searches, KV store',
  '# collections) visible from other apps. Remove it to scope them to this app only.',
  'export = system',
  '',
].join('\n');

/** SemVer 2.0.0, which is what App Inspect checks `[launcher] version` against. */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;

/** Import specifiers must use forward slashes even on Windows. */
const toSpecifier = (absPath: string) => JSON.stringify(absPath.replace(/\\/g, '/'));

const SOURCE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.vue'];

/*
 Which runtime mounts a page, chosen by the page's file extension.

 A `.vue` page is mounted by `splunkapp/vue`, anything else by `splunkapp/react`. The two
 export the same `mountSplunkPage(module)` signature, which is what lets the generated entry
 below be identical either way - and what lets one app hold pages of both kinds.
 */
const MOUNT_MODULES = {
  react: 'splunkapp/react/splunk-page',
  vue: 'splunkapp/vue/splunk-page',
} as const;

const mountModuleFor = (pagePath: string) =>
  path.extname(pagePath) === '.vue' ? MOUNT_MODULES.vue : MOUNT_MODULES.react;

/*
 Generated entries are plain `.js` so they need no transpilation, which means they can live
 under node_modules (the one directory guaranteed writable in the dev container). That only
 holds if every specifier is fully resolved - extensionless imports are not reliably
 resolved from inside node_modules.
 */
const resolveSourceFile = (absPathWithoutExt: string) => {
  if (path.extname(absPathWithoutExt)) return absPathWithoutExt;
  for (const extension of SOURCE_EXTENSIONS) {
    const candidate = `${absPathWithoutExt}${extension}`;
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not resolve a source file for "${absPathWithoutExt}"`);
}

/*
 A page in `src/pages/` is a plain component with a default export - no Splunk-specific
 bootstrapping, no stylesheet import, no mount call. This generates the module that
 supplies all three, so the page file stays ordinary React.

 A page may also `export const splunkPageOptions = { hideAppBar: true }` to configure the
 surrounding Splunk layout.
 */
const makeEntryBootstrap = (pagePath: string, mountPath: string, globalsPath?: string) => {
  const lines = [
    '// Generated by pluginSplunk. Do not edit - your changes will be overwritten.',
    `import * as page from ${toSpecifier(pagePath)};`,
    `import { mountSplunkPage } from ${toSpecifier(mountPath)};`,
  ];
  if (globalsPath) lines.push(`import ${toSpecifier(globalsPath)};`);
  // The whole namespace is handed over rather than `page.default` / `page.splunkPageOptions`:
  // statically reading a named export the page does not declare is an ESM linking error, and
  // `splunkPageOptions` is optional.
  lines.push('', 'mountSplunkPage(page);', '');
  return lines.join('\n');
}

export const pluginSplunk = (options: PluginSplunkOptions): RsbuildPlugin => ({
  name: 'splunk-plugin',

  setup(api) {
    /*
     Captured from the user's `cleanDistPath` before it is repointed, so the plugin's own
     clean honours the same `keep` rules (which exist to preserve `local/` overrides).
     `null` means the user disabled cleaning and the plugin must not clean either.
     */
    let distKeepPatterns: RegExp[] | null = [];

    /*
     Whether to target Splunk's first-party page template instead of shipping our own Mako
     template. This changes the view XML, the JS output path and filename, chunking, and CSS
     handling - see `MODERN_VIEW_TEMPLATE`.
     */
    const useModernViewTemplate = atLeastVersion(
      options.minSplunkVersion || MODERN_VIEW_MIN_VERSION,
      MODERN_VIEW_MIN_VERSION
    );

    const minSplunkVersion = options.minSplunkVersion || MODERN_VIEW_MIN_VERSION;
    const targetPythonVersion = options.targetPythonVersion || '3.9';

    /*
     The two version settings are not independent: 10.0 ships only Python 3.9, while 10.2 and
     10.4 ship 3.9 and 3.13 side by side. Asking for an interpreter the oldest supported release
     does not have is unsatisfiable, and failing here is much kinder than the alternative -
     Splunk treats an unavailable `python.required` as a typo and silently falls back to the
     NEWEST interpreter installed, which runs the app under a Python that cannot load its own
     bundled extensions.
     */
    const availablePythons = splunkPythonVersions(minSplunkVersion);
    if (!availablePythons.includes(targetPythonVersion)) {
      throw new Error(
        `[splunk-plugin] targetPythonVersion "${targetPythonVersion}" is not available on ` +
        `Splunk ${minSplunkVersion}, the oldest release minSplunkVersion says this app supports ` +
        `(it ships ${availablePythons.join(' and ')}). Either raise minSplunkVersion or target an ` +
        `interpreter every supported release actually has.`
      );
    }

    const jobs = options.jobs || {};
    const jobNames = Object.keys(jobs);
    const jobScheme = options.jobScheme || options.appId;
    const appTitle = options.appTitle || titleCase(options.appId);

    /*
     Normalised to the long form up front, so everything downstream reads one shape. The short
     form - `handlers: { api: './backend/api.py' }` - is what the template ships, because the
     attribute is `app` in every FastAPI tutorial ever written.
     */
    const handlers: Record<string, { script: string; app: string }> = {};
    for (const [name, entry] of Object.entries(options.handlers || {})) {
      handlers[name] =
        typeof entry === 'string'
          ? { script: entry, app: 'app' }
          : { script: entry.script, app: entry.app || 'app' };
    }
    const handlerNames = Object.keys(handlers);

    /*
     Filled in during the `additional` stage, where the pip install's temp directory still
     exists and the app's Python can therefore be imported. Consumed in `derived`, which is the
     first stage where `output.copy` has definitely landed, so generated conf can tell whether a
     hand-written file of the same name is already present.
     */
    let described: AppDescription | null = null;
    let describedHandlers: Record<string, HandlerDescription> | null = null;
    let jobShimSource = '';
    let bundledBinaryPackages: string[] = [];

    api.onBeforeCreateCompiler(() => {
      if (distKeepPatterns === null) return;
      // `api.context.distPath` is already repointed at appserver/static by this stage.
      cleanDistDirectory(path.resolve(api.context.distPath, '../../'), distKeepPatterns);
    });

    api.modifyHTMLTags(({ headTags, bodyTags }) => {
      // Nothing to wrap when Splunk supplies the page - no HTML is emitted at all.
      if (useModernViewTemplate) return { headTags, bodyTags };

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
       Record the caller's clean settings before `distPath.root` is repointed below, since
       that repointing is exactly what puts the rest of the app outside Rsbuild's reach.
       */
      const cleanDistPath = config.output?.cleanDistPath;
      if (cleanDistPath === false) {
        distKeepPatterns = null;
      } else if (typeof cleanDistPath === 'object' && cleanDistPath !== null) {
        distKeepPatterns = cleanDistPath.keep || [];
      }

      /*
       Replace each entry with a generated bootstrap module that mounts the page. Keys are
       preserved, so view XML generation downstream is unaffected.
       */
      const entry = config.source?.entry;
      if (entry) {
        const rootPath = api.context.rootPath;
        const generatedDir = path.join(rootPath, 'node_modules', '.splunk-entries');
        mkdirSync(generatedDir, { recursive: true });

        const globalsCss =
          options.globalsCss === null
            ? undefined
            : path.resolve(rootPath, options.globalsCss || 'frontend/globals.css');

        const generatedEntry: Record<string, string> = {};
        for (const [name, value] of Object.entries(entry)) {
          // Entry values may be a path, a list of paths, or a descriptor object.
          const raw = Array.isArray(value)
            ? value[0]
            : typeof value === 'string'
              ? value
              : (value as { import?: string | string[] }).import;
          const pageRef = Array.isArray(raw) ? raw[0] : raw;
          if (typeof pageRef !== 'string') {
            throw new Error(`Cannot resolve a page module for entry "${name}"`);
          }

          const pagePath = resolveSourceFile(path.resolve(rootPath, pageRef));
          const mountPath = resolveSourceFile(
            path.resolve(rootPath, mountModuleFor(pagePath))
          );

          const bootstrapPath = path.join(generatedDir, `${name}.js`);
          writeFileSync(
            bootstrapPath,
            makeEntryBootstrap(pagePath, mountPath, globalsCss)
          );
          generatedEntry[name] = bootstrapPath;
        }

        config.source = { ...config.source, entry: generatedEntry };
      }

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
        // Splunk's first-party template looks for the entry bundle at
        // `/static/app/<appId>/pages/<viewName>.js` and nowhere else.
        js: useModernViewTemplate ? 'pages' : 'js',
        css: 'css',
      }

      if (useModernViewTemplate) {
        /*
         Splunk loads exactly one script, at a path it derives from the view name. Three
         consequences, none optional:

         - the entry filename must be unhashed and equal to the view name
         - split chunks would never be requested, so there must not be any
         - there is no stylesheet hook in the template, so CSS has to ride inside the bundle

         `@splunk/create` reaches the same three settings; Splunk's own apps avoid the last one
         only because they use CSS-in-JS rather than a stylesheet.
         */
        config.output.filename = { ...config.output.filename, js: '[name].js' };
        config.output.injectStyles = true;
        config.performance = {
          ...config.performance,
          chunkSplit: { strategy: 'all-in-one' },
        };
        // Suppresses the per-entry HTML that would otherwise land in appserver/templates/.
        config.tools = { ...config.tools, htmlPlugin: false };
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
        let introspectionDirectory;
        try {
          temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "rsbuild-pluginSplunk-"));

          const pythonBin = options.pythonBin || 'python3.9';
          const libDir = `${temporaryDirectory}/lib`;
          const targetPythonVersion = options.targetPythonVersion || '3.9';

          /*
           Warn when the build interpreter is not the version the app will actually run under.

           The second pass below re-fetches compiled extensions for the target platform, but nothing
           pins the *resolution* version - and pip resolves environment markers against the running
           interpreter. `anyio` requires `exceptiongroup` only for `python_version < "3.11"`, so a
           build on Python 3.12+ silently omits it and `import fastapi` then fails inside Splunk with
           a ModuleNotFoundError that points at a package nobody asked for.

           This cannot simply be fixed by passing `--python-version`: pip only accepts it together
           with `--only-binary=:all:`, and splunk-sdk publishes no wheel at all. So the build warns
           instead. `docker compose up` runs this under Splunk's own interpreter and is unaffected.
           */
          try {
            const probe = execSync(
              `${pythonBin} -c "import sys; print('%d.%d' % sys.version_info[:2]); print(sys.executable)"`
            ).toString().trim().split('\n');
            const [buildPythonVersion, buildPythonPath] = probe;

            if (buildPythonVersion !== targetPythonVersion) {
              compilation.warnings.push(new Error(
                `[splunk-plugin] bundling Python dependencies with Python ${buildPythonVersion} ` +
                `(${buildPythonPath}) but the app targets Python ${targetPythonVersion}. pip resolves ` +
                `dependencies against the interpreter running the build, so dist/lib/ can end up ` +
                `both missing packages Splunk needs and holding versions too new to import under ` +
                `${targetPythonVersion} - "import fastapi" failing on a missing "exceptiongroup", or ` +
                `annotated_types importing EllipsisType, are the usual symptoms. Neither shows up ` +
                `until the app runs inside Splunk. Build with Splunk's own interpreter ` +
                `("docker compose up"), or set SPLUNK_APP_PYTHON to a Python ${targetPythonVersion}.`
              ));
            }
          } catch {
            // A probe failure is not itself fatal - the pip invocation below will report the
            // real problem if the interpreter is genuinely unusable.
          }

          /*
           Pass 1: resolve and install for the interpreter running the build. This settles
           dependency versions, which are governed by the interpreter's Python version.
           */
          execSync(`${pythonBin} -m pip install -qqq --disable-pip-version-check -t ${libDir} -r requirements.txt`)

          /*
           Read the app's own declarations back out of its Python.

           Placement is load-bearing twice over. It must be inside the try, because importing a
           job module pulls in pydantic and splunklib and the `finally` deletes them. And it must
           run *before* the platform pass below: that pass replaces the freshly-installed
           extensions with ones built for the target ABI, which the interpreter running this build
           generally cannot load. Introspecting first means it imports the binaries pip just built
           for this machine, so a build on any host works even though what ships is cp39/linux.

           Doing this by importing rather than by parsing is what keeps `inputs.conf` and
           `collections.conf` from drifting - there is only ever one declaration, in Python.
           */
          const rootPath = api.context.rootPath;

          /*
           Everything the probe scripts below need on `sys.path`, mirroring what Splunk itself
           puts there at runtime: the app's `bin/`, which after the build holds both the
           template's Python and everything copied out of `backend/`.
           */
          const moduleDirectories = new Set<string>([
            // splunkapp.py lives here, and the job shim imports it before anything else.
            path.resolve(rootPath, options.appResourcesRoot || './resources', 'bin'),
            path.resolve(rootPath, options.appBackendRoot || './backend'),
          ]);

          const introspectionEnv = () => ({
            ...process.env,
            PYTHONPATH: [libDir, ...moduleDirectories].join(path.delimiter),
            // Importing the app's modules must not leave a __pycache__ behind in the user's
            // source tree: output.copy would pick it up on a later build and ship compiled
            // Python, which is a hard App Inspect failure.
            PYTHONDONTWRITEBYTECODE: '1',
          });

          if (handlerNames.length > 0 || jobNames.length > 0) {
            /*
             In its own directory, NOT in `temporaryDirectory`. Everything under that one is
             swept into `dist/` further down as bundled Python, so a script written there ships
             at the root of the app - next to `bin/`, `default/` and `lib/`, where nothing
             executes it and it looks like a mistake. Which it was.
             */
            introspectionDirectory = mkdtempSync(
              path.join(os.tmpdir(), 'rsbuild-pluginSplunk-scheme-')
            );
          }

          /*
           Read each REST handler's `root_path` and routes back out of the ASGI app object.

           `restmap.conf` and `web.conf` are two files that have to agree with each other and
           with the Python, and getting any pair of the three out of step produces a 404 with
           nothing in any log to explain it. Generating both from the app itself removes the
           opportunity: the prefix is declared once, on `FastAPI(root_path=...)`, next to the
           routes that live under it.
           */
          if (handlerNames.length > 0 && introspectionDirectory) {
            const probeSpec: Record<string, { script: string; app: string }> = {};
            for (const [handlerName, handler] of Object.entries(handlers)) {
              const absolutePath = path.resolve(rootPath, handler.script);
              if (!existsSync(absolutePath)) {
                throw new Error(
                  `[splunk-plugin] splunkApp.handlers declares "${handlerName}" at ` +
                  `"${handler.script}", but no such file exists.`
                );
              }
              moduleDirectories.add(path.dirname(absolutePath));
              probeSpec[handlerName] = { script: absolutePath, app: handler.app };
            }

            const probePath = path.join(introspectionDirectory, 'handler_probe.py');
            const probeSpecPath = path.join(introspectionDirectory, 'handlers.json');
            writeFileSync(probePath, HANDLER_PROBE);
            writeFileSync(probeSpecPath, JSON.stringify(probeSpec));

            let handlerOutput: string;
            try {
              handlerOutput = execSync(
                `${pythonBin} ${JSON.stringify(probePath)} ${JSON.stringify(probeSpecPath)}`,
                { env: introspectionEnv(), stdio: ['ignore', 'pipe', 'pipe'] }
              ).toString();
            } catch (error) {
              const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim();
              throw new Error(
                `[splunk-plugin] could not read this app's REST handlers. The build imports ` +
                `every module named in splunkApp.handlers so it can read the ASGI app's ` +
                `root_path and routes, and that import failed:\n\n${stderr || String(error)}`
              );
            }

            describedHandlers = JSON.parse(handlerOutput) as Record<string, HandlerDescription>;

            /*
             Two handlers on the same prefix is not a conf error - splunkd accepts it and then
             routes every request to whichever stanza it read last. Failing here is the only
             place this is visible.
             */
            const seen = new Map<string, string>();
            for (const [handlerName, handler] of Object.entries(describedHandlers)) {
              const match = restMatchFor(handlerName, handler.rootPath);
              const previous = seen.get(match);
              if (previous) {
                throw new Error(
                  `[splunk-plugin] REST handlers "${previous}" and "${handlerName}" both declare ` +
                  `root_path "${handler.rootPath}". Each handler needs its own prefix, or only ` +
                  `one of them will ever receive a request.`
                );
              }
              seen.set(match, handlerName);
            }
          }

          if (jobNames.length > 0 && introspectionDirectory) {
            const jobModules: string[] = [];

            for (const [jobName, jobPath] of Object.entries(jobs)) {
              const absolutePath = path.resolve(rootPath, jobPath);
              if (!existsSync(absolutePath)) {
                throw new Error(
                  `[splunk-plugin] splunkApp.jobs declares "${jobName}" at "${jobPath}", but no ` +
                  `such file exists.`
                );
              }
              moduleDirectories.add(path.dirname(absolutePath));
              const moduleName = path.basename(absolutePath, path.extname(absolutePath));
              if (!jobModules.includes(moduleName)) jobModules.push(moduleName);
            }

            jobShimSource = makeJobShim(jobScheme, appTitle, jobModules);
            const shimPath = path.join(introspectionDirectory, `${jobScheme}.py`);
            writeFileSync(shimPath, jobShimSource);

            let describeOutput: string;
            try {
              describeOutput = execSync(`${pythonBin} ${JSON.stringify(shimPath)} --describe`, {
                env: introspectionEnv(),
                stdio: ['ignore', 'pipe', 'pipe'],
              }).toString();
            } catch (error) {
              const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim();
              throw new Error(
                `[splunk-plugin] could not read this app's scheduled job declarations. The build ` +
                `imports every module named in splunkApp.jobs so it can read their @scheduled ` +
                `decorators, and that import failed:\n\n${stderr || String(error)}`
              );
            }

            described = JSON.parse(describeOutput) as AppDescription;

            /*
             package.json and the decorators are two halves of one declaration, so they have to
             agree exactly. A job in the map with no decorator would produce a stanza Splunk runs
             and the runtime then rejects; a decorated function missing from the map would look
             scheduled in the source and simply never run - the worse of the two, because nothing
             anywhere reports it.
             */
            const registered = described.jobs.map((job) => job.name);
            const undecorated = jobNames.filter((name) => !registered.includes(name));
            const unlisted = registered.filter((name) => !jobNames.includes(name));
            if (undecorated.length > 0 || unlisted.length > 0) {
              const problems: string[] = [];
              if (undecorated.length > 0) {
                problems.push(
                  `listed in splunkApp.jobs but no @scheduled function of that name was found: ` +
                  `${undecorated.join(', ')}`
                );
              }
              if (unlisted.length > 0) {
                problems.push(
                  `decorated with @scheduled but missing from splunkApp.jobs, so they would never ` +
                  `be scheduled: ${unlisted.join(', ')}`
                );
              }
              throw new Error(`[splunk-plugin] scheduled jobs do not line up - ${problems.join('; ')}.`);
            }

            // Recorded now because the transforms.conf warning in `derived` needs it and the
            // directory it is read from is about to be deleted.
            bundledBinaryPackages = findBinaryDistributions(libDir).map(({ name }) => name);
          }

          /*
           Pass 2: re-fetch anything that shipped a compiled extension, pinned to the platform
           Splunk actually runs on.

           Without this, `dist/lib/` inherits the build machine's platform - building on macOS
           would emit `_pydantic_core.cpython-39-darwin.so` and the app would fail to import on
           a Linux Splunk, with no build-time error.

           It cannot simply be applied to the whole requirements file: pip only accepts
           `--platform` alongside `--only-binary=:all:`, and packages that publish no wheel at
           all (splunk-sdk, at time of writing) would then fail to install.
           */
          const targetPlatform = options.targetPlatform === undefined
            ? 'manylinux2014_x86_64'
            : options.targetPlatform;

          if (targetPlatform !== null) {
            const platforms = Array.isArray(targetPlatform) ? targetPlatform : [targetPlatform];
            const platformArgs = platforms.map((platform) => `--platform ${platform}`).join(' ');
            for (const distribution of findBinaryDistributions(libDir)) {
              removeDistribution(libDir, distribution);
              execSync(
                `${pythonBin} -m pip install -qqq --disable-pip-version-check -t ${libDir} ` +
                `${platformArgs} --python-version ${targetPythonVersion} --only-binary=:all: --no-deps ` +
                `--upgrade ${distribution.name}==${distribution.version}`
              );
            }
          }

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
          if (introspectionDirectory) {
            rmSync(introspectionDirectory, { recursive: true, force: true });
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

        const views = options.views || {};
        const viewNames = Object.keys(config.source.entry);

        const warn = (message: string) =>
          compilation.warnings.push(new Error(`[splunk-plugin] ${message}`));

        /*
         A hand-written file of the same name always wins, matching how `default.xml` behaves:
         someone who has written their own has deliberately opted out, and silently overwriting
         it would be the more surprising behaviour. It warns, because the opt-out is total -
         none of the generated stanzas appear.
         */
        const emitGenerated = (assetPath: string, contents: string, description: string) => {
          if (assetPath in assets) {
            warn(
              `${description} already exists in this app's resources, so the generated version ` +
              `was not written. The declarations in your Python are being ignored for this ` +
              `file - delete the hand-written copy to go back to generated conf.`
            );
            return;
          }
          compilation.emitAsset(assetPath, new sources.RawSource(contents));
        };

        // Create dashboards to load each entry point
        viewNames.forEach((key) => {
          // path is relative to distPath, which is appserver/static
          const assetPath = `../../default/data/ui/views/${key}.xml`;
          if (assetPath in assets) return;
          const label = views[key]?.label || titleCase(key);
          const template = useModernViewTemplate
            ? MODERN_VIEW_TEMPLATE
            : `${options.appId}:/templates/${key}.html`;
          compilation.emitAsset(
            assetPath,
            new sources.RawSource(makeSplunkView(template, label))
          );
        })

        /*
         Stamp the identity and cache-defeater fields into app.conf rather than asking anyone to
         keep them in sync by hand.

         `[package] id` and `[id] name` must both equal the app's directory name. Deriving them
         from `splunkApp.appId` means a rename is one edit, not four - a half-applied rename is
         otherwise silent until Splunk refuses to load the app.

         `[install] build` is the `:N` segment Splunk embeds in static asset URLs. If it does not
         change, browsers keep serving the previous build's JS. It is a timestamp rather than a
         counter so that it increases without the build needing to persist state; this does mean
         two builds of identical source produce different app.conf bytes.
         */
        const appConfPath = `../../default/app.conf`;
        const handWrittenAppConf = appConfPath in assets;

        if (options.appVersion && !SEMVER.test(options.appVersion)) {
          warn(
            `package.json version "${options.appVersion}" is not valid SemVer 2.0.0, which is ` +
            `what App Inspect checks [launcher] version against. It ships as-is.`
          );
        }

        /*
         Every value here has exactly one source, and it is not this file. `[ui] label` restates
         splunkApp.appTitle; the two `version` keys restate package.json's, and Splunk requires
         them to match each other exactly. Stamping rather than asking anyone to keep three
         copies in step is the whole point - so these overwrite a hand-written value, while
         anything the build has no opinion about (setup_view, [triggers], docs links) is left
         exactly as written.
         */
        const derived: Array<[string, string, string | undefined]> = [
          ['ui', 'label', appTitle],
          ['launcher', 'author', options.appAuthor],
          ['launcher', 'description', options.appDescription],
          ['launcher', 'version', options.appVersion],
          ['id', 'name', options.appId],
          ['id', 'version', options.appVersion],
          ['package', 'id', options.appId],
          // The `:N` cache-defeater segment in static asset URLs. Fixed across builds means
          // browsers keep serving the previous bundle. A timestamp increases without the build
          // having to persist state, at the cost of two identical sources differing here.
          ['install', 'build', String(Math.floor(Date.now() / 1000))],
        ];

        let appConf = handWrittenAppConf
          ? assets[appConfPath].source().toString()
          : makeAppConf();
        for (const [stanza, key, value] of derived) {
          if (value === undefined || value === '') continue;
          appConf = setConfValue(appConf, stanza, key, value);
        }
        if (!appConf.endsWith('\n')) appConf += '\n';

        if (handWrittenAppConf) {
          compilation.updateAsset(appConfPath, new sources.RawSource(appConf));
        } else {
          compilation.emitAsset(appConfPath, new sources.RawSource(appConf));
        }

        /*
         Unlike app.conf there is nothing here to derive, so a hand-written file is simply left
         alone rather than merged into - permissions are not something to half-generate.
         */
        const defaultMetaPath = `../../metadata/default.meta`;
        if (!(defaultMetaPath in assets)) {
          compilation.emitAsset(defaultMetaPath, new sources.RawSource(makeDefaultMeta()));
        }

        /*
         Splunk 10.4 moved app views into a vertical sidebar, and an app with no nav
         definition gets a generated one with no icons. Generating it from the same entry
         map means adding a page needs no second edit.

         A hand-written `resources/splunk/default/data/ui/nav/default.xml` wins - it is
         copied in before this runs, so it is already present in `assets`.
         */
        const navPath = `../../default/data/ui/nav/default.xml`;
        if (!(navPath in assets) && viewNames.length > 0) {
          compilation.emitAsset(
            navPath,
            new sources.RawSource(
              makeSplunkNav(viewNames, views, options.defaultIcon, (message) =>
                compilation.warnings.push(new Error(`[splunk-plugin] ${message}`))
              )
            )
          );
        }

        /*
         Turn the declarations read out of Python into the conf Splunk needs.

         A hand-written file of the same name always wins, matching how `default.xml` behaves:
         someone who has written their own has deliberately opted out, and silently overwriting
         it would be the more surprising behaviour. It warns, because the opt-out is total - none
         of the generated stanzas appear.
         */
        /*
         Register and expose each REST handler.

         Both files are generated from the same probe of the ASGI app, which is what stops the
         classic failure: `restmap.conf` and `web.conf` are separate files that must agree, and
         a handler registered in one but not the other is unreachable with nothing logged.
         */
        if (describedHandlers !== null && Object.keys(describedHandlers).length > 0) {
          emitGenerated(
            `../../default/restmap.conf`,
            makeRestmapConf(describedHandlers),
            'default/restmap.conf'
          );
          emitGenerated(
            `../../default/web.conf`,
            makeWebConf(describedHandlers),
            'default/web.conf'
          );
        }

        if (described !== null) {
          emitGenerated(
            `../../bin/${jobScheme}.py`,
            jobShimSource,
            `bin/${jobScheme}.py`
          );

          const pythonSettings = makePythonSettings(minSplunkVersion, targetPythonVersion);
          emitGenerated(
            `../../default/inputs.conf`,
            makeInputsConf(jobScheme, options.appId, described.jobs, pythonSettings),
            'default/inputs.conf'
          );
          emitGenerated(
            `../../README/inputs.conf.spec`,
            makeInputsSpec(jobScheme, appTitle, described.jobs),
            'README/inputs.conf.spec'
          );

          const collections = described.collections;
          if (collections.length > 0) {
            emitGenerated(
              `../../default/collections.conf`,
              makeCollectionsConf(collections),
              'default/collections.conf'
            );
          }

          /*
           A field with no usable collections.conf type is almost always a list of objects. Those
           store and read back through the REST API completely intact, which is exactly what makes
           this worth warning about: the field is silently dropped from SPL results, so it looks
           fine everywhere except the one place people go looking for it.
           */
          for (const declared of collections) {
            if (declared.undeclarable.length === 0) continue;
            warn(
              `collection "${declared.name}" has field(s) with no collections.conf type: ` +
              `${declared.undeclarable.join(', ')}. They are stored and read back correctly over ` +
              `REST, but a list-of-object field is silently dropped from SPL results - so these ` +
              `will be invisible to searches and lookups.`
            );
          }

          const lookupCollections = collections.filter((declared) => declared.lookup);
          if (lookupCollections.length > 0) {
            emitGenerated(
              `../../default/transforms.conf`,
              makeTransformsConf(lookupCollections),
              'default/transforms.conf'
            );

            /*
             Shipping transforms.conf is what makes App Inspect's `check_idx_binary_compatibility`
             applicable, and that check fails on any compiled extension not built for every
             supported architecture. Without a lookup the same binaries are fine, so this is a
             cost that arrives quietly, attached to a setting that looks unrelated.
             */
            if (bundledBinaryPackages.length > 0) {
              warn(
                `collection(lookup=True) generates transforms.conf, which brings App Inspect's ` +
                `check_idx_binary_compatibility into scope for this app. ` +
                `${bundledBinaryPackages.join(', ')} ship compiled extensions built for ` +
                `${options.targetPlatform || 'manylinux2014_x86_64'} only, so cloud vetting will ` +
                `now fail on architectures they do not cover. Drop lookup=True if SPL does not ` +
                `need the collection.`
              );
            }
          }
        }

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

        /*
         Compiled Python is an App Inspect failure (`check_for_compiled_python`), and it can enter
         from anywhere - not just the pip install into lib/, but also `output.copy` picking up a
         __pycache__ left in resources/ by a developer running the backend locally, which the
         README actively suggests doing. So this sweep is not scoped to bin/ and lib/.
         */
        if (
          normalizedAssetPath.endsWith(".pyc") ||
          normalizedAssetPath.endsWith(".pyo") ||
          normalizedAssetPath.includes("__pycache__")
        ) {
          compilation.deleteAsset(assetPath);
        }

        if (normalizedAssetPath.startsWith("bin/") || normalizedAssetPath.startsWith("lib")) {
          if (normalizedAssetPath.includes(".dist-info") || normalizedAssetPath.includes(".egg-info")) {
            compilation.deleteAsset(assetPath);
          }
        }
      })
    })
  },
});