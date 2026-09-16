# Splunk App Template

A template for building modern Splunk apps: a React or Vue frontend, a Python ASGI backend, and
Splunk's configuration generated from both instead of hand-written.

## Stack

- **Frontend**: React 18 or Vue 3, TypeScript, Tailwind CSS v4, Rsbuild
- **Backend**: Python ASGI with FastAPI (Python 3.9)
- **Integration**: Splunk React Page, splunk-sdk

## Quick Start

### Prerequisites

- Node.js 18+ with pnpm
- Python 3.9+
- Docker (for development environment)

### Development

```bash
# Install dependencies
pnpm install

# Start development environment
docker compose up
```

Access Splunk Web at http://localhost:8000 (Splunk 10.0), http://localhost:8002 (10.2) or
http://localhost:8004 (10.4) — admin / Temp1234!. All three mount the same `dist/`, so a
single build can be checked against every supported release.

The Docker environment runs Rsbuild in watch mode and mounts the build output to Splunk, so changes are reflected automatically.

**Changing `web.conf` is the exception.** splunkd picks up a new expose pattern immediately, but
Splunk Web keeps serving the previous one — neither an app `_reload` nor `splunk restart splunkweb`
rebuilds it. Only a full `splunk restart` does. Until then a correct configuration returns 404s,
with `btool` showing the new value the whole time.

**Note:** It's recommended to create a Python virtualenv and install `requirements.txt` for IDE type checking and autocomplete. This virtualenv is only for development convenience - it is NOT used when packaging the app.

### Production Build

```bash
pnpm build
```

The `dist/` folder contains the ready-to-deploy Splunk app.

`dist/` is cleaned at the start of every build so nothing stale is ever shipped, except the
paths listed in `output.cleanDistPath.keep` in `rsbuild.config.ts` — by default `dist/local/`
and `dist/metadata/local.meta`, so local configuration overrides survive.

## Project Structure

```
├── frontend/               # YOUR frontend
│   ├── pages/              # Page entry points (.tsx or .vue)
│   ├── components/         # Your components
│   ├── lib/                # Your helpers
│   └── globals.css         # Tailwind CSS
├── backend/                # YOUR backend - every .py here lands in the app's bin/
├── splunkapp/              # Template runtime, imported as @splunkapp/*
│   ├── react/              # React mount, providers, hooks
│   ├── vue/                # Vue mount, plugin, composables
│   └── lib/                # Framework-agnostic: API client, user, theme
├── resources/              # Template Splunk resources
│   ├── bin/                # persistconn.py, splunkapp.py
│   ├── default/            # app.conf
│   └── metadata/           # default.meta
├── dist/                   # Build output (Splunk app)
├── rsbuild.config.ts       # Build configuration
└── docker-compose.yml      # Development environment
```

**The split that matters:** `frontend/` and `backend/` are yours. Everything else ships with the
template and stays untouched in a normal app. `@/*` resolves to `frontend/`, `@splunkapp/*` to
`splunkapp/`.

## Customizing Your App

### 1. Update App Metadata

Edit `package.json`:

```json
{
  "splunkApp": {
    "appId": "your_app_id",
    "appTitle": "Your App Title"
  }
}
```

Update `resources/default/app.conf`:

```ini
[ui]
label = Your App Title

[launcher]
author = Your Name
version = 1.0.0
description = Your app description
```

### 2. Create Frontend Pages

Add pages in `frontend/pages/`. A page is a plain component with a default export — there
is no Splunk-specific boilerplate to write:

```tsx
import { useSplunkUser } from "@splunkapp/react";

export default function MyPage() {
  const user = useSplunkUser();

  return (
    <div className="p-4">
      <h1>Hello, {user?.realname}</h1>
    </div>
  );
}
```

A Vue page is the same shape, importing from `@splunkapp/vue`, where the composables return refs:

```vue
<script setup lang="ts">
import { useSplunkUser } from "@splunkapp/vue";
const user = useSplunkUser();
</script>

<template>
  <div class="p-4"><h1>Hello, {{ user?.realname }}</h1></div>
</template>
```

The build picks the mount by file extension, so one app can hold pages of both kinds. A Vue page
still bundles React: Splunk's own chrome is React and has no Vue equivalent, so the page runs
inside a one-component React host and owns everything below it.

The build generates one entry module per page that imports `globals.css`, wraps the page in
`<SplunkPage>` and mounts it into Splunk's layout. You do not import the stylesheet or call
a mount function yourself.

To configure the surrounding Splunk layout for a single page, export `splunkPageOptions`:

```tsx
export const splunkPageOptions = { hideAppBar: true };
```

