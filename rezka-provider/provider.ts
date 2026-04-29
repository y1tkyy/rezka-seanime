/// <reference path="./online-streaming-provider.d.ts" />
/// <reference path="./core.d.ts" />

class Provider {
  constructor() {
    this.base = "https://rezka-ua.co";
    this.headers = {
      Accept: "text/html, */*; q=0.01",
      "Accept-Language": "en-US,en;q=0.9,uk;q=0.8,ru;q=0.7",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Origin: this.base,
      Referer: this.base + "/",
      "X-Requested-With": "XMLHttpRequest",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    };
  }

  getSettings() {
    return {
      episodeServers: ["HLS"],
      supportsDub: true,
    };
  }

  async search(opts) {
    const queries = [
      opts.query,
      opts.media && opts.media.englishTitle ? opts.media.englishTitle : "",
      opts.media && opts.media.romajiTitle ? opts.media.romajiTitle : "",
    ];

    if (opts.media && opts.media.synonyms) {
      for (const synonym of opts.media.synonyms) {
        queries.push(synonym);
      }
    }

    const cleanQueries = [];

    for (const q of queries) {
      const value = String(q || "").trim();
      if (value && cleanQueries.indexOf(value) === -1) {
        cleanQueries.push(value);
      }
    }

    const year =
      opts.year ||
      (opts.media && opts.media.startDate && opts.media.startDate.year
        ? opts.media.startDate.year
        : 0);

    for (const q of cleanQueries) {
      const results = await this.searchRezka(q, year);
      if (results.length > 0) {
        return results;
      }
    }

    return [];
  }

  async searchRezka(q, year) {
    const res = await fetch(this.base + "/engine/ajax/search.php", {
      method: "POST",
      headers: this.headers,
      body: "q=" + encodeURIComponent(q),
    });

    if (!res.ok) {
      return [];
    }

    const html = await res.text();
    const results = [];
    const regex = /<li>\s*<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/li>/g;
    let match;

    while ((match = regex.exec(html)) !== null) {
      const url = this.normalizeUrl(this.decodeHtml(match[1]));
      const inner = match[2];

      if (url.indexOf("/animation/") === -1 && !/аниме/i.test(inner)) {
        continue;
      }

      const titleMatch = inner.match(/<span class="enty">([\s\S]*?)<\/span>/i);
      if (!titleMatch) {
        continue;
      }

      const title = this.cleanText(titleMatch[1]);
      const details = this.cleanText(
        inner
          .replace(/<span class="enty">[\s\S]*?<\/span>/i, "")
          .replace(/<span class="rating">[\s\S]*?<\/span>/i, "")
      );

      const fullTitle = details ? title + " " + details : title;

      if (year && fullTitle.indexOf(String(year)) === -1) {
        continue;
      }

      results.push({
        id: url,
        title: fullTitle,
        url: url,
        subOrDub: "both",
      });
    }

    return results;
  }

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
    const $ = LoadDoc(html);

    const animeId = this.extractAnimeId(html, url);
    const translators = this.extractTranslators(html, url);
    const activeTranslator = this.extractActiveTranslator(html, url, translators);

    const translatorId =
      activeTranslator.id ||
      this.extractTranslatorIdFromUrl(url) ||
      (translators.length > 0 ? translators[0].id : "0");

    const translatorName =
      activeTranslator.name ||
      (translators.length > 0 ? translators[0].name : "Default");

    const episodes = [];
    const seen = {};

