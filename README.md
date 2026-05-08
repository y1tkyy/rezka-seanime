# Seanime Rezka Extension Notes

This document explains how the Rezka provider extension works, what Rezka-specific quirks are handled, and what to remember when updating the code in the future.

## Goal

The provider lets Seanime search anime on Rezka, list episodes, and return HLS video sources for each episode or movie.

Main supported cases:

- Anime series with episode lists
- Anime series with no visible translator list
- Anime movies with no episode list
- Multiple dubbing/translators
- Multiple qualities per dubbing
- Rezka inline stream configs
- Rezka AJAX stream responses
- Movie pages that need browser/ChromeDP fallback

## Important Seanime Concepts

### `search(opts)`

Returns search results.

Each result should include:

```ts
{
  id: url,
  title: fullTitle,
  url: url,
  subOrDub: "both"
}
```

The `id` is later passed into `findEpisodes()`.

### `findEpisodes(id)`

Returns a list of Seanime episodes.

Seanime expects each episode to have a unique number.

For Rezka, the real data needed for playback is not just the visible episode number. You also need:

- `animeId`
- `translatorId`
- `season`
- `episode`
- `baseUrl`
- `isMovie`

Because Seanime only passes the episode object forward, the provider stores all Rezka-specific data inside `episode.id` as JSON.

Example:

```json
{
  "url": "https://rezka.ag/animation/example.html#t:19-s:2-e:1",
  "baseUrl": "https://rezka.ag/animation/example.html",
  "animeId": "2534",
  "translatorId": "19",
  "translatorName": "Default",
  "translators": [],
  "season": 2,
  "episode": 1
}
```

### `findEpisodeServer(episodeOrId, server)`

Returns the playable video sources.

Each source should look like:

```ts
{
  url: "https://...",
  type: "m3u8",
  quality: "Дубляж 1080p",
  label: "Дубляж",
  subtitles: []
}
```

The `quality` field must be unique. If two sources are both just `1080p`, Seanime may not switch correctly.

That is why the extension uses:

```text
Дубляж 1080p
Дубляж 720p
Оригинал (+субтитры) 1080p
Оригинал (+субтитры) 720p
```

instead of:

```text
1080p
720p
1080p
720p
```

## Rezka Page Types

### 1. Normal Series Page

Normal series pages usually contain episode elements like:

```html
<li
  class="b-simple_episode__item"
  data-id="2534"
  data-season_id="2"
  data-episode_id="1"
>
  Серия 1
</li>
```

Important fields:

- `data-id` = Rezka anime/content ID
- `data-season_id` = Rezka season number
- `data-episode_id` = Rezka episode number

Do not rely only on the URL ID. Some pages contain unrelated `data-id` values elsewhere in the HTML. For episode playback, the `data-id` from `.b-simple_episode__item` is often the best source.

### 2. Series Page With Visible Translators

Translator list example:

```html
<ul id="translators-list" class="b-translators__list">
  <li title="DEEP" class="b-translator__item active" data-translator_id="509">DEEP</li>
  <li title="AniLibria" class="b-translator__item" data-translator_id="19">AniLibria</li>
  <li title="AniStar" class="b-translator__item" data-translator_id="224">AniStar</li>
</ul>
```

The provider extracts:

```json
{
  "id": "509",
  "name": "DEEP",
  "index": 0
}
```

The index is important because it preserves Rezka's visible dub order.

Expected order:

```text
DEEP 1080p
DEEP 720p
DEEP 480p
AniLibria 1080p
AniLibria 720p
AniLibria 480p
```

### 3. Series Page Without Visible Translators

Some pages do not have `.b-translator__item`.

Example problematic page:

```text
https://rezka.ag/animation/adventures/2534-istorii-sezon-vtoroy-tv-2-2013.html
```

It has no translator list, but the translator is available in JavaScript:

```js
sof.tv.initCDNSeriesEvents(2534, 19, 2, 1, ...)
```

