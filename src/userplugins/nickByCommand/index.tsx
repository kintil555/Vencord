/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelStore, FluxDispatcher, RestAPI, Toasts, UserStore } from "@webpack/common";

const logger = new Logger("NickByCommand", "#f59e0b");

// ─── Types ────────────────────────────────────────────────────────────────────

interface Message {
    id: string;
    content: string;
    author: { id: string; username: string; };
    guild_id?: string;
    channel_id: string;
}

interface MessageCreatePayload {
    type: "MESSAGE_CREATE";
    message: Message;
    guildId?: string;
    channelId?: string;
}

// ─── State ────────────────────────────────────────────────────────────────────

// cooldown per-guild: guildId -> timestamp terakhir command berhasil (ms)
const cooldownMap = new Map<string, number>();

// pending delay: guildId -> timeoutId (untuk bisa dibatalkan saat stop)
const pendingMap = new Map<string, ReturnType<typeof setTimeout>>();

// ─── Settings ─────────────────────────────────────────────────────────────────

const settings = definePluginSettings({
    prefix: {
        type: OptionType.STRING,
        description: "Prefix command yang dideteksi (contoh: !nick)",
        default: "!nick",
        placeholder: "!nick",
    },

    delaySeconds: {
        type: OptionType.SLIDER,
        description: "Delay sebelum nickname berubah setelah command diterima (detik)",
        default: 5,
        markers: [0, 1, 2, 3, 5, 7, 10, 15, 20, 30],
        stickToMarkers: false,
    },

    cooldownSeconds: {
        type: OptionType.SLIDER,
        description: "Cooldown per-server: jeda minimum antar perubahan nickname (detik)",
        default: 7,
        markers: [0, 3, 5, 7, 10, 15, 20, 30, 60],
        stickToMarkers: false,
    },

    maxNickLength: {
        type: OptionType.SLIDER,
        description: "Panjang maksimum nickname yang diizinkan (Discord max: 32)",
        default: 32,
        markers: [4, 8, 12, 16, 20, 24, 28, 32],
        stickToMarkers: true,
    },

    ignoreSelf: {
        type: OptionType.BOOLEAN,
        description: "Abaikan command dari diri sendiri",
        default: true,
    },

    showToast: {
        type: OptionType.BOOLEAN,
        description: "Tampilkan notifikasi toast saat nickname berubah",
        default: true,
    },

    showDelayToast: {
        type: OptionType.BOOLEAN,
        description: "Tampilkan toast saat mulai delay (sebelum nickname berubah)",
        default: true,
    },
});

// ─── Core ─────────────────────────────────────────────────────────────────────

async function applyNick(guildId: string, nick: string, requester: string) {
    try {
        await RestAPI.patch({
            url: `/guilds/${guildId}/members/@me`,
            body: { nick: nick || null },
        });

        logger.info(`Nickname di guild ${guildId} diubah menjadi "${nick}" oleh ${requester}`);

        if (settings.store.showToast) {
            Toasts.show({
                id: Toasts.genId(),
                message: nick
                    ? `Nickname diubah ke "${nick}" oleh ${requester}`
                    : `Nickname dihapus oleh ${requester}`,
                type: Toasts.Type.SUCCESS,
            });
        }
    } catch (e: any) {
        const reason = e?.body?.message ?? e?.message ?? "Unknown error";
        logger.error(`Gagal ubah nickname di guild ${guildId}:`, reason);

        Toasts.show({
            id: Toasts.genId(),
            message: `Gagal ubah nickname: ${reason}`,
            type: Toasts.Type.FAILURE,
        });
    }
}

