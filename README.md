# Creately Web Image Generator

Automates capturing screenshots of Creately templates using Playwright.
It supports direct template IDs and search terms, updates the workspace title when provided, and logs every capture.

## Requirements
- Node.js (v18+ recommended)
- Playwright installed in this repo (`node_modules` already present)

## Usage
Install dependencies:
```bash
npm install
```

Run the script:
```bash
node screenshot.js
```

Or via npm scripts:
```bash
npm run capture
npm start
```

You will be prompted for:
- Screenshot width (default 1280)
- Screenshot height (default 720)

Then a browser opens to the Creately login page. Log in manually and press Enter in the terminal to continue.

Screenshots are saved to:
```
screenshots/<templateId>.png
```

Capture log:
```
screenshots/capture-log.txt
```

## Input File
`templates.txt` controls what gets captured.

### Format
- One entry per line.
- Optional title after a comma.
- Use `id:` prefix for direct template IDs.
- Lines without `id:` are treated as search terms (uses the first API result).

### Examples
```
# Use id:<tempId> for direct template IDs. Optional title after a comma.
id:vAnBkdf0iQR, Concept Map Maker
Table Chart Maker
id:10rHuSp8Q5l, Simple Table Chart
```

### Behavior
- `id:<tempId>`: opens `https://creately.com/demo-start/?tempId=<tempId>`
- Search term: calls the Creately community API and uses the first `id`
- If a line has only a title (no `id:` and no comma), the title is applied to the workspace before the screenshot
- If the API returns no results, the script skips the screenshot and logs `NO_TEMPLATE_FOUND`

## Workspace Title Update
If a title is provided (text after a comma) or the line is only a title, the script updates:
```
#workspace-title-label > div > div
```
before taking the screenshot.

## Notes
- The script hovers the zoom control, clicks its first button, then drags the canvas 260px to the right before taking each screenshot.
- The login is manual and done once per run.
