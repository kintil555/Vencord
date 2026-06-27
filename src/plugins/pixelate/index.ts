/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType, ApplicationCommandOptionType, findOption, sendBotMessage } from "@api/Commands";
import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { CloudUpload as TCloudUpload, MessageAttachment } from "@vencord/discord-types";
import { CloudUploadPlatform } from "@vencord/discord-types/enums";
import { findLazy } from "@webpack";
import { ChannelStore, Constants, FluxDispatcher, GuildStore, RestAPI, SnowflakeUtils } from "@webpack/common";

const CloudUpload: typeof TCloudUpload = findLazy(m => m.prototype?.trackUploadFinished);

const logger = new Logger("Pixelate", "#a78bfa");

// ─── Settings ─────────────────────────────────────────────────────────────────

const settings = definePluginSettings({
    allowedGuildId: {
        type: OptionType.STRING,
        description: "ID Server yang boleh pakai !pixel (kosongkan = semua server)",
        default: "",
        placeholder: "123456789012345678",
    },
    allowedChannelId: {
        type: OptionType.STRING,
        description: "ID Channel yang boleh pakai !pixel (kosongkan = semua channel)",
        default: "",
        placeholder: "123456789012345678",
    },
    blockSize: {
        type: OptionType.SLIDER,
        description: "Ukuran blok piksel default (makin besar = makin burik)",
        default: 16,
        markers: [4, 8, 12, 16, 24, 32, 48, 64],
        stickToMarkers: false,
    },
    outputFormat: {
        type: OptionType.SELECT,
        description: "Format output gambar",
        options: [
            { label: "PNG (lossless)", value: "image/png", default: true },
            { label: "JPEG (lebih kecil)", value: "image/jpeg" },
            { label: "WebP (terkecil)", value: "image/webp" },
        ],
    },
    jpegQuality: {
        type: OptionType.SLIDER,
        description: "Kualitas JPEG/WebP (hanya berlaku kalau format bukan PNG)",
        default: 90,
        markers: [50, 60, 70, 80, 90, 95, 100],
        stickToMarkers: false,
    },
    cooldownSeconds: {
        type: OptionType.NUMBER,
        description: "Cooldown antar !pixel (detik) untuk mencegah spam",
        default: 10,
    },
});

// ─── State ────────────────────────────────────────────────────────────────────

const cooldownMap = new Map<string, number>();
const processingSet = new Set<string>();

// ─── Core: Pixelate via Canvas ────────────────────────────────────────────────

function loadImageFromUrl(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "Anonymous";
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`Gagal load gambar dari: ${url}`));
        img.src = url;
    });
}

function loadImageFromFile(file: File): Promise<HTMLImageElement> {
    const url = URL.createObjectURL(file);
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`Gagal load: ${file.name}`)); };
        img.src = url;
    });
}

async function pixelateImage(source: HTMLImageElement, blockSize: number): Promise<Blob> {
    const { width, height } = source;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

    // Downsample ke ukuran kecil
    const smallW = Math.max(1, Math.round(width / blockSize));
    const smallH = Math.max(1, Math.round(height / blockSize));

    const small = document.createElement("canvas");
    small.width = smallW;
    small.height = smallH;
    const smallCtx = small.getContext("2d", { willReadFrequently: true })!;
    smallCtx.imageSmoothingEnabled = false;
    smallCtx.drawImage(source, 0, 0, smallW, smallH);

    // Upscale balik tanpa smoothing → efek kotak
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(small, 0, 0, smallW, smallH, 0, 0, width, height);

    const fmt = (settings.store.outputFormat as string) ?? "image/png";
    const quality = fmt !== "image/png" ? (settings.store.jpegQuality ?? 90) / 100 : undefined;

    return new Promise((resolve, reject) => {
        canvas.toBlob(blob => {
            if (!blob) return reject(new Error("Gagal convert canvas ke blob"));
            resolve(blob);
        }, fmt, quality);
    });
}

