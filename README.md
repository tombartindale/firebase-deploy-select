# firebase-deploy-select

Interactive CLI for selectively deploying Firebase functions. Reads your `index.ts`/`index.js` to build a live function list, lets you pick groups or individual functions, then runs the correct `firebase deploy` command.

## Features

- Expand/collapse function groups with arrow keys
- Select whole groups or individual functions within a group
- Type to filter the list in real time
- Works with any Firebase project — auto-discovers `firebase.json`

## Install

```bash
npm install -g firebase-deploy-select
```

## Usage

Run from anywhere inside your Firebase project:

```bash
firebase-deploy-select
```

Or via npm script — add to your `functions/package.json`:

```json
"scripts": {
  "deploy:select": "firebase-deploy-select"
}
```

Then run:

```bash
npm run deploy:select
```

### Options

```
--index <path>    Path to index.ts/index.js (overrides auto-discovery)
```

## Controls

| Key | Action |
|-----|--------|
| `↑` / `↓` | Move cursor |
| `→` | Expand group |
| `←` | Collapse group |
| `space` | Select / deselect |
| `enter` | Confirm and deploy |
| `esc` | Clear filter |
| `ctrl+c` | Quit |
| Any letter | Filter list |
| `backspace` | Delete last filter character |

## How it works

The tool walks up the directory tree from where you run it to find `firebase.json`, then looks for the functions entry point at `functions/src/index.ts` (or `.js`). It parses the file to find:

- **Groups** — exports assigned from a `require()`'d module or an inline object (`exports.training = training`, `exports.dashboard = { ... }`)
- **Individual functions** — exports assigned from a specific property (`exports.createUser = auth.createUser`)

Selecting a group deploys all functions in it:

```
firebase deploy --only "functions:training"
```

Selecting individual functions within a group uses the `group-function` syntax:

```
firebase deploy --only "functions:training-importFacilitators,functions:training-distributeFacilitators"
```

## Requirements

- Node.js 16+
- `firebase-tools` installed and authenticated (`firebase login`)
