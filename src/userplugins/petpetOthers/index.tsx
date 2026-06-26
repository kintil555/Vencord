/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import { makeLazy } from "@utils/lazy";
import definePlugin, { OptionType } from "@utils/types";
import { CloudUpload as TCloudUpload } from "@vencord/discord-types";
import { CloudUploadPlatform } from "@vencord/discord-types/enums";
import { findLazy } from "@webpack";
import { ChannelStore, Constants, FluxDispatcher, GuildStore, RestAPI, SnowflakeUtils, UserStore, UserUtils } from "@webpack/common";
import { GIFEncoder, nearestColorIndex, quantize } from "gifenc";

const CloudUpload: typeof TCloudUpload = findLazy(m => m.prototype?.trackUploadFinished);

// ─── Constants ────────────────────────────────────────────────────────────────

const logger = new Logger("PetpetOthers", "#ff9ff3");

const TRIGGER_PREFIX = "!petpet";
const DEFAULT_DELAY = 20;
const DEFAULT_RESOLUTION = 128;
const FRAMES = 10;

/** Regex untuk Discord snowflake ID (17-19 digit) */
const SNOWFLAKE_REGEX = /^\d{17,19}$/;

// ─── Petpet GIF Engine ────────────────────────────────────────────────────────

const getFrames = makeLazy(() =>
    Promise.all(
        Array.from(
            { length: FRAMES },
            (_, i) =>
                loadImage(
                    `https://raw.githubusercontent.com/VenPlugs/petpet/main/frames/pet${i}.gif`
                )
        )
    )
);

function loadImage(source: File | string): Promise<HTMLImageElement> {
    const isFile = source instanceof File;
    const url = isFile ? URL.createObjectURL(source) : source;

    return new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            if (isFile) URL.revokeObjectURL(url);
            resolve(img);
        };
        img.onerror = () =>
            reject(new Error(`Gagal load image dari ${url}`));
        img.crossOrigin = "Anonymous";
        img.src = url;
    });
}

function rgb888_to_rgb565(r: number, g: number, b: number): number {
    return ((r << 8) & 0xf800) | ((g << 3) & 0x07e0) | (b >> 3);
}

function applyPaletteTransparent(
    data: Uint8Array | Uint8ClampedArray,
    palette: number[][],
    cache: number[],
    threshold: number
): Uint8Array {
    const index = new Uint8Array(Math.floor(data.length / 4));

    for (let i = 0; i < index.length; i++) {
        const r = data[4 * i];
        const g = data[4 * i + 1];
        const b = data[4 * i + 2];
        const a = data[4 * i + 3];

        if (a < threshold) {
            index[i] = 255;
        } else {
            const key = rgb888_to_rgb565(r, g, b);
            index[i] =
                key in cache
                    ? cache[key]
                    : (cache[key] = nearestColorIndex(palette, [r, g, b]));
        }
    }
    return index;
}

async function generatePetpetGif(avatarUrl: string): Promise<File> {
    const frames = await getFrames();
    const avatar = await loadImage(avatarUrl);

    const delay = DEFAULT_DELAY;
    const resolution = DEFAULT_RESOLUTION;

    const gif = GIFEncoder();
    const paletteImageSize = Math.min(120, resolution);

    const canvas = document.createElement("canvas");
    canvas.width = resolution;
    canvas.height = Math.max(resolution, 2 * paletteImageSize);

    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

    ctx.drawImage(avatar, 0, paletteImageSize, 0.8 * paletteImageSize, 0.8 * paletteImageSize);
    ctx.drawImage(frames[0], 0, 0, paletteImageSize, paletteImageSize);
    const { data: paletteData } = ctx.getImageData(0, 0, paletteImageSize, 2 * paletteImageSize);
    const palette = quantize(paletteData, 255);

    const cache = new Array(2 ** 16);

    for (let i = 0; i < FRAMES; i++) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const j = i < FRAMES / 2 ? i : FRAMES - i;
        const width = 0.8 + j * 0.02;
        const height = 0.8 - j * 0.05;
        const offsetX = (1 - width) * 0.5 + 0.1;
        const offsetY = 1 - height - 0.08;

        ctx.drawImage(
            avatar,
            offsetX * resolution,
            offsetY * resolution,
            width * resolution,
            height * resolution
        );
        ctx.drawImage(frames[i], 0, 0, resolution, resolution);

        const { data } = ctx.getImageData(0, 0, resolution, resolution);
        const indexedData = applyPaletteTransparent(data, palette, cache, 1);

        gif.writeFrame(indexedData, resolution, resolution, {
            transparent: true,
            transparentIndex: 255,
            delay,
            palette: i === 0 ? palette : undefined,
        });
    }

    gif.finish();
    return new File([gif.bytesView()], "petpet.gif", { type: "image/gif" });
}

