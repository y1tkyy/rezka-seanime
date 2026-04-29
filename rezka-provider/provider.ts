/// <reference path="./online-streaming-provider.d.ts" />
/// <reference path="./core.d.ts" />

class Provider {
  constructor() {
    this.base = "https://rezka.ag";
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
      const movieUrl =
        activeTranslator.url && activeTranslator.url !== url
          ? activeTranslator.url
          : url;

      const payload = {
        url: movieUrl,
        baseUrl: this.basePageUrl(url),
        animeId: animeId,
        translatorId: translatorId,
        translatorName: translatorName,
        translators: translators,
        season: 0,
        episode: 0,
        isMovie: true,
      };

      episodes.push({
        id: JSON.stringify(payload),
        number: 1,
        title: "Movie",
        url: movieUrl,
        _season: 1,
        _episode: 1,
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
        const res = await fetch(data.baseUrl || data.url, {
          headers: {
            ...this.headers,
            Referer: this.base + "/",
          },
        });

        if (res.ok) {
          const html = await res.text();
          translators = this.extractTranslators(html, data.baseUrl || data.url);
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
      const translatorId = translator.id || data.translatorId;

      if (!translatorId || translatorId === "0") {
        continue;
      }

      const episodeUrl = data.isMovie
        ? this.getTranslatorPageUrl(data.baseUrl || data.url, translator)
        : this.makeEpisodeUrl(
            data.baseUrl || translator.url || data.url,
            translatorId,
            data.season,
            data.episode
          );

      const translatorData = {
        url: episodeUrl,
        baseUrl: data.baseUrl || this.basePageUrl(data.url),
        animeId: data.animeId,
        translatorId: translatorId,
        translatorName: translator.name || "Translator " + translatorId,
        season: data.season,
        episode: data.episode,
        isMovie: data.isMovie === true,
      };

      const sources = await this.getStreamSources(translatorData);

      for (const source of sources) {
        const sourceQuality = this.normalizeQuality(source.quality);

        if (!sourceQuality || this.isBadQuality(sourceQuality)) {
          continue;
        }

        const translatorName = translator.name || "Translator " + translatorId;

        videoSources.push({
          url: source.url,
          type: source.type || this.detectVideoType(source.url),
          quality: translatorName + " " + sourceQuality,
          label: translatorName,
          subtitles: source.subtitles || [],
          _translatorIndex: translators.indexOf(translator),
          _qualityRank: this.qualityRank(sourceQuality),
        });
      }
    }

    const cleaned = this.dedupeVideoSourcesPreserveQuality(videoSources);

    if (cleaned.length === 0) {
      throw new Error("No video sources found");
    }

    return {
      server: server || "HLS",
      headers: {
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        Origin: "https://rezka.ag",
        Referer: "https://rezka.ag/",
        "User-Agent": this.headers["User-Agent"],
      },
      videoSources: cleaned,
    };
  }

  async getStreamSources(data) {
    if (data.isMovie) {
      const directSources = await this.getMoviePageSources(data);

      if (directSources.length > 0) {
        return directSources;
      }
    }

    const inlineSources = await this.getInlineSeriesPageSources(data);

    if (inlineSources.length > 0) {
      return inlineSources;
    }

    const url = this.base + "/ajax/get_cdn_series/?t=" + Date.now();

    const body =
      "id=" +
      encodeURIComponent(data.animeId) +
      "&translator_id=" +
      encodeURIComponent(data.translatorId) +
      "&season=" +
      encodeURIComponent(String(data.season)) +
      "&episode=" +
      encodeURIComponent(String(data.episode)) +
      "&action=get_stream";

    try {
      console.log("Rezka AJAX body", body);

      const res = await fetch(url, {
        method: "POST",
        headers: {
          ...this.headers,
          Origin: this.base,
          Referer: data.baseUrl || data.url || this.base + "/",
        },
        body: body,
      });

      const text = await res.text();
      console.log("Rezka AJAX response start", text.slice(0, 500));

      if (res.ok) {
        const sources = this.extractSources(text);

        if (sources.length > 0) {
          return sources;
        }
      }
    } catch (e) {
      console.error("Rezka AJAX failed", e);
    }

    return [];
  }

  async getInlineSeriesPageSources(data) {
    try {
      const res = await fetch(data.baseUrl || data.url, {
        headers: {
          ...this.headers,
          Referer: this.base + "/",
        },
      });

      if (!res.ok) {
        return [];
      }

      const html = await res.text();
      const inits = this.extractAllInitCDNSeriesData(html);

      console.log("Inline init count", inits.length);
      console.log(
        "Requested stream data",
        JSON.stringify({
          animeId: data.animeId,
          translatorId: data.translatorId,
          season: data.season,
          episode: data.episode,
        })
      );

      for (const init of inits) {
        console.log(
          "Inline init item",
          JSON.stringify({
            animeId: init.animeId,
            translatorId: init.translatorId,
            season: init.season,
            episode: init.episode,
            streamsLen: init.streams.length,
          })
        );

        if (
          this.toNumber(init.animeId) === this.toNumber(data.animeId) &&
          this.toNumber(init.translatorId) === this.toNumber(data.translatorId) &&
          this.toNumber(init.season) === this.toNumber(data.season) &&
          this.toNumber(init.episode) === this.toNumber(data.episode)
        ) {
          return this.extractRezkaStreamSources(init.streams);
        }
      }

      return [];
    } catch (e) {
      console.error("Inline series extraction failed", e);
      return [];
    }
  }

  extractAllInitCDNSeriesData(html) {
    html = String(html || "");

    const results = [];
    const marker = "initCDNSeriesEvents(";
    let start = 0;

    while (true) {
      const index = html.indexOf(marker, start);

      if (index === -1) {
        break;
      }

      const rawArgs = this.readFunctionArgs(html, index + marker.length);

      if (!rawArgs) {
        start = index + marker.length;
        continue;
      }

      const args = this.splitTopLevelArgs(rawArgs);

      if (args.length >= 9) {
        const objectText = args[8];
        const streams = this.extractJsonStringValue(objectText, "streams");
        const defaultQuality = this.extractJsonStringValue(objectText, "default_quality");

        if (streams) {
          results.push({
            animeId: String(args[0]).trim(),
            translatorId: String(args[1]).trim(),
            season: String(args[2]).trim(),
            episode: String(args[3]).trim(),
            streams: streams,
            defaultQuality: defaultQuality || "",
          });
        }
      }

      start = index + marker.length + rawArgs.length;
    }

    return results;
  }

  readFunctionArgs(input, startIndex) {
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
        if (ch === quote) {
          quote = "";
        }
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

  extractInitCDNSeriesData(html) {
    const all = this.extractAllInitCDNSeriesData(html);

    return all.length > 0 ? all[0] : null;
  }

  splitTopLevelArgs(input) {
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

  extractJsonStringValue(objectText, key) {
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
      return this.decodeRezkaEscapedString(raw);
    }
  }

  decodeRezkaEscapedString(value) {
    return String(value || "")
      .replace(/\\\//g, "/")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }

  extractRezkaStreamSources(streams) {
    streams = this.decodeRezkaEscapedString(streams);
    streams = this.removePremiumParts(streams);

    const sources = [];
    const seenQuality = {};

    const blocks = streams.split(/,(?=\[(?:2160p|1440p|1080p|720p|480p|360p|240p|auto)\])/i);

    for (const block of blocks) {
      const match = block.match(/\[([^\]]+)\]([\s\S]+)/);

      if (!match) {
        continue;
      }

      const quality = this.normalizeQuality(match[1]);

      if (!quality || seenQuality[quality]) {
        continue;
      }

      const urls = [];
      const urlRegex = /https?:\/\/[^\s,\[\]]+/g;
      let urlMatch;

      while ((urlMatch = urlRegex.exec(match[2])) !== null) {
        let url = this.decodeRezkaEscapedString(urlMatch[0]).trim();

        url = url.replace(/[)"']+$/g, "");

        if (!url || this.isPremiumUrl(url)) {
          continue;
        }

        if (url.indexOf(":hls:manifest.m3u8") === -1 && url.indexOf(".m3u8") === -1) {
          continue;
        }

        urls.push(url);
      }

      if (urls.length === 0) {
        continue;
      }

      urls.sort((a, b) => {
        const aRezka = /ukrtelcdn/i.test(a) ? 1 : 0;
        const bRezka = /ukrtelcdn/i.test(b) ? 1 : 0;

        if (aRezka !== bRezka) {
          return bRezka - aRezka;
        }

        return a.localeCompare(b);
      });

      seenQuality[quality] = true;
      this.addSource(sources, urls[0], quality);
    }

    console.log(
      "Extracted Rezka sources",
      JSON.stringify(
        sources.map((s) => ({
          quality: s.quality,
          url: s.url.slice(0, 80),
        }))
      )
    );

    return this.dedupeSources(sources);
  }

  async getMoviePageSources(data) {
    try {
      const res = await fetch(data.url, {
        headers: {
          ...this.headers,
          Referer: data.baseUrl || this.base + "/",
        },
      });

      if (res.ok) {
        const html = await res.text();
        const sources = [];
        const directVideoRegex = /<video[^>]+src=["']([^"']+(?:\.m3u8|\.mp4)[^"']*)["'][^>]*>/gi;
        let directVideoMatch;

        while ((directVideoMatch = directVideoRegex.exec(html)) !== null) {
          this.addSource(
            sources,
            directVideoMatch[1],
            this.extractPlayerQuality(html) || "auto"
          );
        }

        this.extractSourceString(html, sources);

        const cleaned = this.dedupeSources(sources);

        if (cleaned.length > 0) {
          return cleaned;
        }
      }
    } catch (_) {}

    return await this.getMoviePageSourcesWithBrowser(data);
  }

  async getMoviePageSourcesWithBrowser(data) {
    let browser = null;

    try {
      browser = await ChromeDP.newBrowser();

      await browser.navigate(data.url);

      $sleep(2500);

      const result = await browser.evaluate(`(() => {
        const clean = (s) => String(s || "").replace(/\\s+/g, " ").trim();

        const videos = Array.from(document.querySelectorAll("video"))
          .map(v => v.currentSrc || v.src || v.getAttribute("src") || "")
          .filter(Boolean);

        const sources = Array.from(document.querySelectorAll("source"))
          .map(s => s.src || s.getAttribute("src") || "")
          .filter(Boolean);

        const iframes = Array.from(document.querySelectorAll("iframe"))
          .map(i => i.src || i.getAttribute("src") || "")
          .filter(Boolean);

        const qualityText = clean(
          Array.from(document.querySelectorAll("#cdnplayer_settings, [fid='1'], pjsdiv"))
            .map(el => el.textContent)
            .join(" ")
        );

        const qualityMatch = qualityText.match(/Качество\\s*(2160p|1440p|1080p|720p|480p|360p|240p|auto)/i);

        return JSON.stringify({
          videos,
          sources,
          iframes,
          quality: qualityMatch ? qualityMatch[1] : "auto",
          html: document.documentElement.outerHTML
        });
      })()`);

      await browser.close();
      browser = null;

      const parsed = JSON.parse(result || "{}");
      const sources = [];
      const quality = parsed.quality || "auto";
      const urls = []
        .concat(parsed.videos || [])
        .concat(parsed.sources || []);

      for (const url of urls) {
        this.addSource(sources, url, quality);
      }

      if (parsed.html) {
        const html = String(parsed.html);
        const videoRegex = /<video[^>]+src=["']([^"']+(?:\.m3u8|\.mp4)[^"']*)["'][^>]*>/gi;
        let videoMatch;

        while ((videoMatch = videoRegex.exec(html)) !== null) {
          this.addSource(sources, videoMatch[1], quality);
        }

        this.extractSourceString(html, sources);
      }

      return this.dedupeSources(sources);
    } catch (e) {
      try {
        if (browser) {
          await browser.close();
        }
      } catch (_) {}

      console.error("Movie ChromeDP extraction failed", e);
      return [];
    }
  }

  extractPlayerQuality(html) {
    const text = this.cleanText(html);
    const match = text.match(/Качество\s*(2160p|1440p|1080p|720p|480p|360p|240p|auto)/i);

    if (match) {
      return match[1];
    }

    return "";
  }

  getTranslatorPageUrl(baseUrl, translator) {
    if (translator && translator.url) {
      return translator.url;
    }

    const clean = this.basePageUrl(baseUrl);

    if (translator && translator.id && translator.id !== "0") {
      return clean.replace(/\.html$/i, "/" + translator.id + "-translator.html");
    }

    return clean;
  }

  extractSources(text) {
    const sources = [];

    try {
      const json = JSON.parse(text);

      if (json.url) {
        const rezkaSources = this.extractRezkaStreamSources(json.url);

        if (rezkaSources.length > 0) {
          return rezkaSources;
        }

        this.extractSourceString(json.url, sources);
      }

      if (json.file) this.extractSourceString(json.file, sources);
      if (json.stream) this.extractSourceString(json.stream, sources);
      if (json.sources) this.extractSourceValue(json.sources, sources);

      return this.dedupeSources(sources);
    } catch (_) {}

    const rezkaSources = this.extractRezkaStreamSources(text);

    if (rezkaSources.length > 0) {
      return rezkaSources;
    }

    const decoded = this.decodeStreamString(text);

    if (decoded && decoded !== text) {
      const decodedRezkaSources = this.extractRezkaStreamSources(decoded);

      if (decodedRezkaSources.length > 0) {
        return decodedRezkaSources;
      }

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

    sources.push({
      url: url,
      quality: quality,
      type: this.detectVideoType(url),
      subtitles: [],
    });
  }

  dedupeVideoSourcesPreserveQuality(sources) {
    const result = [];
    const seen = {};

    for (const source of sources) {
      if (!source || !source.url || !source.quality) {
        continue;
      }

      if (this.isPremiumUrl(source.url)) {
        continue;
      }

      const quality = this.cleanText(source.quality).trim();
      const label = this.cleanText(source.label || "").trim();

      if (
        !quality ||
        quality === "." ||
        quality === "-" ||
        !/(2160p|1440p|1080p|720p|480p|360p|240p|auto)/i.test(quality)
      ) {
        continue;
      }

      const key = quality + "|" + source.url;

      if (seen[key]) {
        continue;
      }

      seen[key] = true;

      result.push({
        url: source.url,
        type: source.type || this.detectVideoType(source.url),
        quality: quality,
        label: label || undefined,
        subtitles: source.subtitles || [],
        _translatorIndex:
          typeof source._translatorIndex === "number"
            ? source._translatorIndex
            : 9999,
        _qualityRank:
          typeof source._qualityRank === "number"
            ? source._qualityRank
            : this.qualityRank(quality),
      });
    }

    result.sort((a, b) => {
      if (a._translatorIndex !== b._translatorIndex) {
        return a._translatorIndex - b._translatorIndex;
      }

      if (a._qualityRank !== b._qualityRank) {
        return b._qualityRank - a._qualityRank;
      }

      return String(a.quality).localeCompare(String(b.quality));
    });

    if (result.length === 0) {
      return [];
    }

    const defaultSource = result[0];
    const rest = result.slice(1).reverse();

    return [defaultSource].concat(rest).map((source) => ({
      url: source.url,
      type: source.type,
      quality: source.quality,
      label: source.label,
      subtitles: source.subtitles || [],
    }));
  }

  qualityRank(value) {
    const match = String(value || "").match(/(2160p|1440p|1080p|720p|480p|360p|240p)/i);

    if (!match) {
      return 0;
    }

    return parseInt(match[1], 10);
  }

  detectVideoType(url) {
    url = String(url || "");

    if (url.indexOf(".m3u8") !== -1 || url.indexOf(":hls:manifest") !== -1) {
      return "m3u8";
    }

    if (url.indexOf(".mp4") !== -1) {
      return "mp4";
    }

    return "unknown";
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
        parsed.isMovie = parsed.isMovie === true;
        parsed.season = this.toNumber(parsed.season);
        parsed.episode = this.toNumber(parsed.episode);
        parsed.baseUrl = parsed.baseUrl || this.basePageUrl(parsed.url);
        parsed.translators = parsed.translators || [];

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
      isMovie: false,
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
    html = String(html || "");
    url = String(url || "");

    const urlMatch = url.match(/\/(\d+)-[^/]+\.html/i);

    if (urlMatch) {
      return urlMatch[1];
    }

    const episodeDataIdMatch = html.match(
      /class=["'][^"']*b-simple_episode__item[^"']*["'][^>]*data-id=["'](\d+)["']/i
    );

    if (episodeDataIdMatch) {
      return episodeDataIdMatch[1];
    }

    const seriesInitMatch = html.match(/initCDNSeriesEvents\s*\(\s*(\d+)\s*,/i);

    if (seriesInitMatch) {
      return seriesInitMatch[1];
    }

    const movieInitMatch = html.match(/initCDNMoviesEvents\s*\(\s*(\d+)\s*,/i);

    if (movieInitMatch) {
      return movieInitMatch[1];
    }

    const dataIdMatch = html.match(/data-id=["'](\d+)["']/i);

    if (dataIdMatch) {
      return dataIdMatch[1];
    }

    return "";
  }

  extractTranslators(html, url) {
    const translators = [];
    const seen = {};
    html = String(html || "");

    const regex =
      /<[^>]+class=["'][^"']*b-translator__item[^"']*["'][^>]*>[\s\S]*?<\/[^>]+>/gi;

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
      const name =
        this.cleanText(this.getAttr(tag, "title") || tag) ||
        "Translator " + id;

      translators.push({
        id: id,
        name: name,
        url: href ? this.absoluteUrl(href) : this.makeEpisodeUrl(url, id, 1, 1),
      });
    }

    if (translators.length > 0) {
      return translators;
    }

    const seriesInitMatch = html.match(
      /initCDNSeriesEvents\s*\(\s*\d+\s*,\s*(\d+)\s*,/i
    );

    if (seriesInitMatch) {
      return [
        {
          id: seriesInitMatch[1],
          name: "Default",
          url: this.makeEpisodeUrl(url, seriesInitMatch[1], 1, 1),
        },
      ];
    }

    const movieInitMatch = html.match(
      /initCDNMoviesEvents\s*\(\s*\d+\s*,\s*(\d+)\s*,/i
    );

    if (movieInitMatch) {
      return [
        {
          id: movieInitMatch[1],
          name: "Default",
          url: url,
        },
      ];
    }

    const id = this.extractTranslatorIdFromUrl(url);

    if (id) {
      return [
        {
          id: id,
          name: "Default",
          url: url,
        },
      ];
    }

    return [];
  }

  extractActiveTranslator(html, url, translators) {
    html = String(html || "");

    const activeMatch = html.match(
      /<[^>]+class=["'][^"']*b-translator__item[^"']*active[^"']*["'][^>]*>[\s\S]*?<\/[^>]+>/i
    );

    if (activeMatch) {
      const tag = activeMatch[0];

      const id =
        this.getAttr(tag, "data-translator_id") ||
        this.extractTranslatorIdFromUrl(tag) ||
        this.extractTranslatorIdFromUrl(url);

      const name =
        this.cleanText(this.getAttr(tag, "title") || tag) ||
        "Translator " + id;

      return {
        id: id,
        name: name,
        url: this.getAttr(tag, "href")
          ? this.absoluteUrl(this.getAttr(tag, "href"))
          : url,
      };
    }

    const seriesInitMatch = html.match(
      /initCDNSeriesEvents\s*\(\s*\d+\s*,\s*(\d+)\s*,/i
    );

    if (seriesInitMatch) {
      const id = seriesInitMatch[1];

      return {
        id: id,
        name: "Default",
        url: this.makeEpisodeUrl(url, id, 1, 1),
      };
    }

    const movieInitMatch = html.match(
      /initCDNMoviesEvents\s*\(\s*\d+\s*,\s*(\d+)\s*,/i
    );

    if (movieInitMatch) {
      const id = movieInitMatch[1];

      return {
        id: id,
        name: "Default",
        url: url,
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
      id: "",
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
    url = String(url || "");

    const hashMatch = url.match(/#t:(\d+)/);

    if (hashMatch) {
      return hashMatch[1];
    }

    const translatorPathMatch = url.match(/\/\d+-[^/]+\/(\d+)-[^/]+\.html/i);

    if (translatorPathMatch) {
      return translatorPathMatch[1];
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
      .replace("https://rezka-ua.co", "https://rezka.ag")
      .replace("http://rezka-ua.co", "https://rezka.ag")
      .replace("http://rezka.ag", "https://rezka.ag");
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
