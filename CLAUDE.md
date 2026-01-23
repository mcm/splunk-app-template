# CLAUDE.md

Guidelines for AI assistants working with this Splunk React ASGI template.

## Project Overview

This is a template for Splunk apps using React 18 frontend and Python ASGI backend. The build system uses Rsbuild with a custom Splunk plugin that packages everything into a deployable Splunk app structure.

## Essential Commands

```bash
docker compose up   # Start development environment (runs build watcher + Splunk)
pnpm build          # Production build to dist/
```

## Architecture

### Frontend (React)

- Entry points: `src/pages/*.tsx` - each becomes a Splunk view
- Splunk wrappers: `src/components/splunk/` - SplunkPage, SplunkCurrentUserProvider, SplunkThemeProvider
- Styling: Tailwind CSS v4 via `src/globals.css`

### Backend (Python ASGI)

- Example ASGI app: `resources/splunk/bin/splunk_react18_asgi_example.py` (reference implementation)
- Protocol bridge: `resources/splunk/bin/persistconn.py` (do not modify)
- Users create their own ASGI apps using the example as a guide
- Routes use `@router("/path")` decorator
- Backend can be split into multiple ASGI apps, each with its own `[script:...]` stanza in `web.conf`

### Build Output

`dist/` contains the packaged Splunk app:
- `appserver/static/` - JS/CSS bundles
- `appserver/templates/` - HTML templates
- `default/` - Splunk config files
- `bin/` - Python scripts
- `lib/` - Python packages

## Key Patterns

### Adding a Frontend Page

1. Create `src/pages/mypage.tsx`:
```tsx
import { SplunkPage, getCurrentSplunkUser } from "@/components/splunk";

export default function MyPage() {
  const user = getCurrentSplunkUser();
  return <SplunkPage><div>Hello {user?.realname}</div></SplunkPage>;
}
```

2. Register in `rsbuild.config.ts` under `source.entry`

### Adding a Backend Endpoint

1. Create your own ASGI app in `resources/splunk/bin/` (use `splunk_react18_asgi_example.py` as reference):
```python
# bin/sprockets_rh.py
@router("/services/sprockets/myendpoint")
def my_endpoint(request):
    return JSONResponse({"data": "value"})
```

2. Register in `web.conf` with unique `[script:name]` stanza and `match` path, expose in `restmap.conf`

**Multiple ASGI apps:** Split backend into separate modules (e.g., `bin/sprockets_gizmos.py`, `bin/sprockets_gadgets.py`), each with its own `[script:...]` stanza and unique `match` value like `/sprockets/gizmos` and `/sprockets/gadgets`

### Calling Backend from Frontend

```tsx
import { createRESTURL } from "@splunk/splunk-utils/url";

const url = createRESTURL("splunk_react18_asgi_example/myendpoint");
const response = await fetch(url, { credentials: "include" });
```

## File Purposes

| Path | Purpose |
|------|---------|
| `src/pages/` | React page entry points |
| `src/components/splunk/` | Splunk integration components |
| `resources/splunk/bin/` | Python backend scripts |
| `resources/splunk/default/*.conf` | Splunk configuration |
| `rsbuild.config.ts` | Build configuration |
| `pluginSplunk.ts` | Build plugin for Splunk packaging |
| `requirements.txt` | Python dependencies (bundled into dist/lib/) |

## Common Tasks

### Customize app identity
Edit `package.json` splunkApp section and `resources/splunk/default/app.conf`

### Add Python dependency
Add to `requirements.txt` - packages install to `dist/lib/` during build

### Add npm dependency
Run `pnpm add <package>`

### Modify theme handling
Edit `src/components/splunk/splunk-theme.tsx`

### Change REST endpoint patterns
Edit `resources/splunk/default/restmap.conf`

## Don't Modify

- `resources/splunk/bin/persistconn.py` - Protocol bridge between Splunk and ASGI
- `pluginSplunk.ts` - Unless changing build behavior

## Testing

Use Docker environment:
```bash
docker compose up
```
- Splunk Web: http://localhost:8000 (admin / Temp1234!)
- Build changes auto-deploy to Splunk via shared volume