    const pushEpisode = (seasonNumber, episodeNumber, href, dataId, text) => {
      seasonNumber = this.toNumber(seasonNumber) || 1;
      episodeNumber = this.toNumber(episodeNumber);

      if (!episodeNumber) {
        episodeNumber =
          this.extractEpisodeNumber(text) ||
          this.extractEpisodeNumber(href);
      }

      if (!episodeNumber) {
        return;
      }

      const key = seasonNumber + ":" + episodeNumber;

      if (seen[key]) {
        return;
      }

      seen[key] = true;

      const epUrl = href
        ? this.absoluteUrl(href)
        : this.makeEpisodeUrl(url, translatorId, seasonNumber, episodeNumber);

      const payload = {
        url: epUrl,
        baseUrl: this.basePageUrl(url),
        animeId: dataId || animeId,
        translatorId: translatorId,
        translatorName: translatorName,
        translators: translators,
        season: seasonNumber,
        episode: episodeNumber,
      };

      episodes.push({
        id: JSON.stringify(payload),
        number: episodeNumber,
        title:
          seasonNumber > 1
            ? "Season " + seasonNumber + " Episode " + episodeNumber
            : "Episode " + episodeNumber,
        url: epUrl,
        _season: seasonNumber,
        _episode: episodeNumber,
      });
    };

    $(".b-simple_episode__item").each((_, el) => {
      const attrs = String(el.toString ? el.toString() : "");

      const season =
        el.attr("data-season_id") ||
        el.attr("data-season-id") ||
        this.getAttr(attrs, "data-season_id") ||
        this.getAttr(attrs, "data-season-id");

      const episode =
        el.attr("data-episode_id") ||
        el.attr("data-episode-id") ||
        this.getAttr(attrs, "data-episode_id") ||
        this.getAttr(attrs, "data-episode-id");

      const dataId =
        el.attr("data-id") ||
        this.getAttr(attrs, "data-id") ||
        animeId;

      const href =
        el.attr("href") ||
        this.getAttr(attrs, "href");

      const text = this.cleanText(el.text ? el.text() : attrs);

      pushEpisode(season, episode, href, dataId, text);
    });

    if (episodes.length === 0) {
      const itemRegex =
        /<[^>]*class=["'][^"']*b-simple_episode__item[^"']*["'][^>]*>/gi;

      let match;

      while ((match = itemRegex.exec(html)) !== null) {
        const tag = match[0];

        pushEpisode(
          this.getAttr(tag, "data-season_id") || this.getAttr(tag, "data-season-id"),
          this.getAttr(tag, "data-episode_id") || this.getAttr(tag, "data-episode-id"),
          this.getAttr(tag, "href"),
          this.getAttr(tag, "data-id") || animeId,
          tag
        );
      }
    }

    if (episodes.length === 0) {
      const hashEpisodes = this.extractHashEpisodes(
        html,
        url,
        animeId,
        activeTranslator,
        translators
      );

      for (const ep of hashEpisodes) {
        try {
          const payload = JSON.parse(ep.id);
          ep._season = payload.season || 1;
          ep._episode = payload.episode || ep.number;
        } catch (_) {
          ep._season = 1;
          ep._episode = ep.number;
        }

        episodes.push(ep);
      }
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

      const epUrl = this.makeEpisodeUrl(
        url,
        translatorId,
        seasonNumber,
        episodeNumber
      );

      const payload = {
        url: epUrl,
        baseUrl: this.basePageUrl(url),
        animeId: animeId,
        translatorId: translatorId,
        translatorName: translatorName,
        translators: translators,
        season: seasonNumber,
        episode: episodeNumber,
      };

      episodes.push({
        id: JSON.stringify(payload),
        number: 1,
        title: "Episode 1",
        url: epUrl,
        _season: seasonNumber,
        _episode: episodeNumber,
      });
    }

    episodes.sort((a, b) => {
      const seasonA = a._season || 1;
      const seasonB = b._season || 1;

      if (seasonA !== seasonB) {
        return seasonA - seasonB;
      }

      return (a._episode || a.number) - (b._episode || b.number);
    });

    for (let i = 0; i < episodes.length; i++) {
      episodes[i].number = i + 1;

      delete episodes[i]._season;
      delete episodes[i]._episode;
    }

    return episodes.filter((episode) => Number.isInteger(episode.number));
  }