Meaning:

```text
animeId = 2534
translatorId = 19
season = 2
episode = 1
```

The provider extracts this as fallback and creates:

```json
{
  "id": "19",
  "name": "Default",
  "index": 0
}
```

This is why the UI may show:

```text
Default 1080p
Default 720p
Default 480p
Default 360p
```

### 4. Movie Pages

Anime movies usually have no episode list.

Example:

```text
https://rezka.ag/animation/fantasy/82137-chelovek-benzopila-film-istoriya-reze-2025-latest.html
```

Movie translator list example:

```html
<a
  class="b-translator__item active"
  data-id="82137"
  data-translator_id="56"
  href="https://rezka-ua.co/animation/fantasy/.../56-dublyazh.html"
>
  Дубляж
</a>
```

Movie pages should return one Seanime episode:

```json
{
  "number": 1,
  "title": "Movie"
}
```

The JSON payload must include:

```json
{
  "isMovie": true,
  "season": 0,
  "episode": 0
}
```

Movie stream extraction is separate from series extraction.

Do not remove movie logic unless you retest movies.

## Stream Extraction Methods

The provider tries different extraction paths depending on page type.

### Series Stream Extraction Order

For series:

1. Try inline player config from page HTML
2. Try Rezka AJAX endpoint

### Inline Series Config

Rezka sometimes embeds streams directly:

```js
sof.tv.initCDNSeriesEvents(2534, 19, 2, 1, false, "rezka.ag", false, false, {
  "id": "cdnplayer",
  "streams": "[360p]https://...m3u8,[480p]https://...m3u8",
  "default_quality": "480p"
})
```

The provider parses this with:

```text
extractAllInitCDNSeriesData(html)
```

Important: do not parse this with a simple regex like:

```regex
/(\{[\s\S]*?\})/
```

The player config contains nested objects like:

```json
{
  "hlsconfig": {
    "maxBufferLength": 180
  }
}
```

Simple regex parsing will stop too early. That is why the provider uses:

- `readFunctionArgs()`
- `splitTopLevelArgs()`
- `extractJsonStringValue()`

### Series AJAX Endpoint

Endpoint:

```text
https://rezka.ag/ajax/get_cdn_series/?t=TIMESTAMP
```

Body:

```text
id=2534&translator_id=19&season=2&episode=1&action=get_stream
```

Response example:

```json
{
  "success": true,
  "message": "",
  "premium_content": 0,
  "url": "[360p]https://...m3u8 or https://mirror...,[480p]https://...m3u8"
}
```

The provider parses `json.url` with:

```text
extractRezkaStreamSources(json.url)
```

### Movie Stream Extraction Order

For movies:

1. Try inline movie config from raw HTML
2. Try ChromeDP/browser extraction
3. Try raw `<video src>` fallback

### Inline Movie Config

Movie pages can include:

```js
sof.tv.initCDNMoviesEvents(82137, 56, 0, 0, 0, "rezka.ag", false, true, {
  "streams": "[480p]https://...,[720p]https://...,[1080p]https://..."
})
```

The provider parses this with:

```text
extractAllInitCDNMoviesData(html)
```

For movie pages, function argument shape can vary, so the code uses:

```text
animeId = args[0]
translatorId = args[1]
playerConfig = args[args.length - 1]
```

### ChromeDP Fallback

Some movie pages do not expose streams in raw HTML until player JS runs.

The provider uses:

```text
getMoviePageSourcesWithBrowser(data)
```

This opens the movie page with ChromeDP and extracts:

- `<video src>`
- `<source src>`
- full dynamic HTML
- movie player config if available after JS runs

Keep this fallback because it fixed anime movies.

## Rezka Stream Format

Rezka stream strings look like:

