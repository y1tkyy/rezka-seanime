/// <reference path="./online-streaming-provider.d.ts" />
/// <reference path="./core.d.ts" />

type RezkaEpisodeId = {
  url: string;
  animeId: string;
  translatorId: string;
  translatorName: string;
  season: number;
  episode: number;
};

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

  async search(opts: SearchOptions): Promise<SearchResult[]> {
    const queries = [
      opts.query,
      opts.media?.englishTitle || "",
      opts.media?.romajiTitle || "",
      ...(opts.media?.synonyms || []),
    ]
      .map((v) => String(v || "").trim())
      .filter((v, i, arr) => v.length > 0 && arr.indexOf(v) === i);

    const year = opts.year || opts.media?.startDate?.year || 0;

    for (const query of queries) {
      const results = await this.searchRezka(query, year);
      if (results.length > 0) return results;
    }

    return [];
  }

  async findEpisodes(id: string): Promise<EpisodeDetails[]> {
    const pageUrl = this.resolveToRezkaUrl(id);

    const res = await fetch(pageUrl, {
      headers: {
        ...this.headers,
        Referer: `${this.base}/`,
      },
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch anime page: ${res.status}`);
    }

    const html = await res.text();
    const $ = LoadDoc(html);

    const episodes: EpisodeDetails[] = [];
    const animeId =
      this.extractAnimeIdFromEpisodeList($) ||
      this.extractAnimeIdFromUrl(pageUrl);

    if (!animeId) {
      throw new Error(`Could not detect Rezka anime id from ${pageUrl}`);
    }

    const translator = this.getActiveTranslator($, pageUrl);

    $(".b-simple_episode__item").each((_, el) => {
      const episodeIdRaw = el.attr("data-episode_id");
      const seasonIdRaw = el.attr("data-season_id");
      const hrefRaw = el.attr("href") || "";
      const textRaw = el.text() || "";

      const episodeNumber =
        this.toNumber(episodeIdRaw) ||
        this.extractEpisodeNumber(textRaw) ||
        this.extractEpisodeNumber(hrefRaw);

      if (!episodeNumber) return;

      const seasonNumber =
        this.toNumber(seasonIdRaw) ||
        this.extractSeasonNumber(hrefRaw) ||
        this.extractSeasonNumber(pageUrl) ||
        1;

      const url = hrefRaw ? this.absoluteUrl(hrefRaw) : pageUrl;

      const payload: RezkaEpisodeId = {
        url,
        animeId,
        translatorId: translator.id,
        translatorName: translator.name,
        season: seasonNumber,
        episode: episodeNumber,
      };

      episodes.push({
        id: JSON.stringify(payload),
        number: episodeNumber,
        title: `${translator.name} - Episode ${episodeNumber}`,
        url,
      });
    });

    if (episodes.length === 0) {
      episodes.push(
        ...this.extractHashEpisodes(html, pageUrl, animeId, translator),
      );
    }

    if (episodes.length === 0) {
      const season = this.extractSeasonNumber(pageUrl) || 1;
      const episode = this.extractEpisodeNumber(pageUrl) || 1;

      const payload: RezkaEpisodeId = {
        url: pageUrl,
        animeId,
        translatorId: translator.id,
        translatorName: translator.name,
        season,
        episode,
      };

      episodes.push({
        id: JSON.stringify(payload),
        number: episode,
        title: `${translator.name} - Episode ${episode}`,
        url: pageUrl,
      });
    }

    episodes.sort((a, b) => a.number - b.number);

    return episodes;
  }

  async findEpisodeServer(
    episode: EpisodeDetails,
    server: string,
  ): Promise<EpisodeServer> {
    const data = this.parseEpisodeId(episode.id, episode.url);

    const pageRes = await fetch(data.url, {
      headers: {
        ...this.headers,
        Referer: `${this.base}/`,
      },
    });

    if (!pageRes.ok) {
      throw new Error(`Failed to fetch episode page: ${pageRes.status}`);
    }

    const html = await pageRes.text();

    const htmlSources = this.extractVideoSourcesFromHtml(html);

    if (htmlSources.length > 0) {
      return {
        server: server === "default" ? "default" : server,
        headers: {
          Referer: `${this.base}/`,
          Origin: this.base,
          "User-Agent": this.headers["User-Agent"],
        },
        videoSources: htmlSources,
      };
    }

    const ajaxSources = await this.fetchAjaxSources(data);

    if (ajaxSources.length > 0) {
      return {
        server: server === "default" ? "default" : server,
        headers: {
          Referer: `${this.base}/`,
          Origin: this.base,
          "User-Agent": this.headers["User-Agent"],
        },
        videoSources: ajaxSources,
      };
    }

    throw new Error("No video sources found");
  }

  resolveToRezkaUrl(id: string): string {
    if (!id) {
      throw new Error("Empty findEpisodes id");
    }

    try {
      const parsed = JSON.parse(id);

      if (parsed && typeof parsed === "object" && parsed.url) {
        return this.normalizeRezkaUrl(parsed.url);
      }

      if (
        typeof parsed === "string" &&
        (parsed.startsWith("http://") || parsed.startsWith("https://"))
      ) {
        return this.normalizeRezkaUrl(parsed);
      }
    } catch (_) {}

    if (id.startsWith("http://") || id.startsWith("https://")) {
      return this.normalizeRezkaUrl(id);
    }

    throw new Error(
      `findEpisodes received invalid id "${id}". Expected Rezka URL from SearchResult.id.`,
    );
  }

  async searchRezka(query: string, year?: number): Promise<SearchResult[]> {
    const res = await fetch(`${this.base}/engine/ajax/search.php`, {
      method: "POST",
      headers: this.headers,
      body: `q=${encodeURIComponent(query)}`,
    });

    if (!res.ok) return [];

    const html = await res.text();
    const results: SearchResult[] = [];

    const itemRegex =
      /<li>\s*<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/li>/g;
    let match: RegExpExecArray | null;

    while ((match = itemRegex.exec(html)) !== null) {
      const url = this.normalizeRezkaUrl(this.decodeHtml(match[1]));
      const innerHtml = match[2];

      const titleMatch = innerHtml.match(
        /<span class="enty">([\s\S]*?)<\/span>/i,
      );
      if (!titleMatch) continue;

      const rawTitle = this.cleanText(titleMatch[1]);

      const details = this.cleanText(
        innerHtml
          .replace(/<span class="enty">[\s\S]*?<\/span>/i, "")
          .replace(/<span class="rating">[\s\S]*?<\/span>/i, ""),
      );

      const isAnimeLike = /аниме/i.test(details) || /\/animation\//i.test(url);
      if (!isAnimeLike) continue;

      const title = details ? `${rawTitle} ${details}` : rawTitle;

      if (year && !title.includes(String(year))) continue;

      results.push({
        id: url,
        title,
        url,
        subOrDub: "both",
      });
    }

    return results;
  }

  async fetchAjaxSources(data: RezkaEpisodeId): Promise<VideoSource[]> {
    const requests = [
      {
        url: `${this.base}/ajax/get_cdn_series/?t=${Date.now()}`,
        body: `id=${encodeURIComponent(data.animeId)}&translator_id=${encodeURIComponent(data.translatorId)}&season=${encodeURIComponent(String(data.season))}&episode=${encodeURIComponent(String(data.episode))}&action=get_stream`,
      },
      {
        url: `${this.base}/engine/ajax/get_cdn_series/?t=${Date.now()}`,
        body: `id=${encodeURIComponent(data.animeId)}&translator_id=${encodeURIComponent(data.translatorId)}&season=${encodeURIComponent(String(data.season))}&episode=${encodeURIComponent(String(data.episode))}&action=get_stream`,
      },
      {
        url: `${this.base}/ajax/get_cdn_series/?t=${Date.now()}`,
        body: `id=${encodeURIComponent(data.animeId)}&translator_id=${encodeURIComponent(data.translatorId)}&season=${encodeURIComponent(String(data.season))}&episode=${encodeURIComponent(String(data.episode))}`,
      },
      {
        url: `${this.base}/engine/ajax/get_cdn_series/?t=${Date.now()}`,
        body: `id=${encodeURIComponent(data.animeId)}&translator_id=${encodeURIComponent(data.translatorId)}&season=${encodeURIComponent(String(data.season))}&episode=${encodeURIComponent(String(data.episode))}`,
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
        const sources = this.extractVideoSourcesFromText(text);

        if (sources.length > 0) return sources;
      } catch (_) {}
    }

    return [];
  }

  extractVideoSourcesFromHtml(html: string): VideoSource[] {
    const sources: VideoSource[] = [];

    const videoRegex = /<video[^>]+src=["']([^"']+)["'][^>]*>/gi;
    let videoMatch: RegExpExecArray | null;

    while ((videoMatch = videoRegex.exec(html)) !== null) {
      this.pushVideoSource(sources, this.decodeHtml(videoMatch[1]), "auto");
    }

    const sourceRegex = /<source[^>]+src=["']([^"']+)["'][^>]*>/gi;
    let sourceMatch: RegExpExecArray | null;

    while ((sourceMatch = sourceRegex.exec(html)) !== null) {
      this.pushVideoSource(sources, this.decodeHtml(sourceMatch[1]), "auto");
    }

    const fileRegexes = [
      /file\s*:\s*["']([^"']+)["']/gi,
      /src\s*:\s*["']([^"']+\.m3u8[^"']*)["']/gi,
      /["'](https?:\/\/[^"']+?\.m3u8[^"']*)["']/gi,
      /["'](https?:\/\/[^"']+?\.mp4[^"']*)["']/gi,
    ];

    for (const regex of fileRegexes) {
      let match: RegExpExecArray | null;

      while ((match = regex.exec(html)) !== null) {
        this.pushVideoSource(sources, this.decodeHtml(match[1]), "auto");
      }
    }

    return sources;
  }

  extractVideoSourcesFromText(text: string): VideoSource[] {
    const sources: VideoSource[] = [];

    try {
      const data = JSON.parse(text);

      const candidates = [
        data?.url,
        data?.file,
        data?.src,
        data?.stream,
        data?.video,
        data?.link,
        data?.sources,
        data?.source,
      ];

      for (const candidate of candidates) {
        this.extractSourcesFromAny(candidate, sources);
      }

      if (sources.length > 0) return sources;
    } catch (_) {}

    const decoded = this.decodeRezkaEncodedStreams(text);

    if (decoded) {
      const nested = this.extractVideoSourcesFromText(decoded);

      nested.forEach((source) => {
        this.pushVideoSource(sources, source.url, source.quality);
      });
    }

    const regexes = [
      /https?:\/\/[^"'\\\s]+?\.m3u8[^"'\\\s]*/gi,
      /https?:\/\/[^"'\\\s]+?\.mp4[^"'\\\s]*/gi,
      /file\s*:\s*["']([^"']+)["']/gi,
      /url\s*:\s*["']([^"']+)["']/gi,
    ];

    for (const regex of regexes) {
      let match: RegExpExecArray | null;

      while ((match = regex.exec(text)) !== null) {
        this.pushVideoSource(
          sources,
          this.decodeHtml(match[1] || match[0]),
          "auto",
        );
      }
    }

    return sources;
  }

  extractSourcesFromAny(value: any, sources: VideoSource[]) {
    if (!value) return;

    if (typeof value === "string") {
      const nested = this.extractVideoSourcesFromText(value);

      if (nested.length > 0) {
        nested.forEach((source) =>
          this.pushVideoSource(sources, source.url, source.quality),
        );
      } else {
        this.pushVideoSource(sources, value, "auto");
      }

      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        this.extractSourcesFromAny(item, sources);
      }

      return;
    }

    if (typeof value === "object") {
      const url = value.url || value.file || value.src || value.link;
      const quality =
        value.quality || value.label || value.resolution || "auto";

      if (url) {
        this.pushVideoSource(sources, url, String(quality));
      }

      for (const key in value) {
        this.extractSourcesFromAny(value[key], sources);
      }
    }
  }

  pushVideoSource(sources: VideoSource[], url: string, quality: string) {
    if (!url) return;

    url = String(url).trim().replace(/\\\//g, "/");

    if (!/^https?:\/\//i.test(url)) return;

    if (sources.some((source) => source.url === url)) return;

    const type: VideoSourceType = url.includes(".m3u8")
      ? "m3u8"
      : url.includes(".mp4")
        ? "mp4"
        : "unknown";

    sources.push({
      url,
      type,
      quality: quality || "auto",
      subtitles: [],
    });
  }

  decodeRezkaEncodedStreams(text: string): string {
    const matches = [
      text.match(/streams["']?\s*:\s*["']([^"']+)["']/i),
      text.match(/videos["']?\s*:\s*["']([^"']+)["']/i),
      text.match(/url["']?\s*:\s*["']([^"']+)["']/i),
    ];

    for (const match of matches) {
      if (!match || !match[1]) continue;

      let value = match[1].replace(/\\\//g, "/").replace(/\\/g, "");
      value = this.decodeHtml(value);

      const trash = ["@#@!", "//_//", "^^^", "$$"];

      for (const item of trash) {
        value = value.split(item).join("");
      }

      if (value.includes("http")) return value;

      try {
        const decoded = CryptoJS.enc.Utf8.stringify(
          CryptoJS.enc.Base64.parse(value),
        );
        if (decoded && decoded.includes("http")) return decoded;
      } catch (_) {}
    }

    return "";
  }

  parseEpisodeId(id: string, fallbackUrl: string): RezkaEpisodeId {
    try {
      const parsed = JSON.parse(id) as RezkaEpisodeId;
      if (parsed?.url) return parsed;
    } catch (_) {}

    const url = this.normalizeRezkaUrl(fallbackUrl || id);

    return {
      url,
      animeId: this.extractAnimeIdFromUrl(url),
      translatorId: this.extractTranslatorIdFromUrl(url) || "0",
      translatorName: "Default",
      season: this.extractSeasonNumber(url) || 1,
      episode: this.extractEpisodeNumber(url) || 1,
    };
  }

  getActiveTranslator(
    $: any,
    pageUrl: string,
  ): { id: string; name: string; url: string } {
    let active = {
      id: "",
      name: "Default",
      url: pageUrl,
    };

    const activeEl = $("#translators-list .b-translator__item.active").first();

    if (activeEl && activeEl.length > 0) {
      active = {
        id: activeEl.attr("data-translator_id") || "",
        name: this.cleanText(
          activeEl.attr("title") || activeEl.text() || "Default",
        ),
        url: this.absoluteUrl(activeEl.attr("href") || pageUrl),
      };
    }

    if (!active.id) {
      const firstEl = $("#translators-list .b-translator__item").first();

      if (firstEl && firstEl.length > 0) {
        active = {
          id: firstEl.attr("data-translator_id") || "",
          name: this.cleanText(
            firstEl.attr("title") || firstEl.text() || "Default",
          ),
          url: this.absoluteUrl(firstEl.attr("href") || pageUrl),
        };
      }
    }

    if (!active.id) {
      active.id = this.extractTranslatorIdFromUrl(pageUrl) || "0";
    }

    return active;
  }

  extractHashEpisodes(
    html: string,
    pageUrl: string,
    animeId: string,
    translator: { id: string; name: string; url: string },
  ): EpisodeDetails[] {
    const episodes: EpisodeDetails[] = [];
    const seen: { [key: string]: boolean } = {};

    const regex = /#t:(\d+)-s:(\d+)-e:(\d+)/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(html)) !== null) {
      const translatorId = match[1];
      const season = parseInt(match[2], 10);
      const episode = parseInt(match[3], 10);

      const key = `${translatorId}:${season}:${episode}`;

      if (seen[key]) continue;

      seen[key] = true;

      const payload: RezkaEpisodeId = {
        url: `${pageUrl.split("#")[0]}#t:${translatorId}-s:${season}-e:${episode}`,
        animeId,
        translatorId,
        translatorName:
          translator.id === translatorId
            ? translator.name
            : `Translator ${translatorId}`,
        season,
        episode,
      };

      episodes.push({
        id: JSON.stringify(payload),
        number: episode,
        title: `${payload.translatorName} - Episode ${episode}`,
        url: payload.url,
      });
    }

    return episodes;
  }

  extractAnimeIdFromEpisodeList($: any): string {
    let id = "";

    $(".b-simple_episode__item").each((_, el) => {
      if (id) return;

      const dataId = el.attr("data-id");

      if (dataId) {
        id = dataId;
      }
    });

    return id;
  }

  extractAnimeIdFromUrl(url: string): string {
    const match = url.match(/\/(\d+)-[^/]+\.html/i);
    return match?.[1] || "";
  }

  extractTranslatorIdFromUrl(url: string): string {
    const hashTranslator = url.match(/#t:(\d+)/);
    const pathTranslator = url.match(
      /\/(\d+)-[^/]+(?:\/\d+-season(?:\/\d+-episode)?\.html|\.html)/i,
    );

    return hashTranslator?.[1] || pathTranslator?.[1] || "";
  }

  extractSeasonNumber(input: string): number {
    const match =
      input.match(/\/(\d+)-season/i) || input.match(/#t:\d+-s:(\d+)-e:\d+/i);
    return match ? parseInt(match[1], 10) : 0;
  }

  extractEpisodeNumber(input: string): number {
    const match =
      input.match(/\/(\d+)-episode/i) ||
      input.match(/#t:\d+-s:\d+-e:(\d+)/i) ||
      input.match(/Серия\s+(\d+)/i) ||
      input.match(/Episode\s+(\d+)/i) ||
      input.match(/Episod[eе]\s+(\d+)/i);

    return match ? parseInt(match[1], 10) : 0;
  }

  toNumber(value?: string): number {
    if (!value) return 0;

    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  normalizeRezkaUrl(url: string): string {
    if (!url) return url;

    try {
      const parsed = JSON.parse(url);

      if (parsed && typeof parsed === "object" && parsed.url) {
        return String(parsed.url)
          .replace("https://rezka.ag", this.base)
          .replace("https://rezka-ua.co", this.base)
          .replace("http://rezka.ag", this.base)
          .replace("http://rezka-ua.co", this.base);
      }
    } catch (_) {}

    return String(url)
      .replace("https://rezka.ag", this.base)
      .replace("https://rezka-ua.co", this.base)
      .replace("http://rezka.ag", this.base)
      .replace("http://rezka-ua.co", this.base);
  }

  absoluteUrl(url: string): string {
    if (!url) return "";

    if (url.startsWith("http://") || url.startsWith("https://")) {
      return this.normalizeRezkaUrl(url);
    }

    if (url.startsWith("/")) {
      return `${this.base}${url}`;
    }

    return `${this.base}/${url}`;
  }

  cleanText(input: string): string {
    return this.decodeHtml(
      String(input || "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
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
