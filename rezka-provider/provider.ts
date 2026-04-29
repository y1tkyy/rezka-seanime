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
      episodeServers: ["default"],
      supportsDub: true,
    };
  }

  async search(query) {
    const queries = [
      query.query,
      query.media && query.media.englishTitle ? query.media.englishTitle : "",
      query.media && query.media.romajiTitle ? query.media.romajiTitle : "",
    ];

    if (query.media && query.media.synonyms) {
      for (const synonym of query.media.synonyms) {
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
      query.year ||
      (query.media && query.media.startDate && query.media.startDate.year
        ? query.media.startDate.year
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
    const html = await this.fetchText(url, this.base + "/");
    const animeId = this.extractAnimeId(html, url);

    if (!animeId) {
      throw new Error("Could not detect Rezka anime id");
    }

    let translators = this.extractTranslators(html, url);

    if (translators.length === 0) {
      translators = [
        {
          id: this.extractTranslatorIdFromUrl(url) || "0",
          name: "Default",
          url: url,
        },
      ];
    }

    const episodesByNumber = {};
    const translatorPages = [];

    translatorPages.push({
      translator: translators[0],
      url: translators[0].url || url,
      html: translators[0].url && translators[0].url !== url ? "" : html,
    });

    for (const translator of translators) {
      if (!translator.url) {
        continue;
      }

      let exists = false;

      for (const page of translatorPages) {
        if (page.url === translator.url) {
          exists = true;
          break;
        }
      }

      if (!exists) {
        translatorPages.push({
          translator: translator,
          url: translator.url,
          html: "",
        });
      }
    }

    for (const page of translatorPages) {
      let pageHtml = page.html;

      if (!pageHtml) {
        try {
          pageHtml = await this.fetchText(page.url, url);
        } catch (_) {
          pageHtml = "";
        }
      }

      if (!pageHtml) {
        continue;
      }

      const parsed = this.extractEpisodeItems(pageHtml, page.url, animeId, page.translator, translators);

      for (const ep of parsed) {
        if (!episodesByNumber[ep.number]) {
          episodesByNumber[ep.number] = ep;
        }
      }

      if (Object.keys(episodesByNumber).length > 1) {
        break;
      }
    }

    if (Object.keys(episodesByNumber).length === 0) {
      const hashEpisodes = this.extractHashEpisodes(html, url, animeId, translators[0], translators);

      for (const ep of hashEpisodes) {
        if (!episodesByNumber[ep.number]) {
          episodesByNumber[ep.number] = ep;
        }
      }
    }

    if (Object.keys(episodesByNumber).length === 0) {
      const seasonNumber = this.extractSeasonNumber(url) || 1;
      const episodeNumber = this.extractEpisodeNumber(url) || 1;

      const payload = {
        url: url,
        animeId: animeId,
        translatorId: translators[0].id,
        translatorName: translators[0].name,
        season: seasonNumber,
        episode: episodeNumber,
        translators: translators,
      };

      episodesByNumber[episodeNumber] = {
        id: JSON.stringify(payload),
        number: episodeNumber,
        title: "Episode " + episodeNumber,
        url: url,
      };
    }

    const episodes = [];

    for (const key in episodesByNumber) {
      episodes.push(episodesByNumber[key]);
    }

    episodes.sort((a, b) => a.number - b.number);

    return episodes;
  }

  extractEpisodeItems(html, pageUrl, animeId, translator, translators) {
    const episodes = [];
    const regex = /<a([^>]*class="[^"]*b-simple_episode__item[^"]*"[^>]*)>([\s\S]*?)<\/a>/g;
    let match;

    while ((match = regex.exec(html)) !== null) {
      const attrs = match[1];
      const text = this.cleanText(match[2]);
      const href = this.getAttr(attrs, "href");
      const episodeId = this.getAttr(attrs, "data-episode_id");
      const seasonId = this.getAttr(attrs, "data-season_id");
      const dataId = this.getAttr(attrs, "data-id");

      const episodeNumber =
        this.toNumber(episodeId) ||
        this.extractEpisodeNumber(text) ||
        this.extractEpisodeNumber(href);

      if (!episodeNumber) {
        continue;
      }

      const seasonNumber =
        this.toNumber(seasonId) ||
        this.extractSeasonNumber(href) ||
        this.extractSeasonNumber(pageUrl) ||
        1;

      const epUrl = href ? this.absoluteUrl(href) : pageUrl;

      const payload = {
        url: epUrl,
        animeId: dataId || animeId,
        translatorId: translator.id,
        translatorName: translator.name,
        season: seasonNumber,
        episode: episodeNumber,
        translators: translators,
      };

      episodes.push({
        id: JSON.stringify(payload),
        number: episodeNumber,
        title: "Episode " + episodeNumber,
        url: epUrl,
      });
    }

    return episodes;
  }

  async findEpisodeServer(episode, server) {
    const data = this.parseEpisodeId(episode);
    let translators = data.translators || [];

    if (!translators.length) {
      try {
        const html = await this.fetchText(data.url, this.base + "/");
        translators = this.extractTranslators(html, data.url);
      } catch (_) {}
    }

    if (!translators.length) {
      translators = [
        {
          id: data.translatorId || "0",
          name: data.translatorName || "Default",
          url: data.url,
        },
      ];
    }

    const allSources = [];

    for (const translator of translators) {
      const translatedData = {
        url: translator.url || data.url,
        animeId: data.animeId,
        translatorId: translator.id,
        translatorName: translator.name,
        season: data.season,
        episode: data.episode,
      };

      const sources = await this.getStreamSources(translatedData, translator.name);

      for (const source of sources) {
        this.addPreparedSource(allSources, source);
      }
    }

    if (allSources.length > 0) {
      return {
        server: server === "default" ? "default" : server,
        headers: {
          Referer: this.base + "/",
          Origin: this.base,
          "User-Agent": this.headers["User-Agent"],
        },
        videoSources: allSources,
      };
    }

    const html = await this.fetchText(data.url, this.base + "/");
    const htmlSources = this.extractSources(html, data.translatorName || "Default");

    if (htmlSources.length > 0) {
      return {
        server: server === "default" ? "default" : server,
        headers: {
          Referer: this.base + "/",
          Origin: this.base,
          "User-Agent": this.headers["User-Agent"],
        },
        videoSources: htmlSources,
      };
    }

    throw new Error("No video sources found");
  }

  async getStreamSources(data, translatorName) {
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
          encodeURIComponent(String(data.episode)),
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
          encodeURIComponent(String(data.episode)),
      },
    ];

    for (const req of requests) {
      try {
        const res = await fetch(req.url, {
          method: "POST",
          headers: {
            ...this.headers,
            Referer: data.url || this.base + "/",
          },
          body: req.body,
        });

        if (!res.ok) {
          continue;
        }

        const text = await res.text();
        const sources = this.extractSources(text, translatorName);

        if (sources.length > 0) {
          return sources;
        }
      } catch (_) {}
    }

    return [];
  }

  extractSources(text, translatorName) {
    const sources = [];

    try {
      const json = JSON.parse(text);

      if (json.url) {
        this.extractSourceString(json.url, sources, translatorName);
      }

      if (json.file) {
        this.extractSourceString(json.file, sources, translatorName);
      }

      if (json.stream) {
        this.extractSourceString(json.stream, sources, translatorName);
      }

      if (json.sources) {
        this.extractSourceValue(json.sources, sources, translatorName);
      }

      if (sources.length > 0) {
        return sources;
      }
    } catch (_) {}

    const decoded = this.decodeStreamString(text);

    if (decoded && decoded !== text) {
      this.extractSourceString(decoded, sources, translatorName);
    }

    this.extractSourceString(text, sources, translatorName);

    return sources;
  }

  extractSourceValue(value, sources, translatorName) {
    if (!value) {
      return;
    }

    if (typeof value === "string") {
      this.extractSourceString(value, sources, translatorName);
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        this.extractSourceValue(item, sources, translatorName);
      }
      return;
    }

    if (typeof value === "object") {
      const url = value.url || value.file || value.src || value.link;
      const quality = value.quality || value.label || value.resolution || "auto";

      if (url) {
        this.addSource(sources, url, quality, translatorName);
      }

      for (const key in value) {
        this.extractSourceValue(value[key], sources, translatorName);
      }
    }
  }

  extractSourceString(value, sources, translatorName) {
    if (!value) {
      return;
    }

    value = this.decodeHtml(String(value))
      .replace(/\\\//g, "/")
      .replace(/\\/g, "");

    const decoded = this.decodeStreamString(value);

    if (decoded && decoded !== value) {
      value = decoded;
    }

    let foundQualitySources = false;

    const bracketRegex = /\[([^\]]+)\](https?:\/\/[^\s,\[\]]+)/g;
    let bracketMatch;

    while ((bracketMatch = bracketRegex.exec(value)) !== null) {
      foundQualitySources = true;
      this.addSource(sources, bracketMatch[2], bracketMatch[1], translatorName);
    }

    const fileLabelRegex =
      /\{\s*["']?file["']?\s*:\s*["']([^"']+)["'][\s\S]*?["']?(?:label|quality|resolution)["']?\s*:\s*["']([^"']+)["'][\s\S]*?\}/g;
    let fileLabelMatch;

    while ((fileLabelMatch = fileLabelRegex.exec(value)) !== null) {
      foundQualitySources = true;
      this.addSource(sources, fileLabelMatch[1], fileLabelMatch[2], translatorName);
    }

    if (foundQualitySources) {
      return;
    }

    const htmlVideoRegex = /<video[^>]+src=["']([^"']+)["'][^>]*>/gi;
    let htmlVideoMatch;

    while ((htmlVideoMatch = htmlVideoRegex.exec(value)) !== null) {
      this.addSource(sources, htmlVideoMatch[1], "auto", translatorName);
    }

    const htmlSourceRegex = /<source[^>]+src=["']([^"']+)["'][^>]*>/gi;
    let htmlSourceMatch;

    while ((htmlSourceMatch = htmlSourceRegex.exec(value)) !== null) {
      this.addSource(sources, htmlSourceMatch[1], "auto", translatorName);
    }

    const fileRegex = /file\s*:\s*["']([^"']+)["']/gi;
    let fileMatch;

    while ((fileMatch = fileRegex.exec(value)) !== null) {
      this.addSource(sources, fileMatch[1], "auto", translatorName);
    }

    if (sources.length > 0) {
      return;
    }

    const directRegex = /https?:\/\/[^"'\\\s,\[\]]+(?:\.m3u8|\.mp4)[^"'\\\s,\[\]]*/g;
    let directMatch;

    while ((directMatch = directRegex.exec(value)) !== null) {
      this.addSource(sources, directMatch[0], "auto", translatorName);
    }
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

    const trash = ["@#@!", "//_//", "^^^", "$$"];
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

  addSource(sources, url, quality, translatorName) {
    if (!url) {
      return;
    }

    url = this.decodeHtml(String(url))
      .trim()
      .replace(/\\\//g, "/")
      .replace(/\\/g, "");

    quality = this.cleanText(String(quality || "auto"));

    if (url.indexOf("http") !== 0) {
      return;
    }

    if (quality.indexOf("pjs-prem-quality") !== -1) {
      return;
    }

    if (url.indexOf("pjs-prem-quality") !== -1) {
      return;
    }

    if (!quality || quality === "undefined" || quality === "null") {
      quality = "auto";
    }

    if (translatorName) {
      quality = quality + " " + translatorName;
    }

    let type = "unknown";

    if (url.indexOf(".m3u8") !== -1) {
      type = "m3u8";
    } else if (url.indexOf(".mp4") !== -1) {
      type = "mp4";
    }

    const source = {
      url: url,
      quality: quality,
      type: type,
      subtitles: [],
    };

    this.addPreparedSource(sources, source);
  }

  addPreparedSource(sources, source) {
    if (!source || !source.url) {
      return;
    }

    if (source.quality && source.quality.indexOf("pjs-prem-quality") !== -1) {
      return;
    }

    for (const existing of sources) {
      if (existing.url === source.url && existing.quality === source.quality) {
        return;
      }
    }

    sources.push(source);
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
      animeId: this.extractAnimeId("", url),
      translatorId: this.extractTranslatorIdFromUrl(url) || "0",
      translatorName: "Default",
      season: this.extractSeasonNumber(url) || 1,
      episode: this.extractEpisodeNumber(url) || episode.number || 1,
      translators: [],
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

  extractTranslators(html, pageUrl) {
    const translators = [];
    const seen = {};
    const regex = /<([a-z0-9]+)([^>]*class=["'][^"']*b-translator__item[^"']*["'][^>]*)>([\s\S]*?)<\/\1>/gi;
    let match;

    while ((match = regex.exec(html)) !== null) {
      const attrs = match[2];
      const body = match[3];
      const id = this.getAttr(attrs, "data-translator_id");
      const href = this.getAttr(attrs, "href");
      const title = this.getAttr(attrs, "title");
      const name = this.cleanText(title || body);

      if (!id || seen[id]) {
        continue;
      }

      seen[id] = true;

      translators.push({
        id: id,
        name: name || "Translator " + id,
        url: href ? this.absoluteUrl(href) : pageUrl.split("#")[0] + "#t:" + id,
      });
    }

    if (translators.length === 0) {
      const id = this.extractTranslatorIdFromUrl(pageUrl);

      if (id) {
        translators.push({
          id: id,
          name: "Translator " + id,
          url: pageUrl,
        });
      }
    }

    return translators;
  }

  extractAnimeId(html, url) {
    const dataIdMatch = String(html || "").match(/data-id=["'](\d+)["']/i);

    if (dataIdMatch) {
      return dataIdMatch[1];
    }

    const urlMatch = String(url).match(/\/(\d+)-[^/]+\.html/i);

    if (urlMatch) {
      return urlMatch[1];
    }

    return "";
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
        url: pageUrl.split("#")[0] + "#t:" + translatorId + "-s:" + season + "-e:" + episode,
        animeId: animeId,
        translatorId: translatorId,
        translatorName: translator.id === translatorId ? translator.name : "Translator " + translatorId,
        season: season,
        episode: episode,
        translators: translators,
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

  extractTranslatorIdFromUrl(url) {
    const hashMatch = String(url).match(/#t:(\d+)/);
    if (hashMatch) {
      return hashMatch[1];
    }

    const pathMatch = String(url).match(/\/(\d+)-[^/]+(?:\/\d+-season(?:\/\d+-episode)?\.html|\.html)/i);
    if (pathMatch) {
      return pathMatch[1];
    }

    return "";
  }

  extractSeasonNumber(input) {
    input = String(input || "");

    const match =
      input.match(/\/(\d+)-season/i) ||
      input.match(/#t:\d+-s:(\d+)-e:\d+/i);

    return match ? parseInt(match[1], 10) : 0;
  }

  extractEpisodeNumber(input) {
    input = String(input || "");

    const match =
      input.match(/\/(\d+)-episode/i) ||
      input.match(/#t:\d+-s:\d+-e:(\d+)/i) ||
      input.match(/Серия\s+(\d+)/i) ||
      input.match(/Episode\s+(\d+)/i) ||
      input.match(/Epis[oó]dio\s+(\d+)/i);

    return match ? parseInt(match[1], 10) : 0;
  }

  async fetchText(url, referer) {
    const res = await fetch(url, {
      headers: {
        ...this.headers,
        Referer: referer || this.base + "/",
      },
    });

    if (!res.ok) {
      throw new Error("Request failed: " + res.status);
    }

    return await res.text();
  }

  getAttr(input, name) {
    const regex = new RegExp(name + '=["\\']([^"\\']+)["\\']', "i");
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