// ─── Avatar URL Builder ───────────────────────────────────────────────────────

/**
 * Bangun avatar URL langsung dari Discord CDN.
 * Digunakan sebagai fallback jika user.getAvatarURL() tidak bisa dipanggil,
 * atau sebagai cara mendapatkan avatar user luar server tanpa guild-specific hash.
 *
 * Format: https://cdn.discordapp.com/avatars/{user_id}/{avatar_hash}.png?size=2048
 * Untuk animated (hash diawali 'a_'): pakai .gif
 */
function buildCdnAvatarUrl(userId: string, avatarHash: string | null | undefined, canAnimate = true): string {
    if (!avatarHash) {
        // Default avatar: nomor discriminator % 5, atau modulo ID untuk new username system
        const defaultIndex = (BigInt(userId) >> 22n) % 6n;
        return `https://cdn.discordapp.com/embed/avatars/${defaultIndex}.png`;
    }

    const isAnimated = avatarHash.startsWith("a_");
    const ext = isAnimated && canAnimate ? "gif" : "png";
    return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.${ext}?size=2048`;
}

/**
 * Dapatkan avatar URL terbaik untuk user:
 * - Untuk user di guild yang sama: coba guild avatar dulu (server-specific pfp)
 * - Untuk user luar server / guild tidak diketahui: pakai global avatar dari CDN
 * - Fallback: default avatar Discord
 */
function getAvatarUrlForUser(user: any, guildId?: string | null): string {
    // Kalau user punya method getAvatarURL (User object dari discord),
    // pakai itu dengan guildId = undefined agar dapat global avatar (bukan guild-specific)
    if (typeof user.getAvatarURL === "function") {
        return user.getAvatarURL(guildId ?? undefined, 2048, true)
            .replace(/\?size=\d+$/, "?size=2048");
    }

    // Fallback: bangun URL manual dari CDN
    return buildCdnAvatarUrl(user.id, user.avatar, true);
}

// ─── Settings ─────────────────────────────────────────────────────────────────

const settings = definePluginSettings({
    targetGuildId: {
        type: OptionType.STRING,
        description:
            "ID Server (Guild) tempat hasil petpet GIF akan dikirim. " +
            "Kosongkan untuk kirim ke channel yang sama.",
        default: "",
        placeholder: "123456789012345678",
    },
    targetChannelId: {
        type: OptionType.STRING,
        description:
            "ID Channel tempat hasil petpet GIF akan dikirim. " +
            "Wajib diisi jika kamu mengisi Target Guild ID di atas.",
        default: "",
        placeholder: "123456789012345678",
    },
    triggerWord: {
        type: OptionType.STRING,
        description: "Kata trigger (default: !petpet). Format: !petpet @mention / !petpet ID / !petpet username",
        default: "!petpet",
    },
    cooldownSeconds: {
        type: OptionType.NUMBER,
        description: "Cooldown antar petpet (detik) untuk mencegah spam.",
        default: 30,
    },
    useGuildAvatar: {
        type: OptionType.BOOLEAN,
        description:
            "Gunakan avatar server (guild-specific) jika tersedia. " +
            "Nonaktifkan untuk selalu pakai avatar global dari CDN.",
        default: true,
    },
});

// ─── State ────────────────────────────────────────────────────────────────────

const cooldownMap = new Map<string, number>();
const processingSet = new Set<string>();

// ─── Helper Functions ─────────────────────────────────────────────────────────

function resolveTargetChannel(sourceChannelId: string): string | null {
    const configuredChannelId = settings.store.targetChannelId?.trim();
    const configuredGuildId = settings.store.targetGuildId?.trim();

    if (!configuredChannelId) return sourceChannelId;

    const channel = ChannelStore.getChannel(configuredChannelId);
    if (!channel) {
        logger.warn(`Channel tujuan ${configuredChannelId} tidak ditemukan!`);
        return sourceChannelId;
    }

    if (configuredGuildId) {
        const guild = GuildStore.getGuild(configuredGuildId);
        if (!guild) {
            logger.warn(`Guild ${configuredGuildId} tidak ditemukan!`);
        } else {
            logger.info(`Target: #${channel.name} di server "${guild.name}"`);
        }
    }

    return configuredChannelId;
}

