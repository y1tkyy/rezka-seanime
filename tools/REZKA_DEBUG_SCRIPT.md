# Rezka Debug Script

`tools/rezka-debug.js` is a standalone Node.js helper for debugging Rezka pages when the Seanime extension stops working or Rezka changes its HTML/player logic.

## Requirements

- Node.js 18+
- No extra packages required

## Usage

```bash
node tools/rezka-debug.js "https://rezka.ag/animation/example-page.html"
```

Or with `package.json`:

```json
{
  "scripts": {
    "debug:rezka": "node tools/rezka-debug.js"
  }
}
```

```bash
npm run debug:rezka -- "https://rezka.ag/animation/example-page.html"
```

## Output

The script saves a full JSON report into:

```text
rezka-debug-reports/
```

It also prints a short summary in the terminal.

## What It Checks

The report includes:

- Detected page type: series or movie
- Detected `animeId`
- Detected `translatorId`
- Seasons
- Episodes
- Translators/dubs
- Active translator
- Raw `<video>` tags
- `initCDNSeriesEvents(...)`
- `initCDNMoviesEvents(...)`
- Inline stream qualities
- AJAX `/ajax/get_cdn_series/` probe results
- Parsed HLS sources
- Warnings about suspicious/missing data

## When To Use

Use this script when:

- Episodes no longer appear
- A page returns `No video sources found`
- A movie stops loading
- Dubs/translators are missing
- Only one quality appears
- Rezka changes its HTML structure
- Rezka changes its player JavaScript
- You are updating the extension parser

## Useful Fields

### `detected`

Shows what the script thinks the page is:

```json
{
  "type": "series",
  "animeId": "2534",
  "translatorId": "19"
}
```

### `episodes`

Shows parsed episode data:

```json
{
  "id": "2534",
  "season": "2",
  "episode": "1"
}
```

### `translators`

Shows parsed dub list:

```json
{
  "index": 0,
  "id": "56",
  "text": "Дубляж",
  "active": true
}
```

### `seriesInits` / `movieInits`

Shows parsed Rezka player initializer data.

Series example:

```js
initCDNSeriesEvents(2534, 19, 2, 1, ...)
```

Movie example:

```js
initCDNMoviesEvents(82137, 56, ...)
```

If these exist but `streamsLength` is `0`, the parser likely needs updating.

### `ajaxProbes`

For series pages, the script tests Rezka's stream endpoint:

```text
/ajax/get_cdn_series/
```

Example body:

```text
id=2534&translator_id=19&season=2&episode=1&action=get_stream
```

If this returns `success: true` and qualities are present, the extension should be able to load the episode.

## Common Warnings

### `Could not detect animeId`

The page ID parser may be broken or Rezka changed the URL format.

### `No visible translator list and no inline translator id detected`

The extension may not know which dub/translator to request.

### `initCDNSeriesEvents detected but streams were not extracted`

Rezka changed the player config format or the function parser needs updating.

### `Movie page has no raw initCDNMoviesEvents streams and no raw video src`

The movie probably requires ChromeDP/browser fallback.

## Recommended Debug Flow

1. Run the script on the problematic Rezka URL.
2. Check warnings.
3. Check `detected.animeId` and `detected.translatorId`.
4. For series, check episodes.
5. Check `seriesInits` or `movieInits`.
6. Check parsed qualities.
7. For series, check `ajaxProbes`.
8. Compare the report with the extension logic.

## Notes

This script does not use browser cookies and does not execute Rezka player JavaScript. It is best for raw HTML and AJAX debugging.

For movie pages where streams appear only after JavaScript runs, the extension's ChromeDP fallback may still work even if this script reports limited raw HTML data.