  async findEpisodeServer(episodeOrId, server) {
    const data = this.parseEpisodeId(episodeOrId);
    let translators = data.translators && data.translators.length ? data.translators : [];

    if (translators.length === 0) {
      try {
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
      } catch (_) {}
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
      if (!translator.id || translator.id === "0") {
        continue;
      }

      const episodeUrl = this.makeEpisodeUrl(
        translator.url || data.url,
        translator.id,
        data.season,
        data.episode
      );

      const translatorData = {
        url: episodeUrl,
        baseUrl: data.baseUrl || this.basePageUrl(data.url),
        animeId: data.animeId,
        translatorId: translator.id,
        translatorName: translator.name,
        season: data.season,
        episode: data.episode,
      };

      const sources = await this.getStreamSources(translatorData);

      for (const source of sources) {
        const quality = this.normalizeQuality(source.quality);

        if (!quality || this.isBadQuality(quality)) {
          continue;
        }

        videoSources.push({
          url: source.url,
          type: source.type,
          quality: translator.name + " - " + quality,
          label: translator.name,
          subtitles: [],
        });
      }
    }

    const cleaned = this.dedupeSources(videoSources);

    if (cleaned.length === 0) {
      throw new Error("No video sources found");
    }

    return {
      server: server || "HLS",
      headers: {
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        Origin: this.base,
        Referer: this.base + "/",
        "User-Agent": this.headers["User-Agent"],
      },
      videoSources: cleaned,
    };
  }

