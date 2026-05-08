#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const PAGE_URL = process.argv[2];

if (!PAGE_URL) {
  console.error('Usage: node tools/rezka-debug.js "https://rezka.ag/animation/..."');
  process.exit(1);
}

const BASE = "https://rezka.ag";

const HEADERS = {
  Accept: "text/html, */*; q=0.01",
  "Accept-Language": "en-US,en;q=0.9,uk;q=0.8,ru;q=0.7",
  "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
  Origin: BASE,
  Referer: BASE + "/",
  "X-Requested-With": "XMLHttpRequest",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
};

function decodeHtml(input) {
  return String(input || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function cleanText(input) {
  return decodeHtml(
    String(input || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function normalizeUrl(url) {
  return String(url || "")
    .replace("https://rezka-ua.co", "https://rezka.ag")
    .replace("http://rezka-ua.co", "https://rezka.ag")
    .replace("http://rezka.ag", "https://rezka.ag");
}

function absoluteUrl(url) {
  url = String(url || "");

  if (url.startsWith("http://") || url.startsWith("https://")) {
    return normalizeUrl(url);
  }

  if (url.startsWith("/")) {
    return BASE + url;
  }

  return BASE + "/" + url;
}

function getAttr(input, name) {
  const regex = new RegExp(name + '=["\']([^"\']+)["\']', "i");
  const match = String(input || "").match(regex);
  return match ? decodeHtml(match[1]) : "";
}

function toNumber(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
}

function readFunctionArgs(input, startIndex) {
  input = String(input || "");

  let i = startIndex;
  let depth = 1;
  let quote = "";
  let escaped = false;

  while (i < input.length) {
    const ch = input[i];

    if (escaped) {
      escaped = false;
    } else if (ch === "\\") {
      escaped = true;
    } else if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;

      if (depth === 0) {
        return input.slice(startIndex, i);
      }
    }

    i++;
  }

  return "";
}

function splitTopLevelArgs(input) {
  input = String(input || "");

  const args = [];
  let current = "";
  let depthCurly = 0;
  let depthSquare = 0;
  let quote = "";
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      current += ch;
      escaped = true;
      continue;
    }

    if (quote) {
      current += ch;

      if (ch === quote) {
        quote = "";
      }

      continue;
    }

    if (ch === '"' || ch === "'") {
      current += ch;
      quote = ch;
      continue;
    }

    if (ch === "{") depthCurly++;
    if (ch === "}") depthCurly--;
    if (ch === "[") depthSquare++;
    if (ch === "]") depthSquare--;

    if (ch === "," && depthCurly === 0 && depthSquare === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }

    current += ch;
  }

  if (current.trim()) {
    args.push(current.trim());
  }

  return args;
}

function decodeRezkaEscapedString(value) {
  return String(value || "")
    .replace(/\\\//g, "/")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function extractJsonStringValue(objectText, key) {
  objectText = String(objectText || "");
  key = String(key || "");

  const marker = '"' + key + '"';
  const keyIndex = objectText.indexOf(marker);

  if (keyIndex === -1) {
    return "";
  }

  const colonIndex = objectText.indexOf(":", keyIndex + marker.length);

  if (colonIndex === -1) {
    return "";
  }

  const quoteIndex = objectText.indexOf('"', colonIndex + 1);

  if (quoteIndex === -1) {
    return "";
  }

  let i = quoteIndex + 1;
  let raw = "";
  let escaped = false;

  while (i < objectText.length) {
    const ch = objectText[i];

    if (escaped) {
      raw += "\\" + ch;
      escaped = false;
    } else if (ch === "\\") {
      escaped = true;
    } else if (ch === '"') {
      break;
    } else {
      raw += ch;
    }

    i++;
  }

  try {
    return JSON.parse('"' + raw + '"');
  } catch (_) {
    return decodeRezkaEscapedString(raw);
  }
}

function extractAllInitCalls(html, marker) {
  const results = [];
  let start = 0;

  while (true) {
    const index = html.indexOf(marker, start);

    if (index === -1) break;

    const rawArgs = readFunctionArgs(html, index + marker.length);

    if (!rawArgs) {
      start = index + marker.length;
      continue;
    }

    const args = splitTopLevelArgs(rawArgs);
    results.push({
      index,
      rawArgsStart: rawArgs.slice(0, 1500),
      rawArgsLength: rawArgs.length,
      argsCount: args.length,
      args,
    });

    start = index + marker.length + rawArgs.length;
  }

  return results;
}

function extractAllInitCDNSeriesData(html) {
  return extractAllInitCalls(html, "initCDNSeriesEvents(").map((call) => {
    const args = call.args;
    const objectText = args[8] || "";
    const streams = extractJsonStringValue(objectText, "streams");
    const defaultQuality = extractJsonStringValue(objectText, "default_quality");

    return {
      animeId: String(args[0] || "").trim(),
      translatorId: String(args[1] || "").trim(),
      season: String(args[2] || "").trim(),
      episode: String(args[3] || "").trim(),
      defaultQuality,
      streams,
      streamsLength: streams.length,
      argsCount: args.length,
      rawArgsStart: call.rawArgsStart,
    };
  });
}

function extractAllInitCDNMoviesData(html) {
  return extractAllInitCalls(html, "initCDNMoviesEvents(").map((call) => {
    const args = call.args;
    const objectText = args[args.length - 1] || "";
    const streams = extractJsonStringValue(objectText, "streams");
    const defaultQuality = extractJsonStringValue(objectText, "default_quality");

    return {
      animeId: String(args[0] || "").trim(),
      translatorId: String(args[1] || "").trim(),
      defaultQuality,
      streams,
      streamsLength: streams.length,
      argsCount: args.length,
      rawArgsStart: call.rawArgsStart,
    };
  });
}

function normalizeQuality(quality) {
  quality = cleanText(String(quality || "auto")).trim();
  const match = quality.match(/(2160p|1440p|1080p|720p|480p|360p|240p|auto)/i);
  return match ? (match[1].toLowerCase() === "auto" ? "auto" : match[1]) : "";
}

function qualityRank(value) {
  const match = String(value || "").match(/(2160p|1440p|1080p|720p|480p|360p|240p)/i);
  return match ? parseInt(match[1], 10) : 0;
}

function extractRezkaStreamSources(streams) {
  streams = decodeRezkaEscapedString(streams);

  const sources = [];
  const seenQuality = {};
  const blocks = streams.split(/,(?=\[(?:2160p|1440p|1080p|720p|480p|360p|240p|auto)\])/i);

  for (const block of blocks) {
    const match = block.match(/\[([^\]]+)\]([\s\S]+)/);

    if (!match) continue;

    const quality = normalizeQuality(match[1]);

    if (!quality || seenQuality[quality]) continue;

    const urls = [];
    const urlRegex = /https?:\/\/[^\s,\[\]]+/g;
    let urlMatch;

    while ((urlMatch = urlRegex.exec(match[2])) !== null) {
      let url = decodeRezkaEscapedString(urlMatch[0]).trim();
      url = url.replace(/[)"']+$/g, "");

      if (!url) continue;

      const isHls = url.includes(":hls:manifest.m3u8") || url.includes(".m3u8");
      if (!isHls) continue;

      urls.push(url);
    }

    if (urls.length === 0) continue;

    urls.sort((a, b) => {
      const aRezka = /ukrtelcdn/i.test(a) ? 1 : 0;
      const bRezka = /ukrtelcdn/i.test(b) ? 1 : 0;

      if (aRezka !== bRezka) return bRezka - aRezka;
      return a.localeCompare(b);
    });

    seenQuality[quality] = true;

    sources.push({
      quality,
      rank: qualityRank(quality),
      selectedUrl: urls[0],
      mirrors: urls,
    });
  }

  sources.sort((a, b) => b.rank - a.rank);

  return sources;
}

function extractAnimeId(html, url) {
  html = String(html || "");
  url = String(url || "");

  const urlMatch = url.match(/\/(\d+)-[^/]+\.html/i);
  if (urlMatch) return urlMatch[1];

  const episodeDataIdMatch = html.match(
    /class=["'][^"']*b-simple_episode__item[^"']*["'][^>]*data-id=["'](\d+)["']/i
  );
  if (episodeDataIdMatch) return episodeDataIdMatch[1];

  const seriesInitMatch = html.match(/initCDNSeriesEvents\s*\(\s*(\d+)\s*,/i);
  if (seriesInitMatch) return seriesInitMatch[1];

  const movieInitMatch = html.match(/initCDNMoviesEvents\s*\(\s*(\d+)\s*,/i);
  if (movieInitMatch) return movieInitMatch[1];

  const dataIdMatch = html.match(/data-id=["'](\d+)["']/i);
  if (dataIdMatch) return dataIdMatch[1];

  return "";
}

function extractTranslatorIdFromUrl(url) {
  url = String(url || "");

  const hashMatch = url.match(/#t:(\d+)/);
  if (hashMatch) return hashMatch[1];

  const translatorPathMatch = url.match(/\/\d+-[^/]+\/(\d+)-[^/]+\.html/i);
  if (translatorPathMatch) return translatorPathMatch[1];

  return "";
}

function extractSeasons(html) {
  const seasons = [];
  const regex = /<[^>]+class=["'][^"']*b-simple_season__item[^"']*["'][^>]*>[\s\S]*?<\/[^>]+>/gi;
  let match;

  while ((match = regex.exec(html)) !== null) {
    const tag = match[0];

    seasons.push({
      text: cleanText(tag),
      tabId: getAttr(tag, "data-tab_id"),
      active: /class=["'][^"']*active[^"']*["']/i.test(tag),
      tagStart: tag.slice(0, 250),
    });
  }

  return seasons;
}

function extractEpisodes(html) {
  const episodes = [];
  const regex = /<[^>]+class=["'][^"']*b-simple_episode__item[^"']*["'][^>]*>[\s\S]*?<\/[^>]+>/gi;
  let match;

  while ((match = regex.exec(html)) !== null) {
    const tag = match[0];

    episodes.push({
      text: cleanText(tag),
      id: getAttr(tag, "data-id"),
      season: getAttr(tag, "data-season_id") || getAttr(tag, "data-season-id"),
      episode: getAttr(tag, "data-episode_id") || getAttr(tag, "data-episode-id"),
      cdnUrl: getAttr(tag, "data-cdn_url"),
      cdnQuality: getAttr(tag, "data-cdn_quality"),
      href: getAttr(tag, "href"),
      active: /class=["'][^"']*active[^"']*["']/i.test(tag),
      tagStart: tag.slice(0, 250),
    });
  }

  return episodes;
}

function extractTranslators(html) {
  const translators = [];
  const seen = {};
  const regex = /<[^>]+class=["'][^"']*b-translator__item[^"']*["'][^>]*>[\s\S]*?<\/[^>]+>/gi;
  let match;

  while ((match = regex.exec(html)) !== null) {
    const tag = match[0];

    const id = getAttr(tag, "data-translator_id") || extractTranslatorIdFromUrl(tag);
    if (!id || seen[id]) continue;

    seen[id] = true;

    translators.push({
      index: translators.length,
      id,
      dataId: getAttr(tag, "data-id"),
      text: cleanText(tag),
      title: cleanText(getAttr(tag, "title")),
      href: getAttr(tag, "href") ? absoluteUrl(getAttr(tag, "href")) : "",
      active: /class=["'][^"']*active[^"']*["']/i.test(tag),
      tagStart: tag.slice(0, 250),
    });
  }

  return translators;
}

function extractVideoTags(html) {
  const videos = [];
  const regex = /<video[^>]*>/gi;
  let match;

  while ((match = regex.exec(html)) !== null) {
    const tag = match[0];

    videos.push({
      src: getAttr(tag, "src"),
      tagStart: tag.slice(0, 400),
    });
  }

  return videos;
}

function extractScriptSnippets(html) {
  const snippets = [];
  const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  let index = 0;

  while ((match = scriptRegex.exec(html)) !== null) {
    const body = match[1] || "";

    if (/initCDN|get_cdn|cdnplayer|streams|translator_id|sof\.tv/i.test(body)) {
      const hits = [];
      const re = /initCDN|get_cdn|cdnplayer|streams|translator_id|sof\.tv/gi;
      let hit;

      while ((hit = re.exec(body)) !== null && hits.length < 10) {
        const start = Math.max(0, hit.index - 300);
        const end = Math.min(body.length, hit.index + 900);
        hits.push(cleanText(body.slice(start, end)));
      }

      snippets.push({
        index,
        hits,
      });
    }

    index++;
  }

  return snippets;
}

async function fetchText(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();

  return {
    url,
    status: res.status,
    ok: res.ok,
    contentType: res.headers.get("content-type"),
    text,
  };
}

async function probeSeriesAjax(baseUrl, animeId, translatorId, seasons, episodes) {
  const probes = [];

  if (!animeId || !translatorId) {
    return probes;
  }

  const sampleEpisodes = [];

  for (const ep of episodes) {
    if (!ep.season || !ep.episode) continue;

    const key = ep.season + ":" + ep.episode;
    if (sampleEpisodes.some((x) => x.key === key)) continue;

    sampleEpisodes.push({
      key,
      season: ep.season,
      episode: ep.episode,
    });

    if (sampleEpisodes.length >= 3) break;
  }

  if (sampleEpisodes.length === 0 && seasons.length > 0) {
    sampleEpisodes.push({
      key: String(seasons[0].tabId || 1) + ":1",
      season: seasons[0].tabId || 1,
      episode: 1,
    });
  }

  if (sampleEpisodes.length === 0) {
    sampleEpisodes.push({
      key: "1:1",
      season: 1,
      episode: 1,
    });
  }

  for (const sample of sampleEpisodes) {
    const endpoint = baseUrl + "/ajax/get_cdn_series/?t=" + Date.now();
    const body =
      "id=" +
      encodeURIComponent(animeId) +
      "&translator_id=" +
      encodeURIComponent(translatorId) +
      "&season=" +
      encodeURIComponent(String(sample.season)) +
      "&episode=" +
      encodeURIComponent(String(sample.episode)) +
      "&action=get_stream";

    try {
      const res = await fetchText(endpoint, {
        method: "POST",
        headers: {
          ...HEADERS,
          Origin: baseUrl,
          Referer: PAGE_URL,
        },
        body,
      });

      let parsed = null;
      let sources = [];

      try {
        parsed = JSON.parse(res.text);
        if (parsed && parsed.url) {
          sources = extractRezkaStreamSources(parsed.url);
        }
      } catch (_) {}

      probes.push({
        endpoint,
        body,
        status: res.status,
        ok: res.ok,
        contentType: res.contentType,
        responseStart: res.text.slice(0, 1500),
        jsonSuccess: parsed ? parsed.success : null,
        jsonMessage: parsed ? parsed.message : null,
        qualities: sources.map((s) => s.quality),
        sources,
      });
    } catch (e) {
      probes.push({
        endpoint,
        body,
        error: String(e && e.message ? e.message : e),
      });
    }
  }

  return probes;
}

function makeWarnings(report) {
  const warnings = [];

  if (!report.detected.animeId) {
    warnings.push("Could not detect animeId.");
  }

  if (report.episodes.length === 0 && report.detected.type === "series") {
    warnings.push("No episode items found, but page looks like a series.");
  }

  if (report.episodes.length > 0) {
    const missingData = report.episodes.filter((ep) => !ep.id || !ep.season || !ep.episode);
    if (missingData.length > 0) {
      warnings.push("Some episodes are missing data-id, data-season_id, or data-episode_id.");
    }
  }

  if (report.translators.length === 0 && !report.detected.inlineSeriesTranslatorId && !report.detected.inlineMovieTranslatorId) {
    warnings.push("No visible translator list and no inline translator id detected.");
  }

  if (report.seriesInits.length > 0) {
    for (const init of report.seriesInits) {
      if (!init.streamsLength) {
        warnings.push("Series initCDNSeriesEvents detected but streams were not extracted. Parser may need update.");
      }
    }
  }

  if (report.movieInits.length > 0) {
    for (const init of report.movieInits) {
      if (!init.streamsLength) {
        warnings.push("Movie initCDNMoviesEvents detected but streams were not extracted. Parser may need update.");
      }
    }
  }

  if (report.detected.type === "movie" && report.movieInits.length === 0 && report.videoTags.length === 0) {
    warnings.push("Movie page has no raw initCDNMoviesEvents streams and no raw video src. ChromeDP/browser fallback may be required.");
  }

  return warnings;
}

async function main() {
  const startedAt = new Date().toISOString();
  const pageUrl = normalizeUrl(PAGE_URL);
  const page = await fetchText(pageUrl, {
    headers: {
      ...HEADERS,
      Referer: BASE + "/",
    },
  });

  const html = page.text;

  const seasons = extractSeasons(html);
  const episodes = extractEpisodes(html);
  const translators = extractTranslators(html);
  const activeTranslator = translators.find((t) => t.active) || translators[0] || null;
  const seriesInits = extractAllInitCDNSeriesData(html);
  const movieInits = extractAllInitCDNMoviesData(html);
  const videoTags = extractVideoTags(html);

  const animeId =
    extractAnimeId(html, pageUrl) ||
    (episodes[0] ? episodes[0].id : "") ||
    (seriesInits[0] ? seriesInits[0].animeId : "") ||
    (movieInits[0] ? movieInits[0].animeId : "");

  const inlineSeriesTranslatorId = seriesInits[0] ? seriesInits[0].translatorId : "";
  const inlineMovieTranslatorId = movieInits[0] ? movieInits[0].translatorId : "";

  const translatorId =
    (activeTranslator && activeTranslator.id) ||
    inlineSeriesTranslatorId ||
    inlineMovieTranslatorId ||
    extractTranslatorIdFromUrl(pageUrl);

  const type =
    episodes.length > 0 || seriesInits.length > 0
      ? "series"
      : "movie";

  const inlineSources = []
    .concat(
      seriesInits.map((init) => ({
        kind: "series",
        animeId: init.animeId,
        translatorId: init.translatorId,
        season: init.season,
        episode: init.episode,
        defaultQuality: init.defaultQuality,
        qualities: extractRezkaStreamSources(init.streams).map((s) => s.quality),
        sources: extractRezkaStreamSources(init.streams),
      }))
    )
    .concat(
      movieInits.map((init) => ({
        kind: "movie",
        animeId: init.animeId,
        translatorId: init.translatorId,
        defaultQuality: init.defaultQuality,
        qualities: extractRezkaStreamSources(init.streams).map((s) => s.quality),
        sources: extractRezkaStreamSources(init.streams),
      }))
    );

  const ajaxProbes =
    type === "series"
      ? await probeSeriesAjax(BASE, animeId, translatorId, seasons, episodes)
      : [];

  const report = {
    tool: "rezka-debug",
    startedAt,
    pageUrl,
    fetch: {
      status: page.status,
      ok: page.ok,
      contentType: page.contentType,
      htmlLength: html.length,
    },
    detected: {
      type,
      animeId,
      translatorId,
      activeTranslator,
      inlineSeriesTranslatorId,
      inlineMovieTranslatorId,
    },
    counts: {
      seasons: seasons.length,
      episodes: episodes.length,
      translators: translators.length,
      seriesInits: seriesInits.length,
      movieInits: movieInits.length,
      videoTags: videoTags.length,
    },
    seasons,
    episodes,
    translators,
    seriesInits: seriesInits.map((x) => ({
      animeId: x.animeId,
      translatorId: x.translatorId,
      season: x.season,
      episode: x.episode,
      defaultQuality: x.defaultQuality,
      streamsLength: x.streamsLength,
      qualities: extractRezkaStreamSources(x.streams).map((s) => s.quality),
      rawArgsStart: x.rawArgsStart,
    })),
    movieInits: movieInits.map((x) => ({
      animeId: x.animeId,
      translatorId: x.translatorId,
      defaultQuality: x.defaultQuality,
      streamsLength: x.streamsLength,
      qualities: extractRezkaStreamSources(x.streams).map((s) => s.quality),
      rawArgsStart: x.rawArgsStart,
    })),
    inlineSources,
    videoTags,
    ajaxProbes,
    scriptSnippets: extractScriptSnippets(html),
  };

  report.warnings = makeWarnings(report);

  const outDir = path.join(process.cwd(), "rezka-debug-reports");
  fs.mkdirSync(outDir, { recursive: true });

  const safeName =
    pageUrl
      .replace(/^https?:\/\//, "")
      .replace(/[^a-z0-9]+/gi, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 120) || "report";

  const outPath = path.join(outDir, safeName + ".json");

  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");

  console.log("");
  console.log("Rezka debug report saved:");
  console.log(outPath);
  console.log("");
  console.log("Summary:");
  console.log(JSON.stringify({
    detected: report.detected,
    counts: report.counts,
    warnings: report.warnings,
    seriesInlineQualities: report.seriesInits.map((x) => x.qualities),
    movieInlineQualities: report.movieInits.map((x) => x.qualities),
    ajaxProbeQualities: report.ajaxProbes.map((x) => ({
      body: x.body,
      qualities: x.qualities,
      success: x.jsonSuccess,
      message: x.jsonMessage,
    })),
  }, null, 2));
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});