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
import { AuthenticationStore, ChannelStore, FluxDispatcher, Forms, PresenceStore, Select, UserStore, useState } from "@webpack/common";

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

// ─── DM User Picker Component ─────────────────────────────────────────────────

function DmUserPicker() {
    // Ambil semua DM yang sudah ada, lalu map ke opsi dropdown
    const dmOptions = (() => {
        const myId = UserStore.getCurrentUser()?.id;
        const dmUserIds = ChannelStore.getDMUserIds();

        const opts = dmUserIds
            .filter(uid => uid !== myId)
            .map(uid => {
                const user = UserStore.getUser(uid);
                const label = user
                    ? (user.globalName || user.username)
                    : uid;
                return { label, value: uid };
            })
            .sort((a, b) => a.label.localeCompare(b.label));

        return [{ label: "— Tidak dipilih —", value: "" }, ...opts];
    })();

    const { allowedUser1, allowedUser2 } = settings.use(["allowedUser1", "allowedUser2"]);

    // Opsi untuk slot ke-2: filter agar tidak bisa pilih user yang sama
    const optionsSlot2 = dmOptions.filter(o => o.value === "" || o.value !== allowedUser1);
    // Opsi untuk slot ke-1: filter agar tidak bisa pilih user yang sama
    const optionsSlot1 = dmOptions.filter(o => o.value === "" || o.value !== allowedUser2);

    return (
        <Forms.FormSection>
            <Forms.FormTitle>Orang yang diizinkan (maks. 2)</Forms.FormTitle>
            <Forms.FormText style={{ marginBottom: 8 }}>
                Pilih dari daftar DM kamu. Kosongkan keduanya untuk menerima dari semua DM.
            </Forms.FormText>

            <Forms.FormTitle tag="h5" style={{ marginTop: 12 }}>Orang pertama</Forms.FormTitle>
            <Select
                options={optionsSlot1}
                placeholder="Pilih dari DM..."
                isDisabled={false}
                closeOnSelect
                select={v => { settings.store.allowedUser1 = v; }}
                isSelected={v => v === allowedUser1}
                serialize={v => v}
            />

            <Forms.FormTitle tag="h5" style={{ marginTop: 12 }}>Orang kedua</Forms.FormTitle>
            <Select
                options={optionsSlot2}
                placeholder="Pilih dari DM..."
                isDisabled={false}
                closeOnSelect
                select={v => { settings.store.allowedUser2 = v; }}
                isSelected={v => v === allowedUser2}
                serialize={v => v}
            />

            {(allowedUser1 || allowedUser2) && (
                <Forms.FormText style={{ marginTop: 8, color: "var(--text-positive)" }}>
                    ✅ Aktif untuk:{" "}
                    {[allowedUser1, allowedUser2]
                        .filter(Boolean)
                        .map(uid => {
                            const u = UserStore.getUser(uid!);
                            return u ? (u.globalName || u.username) : uid;
                        })
                        .join(", ")}
                </Forms.FormText>
            )}
        </Forms.FormSection>
    );
}

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
        type: OptionType.CUSTOM,
        default: "",
    },
    allowedUser2: {
        type: OptionType.CUSTOM,
        default: "",
    },
    dmPicker: {
        type: OptionType.COMPONENT,
        description: "",
        component: DmUserPicker,
    },
    cooldownSeconds: {
        type: OptionType.NUMBER,
        description: "Cooldown reply per DM (detik)",
        default: 60,
    },
});

// ─── State ────────────────────────────────────────────────────────────────────

const cooldownMap = new Map<string, number>();
let pendingChannels: string[] = [];
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

function isDMChannel(channelId: string): boolean {
    const channel = ChannelStore.getChannel(channelId);
    return channel?.type === 1;
}

function isSenderAllowed(senderId: string): boolean {
    const u1 = settings.store.allowedUser1 ?? "";
    const u2 = settings.store.allowedUser2 ?? "";
    if (!u1 && !u2) return true;
    return senderId === u1 || senderId === u2;
}

async function savePending() {
    await DataStore.set(DATASTORE_KEY, pendingChannels);
}

async function loadPending() {
    pendingChannels = (await DataStore.get<string[]>(DATASTORE_KEY)) ?? [];
}

async function flushPending() {
    if (pendingChannels.length === 0) return;
    logger.info(`Ada ${pendingChannels.length} DM pending, kirim dalam 10 detik...`);

    loginDelayTimeout = setTimeout(async () => {
        const toSend = [...new Set(pendingChannels)];
        pendingChannels = [];
        await DataStore.set(DATASTORE_KEY, []);

        for (const channelId of toSend) {
            try {
                await sendMessage(channelId, { content: HARGA_MESSAGE });
                logger.info(`Pending reply terkirim ke DM ${channelId}`);
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

    const myId = UserStore.getCurrentUser()?.id;
    if (!myId || message.author?.id === myId) return;

    const channelId: string = message.channel_id;

    if (!isDMChannel(channelId)) return;

    if (!isSenderAllowed(message.author.id)) {
        logger.info(`User ${message.author.id} tidak ada di whitelist, skip.`);
        return;
    }

    const cooldownMs = (settings.store.cooldownSeconds ?? 60) * 1000;
    const lastSent = cooldownMap.get(channelId) ?? 0;
    if (Date.now() - lastSent < cooldownMs) {
        logger.info(`Cooldown aktif di DM ${channelId}, skip.`);
        return;
    }

    if (!isSelfOnline()) {
        if (!pendingChannels.includes(channelId)) {
            pendingChannels.push(channelId);
            await savePending();
            logger.info(`User offline, DM ${channelId} disimpan sebagai pending.`);
        }
        return;
    }

    try {
        await sendMessage(channelId, { content: HARGA_MESSAGE });
        cooldownMap.set(channelId, Date.now());
        logger.info(`Reply harga terkirim ke DM ${channelId}`);
    } catch (err) {
        logger.error("Gagal kirim reply harga:", err);
    }
}

async function handleConnectionOpen() {
    await loadPending();
    setTimeout(() => {
        if (isSelfOnline()) flushPending();
    }, 3000);
}

// ─── Plugin Definition ────────────────────────────────────────────────────────

export default definePlugin({
    name: "komisHarga",
    description:
        "Auto-reply harga komis thumbnail via DM saat ada yang ketik !harga. " +
        "Pilih maks. 2 orang dari dropdown DM. " +
        "Hanya aktif saat online — kalau offline, pesan disimpan dan dikirim 10 detik setelah login.",
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
        if (loginDelayTimeout) { clearTimeout(loginDelayTimeout); loginDelayTimeout = null; }
        cooldownMap.clear();
    },
});
