# CLAUDE.md

What is non-obvious about this template. The stack, scripts, ports and directory layout are
discoverable from `package.json`, `rsbuild.config.ts`, `docker-compose.yml` and a directory listing.

## Where things live

**Your app is `frontend/` and `backend/`. Everything else ships with the template.**

| directory | what | edit it? |
|---|---|---|
| `frontend/` | pages, components, styles | yes — this is your app |
| `backend/` | FastAPI modules, `@scheduled` jobs. Copied wholesale into the app's `bin/` | yes — this is your app |
| `splunkapp/` | the TS runtime: `react/`, `vue/`, `lib/`. Aliased as `@splunkapp/*` | no |
| `resources/` | `bin/persistconn.py`, `bin/splunkapp.py` — nothing else | no |
| `pluginSplunk.ts` | the build | only to change build behaviour |

`@/*` points at `frontend/`, `@splunkapp/*` at `splunkapp/`.

## The core idea

Splunk config is **generated from declarations in code** — a page in `frontend/pages/` becomes a
view and nav entry, a FastAPI app's `root_path` becomes `restmap.conf` + `web.conf`, an
`@scheduled` function becomes a modular input, a Pydantic model passed to `collection()` becomes a
KV store collection. Two consequences:

- **A hand-written file silently beats the generated one.** Writing `default/restmap.conf`,
  `default/web.conf`, `default/inputs.conf`, `default/collections.conf`, `metadata/default.meta`
  or `data/ui/nav/default.xml` by hand disables the matching declarations, with only a build
  warning. It is also the escape hatch when you want full control — a `capability = ...` on a
  handler, for instance.
- **`default/app.conf` is the one exception: it merges.** A hand-written copy keeps its own
  settings (`setup_view`, `[triggers]`, docs links) and still gets `label`, both `version` keys,
  `description`, `author`, `[id] name`, `[package] id` and `[install] build` stamped in from
  `package.json`. Editing those keys by hand does nothing.
- **Known bug:** *removing* an entry, handler or job leaves its generated conf behind — Rspack's
  persistent cache restores the last build's assets and each generator skips paths that already
  exist. Clear `node_modules/.cache` and delete the orphans.

## Don't modify

- `resources/bin/persistconn.py` — Splunk↔ASGI protocol bridge
- `resources/bin/splunkapp.py` — the `@scheduled` + `collection()` runtime. One file on
  purpose; if it outgrows that it becomes a separately versioned library — flag it, don't split it
  unilaterally
- `splunkapp/` — the React and Vue mounts and the shared `lib/`. Adding a framework means adding a
  sibling of `splunkapp/react/` that exports the same `mountSplunkPage(module)`
- `pluginSplunk.ts` — unless deliberately changing build behaviour
- Anything generated under `dist/`: `bin/<appId>.py`, `default/app.conf`, `default/restmap.conf`,
  `default/web.conf`, `default/inputs.conf`, `default/collections.conf`, `metadata/default.meta`,
  `README/inputs.conf.spec`, view XML, nav. Edit the declaration instead — for `app.conf` that
  means `package.json`'s `version`/`description`/`author` and `splunkApp.appTitle`

## Frontend pages

A page is a plain component with a default export, registered in `rsbuild.config.ts` under
`source.entry`. The build generates the module that imports the stylesheet, wraps the page in the
right framework's providers (theme + current user) and mounts it into Splunk's layout — so **do not
import `globals.css`, and do not call a mount function yourself.**

- **React** (`.tsx`) imports from `@splunkapp/react`; **Vue** (`.vue`) from `@splunkapp/vue`. The
  build picks the mount by file extension, so one app can hold both. The two export the same
  surface, with Vue refs where React has hooks
- A Vue page still bundles React: Splunk's chrome (`@splunk/react-page`) is React and has no Vue
  equivalent, so a Vue page runs inside a one-component React host and owns everything below
  `<div data-splunk-vue-root>`
- Per-page layout: `export const splunkPageOptions = { hideAppBar: true }`
- Nav label and icon: `splunkApp.views` in `package.json`, keyed by entry name. Splunk 10.4's sidebar
  resolves only about 29 icon names; anything else silently degrades to a letter monogram, and the
  build warns with the full list
- `TailwindThemeSync` is **not** `SplunkThemeProvider` from `@splunk/themes` — different components
  with different jobs. Using `@splunk/react-ui` means you need both, composed

## Calling the backend

Use the client from `@splunkapp/react` or `@splunkapp/vue` (both re-export `@splunkapp/lib`):
`apiGet` / `apiPost` / `apiPut` / `apiPatch` / `apiDelete`, plus `createSplunkApiClient(namespace)`
for a second handler. Paths are relative to this app's REST namespace, which is read off the page
URL rather than baked in at build time.

**Never a bare `fetch`.** splunkd rejects any POST/PUT/PATCH/DELETE that lacks *both*
`X-Splunk-Form-Key` (from the `splunkweb_csrf_token_<webport>` cookie) and
`X-Requested-With: XMLHttpRequest`, with a 401 "CSRF validation failed" that never reaches Python. GET
is unaffected, so this only bites once a page grows its first write.

Non-2xx rejects with a `SplunkApiError` carrying `status`, `url` and the parsed `body` — FastAPI's
`{"detail": ...}`, or Splunk's own error envelope (sometimes XML) when splunkd rejected the request
before Python saw it.

## Backend endpoints