function handleMessageCreate({ message, guildId }: MessageCreatePayload) {
    // Hanya proses pesan di server (guild), bukan DM
    const resolvedGuildId = guildId ?? message.guild_id;
    if (!resolvedGuildId) return;

    // Abaikan pesan dari bot
    if ((message.author as any).bot) return;

    const myId = UserStore.getCurrentUser()?.id;

    // Abaikan pesan dari diri sendiri jika setting aktif
    if (settings.store.ignoreSelf && message.author.id === myId) return;

    const prefix = (settings.store.prefix ?? "!nick").trim();
    if (!prefix) return;

    const content = message.content.trim();

    // Cek apakah pesan dimulai dengan prefix + spasi (atau persis prefix saja)
    if (!content.startsWith(prefix)) return;
    const afterPrefix = content.slice(prefix.length);

    // Harus ada spasi setelah prefix, atau pesan persis prefix (untuk hapus nick)
    if (afterPrefix.length > 0 && afterPrefix[0] !== " ") return;

    const newNick = afterPrefix.trim().slice(0, settings.store.maxNickLength ?? 32);

    // Cek cooldown untuk guild ini
    const now = Date.now();
    const lastUsed = cooldownMap.get(resolvedGuildId) ?? 0;
    const cooldownMs = (settings.store.cooldownSeconds ?? 7) * 1000;

    if (now - lastUsed < cooldownMs) {
        const remainingSec = Math.ceil((cooldownMs - (now - lastUsed)) / 1000);
        logger.info(`Cooldown aktif di guild ${resolvedGuildId}, sisa ${remainingSec}s`);

        Toasts.show({
            id: Toasts.genId(),
            message: `Nick command cooldown: tunggu ${remainingSec} detik lagi.`,
            type: Toasts.Type.MESSAGE,
        });
        return;
    }

    // Batalkan pending jika ada (replace dengan yang baru)
    if (pendingMap.has(resolvedGuildId)) {
        clearTimeout(pendingMap.get(resolvedGuildId)!);
        pendingMap.delete(resolvedGuildId);
        logger.info(`Pending nickname di guild ${resolvedGuildId} dibatalkan, diganti request baru.`);
    }

    const delayMs = (settings.store.delaySeconds ?? 5) * 1000;
    const requester = message.author.username;

    if (settings.store.showDelayToast) {
        Toasts.show({
            id: Toasts.genId(),
            message: `${requester} mengubah nicknamemu${newNick ? ` ke "${newNick}"` : " (hapus)"} dalam ${settings.store.delaySeconds ?? 5}s...`,
            type: Toasts.Type.MESSAGE,
        });
    }

    // Set cooldown SEKARANG (bukan setelah delay) supaya tidak bisa di-spam selama delay
    cooldownMap.set(resolvedGuildId, now);

    const timeoutId = setTimeout(() => {
        pendingMap.delete(resolvedGuildId);
        applyNick(resolvedGuildId, newNick, requester);
    }, delayMs);

    pendingMap.set(resolvedGuildId, timeoutId);
}

// ─── Plugin definition ────────────────────────────────────────────────────────

export default definePlugin({
    name: "nickByCommand",
    description:
        "Biarkan orang lain mengubah nicknamemu di server mereka dengan mengetik command chat. " +
        "Contoh: '!nick Mulyono' → nicknamemu berubah di server tersebut setelah delay. " +
        "Dilengkapi cooldown per-server agar tidak di-spam.",
    tags: ["Fun", "Nickname", "Command", "Social"],
    authors: [{ name: "kintil555", id: 0n }],

    settings,

    start() {
        FluxDispatcher.subscribe("MESSAGE_CREATE", handleMessageCreate as any);
        logger.info("Plugin dimulai. Mendengarkan command nickname...");
    },

    stop() {
        FluxDispatcher.unsubscribe("MESSAGE_CREATE", handleMessageCreate as any);

        // Bersihkan semua pending timeout
        for (const [guildId, timeoutId] of pendingMap) {
            clearTimeout(timeoutId);
            logger.info(`Timeout dibatalkan untuk guild ${guildId}`);
        }
        pendingMap.clear();
        cooldownMap.clear();

        logger.info("Plugin dihentikan.");
    },
});