/**
 * Parse trigger dari pesan. Mendukung berbagai format:
 *
 *   !petpet @mention            → mention user (harus di server ini)
 *   !petpet <@123456789>        → mention dengan ID Discord
 *   !petpet 123456789012345678  → ID user langsung (BISA dari luar server!)
 *   !petpet username            → username (cari di cache lokal)
 *   !petpet username#1234       → username + discriminator lama
 *
 * Mengembalikan { userId, isDirectId } atau null jika bukan trigger.
 * isDirectId = true artinya user mungkin tidak di server ini → pakai CDN avatar global.
 */
function parseTrigger(content: string, message: any): { userId: string; isOutsideServer: boolean; } | null {
    const trigger = (settings.store.triggerWord || TRIGGER_PREFIX).trim().toLowerCase();
    const trimmed = content.trim();
    const lower = trimmed.toLowerCase();

    if (!lower.startsWith(trigger)) return null;

    // Ambil bagian setelah trigger word
    const rest = trimmed.slice(trigger.length).trim();

    if (!rest) {
        // Tidak ada argumen — coba ambil dari reply
        const refAuthorId = message.referenced_message?.author?.id;
        if (refAuthorId) return { userId: refAuthorId, isOutsideServer: false };
        return null;
    }

    // 1. Mention format: <@123456789> atau <@!123456789>
    const mentionMatch = rest.match(/^<@!?(\d+)>$/);
    if (mentionMatch) {
        return { userId: mentionMatch[1], isOutsideServer: false };
    }

    // 2. ID langsung: 17-19 digit angka saja
    if (SNOWFLAKE_REGEX.test(rest)) {
        return { userId: rest, isOutsideServer: true };
    }

    // 3. username#discriminator (sistem lama)
    const tagMatch = rest.match(/^(.+)#(\d{4})$/);
    if (tagMatch) {
        const [, uname, disc] = tagMatch;
        const found = UserStore.findByTag(uname.trim(), disc);
        if (found) {
            logger.info(`Ditemukan user via tag: ${found.username}#${disc} (${found.id})`);
            return { userId: found.id, isOutsideServer: false };
        }
        logger.warn(`User ${uname}#${disc} tidak ditemukan di cache lokal.`);
        return null;
    }

    // 4. username saja (sistem baru — unique username tanpa #)
    // Coba cari di UserStore lokal (hanya user yang pernah dilihat di Discord session ini)
    const found = UserStore.findByTag(rest, null);
    if (found) {
        logger.info(`Ditemukan user via username: ${found.username} (${found.id})`);
        return { userId: found.id, isOutsideServer: false };
    }

    // 5. Kalau tidak ketemu di cache, beri petunjuk ke user
    logger.warn(
        `"${rest}" tidak dikenali. ` +
        `Gunakan format: !petpet @mention, !petpet <ID>, atau !petpet username. ` +
        `Untuk user luar server, salin ID mereka (klik kanan → Copy User ID).`
    );
    return null;
}

// ─── Auto Send ────────────────────────────────────────────────────────────────

function autoSendPetpet(file: File, channelId: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const upload = new CloudUpload({
            file,
            isThumbnail: false,
            platform: CloudUploadPlatform.WEB,
        }, channelId);

        upload.on("complete", () => {
            RestAPI.post({
                url: Constants.Endpoints.MESSAGES(channelId),
                body: {
                    channel_id: channelId,
                    content: "",
                    nonce: SnowflakeUtils.fromTimestamp(Date.now()),
                    sticker_ids: [],
                    type: 0,
                    attachments: [{
                        id: "0",
                        filename: upload.filename,
                        uploaded_filename: upload.uploadedFilename,
                    }],
                },
            }).then(() => resolve()).catch(reject);
        });

        upload.on("error", () => {
            logger.error("Gagal upload petpet GIF!");
            reject(new Error("Upload failed"));
        });

        upload.upload();
    });
}