```text
[360p]https://cdn/360.m3u8 or https://mirror/360.m3u8 or https://cdn/360.mp4,[480p]https://cdn/480.m3u8 or https://mirror/480.m3u8,[720p]https://cdn/720.m3u8,[1080p]https://cdn/1080.m3u8
```

The provider:

- Splits by quality blocks
- Extracts URLs inside each block
- Keeps HLS URLs only
- Prefers `ukrtelcdn` over `voidboost`
- Keeps one URL per quality

Handled by:

```text
extractRezkaStreamSources(streams)
```

## Quality and Dubbing Behavior

Sources are built like:

```text
quality: translatorName + " " + sourceQuality
```

Example:

```text
Дубляж 1080p
Дубляж 720p
Оригинал (+субтитры) 1080p
Оригинал (+субтитры) 720p
```

This is necessary because Seanime uses quality as the selectable value.

## Known Seanime UI Quirk

Even if the provider returns sources sorted correctly, Seanime may display the quality dropdown in a different order or preserve selected/default entries internally.

The provider sorts sources as:

1. Rezka translator order
2. Highest quality first

Implemented in:

```text
dedupeVideoSourcesPreserveQuality()
```

Expected provider order:

```text
Дубляж 1080p
Дубляж 720p
Дубляж 480p
Дубляж 360p
Оригинал (+субтитры) 1080p
Оригинал (+субтитры) 720p
Оригинал (+субтитры) 480p
Оригинал (+субтитры) 360p
```

If Seanime still displays a different order, it is probably UI-side behavior.

Do not re-add random `.reverse()` logic unless you retest all cases:

- Single-dub series
- Multi-dub series
- Movies
- Sub-only pages
- Pages with no translator list

Past reverse attempts fixed one case but broke others.

## Important Helper Functions

### `extractAnimeId(html, url)`

Finds Rezka content ID.

Priority:

1. URL ID
2. episode item `data-id`
3. `initCDNSeriesEvents(...)`
4. `initCDNMoviesEvents(...)`
5. fallback `data-id`

Why URL first?

Because pages can contain unrelated `data-id` values in comments, widgets, or other blocks.

### `extractTranslators(html, url)`

Extracts translator/dub list.

Normal source:

```text
.b-translator__item
```

Fallbacks:

- `initCDNSeriesEvents(... translatorId ...)`
- `initCDNMoviesEvents(... translatorId ...)`
- translator id from translator page URL

Each translator gets an index, which preserves Rezka order.

### `extractActiveTranslator(html, url, translators)`

Finds active translator.

Uses:

- `.b-translator__item.active`
- `initCDNSeriesEvents`
- `initCDNMoviesEvents`
- translator id from URL
- first translator
- empty default

### `makeEpisodeUrl(url, translatorId, season, episode)`

Creates hash URLs for internal tracking:

```text
https://rezka.ag/anime.html#t:19-s:2-e:1
```

This URL is not necessarily a real Rezka page route. It is mainly used to preserve state.

### `basePageUrl(url)`

Removes hash:

```text
https://rezka.ag/anime.html#t:19-s:2-e:1
```

becomes:

```text
https://rezka.ag/anime.html
```

### `parseEpisodeId(episode)`

Reads JSON from `episode.id`.

This is critical because the user-facing episode number is flattened for Seanime, while the real Rezka data is inside JSON.

### `normalizeUrl(url)`

Converts alternate Rezka domains to the chosen base:

```text
https://rezka-ua.co -> https://rezka.ag
http://rezka.ag -> https://rezka.ag
```

## Common Bugs and Fixes

### Bug: Only first episode appears

Cause:

- Regex only matched one kind of episode element.
- Rezka can use `<li>` without `href`.

Fix:

- Use `LoadDoc(html)`
- Select `.b-simple_episode__item`
- Read `data-season_id` and `data-episode_id`

### Bug: Quality/dub switching does nothing

Cause:

Multiple sources had the same quality:

```text
1080p
1080p
1080p
```

Fix:

Include translator name in quality:

