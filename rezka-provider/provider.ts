/// <reference path="./core.d.ts" />
/// <reference path="./app.d.ts" />

// ---------------------------------------------------------------------------
// Rezka.ag online-streaming provider for Seanime
//
// Rezka.ag sits behind an Anubis JS proof-of-work challenge (same family as
// Cloudflare's IUAM). A plain fetch() cannot solve it, so every request goes
// through a headless Chrome instance (ChromeDP) which is kept alive for the
// lifetime of this Provider instance and reused for all calls.
//
// The video link decoding ("clearTrash") is the same obfuscation used by
// HDRezka and its mirrors: the CDN response is a base64 blob interleaved with
// junk substrings built out of a fixed 5-character alphabet.
// ---------------------------------------------------------------------------

const ORIGIN = "https://rezka.ag"

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

// Known translator (dub studio) ids, preferred in this order when a title has more than one.
const TRANSLATOR_PRIORITY = [56, 105, 111]

type CdnEpisodesResponse = {
    success: boolean
    seasons?: string
    episodes?: string
}

type CdnStreamResponse = {
    success: boolean
    url?: string
    subtitle?: string
    subtitle_lns?: Record<string, string>
}

type EpisodeIdPayload = {
    postId: number
    translatorId: number
    kind: "movie" | "series"
    season: number
    episode: number
    url: string
}

class Provider {

    browser: ChromeBrowser | null = null

    getSettings(): Settings {
        return {
            episodeServers: ["default"],
            supportsDub: true,
        }
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        const browser = await this.ensureBrowser()

        const titleCandidates = Array.from(new Set([
            opts.query,
            opts.media?.romajiTitle,
            opts.media?.englishTitle,
            ...(opts.media?.synonyms ?? []),
        ].filter((t): t is string => !!t && t.length > 0)))

        const found = new Map<string, SearchResult>()

        for (const title of titleCandidates) {
            const url = `${ORIGIN}/search/?do=search&subaction=search&q=${encodeURIComponent(title)}`
            const html = await this.browserGet(browser, url)
            const $ = LoadDoc(html)

            $(".b-content__inline_item").each((_, el) => {
                const linkEl = el.find(".b-content__inline_item-link a")
                const href = linkEl.attr("href")
                const text = linkEl.text().trim()
                if (href && text && !found.has(href)) {
                    found.set(href, { id: href, title: text, url: href, subOrDub: "both" })
                }
            })

            if (found.size > 0) break
        }

        return Array.from(found.values())
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const browser = await this.ensureBrowser()
        const url = id.startsWith("http") ? id : `${ORIGIN}${id}`
        const html = await this.browserGet(browser, url)
        const $ = LoadDoc(html)

        const postIdRaw = $("#post_id").attr("value")
        if (!postIdRaw) throw new Error("Could not find the post id on the page.")
        const postId = Number(postIdRaw)

        const ogType = $('meta[property="og:type"]').attr("content") ?? ""
        const isSeries = ogType === "video.tv_series"
        const title = $(".b-post__title").text().trim()

        const translatorIds = this.findTranslatorIds($, html)
        if (translatorIds.length === 0) throw new Error("Could not find any translator for this title.")

        if (!isSeries) {
            return [{
                id: JSON.stringify({
                    postId, translatorId: translatorIds[0], kind: "movie", season: 0, episode: 1, url,
                } as EpisodeIdPayload),
                number: 1,
                title,
                url,
            }]
        }

        for (const translatorId of translatorIds) {
            const resp = await this.browserPost<CdnEpisodesResponse>(browser, `${ORIGIN}/ajax/get_cdn_series/`, {
                id: postId, translator_id: translatorId, action: "get_episodes",
            })
            if (!resp.success || !resp.episodes) continue

            const episodeMap = this.parseEpisodeItems(resp.episodes)
            const episodes: EpisodeDetails[] = []

            for (const season of Object.keys(episodeMap)) {
                for (const episode of Object.keys(episodeMap[season])) {
                    episodes.push({
                        id: JSON.stringify({
                            postId, translatorId, kind: "series",
                            season: Number(season), episode: Number(episode), url,
                        } as EpisodeIdPayload),
                        number: Number(episode),
                        title: episodeMap[season][episode] || `Episode ${episode}`,
                        url,
                    })
                }
            }

            if (episodes.length > 0) {
                episodes.sort((a, b) => a.number - b.number)
                return episodes
            }
        }

        throw new Error("No episodes found for this title.")
    }

    async findEpisodeServer(episode: EpisodeDetails, _server: string): Promise<EpisodeServer> {
        const browser = await this.ensureBrowser()
        const meta = JSON.parse(episode.id) as EpisodeIdPayload

        const payload = meta.kind === "series"
            ? { id: meta.postId, translator_id: meta.translatorId, season: meta.season, episode: meta.episode, action: "get_stream" }
            : { id: meta.postId, translator_id: meta.translatorId, action: "get_movie" }

        const resp = await this.browserPost<CdnStreamResponse>(browser, `${ORIGIN}/ajax/get_cdn_series/`, payload)
        if (!resp.success || !resp.url) throw new Error("Failed to fetch the stream URL.")

        const subtitles = this.parseSubtitles(resp.subtitle, resp.subtitle_lns)
        const videoSources = this.parseVideoSources(resp.url, subtitles)

        return {
            server: "default",
            headers: { Referer: `${ORIGIN}/`, "User-Agent": UA },
            videoSources,
        }
    }