function blobToFile(blob: Blob, originalName: string): File {
    const fmt = (settings.store.outputFormat as string) ?? "image/png";
    const extMap: Record<string, string> = {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/webp": ".webp",
    };
    const base = originalName.replace(/\.[^/.]+$/, "");
    const ext = extMap[fmt] ?? ".png";
    return new File([blob], `${base}_pixel${ext}`, { type: fmt });
}

// ─── Upload & Kirim ───────────────────────────────────────────────────────────

function uploadAndSend(file: File, channelId: string, replyToMessageId?: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const upload = new CloudUpload({
            file,
            isThumbnail: false,
            platform: CloudUploadPlatform.WEB,
        }, channelId);

        upload.on("complete", () => {
            const body: Record<string, any> = {
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
            };

            // Kalau ada reply target, tambahkan message_reference
            if (replyToMessageId) {
                body.message_reference = {
                    message_id: replyToMessageId,
                    channel_id: channelId,
                };
                body.allowed_mentions = {
                    parse: [],
                    replied_user: true,
                };
            }

            RestAPI.post({
                url: Constants.Endpoints.MESSAGES(channelId),
                body,
            }).then(() => resolve()).catch(reject);
        });

        upload.on("error", () => {
            reject(new Error("Upload gagal"));
        });

        upload.upload();
    });
}

// ─── Channel / Guild Guard ────────────────────────────────────────────────────

function isAllowed(guildId: string | null | undefined, channelId: string): boolean {
    const allowedGuild = settings.store.allowedGuildId?.trim();
    const allowedChannel = settings.store.allowedChannelId?.trim();

    if (allowedGuild && guildId !== allowedGuild) return false;
    if (allowedChannel && channelId !== allowedChannel) return false;

    return true;
}

// ─── Cari attachment gambar dari pesan ────────────────────────────────────────

function findImageAttachment(attachments: MessageAttachment[]): MessageAttachment | null {
    if (!attachments?.length) return null;
    return attachments.find(a =>
        a.content_type?.startsWith("image/") ||
        /\.(png|jpe?g|webp|gif|bmp)$/i.test(a.filename)
    ) ?? null;
}

// ─── Handler MESSAGE_CREATE ───────────────────────────────────────────────────