Register new pages in `rsbuild.config.ts`:

```ts
source: {
  entry: {
    home: "./frontend/pages/home.tsx",
    mypage: "./frontend/pages/mypage.vue",  // Add entry - .tsx or .vue
  },
},
```

That single edit is enough. The build derives the Splunk view XML and the sidebar
navigation entry from `source.entry`, so there is no `.conf` or XML file to touch.

### 3. Set Navigation Labels and Icons

Splunk 10.4 shows app views in a vertical sidebar. Configure each entry in `package.json`
under `splunkApp.views`, keyed by the `source.entry` name:

```json
"splunkApp": {
  "defaultIcon": "circlesfour",
  "views": {
    "home": { "label": "Home", "icon": "house", "default": true }
  }
}
```

Only these icon names resolve — anything else silently renders as a letter monogram, so the
build emits a warning if you use one that is not in the list:

`bell`, `bookmark`, `bookshelf`, `chartcolumnpanel`, `chartgantt`, `chartgauge`,
`chartline`, `chartpanels`, `circlesfour`, `cog`, `cylinder`, `cylinderindex`, `filechart`,
`filemagnifier`, `filenode`, `forwarderuniversal`, `house`, `layerstriple`, `layout`,
`layoutoverview`, `magnifier`, `monitor`, `networkconnector`, `nodetopology`,
`organizernotebook`, `pulse`, `shieldkeyhole`, `star`, `tag`

Names are case- and separator-insensitive (`Chart Line`, `chart-line` and `chartLine` all
work). To control navigation yourself, create
`resources/default/data/ui/nav/default.xml` — a hand-written file wins over the
generated one.

### 4. Create Backend Endpoints

The backend is ordinary FastAPI, in `backend/`. See `backend/api.py` for a working example.

`backend/sprockets.py`:

```python
from fastapi import Depends, FastAPI

# The one place this handler's REST prefix is written down.
app = FastAPI(root_path="/services/sprockets")

@app.get("/myendpoint")
def my_endpoint(user: SplunkUser = Depends(current_splunk_user)):
    return {"message": f"Hello from backend, {user.username}"}
```

Register it in `package.json`, the same way a page is registered in `source.entry`:

```json
"splunkApp": {
  "handlers": { "sprockets": "./backend/sprockets.py" }
}
```

That is the whole setup. **There is no `restmap.conf` or `web.conf` to write.** Splunk needs both
— `restmap.conf` registers the script with splunkd (`[script:...]` with a `match` prefix),
`web.conf` exposes those routes through Splunk Web (`[expose:...]` with a `pattern`) — and a
handler present in one but not the other is unreachable with nothing in any log to explain it. So
the build imports your module, reads `root_path` off the ASGI app, and generates both:

```ini
# dist/default/restmap.conf                  # dist/default/web.conf
[script:sprockets]                           [expose:sprockets]
match        = /sprockets                    pattern = sprockets/**
script       = sprockets.py                  methods = GET,HEAD
script.param = sprockets.app
driver       = persistconn.py
scripttype   = persist
...
```

`methods` is the union of the verbs your routes declare, so adding a POST route needs no conf
edit. `root_path` must start with `/services/` or the build fails — without it the routes would
register one level away from where splunkd sends requests, and every one would 404.

Note the `**` in the `pattern`. A single `*` matches exactly one path segment, so
`sprockets/*` leaves `sprockets/gizmos/42/rename` unreachable — Splunk Web answers its own 404
and the request never reaches Python. This is easy to miss because the management port on 8089
bypasses `web.conf` entirely: the same URL curls fine there while every browser request fails.

If the module names its ASGI app something other than `app`, say so:

```json
"handlers": { "sprockets": { "script": "./backend/sprockets.py", "app": "application" } }
```

**Multiple ASGI apps:** split the backend across modules, one entry each, each with its own
`root_path`:

```json
"handlers": {
  "sprockets_gizmos": "./backend/sprockets_gizmos.py",
  "sprockets_gadgets": "./backend/sprockets_gadgets.py"
}
```

Two handlers declaring the same `root_path` fails the build — splunkd would accept it and then
route every request to whichever stanza it read last.

Everything under `backend/` is copied into the app's `bin/`, which is the only directory Splunk
puts on `sys.path`. So modules there import each other by name (`from sprockets_data import ...`),
and a module whose name collides with a bundled package in `lib/` will lose.

### 5. Call Backend from Frontend

Use the typed client from `@splunkapp/react` (or `@splunkapp/vue` — same functions, they both
re-export `@splunkapp/lib`). Paths are relative to this app's REST namespace, so `"myendpoint"`
means `/services/my_splunk_app/myendpoint`:

