/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { sendMessage } from "@utils/discord";
import definePlugin from "@utils/types";
import { FluxDispatcher, UserStore } from "@webpack/common";

import { settings } from "./settings";

const logger = new Logger("AutoGreetReply", "#7fc8ff");

/** Kata-kata salam yang dideteksi (case-insensitive, cocok sebagian kata) */
const DEFAULT_TRIGGERS = ["hai", "halo", "hello", "yo", "apa kabar"];

/** Timestamp terakhir kali bot membalas, per channelId */
const cooldownMap = new Map<string, number>();

/** setTimeout yang sedang menunggu untuk dikirim, per channelId */
const pendingMap = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Cek apakah isi pesan mengandung kata sapaan.
 * "halo guys" → cocok karena ada kata "halo" di dalamnya.
 */
function containsGreeting(content: string): boolean {
    const lower = content.toLowerCase();
    // Ambil trigger dari settings; kalau kosong pakai default
    const rawTriggers = settings.store.triggerWords?.trim();
    const triggers = rawTriggers
        ? rawTriggers.split(",").map((t: string) => t.trim().toLowerCase()).filter(Boolean)
        : DEFAULT_TRIGGERS;

    return triggers.some(trigger => lower.includes(trigger));
}

/**
 * Pilih satu balasan secara acak dari daftar balasan yang dikonfigurasi.
 */
function pickReply(): string {
    const rawReplies = settings.store.replyVariants?.trim();
    if (!rawReplies) return "Hai juga! 👋";

    const replies = rawReplies
        .split("\n")
        .map((r: string) => r.trim())
        .filter(Boolean);

    if (replies.length === 0) return "Hai juga! 👋";
    return replies[Math.floor(Math.random() * replies.length)];
}

function handleMessage({ message }: { message: any; }) {
    if (!settings.store.enabled) return;

    // Jangan balas pesan sendiri
    const myId = UserStore.getCurrentUser()?.id;
    if (!myId || message.author?.id === myId) return;

    // Hanya proses pesan teks biasa (bukan system message, dll.)
    if (!message.content || typeof message.content !== "string") return;

    if (!containsGreeting(message.content)) return;

    const channelId: string = message.channel_id;

    // --- Cek cooldown ---
    const cooldownMs = (settings.store.cooldownSeconds ?? 15) * 1000;
    const lastSent = cooldownMap.get(channelId) ?? 0;
    const now = Date.now();
    if (now - lastSent < cooldownMs) {
        logger.info(`Cooldown aktif di channel ${channelId}, skip.`);
        return;
    }

    // --- Batalkan pending yang ada (de-bounce per channel) ---
    const existing = pendingMap.get(channelId);
    if (existing) clearTimeout(existing);

    // --- Delay 10 detik sebelum kirim ---
    const delayMs = (settings.store.delaySeconds ?? 10) * 1000;
    logger.info(`Sapaan terdeteksi di channel ${channelId}. Membalas dalam ${delayMs / 1000}s...`);

    const tid = setTimeout(async () => {
        pendingMap.delete(channelId);

        // Re-cek cooldown (mungkin ada balasan lain yang sudah terkirim selama delay)
        const nowInner = Date.now();
        const lastSentInner = cooldownMap.get(channelId) ?? 0;
        if (nowInner - lastSentInner < cooldownMs) {
            logger.info(`Cooldown aktif saat hendak kirim di channel ${channelId}, batal.`);
            return;
        }

        const reply = pickReply();
        try {
            await sendMessage(channelId, { content: reply });
            cooldownMap.set(channelId, Date.now());
            logger.info(`Balasan terkirim ke channel ${channelId}: "${reply}"`);
        } catch (e) {
            logger.error("Gagal mengirim balasan:", e);
        }
    }, delayMs);

    pendingMap.set(channelId, tid);
}

export default definePlugin({
    name: "AutoGreetReply",
    description:
        "Balas otomatis pesan yang mengandung kata sapaan (hai, halo, hello, yo, apa kabar, dll.) " +
        "dengan pesan yang bisa dikustomisasi, plus delay 10 detik dan cooldown 15 detik per channel.",
    authors: [{ name: "kintil555", id: 0n }],

    settings,

    start() {
        logger.info("Plugin dimulai.");
        FluxDispatcher.subscribe("MESSAGE_CREATE", handleMessage);
    },

    stop() {
        logger.info("Plugin dihentikan.");
        FluxDispatcher.unsubscribe("MESSAGE_CREATE", handleMessage);

        // Bersihkan semua pending timeout
        for (const tid of pendingMap.values()) clearTimeout(tid);
        pendingMap.clear();
        cooldownMap.clear();
    },
});
