/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export type SlotKey = "morning" | "noon" | "afternoon" | "night";

export interface GreetingSlot {
    key: SlotKey;
    label: string;
    enabled: boolean;
    message: string;
    /** "HH:mm" 24 jam */
    startTime: string;
    /** "HH:mm" 24 jam */
    endTime: string;
    /** Tanggal terakhir slot ini berhasil terkirim otomatis, format YYYY-MM-DD. Kosong = belum pernah. */
    lastSentDate: string;
}

export const DEFAULT_SLOTS: GreetingSlot[] = [
    {
        key: "morning",
        label: "Pagi",
        enabled: true,
        message: "**Selamat Pagi!** ☀️ Semoga harimu menyenangkan~",
        startTime: "05:00",
        endTime: "10:59",
        lastSentDate: "",
    },
    {
        key: "noon",
        label: "Siang",
        enabled: true,
        message: "**Selamat Siang!** 🌤️ Jangan lupa makan ya~",
        startTime: "11:00",
        endTime: "14:59",
        lastSentDate: "",
    },
    {
        key: "afternoon",
        label: "Sore",
        enabled: true,
        message: "**Selamat Sore!** 🌇 Tetap semangat~",
        startTime: "15:00",
        endTime: "17:59",
        lastSentDate: "",
    },
    {
        key: "night",
        label: "Malam",
        enabled: true,
        message: "**Selamat Malam!** 🌙 Istirahat yang cukup ya~",
        startTime: "18:00",
        endTime: "23:59",
        lastSentDate: "",
    },
];
