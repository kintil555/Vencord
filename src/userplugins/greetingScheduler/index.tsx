/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import definePlugin from "@utils/types";

import { hasValidTarget, isSelfOnline, logger, sendGreetingForSlot } from "./sender";
import { settings } from "./settings";
import { alreadySentToday, getActiveSlot } from "./timeUtils";

/** Interval pengecekan slot baru, dalam ms (cek tiap 1 menit cukup, jam tidak perlu presisi detik). */
const CHECK_INTERVAL_MS = 60_000;

let checkIntervalId: ReturnType<typeof setInterval> | null = null;
let countdownTimeoutId: ReturnType<typeof setTimeout> | null = null;
/** Slot key yang sedang dalam proses countdown, supaya tidak double-trigger countdown untuk slot yang sama. */
let pendingSlotKey: string | null = null;

function clearPendingCountdown() {
    if (countdownTimeoutId) {
        clearTimeout(countdownTimeoutId);
        countdownTimeoutId = null;
    }
    pendingSlotKey = null;
}

/**
 * Dipanggil berkala. Kalau mode auto aktif, target valid, user online, dan jam sekarang
 * masuk slot yang belum terkirim hari ini, mulai countdown lalu kirim sekali.
 */
function checkAndScheduleAutoSend() {
    if (settings.store.mode !== "auto") return;
    if (!hasValidTarget()) return;

    const slot = getActiveSlot(settings.store.slots);
    if (!slot) {
        // Tidak ada slot aktif sekarang -> batalkan countdown yang mungkin masih menunggu
        clearPendingCountdown();
        return;
    }

    if (alreadySentToday(slot)) return;
    if (pendingSlotKey === slot.key) return; // sudah dalam proses countdown untuk slot ini
    if (!isSelfOnline()) return;

    // Slot baru terdeteksi & valid -> mulai countdown
    clearPendingCountdown();
    pendingSlotKey = slot.key;

    const seconds = Math.max(0, settings.store.countdownSeconds ?? 10);
    logger.info(`Slot "${slot.label}" terdeteksi aktif. Mengirim dalam ${seconds} detik...`);

    countdownTimeoutId = setTimeout(async () => {
        countdownTimeoutId = null;
        const keyToSend = pendingSlotKey;
        pendingSlotKey = null;

        if (!keyToSend) return;
        // Re-validasi sesaat sebelum kirim, kondisi bisa berubah selama countdown
        if (settings.store.mode !== "auto") return;
        if (!isSelfOnline()) return;
        if (!hasValidTarget()) return;

        const stillActive = getActiveSlot(settings.store.slots);
        if (!stillActive || stillActive.key !== keyToSend) return;
        if (alreadySentToday(stillActive)) return;

        await sendGreetingForSlot(keyToSend);
    }, seconds * 1000);
}

export default definePlugin({
    name: "GreetingScheduler",
    description: "Kirim pesan ucapan (Selamat Pagi/Siang/Sore/Malam) otomatis atau manual ke channel tertentu, dengan formatting teks, jadwal per waktu, dan filter status online.",
    authors: [{ name: "kintil555", id: 0n }],

    settings,

    start() {
        logger.info("Plugin dimulai.");
        // Cek pertama kali sesaat setelah start (beri waktu store2 ter-hydrate)
        setTimeout(checkAndScheduleAutoSend, 1500);
        checkIntervalId = setInterval(checkAndScheduleAutoSend, CHECK_INTERVAL_MS);
    },

    stop() {
        logger.info("Plugin dihentikan, membersihkan timer.");
        if (checkIntervalId) {
            clearInterval(checkIntervalId);
            checkIntervalId = null;
        }
        clearPendingCountdown();
    },
});