  async getStreamSources(data) {
    const urls = [
      this.base + "/ajax/get_cdn_series/?t=" + Date.now(),
      this.base + "/engine/ajax/get_cdn_series/?t=" + Date.now(),
    ];

    const bodies = [
      "id=" +
        encodeURIComponent(data.animeId) +
        "&translator_id=" +
        encodeURIComponent(data.translatorId) +
        "&season=" +
        encodeURIComponent(String(data.season)) +
        "&episode=" +
        encodeURIComponent(String(data.episode)) +
        "&action=get_stream",
      "action=get_stream&id=" +
        encodeURIComponent(data.animeId) +
        "&translator_id=" +
        encodeURIComponent(data.translatorId) +
        "&season=" +
        encodeURIComponent(String(data.season)) +
        "&episode=" +
        encodeURIComponent(String(data.episode)),
    ];

    for (const url of urls) {
      for (const body of bodies) {
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: {
              ...this.headers,
              Referer: data.url,
            },
            body: body,
          });

          if (!res.ok) {
            continue;
          }

          const text = await res.text();
          const sources = this.extractSources(text);

          if (sources.length > 0) {
            return sources;
          }
        } catch (_) {}
      }
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

      return this.dedupeSources(sources);
    } catch (_) {}

    const decoded = this.decodeStreamString(text);

    if (decoded && decoded !== text) {
      this.extractSourceString(decoded, sources);
    }

    this.extractSourceString(text, sources);

    return this.dedupeSources(sources);
  }

  extractSourceValue(value, sources) {
    if (!value) {
      return;
    }

    if (typeof value === "string") {
      this.extractSourceString(value, sources);
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        this.extractSourceValue(item, sources);
      }
      return;
    }

    if (typeof value === "object") {
      const url = value.url || value.file || value.src || value.link;
      const quality = value.quality || value.label || value.resolution || "auto";

      if (url) {
        this.addSource(sources, url, quality);
      }

      for (const key in value) {
        this.extractSourceValue(value[key], sources);
      }
    }
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

    value = this.removePremiumParts(value);

    let foundQualityPairs = false;

    const bracketRegex = /\[([^\]]+)\](https?:\/\/[^\s,\[\]]+)/g;
    let bracketMatch;

    while ((bracketMatch = bracketRegex.exec(value)) !== null) {
      const rawQuality = bracketMatch[1];

      if (this.isBadQuality(rawQuality)) {
        continue;
      }

      const quality = this.normalizeQuality(rawQuality);

      if (!quality) {
        continue;
      }

      foundQualityPairs = true;
      this.addSource(sources, bracketMatch[2], quality);
    }

    const pairRegex = /(?:^|,|\s)(2160p|1440p|1080p|720p|480p|360p|240p|auto)\s*[:=]\s*(https?:\/\/[^\s,\[\]]+)/gi;
    let pairMatch;

    while ((pairMatch = pairRegex.exec(value)) !== null) {
      const rawQuality = pairMatch[1];

      if (this.isBadQuality(rawQuality)) {
        continue;
      }

      const quality = this.normalizeQuality(rawQuality);

      if (!quality) {
        continue;
      }

      foundQualityPairs = true;
      this.addSource(sources, pairMatch[2], quality);
    }

    if (!foundQualityPairs) {
      const directRegex = /https?:\/\/[^"'\\\s,\[\]]+(?:\.m3u8|\.mp4)[^"'\\\s,\[\]]*/g;
      let directMatch;

      while ((directMatch = directRegex.exec(value)) !== null) {
        const before = value.slice(Math.max(0, directMatch.index - 120), directMatch.index);

        if (this.isBadQuality(before)) {
          continue;
        }

        const qualityMatch = before.match(/(2160p|1440p|1080p|720p|480p|360p|240p|auto)/i);
        const quality = qualityMatch ? this.normalizeQuality(qualityMatch[1]) : "auto";

        if (!quality) {
          continue;
        }

        this.addSource(sources, directMatch[0], quality);
      }
    }

    const fileRegex = /file\s*:\s*["']([^"']+)["']/gi;
    let fileMatch;

    while ((fileMatch = fileRegex.exec(value)) !== null) {
      this.addSource(sources, fileMatch[1], "auto");
    }

    const videoRegex = /<video[^>]+src=["']([^"']+)["'][^>]*>/gi;
    let videoMatch;

    while ((videoMatch = videoRegex.exec(value)) !== null) {
      this.addSource(sources, videoMatch[1], "auto");
    }

    const sourceRegex = /<source[^>]+src=["']([^"']+)["'][^>]*>/gi;
    let sourceMatch;

    while ((sourceMatch = sourceRegex.exec(value)) !== null) {
      this.addSource(sources, sourceMatch[1], "auto");
    }
  }

  removePremiumParts(value) {
    value = String(value || "");

    value = value.replace(/\[[^\]]*(?:Ultra|Premium|premium|pjs-prem-quality|prem-icon|static\.hdrezka|templates\/hdrezka)[^\]]*\]https?:\/\/[^\s,\[\]]+/gi, "");
    value = value.replace(/<span[^>]*pjs-prem-quality[^>]*>[\s\S]*?<\/span>/gi, "");
    value = value.replace(/<img[^>]*(?:prem-icon|static\.hdrezka|templates\/hdrezka)[^>]*>/gi, "");
    value = value.replace(/&lt;span[\s\S]*?pjs-prem-quality[\s\S]*?&lt;\/span&gt;/gi, "");
    value = value.replace(/&lt;img[\s\S]*?(?:prem-icon|static\.hdrezka|templates\/hdrezka)[\s\S]*?&gt;/gi, "");

    return value;
  }

  decodeStreamString(value) {
    if (!value) {
      return "";
    }

    value = String(value)
      .replace(/\\\//g, "/")
      .replace(/\\/g, "");

    value = this.decodeHtml(value);

    const jsonUrlMatch =
      value.match(/"url"\s*:\s*"([^"]+)"/i) ||
      value.match(/'url'\s*:\s*'([^']+)'/i) ||
      value.match(/url\s*:\s*["']([^"']+)["']/i);

    if (jsonUrlMatch && jsonUrlMatch[1]) {
      value = jsonUrlMatch[1].replace(/\\\//g, "/").replace(/\\/g, "");
    }

    const trash = [
      "@#@!",
      "//_//",
      "^^^",
      "$$",
      "#h",
      "#2",
      "#3",
      "#4",
      "@",
      "!",
      "^",
    ];

    let cleaned = value;

    for (const item of trash) {
      cleaned = cleaned.split(item).join("");
    }

    if (cleaned.indexOf("http") !== -1) {
      return cleaned;
    }

    try {
      const decoded = CryptoJS.enc.Utf8.stringify(CryptoJS.enc.Base64.parse(cleaned));
      if (decoded && decoded.indexOf("http") !== -1) {
        return decoded;
      }
    } catch (_) {}

    return value;
  }

  addSource(sources, url, quality) {
    if (!url) return;

    if (this.isBadQuality(quality)) {
      return;
    }

    quality = this.normalizeQuality(quality);

    if (!quality) {
      return;
    }

    url = this.decodeHtml(String(url))
      .trim()
      .replace(/\\\//g, "/")
      .replace(/\\/g, "");

    if (url.indexOf("http") !== 0) {
      return;
    }

    if (this.isPremiumUrl(url)) {
      return;
    }

    if (sources.some((source) => source.url === url && source.quality === quality)) {
      return;
    }

    let type = "unknown";

    if (url.indexOf(".m3u8") !== -1) {
      type = "m3u8";
    } else if (url.indexOf(".mp4") !== -1) {
      type = "mp4";
    }

    sources.push({
      url: url,
      quality: quality,
      type: type,
      subtitles: [],
    });
  }

  normalizeQuality(quality) {
    quality = String(quality || "auto");

    if (this.isBadQuality(quality)) {
      return "";
    }

    quality = this.cleanText(quality)
      .replace(/\s+/g, " ")
      .replace(/\s*-\s*$/, "")
      .trim();

    if (this.isBadQuality(quality)) {
      return "";
    }

    const match = quality.match(/(2160p|1440p|1080p|720p|480p|360p|240p|auto)/i);

    if (!match) {
      return "";
    }

    return match[1].toLowerCase() === "auto" ? "auto" : match[1];
  }

  isBadQuality(value) {
    value = String(value || "");

    return (
      /</.test(value) ||
      />/.test(value) ||
      /&lt;/.test(value) ||
      /&gt;/.test(value) ||
      /ultra/i.test(value) ||
      /premium/i.test(value) ||
      /pjs-prem-quality/i.test(value) ||
      /prem-icon/i.test(value) ||
      /static\.hdrezka/i.test(value) ||
      /templates\/hdrezka/i.test(value)
    );
  }

  isPremiumUrl(url) {
    url = String(url || "");

    return (
      /prem-icon/i.test(url) ||
      /static\.hdrezka/i.test(url) ||
      /templates\/hdrezka/i.test(url) ||
      /\.svg/i.test(url)
    );
  }

  dedupeSources(sources) {
    const result = [];
    const seen = {};

    for (const source of sources) {
      if (!source || !source.url) {
        continue;
      }

      if (this.isBadQuality(source.quality) || this.isPremiumUrl(source.url)) {
        continue;
      }

      const quality = this.normalizeQuality(source.quality);

      if (!quality) {
        continue;
      }

      const key = source.label + "|" + quality + "|" + source.url;

      if (seen[key]) {
        continue;
      }

      seen[key] = true;

      result.push({
        url: source.url,
        type: source.type,
        quality: quality,
        label: source.label,
        subtitles: source.subtitles || [],
      });
    }

    return result;
  }

  parseEpisodeId(episode) {
    try {
      const parsed = JSON.parse(episode.id);
      if (parsed && parsed.url) {
        return parsed;
      }
    } catch (_) {}

    const url = this.normalizeUrl(episode.url || episode.id);

    return {
      url: url,
      baseUrl: this.basePageUrl(url),
      animeId: this.extractAnimeId("", url),
      translatorId: this.extractTranslatorIdFromUrl(url) || "0",
      translatorName: "Default",
      translators: [],
      season:
        this.extractSeasonNumber(url) ||
        this.extractSeasonNumberFromHash(url) ||
        1,
      episode:
        this.extractEpisodeNumber(url) ||
        this.extractEpisodeNumberFromHash(url) ||
        episode.number ||
        1,
    };
  }

  resolveUrl(id) {
    if (!id) {
      throw new Error("Empty id");
    }

    try {
      const parsed = JSON.parse(id);

      if (parsed && typeof parsed === "object" && parsed.url) {
        return this.normalizeUrl(parsed.url);
      }

      if (typeof parsed === "string" && parsed.indexOf("http") === 0) {
        return this.normalizeUrl(parsed);
      }
    } catch (_) {}

    if (String(id).indexOf("http") === 0) {
      return this.normalizeUrl(id);
    }

    throw new Error("Invalid id. Expected URL from search result.");
  }

  extractAnimeId(html, url) {
    const dataIdMatch = String(html || "").match(/data-id=["'](\d+)["']/i);

    if (dataIdMatch) {
      return dataIdMatch[1];
    }

    const urlMatch = String(url || "").match(/\/(\d+)-[^/]+\.html/i);

    if (urlMatch) {
      return urlMatch[1];
    }

    return "";
  }

  extractTranslators(html, url) {
    const translators = [];
    const seen = {};
    const regex = /<[^>]+class=["'][^"']*b-translator__item[^"']*["'][^>]*>[\s\S]*?<\/[^>]+>/gi;
    let match;

    while ((match = regex.exec(html)) !== null) {
      const tag = match[0];
      const id =
        this.getAttr(tag, "data-translator_id") ||
        this.extractTranslatorIdFromUrl(tag);

      if (!id || seen[id]) {
        continue;
      }

      seen[id] = true;

      const href = this.getAttr(tag, "href");
      const name = this.cleanText(this.getAttr(tag, "title") || tag) || "Translator " + id;

      translators.push({
        id: id,
        name: name,
        url: href ? this.absoluteUrl(href) : this.makeEpisodeUrl(url, id, 1, 1),
      });
    }

    if (translators.length === 0) {
      const id = this.extractTranslatorIdFromUrl(url) || "0";
      translators.push({
        id: id,
        name: "Default",
        url: url,
      });
    }

    return translators;
  }

  extractActiveTranslator(html, url, translators) {
    const activeMatch =
      String(html || "").match(/<[^>]+class=["'][^"']*b-translator__item[^"']*active[^"']*["'][^>]*>[\s\S]*?<\/[^>]+>/i);

    if (activeMatch) {
      const tag = activeMatch[0];
      const id =
        this.getAttr(tag, "data-translator_id") ||
        this.extractTranslatorIdFromUrl(tag) ||
        this.extractTranslatorIdFromUrl(url) ||
        "0";

      const name = this.cleanText(this.getAttr(tag, "title") || tag) || "Translator " + id;

      return {
        id: id,
        name: name,
        url: this.getAttr(tag, "href") ? this.absoluteUrl(this.getAttr(tag, "href")) : url,
      };
    }

    const urlTranslatorId = this.extractTranslatorIdFromUrl(url);

    if (urlTranslatorId) {
      for (const translator of translators) {
        if (translator.id === urlTranslatorId) {
          return translator;
        }
      }

      return {
        id: urlTranslatorId,
        name: "Translator " + urlTranslatorId,
        url: url,
      };
    }

    if (translators.length > 0) {
      return translators[0];
    }

    return {
      id: "0",
      name: "Default",
      url: url,
    };
  }

  extractHashEpisodes(html, pageUrl, animeId, translator, translators) {
    const episodes = [];
    const seen = {};
    const regex = /#t:(\d+)-s:(\d+)-e:(\d+)/g;
    let match;

    while ((match = regex.exec(html)) !== null) {
      const translatorId = match[1];
      const season = parseInt(match[2], 10);
      const episode = parseInt(match[3], 10);
      const key = season + ":" + episode;

      if (seen[key]) {
        continue;
      }

      seen[key] = true;

      const payload = {
        url: this.makeEpisodeUrl(pageUrl, translatorId, season, episode),
        baseUrl: this.basePageUrl(pageUrl),
        animeId: animeId,
        translatorId: translatorId,
        translatorName: translator.id === translatorId ? translator.name : "Translator " + translatorId,
        translators: translators,
        season: season,
        episode: episode,
      };

      episodes.push({
        id: JSON.stringify(payload),
        number: episode,
        title: "Episode " + episode,
        url: payload.url,
      });
    }

    return episodes;
  }

  makeEpisodeUrl(url, translatorId, season, episode) {
    const clean = this.normalizeUrl(String(url || "").split("#")[0]);

    if (translatorId && translatorId !== "0") {
      return clean + "#t:" + translatorId + "-s:" + season + "-e:" + episode;
    }

    return clean + "#s:" + season + "-e:" + episode;
  }

  basePageUrl(url) {
    return this.normalizeUrl(String(url || "").split("#")[0]);
  }

  extractTranslatorIdFromUrl(url) {
    const hashMatch = String(url || "").match(/#t:(\d+)/);

    if (hashMatch) {
      return hashMatch[1];
    }

    const pathMatch = String(url || "").match(/\/(\d+)-[^/]+(?:\/\d+-season(?:\/\d+-episode)?\.html|\.html)/i);

    if (pathMatch) {
      return pathMatch[1];
    }

    return "";
  }

  extractSeasonNumber(input) {
    input = String(input || "");

    const match =
      input.match(/\/(\d+)-season/i) ||
      input.match(/#t:\d+-s:(\d+)-e:\d+/i) ||
      input.match(/#s:(\d+)-e:\d+/i);

    return match ? parseInt(match[1], 10) : 0;
  }

  extractEpisodeNumber(input) {
    input = String(input || "");

    const match =
      input.match(/\/(\d+)-episode/i) ||
      input.match(/#t:\d+-s:\d+-e:(\d+)/i) ||
      input.match(/#s:\d+-e:(\d+)/i) ||
      input.match(/Серия\s+(\d+)/i) ||
      input.match(/Episode\s+(\d+)/i) ||
      input.match(/Epis[oó]dio\s+(\d+)/i);

    return match ? parseInt(match[1], 10) : 0;
  }

  extractSeasonNumberFromHash(input) {
    const match =
      String(input || "").match(/#t:\d+-s:(\d+)-e:\d+/i) ||
      String(input || "").match(/#s:(\d+)-e:\d+/i);

    return match ? parseInt(match[1], 10) : 0;
  }

  extractEpisodeNumberFromHash(input) {
    const match =
      String(input || "").match(/#t:\d+-s:\d+-e:(\d+)/i) ||
      String(input || "").match(/#s:\d+-e:(\d+)/i);

    return match ? parseInt(match[1], 10) : 0;
  }

  getAttr(input, name) {
    const regex = new RegExp(name + '=["\']([^"\']+)["\']', "i");
    const match = String(input || "").match(regex);
    return match ? this.decodeHtml(match[1]) : "";
  }

  toNumber(value) {
    if (!value) {
      return 0;
    }

    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  absoluteUrl(url) {
    url = String(url || "");

    if (url.indexOf("http://") === 0 || url.indexOf("https://") === 0) {
      return this.normalizeUrl(url);
    }

    if (url.indexOf("/") === 0) {
      return this.base + url;
    }

    return this.base + "/" + url;
  }

  normalizeUrl(url) {
    return String(url || "")
      .replace("https://rezka.ag", this.base)
      .replace("https://rezka-ua.co", this.base)
      .replace("http://rezka.ag", this.base)
      .replace("http://rezka-ua.co", this.base);
  }

  cleanText(input) {
    return this.decodeHtml(
      String(input || "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    );
  }

  decodeHtml(input) {
    return String(input || "")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
  }
}
