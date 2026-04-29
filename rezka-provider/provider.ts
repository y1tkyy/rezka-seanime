async findEpisodes(id) {
  const url = this.resolveUrl(id);

  const res = await fetch(url, {
    headers: {
      ...this.headers,
      Referer: this.base + "/",
    },
  });

  if (!res.ok) {
    throw new Error("Failed to fetch anime page: " + res.status);
  }

  const html = await res.text();
  const animeId = this.extractAnimeId(html, url);
  const translators = this.extractTranslators(html, url);
  const activeTranslator = this.extractTranslator(html, url);
  const episodes = [];
  const seen = {};

  const addEpisode = (attrs, text) => {
    const episodeNumber =
      this.toNumber(this.getAttr(attrs, "data-episode_id")) ||
      this.extractEpisodeNumber(text);

    if (!episodeNumber) return;

    const seasonNumber =
      this.toNumber(this.getAttr(attrs, "data-season_id")) ||
      this.extractSeasonNumber(url) ||
      this.extractSeasonNumberFromHash(url) ||
      1;

    const key = seasonNumber + ":" + episodeNumber;

    if (seen[key]) return;

    seen[key] = true;

    const translatorId =
      activeTranslator.id ||
      this.extractTranslatorIdFromUrl(url) ||
      (translators.length ? translators[0].id : "0");

    const translatorName =
      activeTranslator.name ||
      (translators.length ? translators[0].name : "Default");

    const epUrl = this.makeHashEpisodeUrl(url, translatorId, seasonNumber, episodeNumber);

    const payload = {
      url: epUrl,
      animeId: this.getAttr(attrs, "data-id") || animeId,
      translatorId: translatorId,
      translatorName: translatorName,
      translators: translators,
      season: seasonNumber,
      episode: episodeNumber,
    };

    episodes.push({
      id: JSON.stringify(payload),
      number: episodeNumber,
      title: "Episode " + episodeNumber,
      url: epUrl,
    });
  };

  const liRegex = /<li\b([^>]*class=["'][^"']*b-simple_episode__item[^"']*["'][^>]*)>([\s\S]*?)<\/li>/gi;
  let liMatch;

  while ((liMatch = liRegex.exec(html)) !== null) {
    addEpisode(liMatch[1], this.cleanText(liMatch[2]));
  }

  const aRegex = /<a\b([^>]*class=["'][^"']*b-simple_episode__item[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi;
  let aMatch;

  while ((aMatch = aRegex.exec(html)) !== null) {
    addEpisode(aMatch[1], this.cleanText(aMatch[2]));
  }

  const dataRegex = /<[^>]+data-id=["']\d+["'][^>]+data-season_id=["']\d+["'][^>]+data-episode_id=["']\d+["'][^>]*>/gi;
  let dataMatch;

  while ((dataMatch = dataRegex.exec(html)) !== null) {
    addEpisode(dataMatch[0], "");
  }

  if (episodes.length === 0) {
    const seasonNumber =
      this.extractSeasonNumber(url) ||
      this.extractSeasonNumberFromHash(url) ||
      1;

    const episodeNumber =
      this.extractEpisodeNumber(url) ||
      this.extractEpisodeNumberFromHash(url) ||
      1;

    const translatorId =
      activeTranslator.id ||
      this.extractTranslatorIdFromUrl(url) ||
      (translators.length ? translators[0].id : "0");

    const translatorName =
      activeTranslator.name ||
      (translators.length ? translators[0].name : "Default");

    const epUrl = this.makeHashEpisodeUrl(url, translatorId, seasonNumber, episodeNumber);

    const payload = {
      url: epUrl,
      animeId: animeId,
      translatorId: translatorId,
      translatorName: translatorName,
      translators: translators,
      season: seasonNumber,
      episode: episodeNumber,
    };

    episodes.push({
      id: JSON.stringify(payload),
      number: episodeNumber,
      title: "Episode " + episodeNumber,
      url: epUrl,
    });
  }

  episodes.sort((a, b) => a.number - b.number);

  return episodes;
}

async findEpisodeServer(episode, server) {
  const data = this.parseEpisodeId(episode);
  let translators = data.translators && data.translators.length ? data.translators : [];

  if (translators.length === 0) {
    const res = await fetch(data.url, {
      headers: {
        ...this.headers,
        Referer: this.base + "/",
      },
    });

    if (res.ok) {
      const html = await res.text();
      translators = this.extractTranslators(html, data.url);
    }
  }

  if (translators.length === 0) {
    translators = [
      {
        id: data.translatorId || "0",
        name: data.translatorName || "Default",
        url: data.url,
      },
    ];
  }

  const videoSources = [];

  for (const translator of translators) {
    if (!translator.id || translator.id === "0") continue;

    const translatorData = {
      url: this.makeHashEpisodeUrl(data.url, translator.id, data.season, data.episode),
      animeId: data.animeId,
      translatorId: translator.id,
      translatorName: translator.name,
      season: data.season,
      episode: data.episode,
    };

    const sources = await this.getStreamSources(translatorData);

    for (const source of sources) {
      videoSources.push({
        url: source.url,
        type: source.type,
        quality: source.quality,
        label: translator.name,
        subtitles: source.subtitles || [],
      });
    }
  }

  if (videoSources.length === 0) {
    const sources = await this.getStreamSources(data);

    for (const source of sources) {
      videoSources.push({
        url: source.url,
        type: source.type,
        quality: source.quality,
        label: data.translatorName || "Default",
        subtitles: source.subtitles || [],
      });
    }
  }

  if (videoSources.length === 0) {
    throw new Error("No video sources found");
  }

  return {
    server: server === "default" ? "default" : server,
    headers: {
      Accept: "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      Origin: this.base,
      Referer: this.base + "/",
      "User-Agent": this.headers["User-Agent"],
    },
    videoSources: this.dedupeSources(videoSources),
  };
}

async getStreamSources(data) {
  const requests = [
    {
      url: this.base + "/ajax/get_cdn_series/?t=" + Date.now(),
      body:
        "id=" +
        encodeURIComponent(data.animeId) +
        "&translator_id=" +
        encodeURIComponent(data.translatorId) +
        "&season=" +
        encodeURIComponent(String(data.season)) +
        "&episode=" +
        encodeURIComponent(String(data.episode)) +
        "&action=get_stream",
    },
    {
      url: this.base + "/engine/ajax/get_cdn_series/?t=" + Date.now(),
      body:
        "id=" +
        encodeURIComponent(data.animeId) +
        "&translator_id=" +
        encodeURIComponent(data.translatorId) +
        "&season=" +
        encodeURIComponent(String(data.season)) +
        "&episode=" +
        encodeURIComponent(String(data.episode)) +
        "&action=get_stream",
    },
  ];

  for (const req of requests) {
    try {
      const res = await fetch(req.url, {
        method: "POST",
        headers: {
          ...this.headers,
          Referer: data.url,
        },
        body: req.body,
      });

      if (!res.ok) continue;

      const text = await res.text();
      const sources = this.extractSources(text);

      if (sources.length > 0) return sources;
    } catch (_) {}
  }

  return [];
}

extractSources(text) {
  const sources = [];

  try {
    const json = JSON.parse(text);

    if (json.url) this.extractSourceString(json.url, sources);
    if (json.file) this.extractSourceString(json.file, sources);
    if (json.stream) this.extractSourceString(json.stream, sources);
    if (json.sources) this.extractSourceValue(json.sources, sources);

    if (sources.length > 0) return this.dedupeSources(sources);
  } catch (_) {}

  const decoded = this.decodeStreamString(text);

  if (decoded && decoded !== text) {
    this.extractSourceString(decoded, sources);
  }

  this.extractSourceString(text, sources);

  return this.dedupeSources(sources);
}

extractSourceString(value, sources) {
  if (!value) return;

  value = this.decodeHtml(String(value))
    .replace(/\\\//g, "/")
    .replace(/\\/g, "");

  const decoded = this.decodeStreamString(value);

  if (decoded && decoded !== value) {
    value = decoded;
  }

  const bracketRegex = /\[([^\]]+)\](https?:\/\/[^\s,\[\]]+)/g;
  let bracketMatch;

  while ((bracketMatch = bracketRegex.exec(value)) !== null) {
    this.addSource(sources, bracketMatch[2], bracketMatch[1]);
  }

  const directRegex = /https?:\/\/[^"'\\\s,\[\]]+(?:\.m3u8|\.mp4)[^"'\\\s,\[\]]*/g;
  let directMatch;

  while ((directMatch = directRegex.exec(value)) !== null) {
    this.addSource(sources, directMatch[0], "auto");
  }

  const fileRegex = /file\s*:\s*["']([^"']+)["']/gi;
  let fileMatch;

  while ((fileMatch = fileRegex.exec(value)) !== null) {
    this.addSource(sources, fileMatch[1], "auto");
  }
}

addSource(sources, url, quality) {
  if (!url) return;

  url = this.decodeHtml(String(url))
    .trim()
    .replace(/\\\//g, "/")
    .replace(/\\/g, "");

  if (url.indexOf("http") !== 0) return;

  let type = "unknown";

  if (url.indexOf(".m3u8") !== -1) {
    type = "m3u8";
  } else if (url.indexOf(".mp4") !== -1) {
    type = "mp4";
  }

  const cleanQuality = this.cleanQuality(quality);

  if (sources.some((source) => source.url === url && source.quality === cleanQuality)) return;

  sources.push({
    url: url,
    quality: cleanQuality,
    type: type,
    subtitles: [],
  });
}

cleanQuality(quality) {
  quality = String(quality || "auto").trim();

  const match = quality.match(/(\d{3,4}p)/i);
  if (match) return match[1];

  if (/auto/i.test(quality)) return "auto";

  return quality;
}

dedupeSources(sources) {
  const result = [];
  const seen = {};

  for (const source of sources) {
    const key = source.label + "|" + source.quality + "|" + source.url;

    if (seen[key]) continue;

    seen[key] = true;
    result.push(source);
  }

  return result;
}

makeHashEpisodeUrl(url, translatorId, season, episode) {
  return (
    this.normalizeUrl(String(url || "").split("#")[0]) +
    "#t:" +
    translatorId +
    "-s:" +
    season +
    "-e:" +
    episode
  );
}

extractSeasonNumberFromHash(input) {
  const match = String(input || "").match(/#t:\d+-s:(\d+)-e:\d+/i);
  return match ? parseInt(match[1], 10) : 0;
}

extractEpisodeNumberFromHash(input) {
  const match = String(input || "").match(/#t:\d+-s:\d+-e:(\d+)/i);
  return match ? parseInt(match[1], 10) : 0;
}
