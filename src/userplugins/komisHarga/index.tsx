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
import { AuthenticationStore, ChannelStore, FluxDispatcher, PresenceStore, UserStore } from "@webpack/common";

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
        description: "Kata trigger (default: !harga)",
        default: "!harga",
    },
    allowedUser1: {
        type: OptionType.STRING,
        description: "User ID orang pertama yang boleh trigger !harga via DM (kosongkan = semua DM)",
        default: "",
        placeholder: "123456789012345678",
    },
    allowedUser2: {
        type: OptionType.STRING,
        description: "User ID orang kedua yang boleh trigger !harga via DM (maks. 2 orang)",
        default: "",
        placeholder: "123456789012345678",
    },
    cooldownSeconds: {
        type: OptionType.NUMBER,
        description: "Cooldown reply per DM (detik)",
        default: 60,
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

/** Cek apakah channel adalah DM (type 1 = DM) */
function isDMChannel(channelId: string): boolean {
    const channel = ChannelStore.getChannel(channelId);
    return channel?.type === 1;
}

/**
 * Cek apakah sender diizinkan:
 * - Kalau kedua allowedUser kosong → semua DM diizinkan
 * - Kalau ada yang diisi → hanya user yang terdaftar
 */
function isSenderAllowed(senderId: string): boolean {
    const u1 = settings.store.allowedUser1?.trim();
    const u2 = settings.store.allowedUser2?.trim();

    // Tidak ada yang dikonfigurasi → semua DM boleh
    if (!u1 && !u2) return true;

    return senderId === u1 || senderId === u2;
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

    // Hanya proses pesan dari DM (bukan server)
    if (!isDMChannel(channelId)) return;

    // Cek apakah sender termasuk yang diizinkan
    if (!isSenderAllowed(message.author.id)) {
        logger.info(`User ${message.author.id} tidak ada di whitelist, skip.`);
        return;
    }

    // Cek cooldown
    const cooldownMs = (settings.store.cooldownSeconds ?? 60) * 1000;
    const lastSent = cooldownMap.get(channelId) ?? 0;
    if (Date.now() - lastSent < cooldownMs) {
        logger.info(`Cooldown aktif di DM ${channelId}, skip.`);
        return;
    }

    // Kalau offline → simpan ke pending
    if (!isSelfOnline()) {
        if (!pendingChannels.includes(channelId)) {
            pendingChannels.push(channelId);
            await savePending();
            logger.info(`User offline, DM ${channelId} disimpan sebagai pending.`);
        }
        return;
    }

    // Online → langsung reply
    try {
        await sendMessage(channelId, { content: HARGA_MESSAGE });
        cooldownMap.set(channelId, Date.now());
        logger.info(`Reply harga terkirim ke DM ${channelId}`);
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
        "Auto-reply harga komis thumbnail via DM saat ada yang ketik !harga. " +
        "Khusus DM, bisa dibatasi maksimal 2 orang. " +
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