Ordinary FastAPI in `backend/`, running under **Python 3.9**. Register each module in
`package.json` under `splunkApp.handlers` — `{"api": "./backend/api.py"}` — mirroring
`source.entry`. The key names the `[script:...]` stanza; the value's module must expose an ASGI
app called `app` (or name it: `{"api": {"script": "./backend/api.py", "app": "application"}}`).

- **`root_path` is the single source of truth for where the handler is mounted.** The build imports
  the module, reads `root_path`, and generates `restmap.conf`'s `match` and `web.conf`'s `pattern`
  from it. It must start with `/services/`, or the build fails. `web.conf`'s `methods` is the union
  of the verbs your routes declare, so adding a POST route needs no conf edit
- `restmap.conf` registers the handler and `web.conf` exposes it; a handler in one but not the other
  is unreachable with nothing logged. Generating both from one probe is what removes that failure
- Identity arrives by dependency injection: `Depends(current_splunk_user)`. **Never read headers** —
  splunkd authenticates before Python runs. `Depends(splunk_service)` gives a `splunklib` client bound
  to the calling user, so Splunk's access controls apply
- Two handlers declaring the same `root_path` is a build failure: splunkd accepts it and then routes
  every request to whichever stanza it read last

Everything under `backend/` lands in the app's `bin/`, which is the only directory Splunk puts on
`sys.path`. So a module there is importable by name from any other (`from quake_data import ...`),
and a name that collides with something in `lib/` will lose.

## Scheduled jobs and KV store

```python
from splunkapp import collection, scheduled

GIZMOS = collection(Gizmo, name="gizmos")          # Gizmo is a Pydantic model

@scheduled(seconds=300, index="main", sourcetype="sprockets:gizmo")
def collect(splunk, state, log):
    """One-line docstring becomes the inputs.conf comment."""
    GIZMOS.bind(splunk, log).upsert("gizmo-1", Gizmo(...))
    return [{"gizmo": "a"}]                        # returned records are indexed
```

Register it in `package.json` under `splunkApp.jobs` — `{"collect": "./backend/jobs.py"}` —
mirroring `source.entry`. The key is the **function name**; the build fails if the two disagree in
either direction.

- Pass exactly one of `seconds=` or `cron=`. Separate because first-run behaviour differs: a `seconds`
  job fires the moment Splunk registers the input — after a restart that is *before* KV store is
  ready — while a `cron` job waits for its first matching time
- **Never `print()`** — stdout is the event channel. Use the injected `log`, which writes to a file
- Return nothing, an iterable of dicts, or of `(epoch_seconds, dict)`. Set the timestamp whenever the
  source has its own event time, and convert milliseconds to seconds — Splunk will cheerfully date an
  event to the year 58,500
- A job runs as `splunk-system-user` with admin and has **no user context**, unlike a REST route
- `upsert` takes an explicit key, so a repeated collection overwrites rather than duplicating
- `collections.conf` field types come from the model's annotations. Only `number`, `bool`, `string` and
  `time` exist; a list-of-object field stores fine but is invisible to SPL — the build warns

## shadcn/ui components

This project is on **React 18**, but the shadcn CLI emits components written for React 19, where `ref`
is an ordinary prop. Under React 18 a plain function component silently drops refs, so **wrap anything
you add in `React.forwardRef`.** Radix attaches a ref to whatever it wraps with `asChild` — to anchor a
popper, or return focus on close — and without it the click handler still fires while the menu never
appears. A console warning about refs is the only clue.

Portalled content needs **two** things this template does not give it for free, and both apply
equally to a Vue `<Teleport to="body">`:

- **A z-index above Splunk's chrome**, whose layers run from `99` to `9999999999`. shadcn's
  default `z-50` assumes the app owns the page.
- **An explicit `text-*` to pair with its `bg-*`.** shadcn assumes
  `body { @apply bg-background text-foreground }`; this template has no such rule, because a page
  lives inside Splunk's DOM and inherits Splunk's own theme-correct colour. A portal escapes that
  — it mounts on `document.body` — so anything without its own colour inherits the bare body
  value. In dark mode that is a dark panel with dark text: the title, labels and ghost buttons
  vanish while the body copy and filled buttons, which do set a colour, look fine. Ship
  `bg-popover text-popover-foreground` (or `bg-background text-foreground`) as a pair, never the
  background alone.

## Version settings and packaging

In `package.json` under `splunkApp`:

- **`minSplunkVersion`** selects the view path. At 10.4+ the build targets Splunk's first-party page
  template and ships no HTML of its own; below that it emits a Mako template, which App Inspect fails
  from 4.4.0 onward
- **`targetPythonVersion`** is the ABI `dist/lib/` is built for, and is **coupled** to
  `minSplunkVersion`: 10.0 ships only Python 3.9, 10.2+ ship 3.9 and 3.13. The build fails on an
  unsatisfiable pair. `python.required` is derived from it and must never be set by hand
- **`targetPlatform`** (default `manylinux2014_x86_64`) — compiled extensions are re-fetched for it, so
  the bundle never inherits the build machine's platform

Add Python dependencies to `requirements.txt`, and **build under Splunk's own interpreter**
(`docker compose up`): pip resolves against whatever interpreter runs the build, so a host build can
silently bundle packages that cannot import under 3.9.

`dist/` is **not submittable** — it is what Splunk mounts and runs, so it accumulates
`metadata/local.meta`, `local/` and `__pycache__`, each a hard App Inspect failure. Use `pnpm package`,
which stages `dist/`, strips those, and tars it with the app id as the single top-level directory.
