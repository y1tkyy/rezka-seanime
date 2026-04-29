/// <reference path="./online-streaming-provider.d.ts" />
/// <reference path="./core.d.ts" />

class Provider {
  base = "https://rezka-ua.co";

  headers = {
    Accept: "text/html, */*; q=0.01",
    "Accept-Language": "en-US,en;q=0.9,uk;q=0.8,ru;q=0.7",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    Origin: "https://rezka-ua.co",
    Referer: "https://rezka-ua.co/",
    "X-Requested-With": "XMLHttpRequest",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  };

  getSettings(): Settings {
    return {
      episodeServers: ["default"],
      supportsDub: true,
    };
  }

  async search(query: SearchOptions): Promise<SearchResult[]> {
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

    const cleanQueries: string[] = [];

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

  async searchRezka(q: string, year: number): Promise<SearchResult[]> {
    const res = await fetch(this.base + "/engine/ajax/search.php", {
      method: "POST",
      headers: this.headers,
      body: "q=" + encodeURIComponent(q),
    });

    if (!res.ok) {
      return [];
    }

    const html = await res.text();
    const results: SearchResult[] = [];
    const regex = /<li>\s*<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/li>/g;
    let match: RegExpExecArray | null;

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

  async findEpisodes(id: string): Promise<EpisodeDetails[]> {
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
    const episodes: EpisodeDetails[] = [];
    const seen: { [key: string]: boolean } = {};

    const liRegex = /<li\b([^>]*class=["'][^"']*b-simple_episode__item[^"']*["'][^>]*)>([\s\S]*?)<\/li>/gi;
    let liMatch: RegExpExecArray | null;

    while ((liMatch = liRegex.exec(html)) !== null) {
      const attrs = liMatch[1];
      const text = this.cleanText(liMatch[2]);
      const episodeNumber =
        this.toNumber(this.getAttr(attrs, "data-episode_id")) ||
        this.extractEpisodeNumber(text);

      if (!episodeNumber) {
        continue;
      }

      const seasonNumber =
        this.toNumber(this.getAttr(attrs, "data-season_id")) ||
        this.extractSeasonNumber(url) ||
        this.extractSeasonNumberFromHash(url) ||
        1;

      const key = seasonNumber + ":" + episodeNumber;

      if (seen[key]) {
        continue;
      }

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
    }

    const aRegex = /<a\b([^>]*class=["'][^"']*b-simple_episode__item[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi;
    let aMatch: RegExpExecArray | null;

    while ((aMatch = aRegex.exec(html)) !== null) {
      const attrs = aMatch[1];
      const text = this.cleanText(aMatch[2]);
      const episodeNumber =
        this.toNumber(this.getAttr(attrs, "data-episode_id")) ||
        this.extractEpisodeNumber(text) ||
        this.extractEpisodeNumber(this.getAttr(attrs, "href"));

      if (!episodeNumber) {
        continue;
      }

      const seasonNumber =
        this.toNumber(this.getAttr(attrs, "data-season_id")) ||
        this.extractSeasonNumber(this.getAttr(attrs, "href")) ||
        this.extractSeasonNumber(url) ||
        this.extractSeasonNumberFromHash(url) ||
        1;

      const key = seasonNumber + ":" + episodeNumber;

      if (seen[key]) {
        continue;
      }

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

  async findEpisodeServer(episode: EpisodeDetails, server: string): Promise<EpisodeServer> {
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

    const videoSources: VideoSource[] = [];

    for (const translator of translators) {
      if (!translator.id || translator.id === "0") {
        continue;
      }

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

  async getStreamSources(data: any): Promise<VideoSource[]> {
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

    return [];
  }

  extractSources(text: string): VideoSource[] {
    const sources: VideoSource[] = [];

    try {
      const json = JSON.parse(text);

      if (json.url) this.extractSourceString(json.url, sources);
      if (json.file) this.extractSourceString(json.file, sources);
      if (json.stream) this.extractSourceString(json.stream, sources);
      if (json.sources) this.extractSourceValue(json.sources, sources);

      if (sources.length > 0) {
        return this.dedupeSources(sources);
      }
    } catch (_) {}

    const decoded = this.decodeStreamString(text);

    if (decoded && decoded !== text) {
      this.extractSourceString(decoded, sources);
    }

    this.extractSourceString(text, sources);

    return this.dedupeSources(sources);
  }

  extractSourceValue(value: any, sources: VideoSource[]) {
    if (!value) return;

    if (typeof value === "string") {
      this.extractSourceString(value, sources);
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) this.extractSourceValue(item, sources);
      return;
    }

    if (typeof value === "object") {
      const url = value.url || value.file || value.src || value.link;
      const quality = value.quality || value.label || value.resolution || "auto";

      if (url) this.addSource(sources, url, quality);

      for (const key in value) this.extractSourceValue(value[key], sources);
    }
  }

  extractSourceString(value: string, sources: VideoSource[]) {
    if (!value) return;

    value = this.decodeHtml(String(value))
      .replace(/\\\//g, "/")
      .replace(/\\/g, "");

    const decoded = this.decodeStreamString(value);

    if (decoded && decoded !== value) {
      value = decoded;
    }

    const bracketRegex = /\[([^\]]+)\](https?:\/\/[^\s,\[\]]+)/g;
    let bracketMatch: RegExpExecArray | null;

    while ((bracketMatch = bracketRegex.exec(value)) !== null) {
      this.addSource(sources, bracketMatch[2], bracketMatch[1]);
    }

    const directRegex = /https?:\/\/[^"'\\\s,\[\]]+(?:\.m3u8|\.mp4)[^"'\\\s,\[\]]*/g;
    let directMatch: RegExpExecArray | null;

    while ((directMatch = directRegex.exec(value)) !== null) {
      this.addSource(sources, directMatch[0], "auto");
    }

    const fileRegex = /file\s*:\s*["']([^"']+)["']/gi;
    let fileMatch: RegExpExecArray | null;

    while ((fileMatch = fileRegex.exec(value)) !== null) {
      this.addSource(sources, fileMatch[1], "auto");
    }
  }

  decodeStreamString(value: string): string {
    if (!value) return "";

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

    const trash = ["@#@!", "//_//", "^^^", "$$", "#h", "#2", "#3", "#4", "@", "!", "^"];
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

  addSource(sources: VideoSource[], url: string, quality: string) {
    if (!url) return;

    url = this.decodeHtml(String(url))
      .trim()
      .replace(/\\\//g, "/")
      .replace(/\\/g, "");

    if (url.indexOf("http") !== 0) return;

    let type: VideoSourceType = "unknown";

    if (url.indexOf(".m3u8") !== -1) {
      type = "m3u8";
    } else if (url.indexOf(".mp4") !== -1) {
      type = "mp4";
    }

    const cleanQuality = this.cleanQuality(quality);

    if (sources.some((source) => source.url === url && source.quality === cleanQuality)) {
      return;
    }

    sources.push({
      url: url,
      quality: cleanQuality,
      type: type,
      subtitles: [],
    });
  }

  cleanQuality(quality: string): string {
    quality = String(quality || "auto").trim();

    const match = quality.match(/(\d{3,4}p)/i);
    if (match) return match[1];

    if (/auto/i.test(quality)) return "auto";

    return quality;
  }

  dedupeSources(sources: VideoSource[]): VideoSource[] {
    const result: VideoSource[] = [];
    const seen: { [key: string]: boolean } = {};

    for (const source of sources) {
      const key = source.label + "|" + source.quality + "|" + source.url;

      if (seen[key]) continue;

      seen[key] = true;
      result.push(source);
    }

    return result;
  }

  parseEpisodeId(episode: EpisodeDetails): any {
    try {
      const parsed = JSON.parse(episode.id);
      if (parsed && parsed.url) return parsed;
    } catch (_) {}

    const url = this.normalizeUrl(episode.url || episode.id);

    return {
      url: url,
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

  resolveUrl(id: string): string {
    if (!id) throw new Error("Empty id");

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

  extractAnimeId(html: string, url: string): string {
    const dataIdMatch = String(html || "").match(/data-id=["'](\d+)["']/i);

    if (dataIdMatch) return dataIdMatch[1];

    const urlMatch = String(url).match(/\/(\d+)-[^/]+\.html/i);

    if (urlMatch) return urlMatch[1];

    return "";
  }

  extractTranslators(html: string, url: string): any[] {
    const translators: any[] = [];
    const seen: { [key: string]: boolean } = {};
    const regex = /<[^>]+class=["'][^"']*b-translator__item[^"']*["'][^>]*>[\s\S]*?<\/[^>]+>/gi;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(html)) !== null) {
      const tag = match[0];
      const id = this.getAttr(tag, "data-translator_id") || this.extractTranslatorIdFromUrl(tag);

      if (!id || seen[id]) continue;

      seen[id] = true;

      const href = this.getAttr(tag, "href");
      const name = this.cleanText(this.getAttr(tag, "title") || tag) || "Translator " + id;

      translators.push({
        id: id,
        name: name,
        url: href ? this.absoluteUrl(href) : this.makeHashEpisodeUrl(url, id, 1, 1),
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

  extractTranslator(html: string, url: string): any {
    const activeMatch =
      String(html || "").match(/<[^>]+class=["'][^"']*b-translator__item[^"']*active[^"']*["'][^>]*>[\s\S]*?<\/[^>]+>/i) ||
      String(html || "").match(/<[^>]+class=["'][^"']*b-translator__item[^"']*["'][^>]*>[\s\S]*?<\/[^>]+>/i);

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

  makeHashEpisodeUrl(url: string, translatorId: string, season: number, episode: number): string {
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

  extractTranslatorIdFromUrl(url: string): string {
    const hashMatch = String(url).match(/#t:(\d+)/);
    if (hashMatch) return hashMatch[1];

    const pathMatch = String(url).match(/\/(\d+)-[^/]+(?:\/\d+-season(?:\/\d+-episode)?\.html|\.html)/i);
    if (pathMatch) return pathMatch[1];

    return "";
  }

  extractSeasonNumber(input: string): number {
    input = String(input || "");

    const match =
      input.match(/\/(\d+)-season/i) ||
      input.match(/#t:\d+-s:(\d+)-e:\d+/i);

    return match ? parseInt(match[1], 10) : 0;
  }

  extractEpisodeNumber(input: string): number {
    input = String(input || "");

    const match =
      input.match(/\/(\d+)-episode/i) ||
      input.match(/#t:\d+-s:\d+-e:(\d+)/i) ||
      input.match(/Серия\s+(\d+)/i) ||
      input.match(/Episode\s+(\d+)/i) ||
      input.match(/Epis[oó]dio\s+(\d+)/i);

    return match ? parseInt(match[1], 10) : 0;
  }

  extractSeasonNumberFromHash(input: string): number {
    const match = String(input || "").match(/#t:\d+-s:(\d+)-e:\d+/i);
    return match ? parseInt(match[1], 10) : 0;
  }

  extractEpisodeNumberFromHash(input: string): number {
    const match = String(input || "").match(/#t:\d+-s:\d+-e:(\d+)/i);
    return match ? parseInt(match[1], 10) : 0;
  }

  getAttr(input: string, name: string): string {
    const regex = new RegExp(name + "=[\"']([^\"']+)[\"']", "i");
    const match = String(input || "").match(regex);
    return match ? this.decodeHtml(match[1]) : "";
  }

  toNumber(value: string): number {
    if (!value) return 0;

    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  absoluteUrl(url: string): string {
    url = String(url || "");

    if (url.indexOf("http://") === 0 || url.indexOf("https://") === 0) {
      return this.normalizeUrl(url);
    }

    if (url.indexOf("/") === 0) {
      return this.base + url;
    }

    return this.base + "/" + url;
  }

  normalizeUrl(url: string): string {
    return String(url || "")
      .replace("https://rezka.ag", this.base)
      .replace("https://rezka-ua.co", this.base)
      .replace("http://rezka.ag", this.base)
      .replace("http://rezka-ua.co", this.base);
  }

  cleanText(input: string): string {
    return this.decodeHtml(
      String(input || "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    );
  }

  decodeHtml(input: string): string {
    return String(input || "")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
  }
}
