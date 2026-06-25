/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType, ApplicationCommandOptionType, findOption, sendBotMessage } from "@api/Commands";
import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { CommandContext } from "@vencord/discord-types";
import { DraftType, UploadAttachmentStore, UploadHandler, UploadManager } from "@webpack/common";

const logger = new Logger("Pixelate");

const settings = definePluginSettings({
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
});

// ========================
// Core: efek pixelate via Canvas
// ========================

function loadImageFromFile(file: File): Promise<HTMLImageElement> {
    const url = URL.createObjectURL(file);
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            URL.revokeObjectURL(url);
            resolve(img);
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error(`Gagal load gambar: ${file.name}`));
        };
        img.src = url;
    });
}

async function pixelateImage(file: File, blockSize: number): Promise<File> {
    const img = await loadImageFromFile(file);

    const { width, height } = img;

    // Canvas utama - ukuran asli gambar
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

    // Step 1: downsample ke ukuran kecil (buat efek piksel)
    const smallW = Math.max(1, Math.round(width / blockSize));
    const smallH = Math.max(1, Math.round(height / blockSize));

    const smallCanvas = document.createElement("canvas");
    smallCanvas.width = smallW;
    smallCanvas.height = smallH;
    const smallCtx = smallCanvas.getContext("2d", { willReadFrequently: true })!;

    // Matikan image smoothing di small canvas - penting untuk hasil kotak yang crisp
    smallCtx.imageSmoothingEnabled = false;
    smallCtx.drawImage(img, 0, 0, smallW, smallH);

    // Step 2: upscale balik ke ukuran asli TANPA smoothing - ini yang bikin "kotak"
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(smallCanvas, 0, 0, smallW, smallH, 0, 0, width, height);

    // Tentukan format & nama file output
    const fmt = settings.store.outputFormat ?? "image/png";
    const quality = fmt !== "image/png" ? (settings.store.jpegQuality ?? 90) / 100 : undefined;

    const extMap: Record<string, string> = {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/webp": ".webp",
    };
    const originalBase = file.name.replace(/\.[^/.]+$/, "");
    const newExt = extMap[fmt] ?? ".png";
    const newName = `${originalBase}_pixelated${newExt}`;

    return new Promise((resolve, reject) => {
        canvas.toBlob(
            blob => {
                if (!blob) return reject(new Error("Gagal convert canvas ke blob"));
                resolve(new File([blob], newName, { type: fmt }));
            },
            fmt,
            quality
        );
    });
}

// ========================
// Plugin
// ========================

export default definePlugin({
    name: "Pixelate",
    description: "Bikin gambar jadi burik (efek piksel kotak-kotak) sebelum dikirim. Resolusi file tetap sama, tapi keliatan mosaic. Pakai /pixelate.",
    authors: [Devs.kintil555],
    tags: ["fun", "image", "pixelate", "mosaic", "burik"],
    settings,

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
                    description: "Ukuran blok piksel (default dari settings). Makin besar = makin burik",
                    type: ApplicationCommandOptionType.INTEGER,
                    required: false,
                },
            ],

            async execute(opts, ctx: CommandContext) {
                // Ambil upload dari slash command attachment
                const upload = UploadAttachmentStore.getUpload(ctx.channel.id, "image", DraftType.SlashCommand);

                if (!upload) {
                    UploadManager.clearAll(ctx.channel.id, DraftType.SlashCommand);
                    return sendBotMessage(ctx.channel.id, { content: "❌ Pixelate: Tidak ada gambar yang di-attach!" });
                }

                if (!upload.isImage) {
                    UploadManager.clearAll(ctx.channel.id, DraftType.SlashCommand);
                    return sendBotMessage(ctx.channel.id, { content: "❌ Pixelate: File yang di-attach bukan gambar!" });
                }

                const blockSize = findOption<number>(opts, "block", settings.store.blockSize ?? 16);

                if (blockSize < 2 || blockSize > 256) {
                    UploadManager.clearAll(ctx.channel.id, DraftType.SlashCommand);
                    return sendBotMessage(ctx.channel.id, { content: "❌ Pixelate: Ukuran blok harus antara 2–256." });
                }

                const file = upload.item.file;

                sendBotMessage(ctx.channel.id, {
                    content: `⏳ Pixelate: Lagi nge-burikin \`${file.name}\` (block size: ${blockSize}px)...`,
                });

                UploadManager.clearAll(ctx.channel.id, DraftType.SlashCommand);

                try {
                    const result = await pixelateImage(file, blockSize);

                    logger.info(`Pixelated ${file.name} → ${result.name} (${result.size} bytes)`);

                    // Delay kecil biar Discord sempat clear input sebelum kita inject upload baru
                    setTimeout(() => {
                        UploadHandler.promptToUpload([result], ctx.channel, DraftType.ChannelMessage);
                    }, 10);
                } catch (e: any) {
                    logger.error("Pixelate error:", e);
                    sendBotMessage(ctx.channel.id, {
                        content: `❌ Pixelate gagal: ${e?.message ?? "Unknown error"}`,
                    });
                }
            },
        },
    ],
});
