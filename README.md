# Splunk React ASGI Template

A template for building modern Splunk apps using React 18 frontend and Python ASGI backend.

## Stack

- **Frontend**: React 18, TypeScript, Tailwind CSS v4, Rsbuild
- **Backend**: Python ASGI with Starlette
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

Access Splunk Web at http://localhost:8000 (admin / Temp1234!)

The Docker environment runs Rsbuild in watch mode and mounts the build output to Splunk, so changes are reflected automatically.

**Note:** It's recommended to create a Python virtualenv and install `requirements.txt` for IDE type checking and autocomplete. This virtualenv is only for development convenience - it is NOT used when packaging the app.

### Production Build

```bash
pnpm build
```

The `dist/` folder contains the ready-to-deploy Splunk app.

## Project Structure

```
├── src/                    # React frontend
│   ├── pages/              # Page entry points
│   ├── components/         # React components
│   │   └── splunk/         # Splunk integration wrappers
│   └── globals.css         # Tailwind CSS
├── resources/splunk/       # Splunk app resources
│   ├── bin/                # Python backend scripts
│   └── default/            # Splunk configuration
├── dist/                   # Build output (Splunk app)
├── rsbuild.config.ts       # Build configuration
└── docker-compose.yml      # Development environment
```

## Customizing Your App

### 1. Update App Metadata

Edit `package.json`:

```json
{
  "splunkApp": {
    "appId": "your-app-id",
    "appTitle": "Your App Title",
    "appResourcesRoot": "./resources/splunk"
  }
}
```

Update `resources/splunk/default/app.conf`:

```ini
[ui]
label = Your App Title

[launcher]
author = Your Name
version = 1.0.0
description = Your app description
```

### 2. Create Frontend Pages

Add pages in `src/pages/`. Each page should use the `SplunkPage` wrapper:

```tsx
import { SplunkPage, getCurrentSplunkUser } from "@/components/splunk";

export default function MyPage() {
  const user = getCurrentSplunkUser();

  return (
    <SplunkPage>
      <div className="p-4">
        <h1>Hello, {user?.realname}</h1>
      </div>
    </SplunkPage>
  );
}
```

Register new pages in `rsbuild.config.ts`:

```ts
source: {
  entry: {
    home: "./src/pages/home.tsx",
    mypage: "./src/pages/mypage.tsx",  // Add entry
  },
},
```

### 3. Create Backend Endpoints

Create your own ASGI application in `resources/splunk/bin/`. See `splunk_react18_asgi_example.py` for a working example of routing and Splunk integration.

Example endpoint in `bin/sprockets_rh.py`:

```python
@router("/services/sprockets/myendpoint")
def my_endpoint(request):
    return JSONResponse({"message": "Hello from backend"})
```

Register your script in `resources/splunk/default/web.conf` and expose the endpoint in `resources/splunk/default/restmap.conf`:

```ini
[script:sprockets]
match = /sprockets
...

[expose:sprockets]
pattern = sprockets/*
methods = GET,POST
```

**Multiple ASGI apps:** You can split your backend into multiple ASGI applications. For example, an app called `sprockets` could have separate modules for different concerns:

- `bin/sprockets_gizmos.py` with routes under `/services/sprockets/gizmos/...`
- `bin/sprockets_gadgets.py` with routes under `/services/sprockets/gadgets/...`

Each needs its own `[script:...]` stanza in `web.conf` with a unique name and `match` value:

```ini
[script:sprockets_gizmos]
match = /sprockets/gizmos
script = sprockets_gizmos.py
...

[script:sprockets_gadgets]
match = /sprockets/gadgets
script = sprockets_gadgets.py
...
```

### 4. Call Backend from Frontend

Use `createRESTURL` from Splunk utilities:

```tsx
import { createRESTURL } from "@splunk/splunk-utils/url";

async function fetchData() {
  const url = createRESTURL("splunk_react18_asgi_example/myendpoint");
  const response = await fetch(url, { credentials: "include" });
  return response.json();
}
```

## Key Components

### SplunkPage

Wrapper that provides Splunk theme and user context:

```tsx
<SplunkPage options={{ hideAppBar: true }}>
  {children}
</SplunkPage>
```

Options:
- `hideAppBar` - Hide Splunk app bar
- `hideChrome` - Hide Splunk chrome
- `hideFooter` - Hide Splunk footer

### getCurrentSplunkUser()

Hook to access current user information:

```tsx
const user = getCurrentSplunkUser();
// user.username, user.realname, user.email, user.roles, etc.
```

### SplunkThemeProvider

Automatically syncs with user's Splunk theme preference (light/dark).

## Backend Architecture

The backend uses a persistence connection model:

1. `persistconn.py` - Protocol bridge (do not modify)
2. Your ASGI application(s) (see `splunk_react18_asgi_example.py` for reference)

You can have one ASGI app or multiple - each registered with its own `[script:...]` stanza in `web.conf` and a unique `match` path.

Request flow:
```
React → Splunk Web → web.conf (match) → persistconn.py → Starlette app → Response
```

### Accessing Splunk Context

The backend receives authentication headers automatically:

```python
def my_handler(request):
    auth_header = request.headers.get("authorization")
    user = request.headers.get("x-splunk-ns-user")
    app = request.headers.get("x-splunk-ns-app")
```

### Using Splunk SDK

```python
import splunklib.client as client

def my_handler(request):
    service = client.connect(
        token=request.headers.get("authorization").split()[1],
        host="localhost",
        port=8089,
    )
    # Use service to query Splunk
```

## Adding Dependencies

### Frontend (npm packages)

```bash
pnpm add <package-name>
```

### Backend (Python packages)

Add to `requirements.txt`:

```
starlette<0.50.0
asgiref
splunk-sdk
your-package
```

Packages are bundled into `dist/lib/` during build.

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
| `resources/splunk/default/app.conf` | App metadata and UI settings |
| `resources/splunk/default/web.conf` | Web routing configuration |
| `resources/splunk/default/restmap.conf` | REST API endpoint mappings |
| `requirements.txt` | Python dependencies |
| `docker-compose.yml` | Development environment |

## License

MIT
