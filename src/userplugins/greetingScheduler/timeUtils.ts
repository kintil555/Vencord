/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { GreetingSlot } from "./types";

/** Ubah "HH:mm" jadi total menit sejak 00:00 */
function timeToMinutes(time: string): number {
    const [h, m] = time.split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
}

/** Tanggal lokal hari ini, format YYYY-MM-DD (dipakai untuk anti-duplikat kirim per hari) */
export function todayKey(d = new Date()): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

/**
 * Apakah waktu "now" (menit sejak 00:00) berada dalam rentang start..end.
 * Mendukung rentang yang melewati tengah malam, misal start=22:00 end=02:00.
 */
function isWithinRange(nowMinutes: number, startMinutes: number, endMinutes: number): boolean {
    if (startMinutes <= endMinutes) {
        return nowMinutes >= startMinutes && nowMinutes <= endMinutes;
    }
    // Rentang melewati tengah malam
    return nowMinutes >= startMinutes || nowMinutes <= endMinutes;
}

/** Cari slot yang aktif (enabled & jam sekarang masuk rentang) pada waktu "now". Null jika tidak ada. */
export function getActiveSlot(slots: GreetingSlot[], now = new Date()): GreetingSlot | null {
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    for (const slot of slots) {
        if (!slot.enabled) continue;
        const start = timeToMinutes(slot.startTime);
        const end = timeToMinutes(slot.endTime);
        if (isWithinRange(nowMinutes, start, end)) return slot;
    }
    return null;
}

/** Apakah slot ini sudah terkirim (otomatis) hari ini? */
export function alreadySentToday(slot: GreetingSlot, now = new Date()): boolean {
    return slot.lastSentDate === todayKey(now);
}