async function handleMessage({ message }: { message: any; }) {
    const content: string = message?.content?.trim() ?? "";
    if (!content.toLowerCase().startsWith("!pixel")) return;

    const channelId: string = message.channel_id;
    const guildId: string | null = message.guild_id ?? null;

    // Guard: hanya channel/server yang diizinkan
    if (!isAllowed(guildId, channelId)) return;

    // Cooldown per user
    const userId: string = message.author?.id;
    const cooldownMs = (settings.store.cooldownSeconds ?? 10) * 1000;
    const lastUsed = cooldownMap.get(userId) ?? 0;
    if (Date.now() - lastUsed < cooldownMs) {
        logger.info(`Cooldown aktif untuk ${userId}, skip.`);
        return;
    }

    // Cegah double processing
    const key = `${channelId}:${message.id}`;
    if (processingSet.has(key)) return;
    processingSet.add(key);

    try {
        let imgAttachment: MessageAttachment | null = null;
        let replyToMessageId: string | undefined;

        // === Kasus 1: user reply ke pesan orang lain yang punya gambar ===
        const refMsg = message.referenced_message;
        if (refMsg) {
            imgAttachment = findImageAttachment(refMsg.attachments ?? []);
            if (imgAttachment) {
                // Kita akan reply ke pesan si pengirim !pixel (orang yang minta)
                replyToMessageId = message.id;
            }
        }

        // === Kasus 2: user kirim gambar sendiri + !pixel ===
        if (!imgAttachment) {
            imgAttachment = findImageAttachment(message.attachments ?? []);
            if (imgAttachment) {
                replyToMessageId = message.id;
            }
        }

        if (!imgAttachment) {
            logger.info("!pixel dipanggil tapi tidak ada gambar ditemukan.");
            return;
        }

        const blockSize = settings.store.blockSize ?? 16;
        const imageUrl = imgAttachment.proxy_url || imgAttachment.url;

        logger.info(`Pixelating: ${imgAttachment.filename} (block: ${blockSize})`);

        cooldownMap.set(userId, Date.now());

        const img = await loadImageFromUrl(imageUrl);
        const blob = await pixelateImage(img, blockSize);
        const file = blobToFile(blob, imgAttachment.filename);

        await uploadAndSend(file, channelId, replyToMessageId);

        logger.info(`Pixelated ${imgAttachment.filename} dikirim ke ${channelId}`);
    } catch (err) {
        logger.error("Error saat pixelate:", err);
    } finally {
        processingSet.delete(key);
    }
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

function loadImageFromFileForCmd(file: File): Promise<HTMLImageElement> {
    return loadImageFromFile(file);
}

export default definePlugin({
    name: "Pixelate",
    description: "Bikin gambar jadi burik. Pakai /pixelate untuk gambar sendiri, atau ketik !pixel sambil reply/attach gambar biar otomatis diproses dan dikirim balik.",
    authors: [{ name: "kintil555", id: 0n }],
    tags: ["fun", "image", "pixelate", "mosaic"],
    settings,

    start() {
        logger.info("Pixelate started 🟪");
        FluxDispatcher.subscribe("MESSAGE_CREATE", handleMessage);
    },

    stop() {
        FluxDispatcher.unsubscribe("MESSAGE_CREATE", handleMessage);
        cooldownMap.clear();
        processingSet.clear();
        logger.info("Pixelate stopped.");
    },

    commands: [
        {
            name: "pixelate",
            description: "Bikin gambar jadi burik (pixelated) sebelum dikirim",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "image",
                    description: "Gambar yang mau di-pixelate",
                    type: ApplicationCommandOptionType.ATTACHMENT,
                    required: true,
                },
                {
                    name: "block",
                    description: "Ukuran blok piksel. Makin besar = makin burik",
                    type: ApplicationCommandOptionType.INTEGER,
                    required: false,
                },
            ],

            async execute(opts, ctx) {
                const { UploadAttachmentStore, UploadManager, UploadHandler, DraftType } = await import("@webpack/common");
                const upload = UploadAttachmentStore.getUpload(ctx.channel.id, "image", DraftType.SlashCommand);

                if (!upload?.isImage) {
                    UploadManager.clearAll(ctx.channel.id, DraftType.SlashCommand);
                    return sendBotMessage(ctx.channel.id, { content: "❌ Tidak ada gambar yang di-attach!" });
                }

                const blockSize = findOption<number>(opts, "block", settings.store.blockSize ?? 16);
                if (blockSize < 2 || blockSize > 256) {
                    UploadManager.clearAll(ctx.channel.id, DraftType.SlashCommand);
                    return sendBotMessage(ctx.channel.id, { content: "❌ Ukuran blok harus 2–256." });
                }

                sendBotMessage(ctx.channel.id, { content: `⏳ Lagi nge-burikin gambar (block: ${blockSize}px)...` });
                UploadManager.clearAll(ctx.channel.id, DraftType.SlashCommand);

                try {
                    const file = upload.item.file;
                    const img = await loadImageFromFileForCmd(file);
                    const blob = await pixelateImage(img, blockSize);
                    const result = blobToFile(blob, file.name);

                    setTimeout(() => {
                        UploadHandler.promptToUpload([result], ctx.channel, DraftType.ChannelMessage);
                    }, 10);
                } catch (e: any) {
                    logger.error("Slash command pixelate error:", e);
                    sendBotMessage(ctx.channel.id, { content: `❌ Gagal: ${e?.message ?? "Unknown error"}` });
                }
            },
        },
    ],
});