    // -- browser plumbing -----------------------------------------------------

    private async ensureBrowser(): Promise<ChromeBrowser> {
        if (this.browser) return this.browser

        const browser = await ChromeDP.newBrowser({ headless: true, timeout: 30, userAgent: UA })
        await browser.navigate(`${ORIGIN}/`)

        // Rezka.ag runs an Anubis JS proof-of-work challenge on first visit.
        // A real Chromium tab solves it automatically; just give it a moment.
        for (let i = 0; i < 6; i++) {
            const title = await browser.evaluate("document.title") as string
            if (!title.includes("бот") && title !== "Verify" && title !== "Проверяем, что вы не бот!") break
            await browser.sleep(1500)
        }

        this.browser = browser
        return browser
    }

    private async browserGet(browser: ChromeBrowser, url: string): Promise<string> {
        await browser.navigate(url)
        return await browser.outerHTML("html")
    }

    private async browserPost<T>(browser: ChromeBrowser, url: string, data: Record<string, string | number>): Promise<T> {
        const body = Object.entries(data)
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
            .join("&")

        const js = `
            (async () => {
                const res = await fetch(${JSON.stringify(url)}, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded",
                        "X-Requested-With": "XMLHttpRequest",
                    },
                    body: ${JSON.stringify(body)},
                    credentials: "same-origin",
                })
                return await res.text()
            })()
        `
        const text = await browser.evaluate(js) as string
        return JSON.parse(text) as T
    }

    // -- parsing helpers -------------------------------------------------------

    private findTranslatorIds($: DocSelectionFunction, html: string): number[] {
        const ids: number[] = []
        const list = $("#translators-list")
        if (list.length() > 0) {
            list.children().each((_, child) => {
                const raw = child.attr("data-translator_id")
                if (raw) ids.push(Number(raw))
            })
        }

        if (ids.length === 0) {
            const m = html.match(/sof\.tv\.initCDN(?:Series|Movies)Events\(\s*\d+\s*,\s*(\d+)/)
            if (m) ids.push(Number(m[1]))
        }

        return ids.sort((a, b) => {
            const pa = TRANSLATOR_PRIORITY.indexOf(a)
            const pb = TRANSLATOR_PRIORITY.indexOf(b)
            const ra = pa === -1 ? TRANSLATOR_PRIORITY.length : pa
            const rb = pb === -1 ? TRANSLATOR_PRIORITY.length : pb
            return ra - rb
        })
    }

    private parseEpisodeItems(html: string): Record<string, Record<string, string>> {
        const $ = LoadDoc(html)
        const map: Record<string, Record<string, string>> = {}

        $(".b-simple_episode__item").each((_, el) => {
            const season = el.attr("data-season_id")
            const episode = el.attr("data-episode_id")
            if (!season || !episode) return
            if (!map[season]) map[season] = {}
            map[season][episode] = el.text().trim()
        })

        return map
    }

    private parseVideoSources(encoded: string, subtitles: VideoSubtitle[]): VideoSource[] {
        const decoded = clearTrash(encoded)
        const sources: VideoSource[] = []

        for (const chunk of decoded.split(",")) {
            const m = chunk.match(/\[(.*?)\](.*)/)
            if (!m) continue
            const quality = m[1].replace(/<[^>]*>/g, "").trim()
            const links = m[2].split(" or ").map(s => s.trim()).filter(s => s.endsWith(".mp4"))
            for (const url of links) {
                sources.push({ url, type: "mp4", quality, subtitles })
            }
        }

        return sources
    }

    private parseSubtitles(raw?: string, codes?: Record<string, string>): VideoSubtitle[] {
        if (!raw) return []
        const subtitles: VideoSubtitle[] = []

        for (const chunk of raw.split(",")) {
            const m = chunk.match(/\[(.*?)\](.*)/)
            if (!m) continue
            const language = m[1]
            const url = m[2]
            const id = (codes && codes[language]) || language
            subtitles.push({ id, url, language, isDefault: false })
        }

        return subtitles
    }
}

// ---------------------------------------------------------------------------
// clearTrash: ports HDRezka's stream-url deobfuscation.
// The blob is base64 text with "//_//" separators and base64-encoded junk
// substrings (built from combinations of "@#!^$") spliced in; strip the junk
// and separators, then base64-decode what's left.
// ---------------------------------------------------------------------------

function clearTrash(data: string): string {
    const trashChars = ["@", "#", "!", "^", "$"]
    const trashCodes: string[] = []

    for (const len of [2, 3]) {
        for (const combo of cartesianProduct(trashChars, len)) {
            trashCodes.push(base64Encode(combo.join("")))
        }
    }

    let trashString = data.split("#h").join("").split("//_//").join("")
    for (const code of trashCodes) {
        trashString = trashString.split(code).join("")
    }

    try {
        return base64Decode(trashString + "==")
    } catch {
        return trashString
    }
}

function cartesianProduct(list: string[], repeat: number): string[][] {
    let result: string[][] = [[]]
    for (let i = 0; i < repeat; i++) {
        const next: string[][] = []
        for (const prefix of result) {
            for (const item of list) {
                next.push([...prefix, item])
            }
        }
        result = next
    }
    return result
}

function base64Encode(input: string): string {
    return CryptoJS.enc.Base64.stringify($toBytes(input))
}

function base64Decode(input: string): string {
    return $toString(CryptoJS.enc.Base64.parse(input))
}
