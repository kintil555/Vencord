/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { sendMessage } from "@utils/discord";
import { AuthenticationStore, PresenceStore } from "@webpack/common";

import { settings } from "./settings";
import { getActiveSlot, todayKey } from "./timeUtils";

export const logger = new Logger("GreetingScheduler", "#ffb347");

export interface SendResult {
    ok: boolean;
    message: string;
}

/** Apakah user (kita sendiri) sedang online (bukan offline/invisible)? */
export function isSelfOnline(): boolean {
    const myId = AuthenticationStore.getId();
    if (!myId) return false;
    const status = PresenceStore.getStatus(myId);
    return status === "online" || status === "idle" || status === "dnd" || status === "streaming";
}

/** Validasi target server/channel sudah diisi di settings. */
export function hasValidTarget(): boolean {
    return !!settings.store.targetGuildId && !!settings.store.targetChannelId;
}

/**
 * Kirim pesan untuk slot waktu saat ini sekarang juga (tanpa countdown, tanpa cek histori harian).
 * Dipakai oleh tombol "Kirim Sekarang" (mode manual).
 */
export async function sendGreetingNow(): Promise<SendResult> {
    if (!hasValidTarget()) {
        return { ok: false, message: "Server/channel tujuan belum diatur di settings plugin." };
    }

    const slot = getActiveSlot(settings.store.slots);
    if (!slot) {
        return { ok: false, message: "Jam sekarang tidak masuk slot waktu manapun yang aktif." };
    }

    return doSend(slot.message, slot.label);
}

/**
 * Kirim pesan untuk slot tertentu (dipakai oleh auto-scheduler) dan tandai sudah terkirim hari ini.
 */
export async function sendGreetingForSlot(slotKey: string): Promise<SendResult> {
    const slot = settings.store.slots.find(s => s.key === slotKey);
    if (!slot) return { ok: false, message: "Slot tidak ditemukan." };

    const result = await doSend(slot.message, slot.label);
    if (result.ok) {
        slot.lastSentDate = todayKey();
    }
    return result;
}

async function doSend(content: string, label: string): Promise<SendResult> {
    const channelId = settings.store.targetChannelId;
    try {
        await sendMessage(channelId, { content });
        logger.info(`Pesan "${label}" terkirim ke channel ${channelId}`);
        return { ok: true, message: `Pesan "${label}" terkirim!` };
    } catch (e) {
        logger.error("Gagal mengirim pesan greeting:", e);
        return { ok: false, message: `Gagal mengirim pesan "${label}". Cek console untuk detail.` };
    }
}