```text
Дубляж 1080p
AniLibria 1080p
Оригинал (+субтитры) 1080p
```

### Bug: Movie returns no sources

Cause:

Movies do not use the same episode AJAX flow as series.

Fix:

- Mark fallback episode with `isMovie: true`
- Use movie-specific extraction
- Keep ChromeDP fallback

### Bug: Movie only returns one quality

Cause:

Reading `<video src>` only gives current selected player quality.

Fix:

Prefer streams from `initCDNMoviesEvents(...)`, which contains all qualities.

### Bug: Problematic series returns no sources

Example:

```text
2534-istorii-sezon-vtoroy-tv-2-2013.html
```

Cause:

No visible translator list. Translator ID exists only in:

```js
initCDNSeriesEvents(2534, 19, 2, 1, ...)
```

Fix:

Extract translator from `initCDNSeriesEvents`.

Correct AJAX body:

```text
id=2534&translator_id=19&season=2&episode=1&action=get_stream
```

### Bug: Wrong anime ID

Cause:

Using first random `data-id` from page.

Fix:

Prefer URL ID or episode item `data-id`.

## Debug Snippets

### Check Rezka page values in browser

Run in Chrome DevTools on a Rezka page:

```js
(() => {
  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
  console.log({
    url: location.href,
    episodes: [...document.querySelectorAll(".b-simple_episode__item")].map((el) => ({
      text: clean(el.textContent),
      id: el.getAttribute("data-id"),
      season: el.getAttribute("data-season_id"),
      episode: el.getAttribute("data-episode_id"),
      active: el.classList.contains("active"),
    })),
    translators: [...document.querySelectorAll(".b-translator__item")].map((el, index) => ({
      index,
      text: clean(el.textContent),
      title: el.getAttribute("title"),
      id: el.getAttribute("data-translator_id"),
      href: el.href || el.getAttribute("href"),
      active: el.classList.contains("active"),
    })),
    initSeries: document.documentElement.outerHTML.includes("initCDNSeriesEvents("),
    initMovies: document.documentElement.outerHTML.includes("initCDNMoviesEvents("),
  });
})();
```

### Test series AJAX manually

```js
fetch("/ajax/get_cdn_series/?t=" + Date.now(), {
  method: "POST",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "X-Requested-With": "XMLHttpRequest"
  },
  body: "id=2534&translator_id=19&season=2&episode=1&action=get_stream",
  credentials: "include"
})
  .then((r) => r.text())
  .then(console.log);
```

## Things To Be Careful With

- Do not remove movie ChromeDP unless all tested movies still work.
- Do not remove `isMovie`.
- Do not replace `quality: translatorName + " " + sourceQuality` with only `sourceQuality`.
- Do not rely on first page `data-id`.
- Do not use simple regex to parse the full player object.
- Do not guess translator page slugs like `/56-translator.html`.
- Use provided translator `href` if available. Otherwise use base page URL.
- Do not assume Rezka always has a visible translator list.
- Do not assume Rezka always has episode `href`.
- Do not assume `<video src>` contains all qualities.

## Suggested Test Set Before Release

Test these cases after every big update:

- Normal multi-episode anime with visible dubs
- Anime with no visible translator list
- Anime movie with multiple dubs
- Anime movie with multiple qualities
- Sub-only or original audio page
- Page with only one translator
- Page where episode elements are `<li>` without `href`

Known examples:

```text
https://rezka.ag/animation/adventures/2534-istorii-sezon-vtoroy-tv-2-2013.html
https://rezka.ag/animation/fantasy/82137-chelovek-benzopila-film-istoriya-reze-2025-latest.html
```

## Release Notes Template

Rezka provider for Seanime.

Supports:

- Search
- Series episodes
- Anime movies
- Multiple dubs
- Multiple qualities
- HLS sources

Known limitation:

On some pages, Seanime may display quality options in a different order than Rezka. Source selection should still work.
