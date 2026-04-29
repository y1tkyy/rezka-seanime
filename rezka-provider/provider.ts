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
    const activeTranslator = translators.length > 0 ? translators[0] : this.extractTranslator(html, url);
    const episodes = [];
    const seen = {};

    const addEpisode = (episodeUrl, attrs, text) => {
      episodeUrl = this.absoluteUrl(episodeUrl || url);

      const episodeNumber =
        this.toNumber(this.getAttr(attrs, "data-episode_id")) ||
        this.extractEpisodeNumber(text) ||
        this.extractEpisodeNumber(episodeUrl);

      if (!episodeNumber) {
        return;
      }

      const seasonNumber =
        this.toNumber(this.getAttr(attrs, "data-season_id")) ||
        this.extractSeasonNumber(episodeUrl) ||
        this.extractSeasonNumber(url) ||
        1;

      const key = seasonNumber + ":" + episodeNumber;

      if (seen[key]) {
        return;
      }

      seen[key] = true;

      const payload = {
        url: episodeUrl,
        animeId: this.getAttr(attrs, "data-id") || animeId,
        translatorId: activeTranslator.id,
        translatorName: activeTranslator.name,
        translators: translators,
        season: seasonNumber,
        episode: episodeNumber,
      };

      episodes.push({
        id: JSON.stringify(payload),
        number: episodeNumber,
        title: "Season " + seasonNumber + " - Episode " + episodeNumber,
        url: episodeUrl,
      });
    };

    const classRegex = /<a\b([^>]*class=["'][^"']*b-simple_episode__item[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi;
    let classMatch;

    while ((classMatch = classRegex.exec(html)) !== null) {
      addEpisode(this.getAttr(classMatch[1], "href"), classMatch[1], this.cleanText(classMatch[2]));
    }

    const hrefRegex = /<a\b([^>]*href=["']([^"']*(?:\d+-season\/\d+-episode\.html|#t:\d+-s:\d+-e:\d+)[^"']*)["'][^>]*)>([\s\S]*?)<\/a>/gi;
    let hrefMatch;

    while ((hrefMatch = hrefRegex.exec(html)) !== null) {
      addEpisode(hrefMatch[2], hrefMatch[1], this.cleanText(hrefMatch[3]));
    }

    const dataRegex = /<[^>]+data-season_id=["'](\d+)["'][^>]+data-episode_id=["'](\d+)["'][^>]*>/gi;
    let dataMatch;

    while ((dataMatch = dataRegex.exec(html)) !== null) {
      const attrs = dataMatch[0];
      const href = this.getAttr(attrs, "href");
      addEpisode(href || url, attrs, "Episode " + dataMatch[2]);
    }

    if (episodes.length === 0) {
      const hashEpisodes = this.extractHashEpisodes(html, url, animeId, activeTranslator, translators);
      for (const ep of hashEpisodes) {
        episodes.push(ep);
      }
    }

    if (episodes.length === 0) {
      const seasonNumber = this.extractSeasonNumber(url) || 1;
      const episodeNumber = this.extractEpisodeNumber(url) || 1;

      const payload = {
        url: url,
        animeId: animeId,
        translatorId: activeTranslator.id,
        translatorName: activeTranslator.name,
        translators: translators,
        season: seasonNumber,
        episode: episodeNumber,
      };

      episodes.push({
        id: JSON.stringify(payload),
        number: episodeNumber,
        title: "Season " + seasonNumber + " - Episode " + episodeNumber,
        url: url,
      });
    }

    episodes.sort((a, b) => a.number - b.number);

    return episodes;
  }

  async findEpisodeServer(episode, server) {
    const data = this.parseEpisodeId(episode);
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
      const translatorData = {
        url: this.getEpisodeUrlForTranslator(translator, data),
        animeId: data.animeId,
        translatorId: translator.id,
        translatorName: translator.name,
        season: data.season,
        episode: data.episode,
      };

      const ajaxSources = await this.getStreamSources(translatorData);

      for (const source of ajaxSources) {
        videoSources.push({
          url: source.url,
          type: source.type,
          quality: translator.name + " - " + source.quality,
          label: translator.name,
          subtitles: source.subtitles || [],
        });
      }

      if (ajaxSources.length === 0) {
        try {
          const res = await fetch(translatorData.url, {
            headers: {
              ...this.headers,
              Referer: this.base + "/",
            },
          });

          if (res.ok) {
            const html = await res.text();
            const htmlSources = this.extractSources(html);

            for (const source of htmlSources) {
              videoSources.push({
                url: source.url,
                type: source.type,
                quality: translator.name + " - " + source.quality,
                label: translator.name,
                subtitles: source.subtitles || [],
              });
            }
          }
        } catch (_) {}
      }
    }

    if (videoSources.length > 0) {
      return {
        server: server === "default" ? "default" : server,
        headers: {
          Referer: this.base + "/",
          Origin: this.base,
          "User-Agent": this.headers["User-Agent"],
        },
        videoSources: this.dedupeSources(videoSources),
      };
    }

    throw new Error("No video sources found");
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
      "id=" +
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

      if (json.url) {
        this.extractSourceString(json.url, sources);
      }

      if (json.file) {
        this.extractSourceString(json.file, sources);
      }

      if (json.stream) {
        this.extractSourceString(json.stream, sources);
      }

      if (json.sources) {
        this.extractSourceValue(json.sources, sources);
      }

      if (sources.length > 0) {
        return sources;
      }
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

    const htmlVideoRegex = /<video[^>]+src=["']([^"']+)["'][^>]*>/gi;
    let htmlVideoMatch;

    while ((htmlVideoMatch = htmlVideoRegex.exec(value)) !== null) {
      this.addSource(sources, htmlVideoMatch[1], "auto");
    }

    const htmlSourceRegex = /<source[^>]+src=["']([^"']+)["'][^>]*>/gi;
    let htmlSourceMatch;

    while ((htmlSourceMatch = htmlSourceRegex.exec(value)) !== null) {
      this.addSource(sources, htmlSourceMatch[1], "auto");
    }

    const fileRegex = /file\s*:\s*["']([^"']+)["']/gi;
    let fileMatch;

    while ((fileMatch = fileRegex.exec(value)) !== null) {
      this.addSource(sources, fileMatch[1], "auto");
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
      value = jsonUrlMatch[1]
        .replace(/\\\//g, "/")
        .replace(/\\/g, "");
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
    if (!url) {
      return;
    }

    url = this.decodeHtml(String(url))
      .trim()
      .replace(/\\\//g, "/")
      .replace(/\\/g, "");

    if (url.indexOf("http") !== 0) {
      return;
    }

    if (sources.some((source) => source.url === url)) {
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
      quality: String(quality || "auto"),
      type: type,
      subtitles: [],
    });
  }

  dedupeSources(sources) {
    const result = [];
    const seen = {};

    for (const source of sources) {
      const key = source.label + "|" + source.quality + "|" + source.url;

      if (seen[key]) {
        continue;
      }

      seen[key] = true;
      result.push(source);
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
      animeId: this.extractAnimeId("", url),
      translatorId: this.extractTranslatorIdFromUrl(url) || "0",
      translatorName: "Default",
      translators: [],
      season: this.extractSeasonNumber(url) || 1,
      episode: this.extractEpisodeNumber(url) || episode.number || 1,
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
    const dataIdMatch = html.match(/data-id=["'](\d+)["']/i);

    if (dataIdMatch) {
      return dataIdMatch[1];
    }

    const urlMatch = String(url).match(/\/(\d+)-[^/]+\.html/i);

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
      const id = this.getAttr(tag, "data-translator_id") || this.extractTranslatorIdFromUrl(tag);

      if (!id || seen[id]) {
        continue;
      }

      seen[id] = true;

      const href = this.getAttr(tag, "href");
      const name = this.cleanText(this.getAttr(tag, "title") || tag) || "Translator " + id;

      translators.push({
        id: id,
        name: name,
        url: href ? this.absoluteUrl(href) : url,
      });
    }

    const current = this.extractTranslator(html, url);

    if (current.id && !seen[current.id]) {
      translators.unshift({
        id: current.id,
        name: current.name,
        url: url,
      });
    }

    if (translators.length === 0) {
      translators.push({
        id: this.extractTranslatorIdFromUrl(url) || "0",
        name: "Default",
        url: url,
      });
    }

    return translators;
  }

  extractTranslator(html, url) {
    const activeMatch =
      html.match(/<[^>]+class=["'][^"']*b-translator__item[^"']*active[^"']*["'][^>]*>[\s\S]*?<\/[^>]+>/i) ||
      html.match(/<[^>]+class=["'][^"']*b-translator__item[^"']*["'][^>]*>[\s\S]*?<\/[^>]+>/i);

    if (activeMatch) {
      const tag = activeMatch[0];
      const id = this.getAttr(tag, "data-translator_id") || this.extractTranslatorIdFromUrl(url) || "0";
      const name = this.cleanText(this.getAttr(tag, "title") || tag);

      return {
        id: id,
        name: name || "Default",
      };
    }

    return {
      id: this.extractTranslatorIdFromUrl(url) || "0",
      name: "Default",
    };
  }

  getEpisodeUrlForTranslator(translator, data) {
    let url = translator.url || data.url;

    url = this.normalizeUrl(url);

    if (url.indexOf("#") !== -1) {
      return url.split("#")[0] + "#t:" + translator.id + "-s:" + data.season + "-e:" + data.episode;
    }

    if (url.match(/\/\d+-season\/\d+-episode\.html/i)) {
      return url.replace(/\/\d+-season\/\d+-episode\.html/i, "/" + data.season + "-season/" + data.episode + "-episode.html");
    }

    if (url.match(/\/\d+-season\.html/i)) {
      return url.replace(/\/\d+-season\.html/i, "/" + data.season + "-season/" + data.episode + "-episode.html");
    }

    if (url.match(/\.html/i)) {
      return url.replace(/\.html.*$/i, "/" + data.season + "-season/" + data.episode + "-episode.html");
    }

    return data.url;
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
        translators: translators,
        season: season,
        episode: episode,
      };

      episodes.push({
        id: JSON.stringify(payload),
        number: episode,
        title: "Season " + season + " - Episode " + episode,
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