// ─── Event Handler ────────────────────────────────────────────────────────────

async function handleMessage({ message }: { message: any; }) {
    if (!message?.content || typeof message.content !== "string") return;

    const parsed = parseTrigger(message.content, message);
    if (!parsed) return;

    const { userId, isOutsideServer } = parsed;

    // Cek cooldown
    const cooldownMs = (settings.store.cooldownSeconds ?? 30) * 1000;
    const lastTime = cooldownMap.get(userId) ?? 0;
    if (Date.now() - lastTime < cooldownMs) {
        logger.info(`Cooldown aktif untuk user ${userId}, skip.`);
        return;
    }

    // Cegah double processing
    const processKey = `${message.channel_id}:${userId}`;
    if (processingSet.has(processKey)) return;
    processingSet.add(processKey);

    try {
        logger.info(`Generating petpet untuk user ${userId}${isOutsideServer ? " (luar server)" : ""}...`);

        // Fetch user object — UserUtils.getUser bisa fetch user bahkan dari luar server
        // karena dia hit Discord API: GET /users/:id
        let user: any;
        try {
            user = await UserUtils.getUser(userId);
        } catch (err) {
            logger.error("Gagal fetch user:", err);
            return;
        }

        if (!user) {
            logger.error(`User ${userId} tidak ditemukan!`);
            return;
        }

        // Bangun avatar URL:
        // - Untuk user di server yang sama + setting useGuildAvatar aktif → pakai guild avatar
        // - Untuk user luar server → lewati guildId (undefined) → dapat global CDN avatar
        let avatarUrl: string;

        if (isOutsideServer || !settings.store.useGuildAvatar) {
            // Paksa global avatar — user mungkin tidak punya guild avatar di sini
            avatarUrl = getAvatarUrlForUser(user, undefined);
            logger.info(`Memakai global CDN avatar untuk ${user.username}: ${avatarUrl}`);
        } else {
            // Coba guild avatar dulu, fallback ke global otomatis oleh getAvatarURL
            const guildId = message.guild_id || undefined;
            avatarUrl = getAvatarUrlForUser(user, guildId);
            logger.info(`Memakai avatar (guild=${guildId ?? "none"}) untuk ${user.username}: ${avatarUrl}`);
        }

        // Generate GIF
        const gifFile = await generatePetpetGif(avatarUrl);

        // Tentukan channel tujuan
        const targetChannelId = resolveTargetChannel(message.channel_id);
        if (!targetChannelId) {
            logger.error("Channel tujuan tidak ditemukan!");
            return;
        }

        // Set cooldown sebelum upload
        cooldownMap.set(userId, Date.now());

        // Upload & kirim
        await autoSendPetpet(gifFile, targetChannelId);

        logger.info(
            `Petpet GIF untuk ${user.username} (${userId}) dikirim ke channel ${targetChannelId}!`
        );
    } catch (err) {
        logger.error("Error saat generate petpet:", err);
    } finally {
        processingSet.delete(processKey);
    }
}

// ─── Plugin Definition ────────────────────────────────────────────────────────

export default definePlugin({
    name: "petpetOthers",
    description:
        "Plugin fun: ketik \"!petpet @mention\", \"!petpet ID\", atau \"!petpet username\" untuk " +
        "generate petpet GIF dari avatar mereka. Mendukung user luar server via ID atau username!",
    tags: ["Fun", "Social"],
    authors: [{ name: "kintil555", id: 0n }],

    settings,

    start() {
        logger.info("PetpetOthers dimulai! 🐾");
        FluxDispatcher.subscribe("MESSAGE_CREATE", handleMessage);
    },

    stop() {
        logger.info("PetpetOthers dihentikan.");
        FluxDispatcher.unsubscribe("MESSAGE_CREATE", handleMessage);
        cooldownMap.clear();
        processingSet.clear();
    },
});
