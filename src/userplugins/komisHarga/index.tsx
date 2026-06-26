/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import { sendMessage } from "@utils/discord";
import definePlugin, { OptionType } from "@utils/types";
import { AuthenticationStore, FluxDispatcher, PresenceStore, UserStore } from "@webpack/common";

// ─── Constants ────────────────────────────────────────────────────────────────

const logger = new Logger("KomisHarga", "#f9ca24");

const DATASTORE_KEY = "KomisHarga_pendingChannels";
const TRIGGER_WORD = "!harga";

// ─── Pesan Harga ─────────────────────────────────────────────────────────────

const HARGA_MESSAGE = `\
╔══════════════════════════════╗
       💰 **KOMIS THUMBNAIL** 💰
╚══════════════════════════════╝

Halo! Berikut ketentuan harga komis thumbnail gue:

┌─────────────────────────────┐
│  🎨 **BLENDER RENDER**      │
├─────────────────────────────┤
│  • Harga mulai  **Rp 20.000**   │
│  • Banyak revisi → **Rp 25.000** │
│  • Cocok buat yang mau      │
│    hasil 3D clean & modern  │
└─────────────────────────────┘

┌─────────────────────────────┐
│  📸 **SCREENSHOT + MANUAL SHADING** │
├─────────────────────────────┤
│  • Harga mulai  **Rp 35.000**   │
│  • Banyak revisi → **Rp 40.000** │
│  • Screenshot in-game +     │
│    shading manual tangan,   │
│    hasil lebih artistik     │
└─────────────────────────────┘

📌 **Info penting:**
> Revisi dihitung setelah sketsa awal disetujui
> Harga bisa berubah tergantung kompleksitas
> DM atau tanya langsung buat konsultasi dulu ✨`;

// ─── Settings ─────────────────────────────────────────────────────────────────

const settings = definePluginSettings({
    enabled: {
        type: OptionType.BOOLEAN,
        description: "Aktifkan auto-reply harga komis",
        default: true,
    },
    triggerWord: {
        type: OptionType.STRING,
        description: "Kata trigger untuk munculkan harga (default: !harga)",
        default: "!harga",
    },
    cooldownSeconds: {
        type: OptionType.NUMBER,
        description: "Cooldown reply per channel (detik)",
        default: 60,
    },
    replyOnlyWhenOnline: {
        type: OptionType.BOOLEAN,
        description: "Hanya reply saat kamu online/idle/dnd. Kalau offline, simpan & kirim saat login.",
        default: true,
    },
});

// ─── State ────────────────────────────────────────────────────────────────────

/** Cooldown per channel */
const cooldownMap = new Map<string, number>();

/** Pending channels saat offline (persistent via DataStore) */
let pendingChannels: string[] = [];

/** Timeout untuk delay kirim saat login */
let loginDelayTimeout: ReturnType<typeof setTimeout> | null = null;

// ─── Helper ───────────────────────────────────────────────────────────────────

function isSelfOnline(): boolean {
    const myId = AuthenticationStore.getId();
    if (!myId) return false;
    const status = PresenceStore.getStatus(myId);
    return status === "online" || status === "idle" || status === "dnd";
}

function getTrigger(): string {
    return (settings.store.triggerWord || TRIGGER_WORD).trim().toLowerCase();
}

function hasTrigger(content: string): boolean {
    return content.trim().toLowerCase().startsWith(getTrigger());
}

/** Simpan pending channels ke DataStore supaya survive restart */
async function savePending() {
    await DataStore.set(DATASTORE_KEY, pendingChannels);
}

/** Load pending channels dari DataStore */
async function loadPending() {
    pendingChannels = (await DataStore.get<string[]>(DATASTORE_KEY)) ?? [];
}

/** Kirim semua pesan yang pending saat user offline, dengan delay 10 detik */
async function flushPending() {
    if (pendingChannels.length === 0) return;

    logger.info(`Ada ${pendingChannels.length} channel pending, kirim dalam 10 detik...`);

    loginDelayTimeout = setTimeout(async () => {
        const toSend = [...new Set(pendingChannels)]; // deduplicate
        pendingChannels = [];
        await DataStore.set(DATASTORE_KEY, []);

        for (const channelId of toSend) {
            try {
                await sendMessage(channelId, { content: HARGA_MESSAGE });
                logger.info(`Pending reply terkirim ke channel ${channelId}`);
                // Jeda antar pesan supaya tidak rate-limit
                await new Promise(r => setTimeout(r, 1500));
            } catch (err) {
                logger.error(`Gagal kirim pending ke ${channelId}:`, err);
            }
        }
    }, 10_000);
}

// ─── Event Handlers ───────────────────────────────────────────────────────────

async function handleMessage({ message }: { message: any; }) {
    if (!settings.store.enabled) return;
    if (!message?.content || typeof message.content !== "string") return;
    if (!hasTrigger(message.content)) return;

    // Jangan balas pesan sendiri
    const myId = UserStore.getCurrentUser()?.id;
    if (!myId || message.author?.id === myId) return;

    const channelId: string = message.channel_id;

    // Cek cooldown
    const cooldownMs = (settings.store.cooldownSeconds ?? 60) * 1000;
    const lastSent = cooldownMap.get(channelId) ?? 0;
    if (Date.now() - lastSent < cooldownMs) {
        logger.info(`Cooldown aktif di channel ${channelId}, skip.`);
        return;
    }

    // Kalau settings replyOnlyWhenOnline aktif, cek status dulu
    if (settings.store.replyOnlyWhenOnline && !isSelfOnline()) {
        // User offline → simpan ke pending
        if (!pendingChannels.includes(channelId)) {
            pendingChannels.push(channelId);
            await savePending();
            logger.info(`User offline, channel ${channelId} disimpan sebagai pending.`);
        }
        return;
    }

    // Online → langsung reply
    try {
        await sendMessage(channelId, { content: HARGA_MESSAGE });
        cooldownMap.set(channelId, Date.now());
        logger.info(`Reply harga terkirim ke channel ${channelId}`);
    } catch (err) {
        logger.error("Gagal kirim reply harga:", err);
    }
}

/** Dipanggil saat Discord establish connection (login / reconnect) */
async function handleConnectionOpen() {
    await loadPending();
    // Tunggu sebentar agar PresenceStore settled setelah connect
    setTimeout(() => {
        if (isSelfOnline()) {
            flushPending();
        }
    }, 3000);
}

// ─── Plugin Definition ────────────────────────────────────────────────────────

export default definePlugin({
    name: "komisHarga",
    description:
        "Auto-reply harga komis thumbnail saat ada yang ketik !harga. " +
        "Hanya aktif saat kamu online. Kalau ada yang tanya saat offline, " +
        "pesannya disimpan dan otomatis dikirim 10 detik setelah kamu login.",
    tags: ["Fun", "Utility"],
    authors: [{ name: "kintil555", id: 0n }],

    settings,

    start() {
        logger.info("KomisHarga aktif 💰");
        FluxDispatcher.subscribe("MESSAGE_CREATE", handleMessage);
        FluxDispatcher.subscribe("CONNECTION_OPEN", handleConnectionOpen);
    },

    stop() {
        logger.info("KomisHarga nonaktif.");
        FluxDispatcher.unsubscribe("MESSAGE_CREATE", handleMessage);
        FluxDispatcher.unsubscribe("CONNECTION_OPEN", handleConnectionOpen);

        if (loginDelayTimeout) {
            clearTimeout(loginDelayTimeout);
            loginDelayTimeout = null;
        }

        cooldownMap.clear();
    },
});
