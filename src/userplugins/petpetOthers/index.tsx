/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import { makeLazy } from "@utils/lazy";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelStore, FluxDispatcher, GuildStore, UploadHandler, UserUtils } from "@webpack/common";
import { GIFEncoder, nearestColorIndex, quantize } from "gifenc";

// ─── Constants ────────────────────────────────────────────────────────────────

const logger = new Logger("PetpetOthers", "#ff9ff3");

const TRIGGER_PREFIX = "!petpet";
const DEFAULT_DELAY = 20;
const DEFAULT_RESOLUTION = 128;
const FRAMES = 10;

// ─── Petpet GIF Engine (sama persis dari plugin petpet resmi) ─────────────────

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

    // Generate palette
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
        description: "Kata trigger (default: !petpet). Format: !petpet @mention",
        default: "!petpet",
    },
    cooldownSeconds: {
        type: OptionType.NUMBER,
        description: "Cooldown antar petpet (detik) untuk mencegah spam.",
        default: 30,
    },
});

// ─── State ────────────────────────────────────────────────────────────────────

/** Cooldown per user yang di-petpet (userId → timestamp terakhir) */
const cooldownMap = new Map<string, number>();

/** Sedang dalam proses generate (untuk mencegah double-trigger) */
const processingSet = new Set<string>();

// ─── Helper Functions ─────────────────────────────────────────────────────────

/** Validasi bahwa channel tujuan ada dan accessible */
function resolveTargetChannel(sourceChannelId: string): string | null {
    const configuredChannelId = settings.store.targetChannelId?.trim();
    const configuredGuildId = settings.store.targetGuildId?.trim();

    // Kalau tidak dikonfigurasi, kirim ke channel yang sama
    if (!configuredChannelId) return sourceChannelId;

    // Validasi channel ada
    const channel = ChannelStore.getChannel(configuredChannelId);
    if (!channel) {
        logger.warn(`Channel tujuan ${configuredChannelId} tidak ditemukan!`);
        return sourceChannelId; // Fallback ke source channel
    }

    // Validasi guild (opsional — hanya untuk logging)
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
 * Parse trigger dari pesan.
 * Format yang valid:
 *   !petpet @mention          (mention user yang di-reply atau mention langsung)
 *   !petpet <@123456789>      (mention dengan ID)
 *
 * Mengembalikan userId jika trigger valid, null jika bukan trigger.
 */
function parseTrigger(content: string, message: any): string | null {
    const trigger = (settings.store.triggerWord || TRIGGER_PREFIX).trim().toLowerCase();
    const lower = content.trim().toLowerCase();

    if (!lower.startsWith(trigger)) return null;

    // Ekstrak user ID dari mention di konten pesan
    const mentionMatch = content.match(/<@!?(\d+)>/);
    if (mentionMatch) return mentionMatch[1];

    // Kalau tidak ada mention eksplisit, pakai user yang di-reply
    if (message.message_reference?.message_id) {
        // User di-reply akan diambil dari referenced_message
        const refAuthorId = message.referenced_message?.author?.id;
        if (refAuthorId) return refAuthorId;
    }

    return null;
}

// ─── Event Handler ────────────────────────────────────────────────────────────

async function handleMessage({ message }: { message: any; }) {
    if (!message?.content || typeof message.content !== "string") return;

    const userId = parseTrigger(message.content, message);
    if (!userId) return;

    // Jangan petpet diri sendiri via bot (opsional — biarkan saja)
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
        logger.info(`Generating petpet untuk user ${userId}...`);

        // Ambil avatar URL user yang akan di-petpet
        let user: any;
        try {
            user = await UserUtils.getUser(userId);
        } catch (err) {
            logger.error("Gagal fetch user:", err);
            return;
        }

        // Ambil avatar URL (pakai guild avatar jika ada, fallback ke global)
        const guildId = message.guild_id;
        const avatarUrl = user
            .getAvatarURL(guildId || undefined, 2048)
            .replace(/\?size=\d+$/, "?size=2048");

        // Generate GIF
        const gifFile = await generatePetpetGif(avatarUrl);

        // Tentukan channel tujuan
        const targetChannelId = resolveTargetChannel(message.channel_id);
        const targetChannel = ChannelStore.getChannel(targetChannelId);

        if (!targetChannel) {
            logger.error(`Channel ${targetChannelId} tidak ditemukan!`);
            return;
        }

        // Set cooldown sebelum upload (untuk cegah race condition)
        cooldownMap.set(userId, Date.now());

        // Upload GIF ke channel tujuan
        // setTimeout diperlukan karena Discord kadang clear state setelah event
        setTimeout(() => {
            UploadHandler.promptToUpload([gifFile], targetChannel, 0);
        }, 10);

        logger.info(
            `Petpet GIF untuk user ${user.username} dikirim ke channel ${targetChannelId}!`
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
        "Plugin fun: reply pesan seseorang lalu ketik \"!petpet @mention\" untuk " +
        "generate petpet GIF dari avatar mereka dan kirim ke channel yang dikonfigurasi. " +
        "Mendukung server/channel tujuan khusus agar tidak melanggar rules.",
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
