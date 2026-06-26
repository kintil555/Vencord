/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IpcMainInvokeEvent } from "electron";
import { readFile } from "fs/promises";
import { extname, normalize } from "path";

const ALLOWED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

const MIME_MAP: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
};

/**
 * Baca file gambar dari path lokal dan kembalikan sebagai base64 data URL.
 * Hanya mengizinkan ekstensi gambar yang aman.
 */
export async function readImageAsDataUrl(_: IpcMainInvokeEvent, filePath: string): Promise<string | null> {
    try {
        const normalized = normalize(filePath);
        const ext = extname(normalized).toLowerCase();

        if (!ALLOWED_EXTENSIONS.has(ext)) {
            console.error(`[ChatBackground] Ekstensi tidak diizinkan: ${ext}`);
            return null;
        }

        const buf = await readFile(normalized);
        const mime = MIME_MAP[ext] ?? "image/png";
        const base64 = buf.toString("base64");

        return `data:${mime};base64,${base64}`;
    } catch (err) {
        console.error("[ChatBackground] Gagal baca file:", err);
        return null;
    }
}