```tsx
import { apiGet, apiPost, apiDelete, SplunkApiError } from "@splunkapp/react";

const gizmos = await apiGet<Gizmo[]>("gizmos");
const created = await apiPost<Gizmo>("gizmos", { name: "sprocket" });
await apiDelete("gizmos/42");
```

`apiPut` and `apiPatch` complete the set, and each verb takes an options object for `query`,
`headers` and an `AbortSignal`. Non-2xx rejects with a `SplunkApiError`:

```tsx
try {
  await apiPost("gizmos", { name: "" });
} catch (e) {
  if (e instanceof SplunkApiError) {
    console.log(e.status, e.message, e.body); // e.body is FastAPI's {"detail": ...}
  }
}
```

> **Do not hand-roll this with `fetch`.** splunkd rejects any POST/PUT/PATCH/DELETE that does
> not carry *both* `X-Splunk-Form-Key` (read from the `splunkweb_csrf_token_<webport>` cookie)
> and `X-Requested-With: XMLHttpRequest` — 401 "CSRF validation failed", raised before your
> Python handler ever runs. GET needs neither, which is exactly why the omission goes unnoticed
> until the first write.

If the backend is split across several handlers with their own `match` prefixes, build a client
per prefix:

```tsx
import { createSplunkApiClient } from "@splunkapp/react";

const gizmos = createSplunkApiClient("sprockets/gizmos");
await gizmos.get<Gizmo>("42"); // GET /services/sprockets/gizmos/42
```

## Key Components

### SplunkPage

Supplies the theme and current-user context every page needs. The generated entry module
wraps your page in it, so you rarely render it directly.

Per-page layout options, via `export const splunkPageOptions` in the page module:
- `hideAppBar` - Hide Splunk app bar
- `hideChrome` - Hide Splunk chrome
- `hideFooter` - Hide Splunk footer

### useSplunkUser()

Hook to access current user information. Returns `undefined` until the lookup resolves:

```tsx
const user = useSplunkUser();
// user?.username, user?.realname, user?.email, user?.roles, etc.
```

### TailwindThemeSync

Mirrors the user's Splunk theme preference onto Tailwind's `dark` class, and exposes it via
`useSplunkTheme()`.

> **Note the name.** `@splunk/themes` exports a `SplunkThemeProvider` that does something
> different — it supplies the design-token context `@splunk/react-ui` components require.
> If you use `@splunk/react-ui`, you need both, composed:
>
> ```tsx
> <SplunkThemeProvider>   {/* from @splunk/themes */}
>   <TailwindThemeSync>   {/* from @splunkapp/react */}
>     {children}
>   </TailwindThemeSync>
> </SplunkThemeProvider>
> ```

## Scheduled Jobs and KV Store

A background job is a decorated function, and a KV store collection is a Pydantic model.
See `backend/jobs.py` for a working example.

```python
from splunkapp import collection, scheduled

class Gizmo(BaseModel):
    name: str
    count: int

GIZMOS = collection(Gizmo, name="gizmos")

@scheduled(seconds=300, index="main", sourcetype="sprockets:gizmo")
def collect(splunk, state, log):
    """Collect gizmos."""
    GIZMOS.bind(splunk, log).upsert("gizmo-1", Gizmo(name="a", count=1))
    return [{"gizmo": "a"}]          # returned records are indexed
```

Register it in `package.json` under `splunkApp.jobs`, exactly the way a page is registered in
`source.entry`:

```json
"jobs": { "collect": "./backend/jobs.py" }
```

The build imports the module, reads the decorators, and generates the modular input runner,
`inputs.conf`, `README/inputs.conf.spec` and `collections.conf`. **Do not write those by hand** —
a hand-written file wins over the generated one, which silently disables your declarations. If
the job name in `package.json` and the decorated function name disagree in either direction, the
build fails rather than shipping a job that never runs.

Things worth knowing:

- **`seconds=` and `cron=` are separate parameters** because their first-run behaviour differs.
  A `seconds` job fires as soon as Splunk registers the input — which, after a restart, is
  before KV store has finished starting. A `cron` job waits for its first matching time.
- **The job gets `(splunk, state, log)`**: a client authenticated as `splunk-system-user` with
  admin, a checkpoint dict that survives restarts, and a file logger. A modular input has **no
  user context**, unlike a REST route.
- **Never `print()` in a job.** stdout is the event channel; anything written there is indexed
  as an event, and stderr is logged at ERROR regardless of content. That is why `log` exists.
- **Return `(epoch_seconds, record)` tuples** when the source has its own notion of event time.
  Convert milliseconds to seconds — Splunk will cheerfully date an event to the year 58,500.
- **`upsert` takes an explicit key**, so a repeated collection overwrites rather than
  accumulating duplicates.

## Backend Architecture

The backend uses a persistence connection model:

1. `resources/bin/persistconn.py` - Protocol bridge (do not modify)
2. Your ASGI application(s) in `backend/` (see `backend/api.py` for reference)

You can have one ASGI app or multiple - each listed in `splunkApp.handlers` with its own
`root_path`, from which the build generates the `[script:...]` and `[expose:...]` stanzas.

Request flow:
```
React → Splunk Web → web.conf (expose) → restmap.conf (match) → persistconn.py → FastAPI app → Response
```

`root_path` *is* the `match` prefix — the build derives one from the other — so route decorators
stay short: `@app.get("/d6")` serves `/services/my_splunk_app/d6`.

**Python version:** these handlers run under Python 3.9. Splunk 10.4 ships both 3.9 and 3.13,
but uses 3.9 for persistent REST handlers, which is why `requirements.txt` pins
`starlette<0.50.0`.

### Accessing Splunk Context

splunkd authenticates every request before it reaches Python, so a route never checks
credentials. Ask for the user as a dependency:

```python
@app.get("/gizmos")
def list_gizmos(user: SplunkUser = Depends(current_splunk_user)):
    return {"owner": user.username}
```

Identity comes from the persistent-connection packet, not from headers. `session.user` is
always present; the namespace (`user.app` / `user.owner`) is only populated for
`/servicesNS/<user>/<app>/...` requests and is `None` otherwise.

`SplunkUser.token` is a live credential and is marked `exclude=True`, so returning a
`SplunkUser` from a route never leaks it to the browser.

### Using Splunk SDK

The Splunk SDK works alongside FastAPI. `splunk_service` yields a client bound to the
calling user, so Splunk's own access controls still apply:

```python
@app.get("/apps")
def list_apps(service: Service = Depends(splunk_service)):
    return {"apps": sorted(entry.name for entry in service.apps)}
```

## Adding Dependencies

### Frontend (npm packages)

```bash
pnpm add <package-name>
```

### Backend (Python packages)

Add to `requirements.txt`:

```
asgiref
fastapi
splunk-sdk
starlette<0.50.0
your-package
```

Packages are bundled into `dist/lib/` during build, installed with Splunk's own Python 3.9.

**Compiled extensions are pinned to Splunk's platform, not the build machine's.** `pydantic`
(a FastAPI dependency) ships `_pydantic_core.cpython-39-x86_64-linux-gnu.so`. Left alone, a
build on macOS would emit a macOS binary that fails to import on a Linux Splunk, with no
build-time error. So the build installs in two passes:

1. Resolve and install normally, which settles dependency versions.
2. Re-fetch any distribution that shipped a compiled extension, pinned with
   `--platform`/`--python-version`, replacing the host-specific build.

Only packages with binaries are re-fetched; pure-Python ones are platform-agnostic. The
second pass cannot be applied to the whole requirements file, because pip only accepts
`--platform` together with `--only-binary=:all:`, and `splunk-sdk` publishes no wheel at all.

Override the target in `package.json` if you deploy somewhere other than Linux x86-64:

```json
"splunkApp": {
  "targetPlatform": "manylinux2014_x86_64",
  "targetPythonVersion": "3.9"
}
```

Set `"targetPlatform": null` to install for the build host instead.

## Deployment

1. Run `pnpm build`
2. Copy the `dist/` folder to your Splunk apps directory:
   - Linux: `/opt/splunk/etc/apps/`
   - macOS: `/Applications/Splunk/etc/apps/`
   - Windows: `C:\Program Files\Splunk\etc\apps\`
3. Restart Splunk or reload the app

## Development Commands

| Command | Description |
|---------|-------------|
| `docker compose up` | Start development environment |
| `pnpm build` | Create production build |
| `pnpm rsbuild_shell` | Access build container shell |
| `pnpm splunk_shell` | Access Splunk container shell |

## Configuration Files

| File | Purpose |
|------|---------|
| `rsbuild.config.ts` | Build configuration and entry points |
| `pluginSplunk.ts` | Splunk-specific build plugin |
| `resources/default/app.conf` | App metadata and UI settings |
| `package.json` → `splunkApp` | App id, views, handlers, jobs, version targets |
| `requirements.txt` | Python dependencies |
| `docker-compose.yml` | Development environment |

## License

MIT
