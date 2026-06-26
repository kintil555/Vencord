/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative, StartAt } from "@utils/types";

// ─── Types ────────────────────────────────────────────────────────────────────

const Native = VencordNative.pluginHelpers.chatBackground as PluginNative<typeof import("./native")>;

const logger = new Logger("ChatBackground", "#a78bfa");

// ─── CSS Style Element ────────────────────────────────────────────────────────

const STYLE_ID = "vc-chat-background-style";

function getOrCreateStyle(): HTMLStyleElement {
    let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (!el) {
        el = document.createElement("style");
        el.id = STYLE_ID;
        document.head.appendChild(el);
    }
    return el;
}

function removeStyle() {
    document.getElementById(STYLE_ID)?.remove();
}

// ─── CSS Generator ────────────────────────────────────────────────────────────

/**
 * Selector Discord untuk area chat messages.
 * Gunakan ini saat mode "chat only".
 */
const CHAT_SELECTORS = [
    /* area scroll chat utama */
    '[class*="messagesWrapper"]',
    '[class*="chatContent"]',
    '[class*="content__"]',
].join(",\n");

/**
 * Selector untuk seluruh app Discord.
 * Gunakan ini saat mode "fullscreen".
 */
const APP_SELECTOR = "#app-mount";

function buildCSS(
    dataUrl: string,
    opacity: number,
    mode: "chat" | "full",
    glowColor: string,
    glowSize: number,
    glowOpacity: number,
    backgroundSize: string,
    backgroundPosition: string,
): string {
    const target = mode === "chat" ? CHAT_SELECTORS : APP_SELECTOR;
    const glowColorHex = glowColor.replace("#", "");
    const r = parseInt(glowColorHex.substring(0, 2), 16);
    const g = parseInt(glowColorHex.substring(2, 4), 16);
    const b = parseInt(glowColorHex.substring(4, 6), 16);

    // Konversi opacity 0-100 ke 0.0-1.0
    const bgOpacity = Math.max(0, Math.min(1, opacity / 100));
    const innerGlowOpacity = Math.max(0, Math.min(1, glowOpacity / 100));

    return `
/* ── ChatBackground Plugin ─────────────────────────────── */
${target} {
    position: relative;
}

${target}::before {
    content: "";
    position: fixed;
    inset: 0;
    z-index: 0;
    pointer-events: none;

    background-image: url("${dataUrl}");
    background-size: ${backgroundSize};
    background-position: ${backgroundPosition};
    background-repeat: no-repeat;
    background-attachment: fixed;

    opacity: ${bgOpacity};
}

/* Inner glow di tepi untuk memisahkan konten dari background */
${target}::after {
    content: "";
    position: fixed;
    inset: 0;
    z-index: 1;
    pointer-events: none;

    box-shadow: inset 0 0 ${glowSize}px ${Math.round(glowSize * 0.4)}px rgba(${r}, ${g}, ${b}, ${innerGlowOpacity});
}

/* Pastikan konten tetap di atas pseudo-elements */
${target} > * {
    position: relative;
    z-index: 2;
}
/* ─────────────────────────────────────────────────────── */
`;
}

// ─── Settings ─────────────────────────────────────────────────────────────────

const settings = definePluginSettings({
    imagePath: {
        type: OptionType.STRING,
        description: "Path file gambar di komputer kamu (contoh: C:\\Users\\kamu\\Pictures\\bg.png atau /home/kamu/bg.jpg). Support: PNG, JPG, WEBP, GIF",
        default: "",
        placeholder: "C:\\Users\\kamu\\Pictures\\background.png",
        onChange: () => applyBackground(),
    },

    coverMode: {
        type: OptionType.SELECT,
        description: "Area yang diberi background",
        options: [
            { label: "Chat saja (area pesan)", value: "chat", default: true },
            { label: "Seluruh tampilan Discord", value: "full" },
        ] as const,
        onChange: () => applyBackground(),
    },

    opacity: {
        type: OptionType.SLIDER,
        description: "Opacity background gambar (0 = transparan, 100 = penuh)",
        default: 30,
        markers: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
        stickToMarkers: false,
        onChange: () => applyBackground(),
    },

    backgroundSize: {
        type: OptionType.SELECT,
        description: "Ukuran background",
        options: [
            { label: "Cover (memenuhi area, mungkin terpotong)", value: "cover", default: true },
            { label: "Contain (seluruh gambar terlihat)", value: "contain" },
            { label: "Asli (ukuran sebenarnya)", value: "auto" },
            { label: "Stretch (memenuhi persis, mungkin terdistorsi)", value: "100% 100%" },
        ] as const,
        onChange: () => applyBackground(),
    },

    backgroundPosition: {
        type: OptionType.SELECT,
        description: "Posisi background",
        options: [
            { label: "Tengah", value: "center", default: true },
            { label: "Atas", value: "top center" },
            { label: "Bawah", value: "bottom center" },
            { label: "Kiri", value: "center left" },
            { label: "Kanan", value: "center right" },
        ] as const,
        onChange: () => applyBackground(),
    },

    glowColor: {
        type: OptionType.STRING,
        description: "Warna inner glow di tepi (format HEX, contoh: #7c3aed)",
        default: "#000000",
        placeholder: "#000000",
        onChange: () => applyBackground(),
    },

    glowSize: {
        type: OptionType.SLIDER,
        description: "Ukuran inner glow (px) — makin besar makin lebar efek tepinya",
        default: 60,
        markers: [0, 20, 40, 60, 80, 100, 150, 200],
        stickToMarkers: false,
        onChange: () => applyBackground(),
    },

    glowOpacity: {
        type: OptionType.SLIDER,
        description: "Opacity inner glow (0 = tidak ada, 100 = penuh)",
        default: 70,
        markers: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
        stickToMarkers: false,
        onChange: () => applyBackground(),
    },
});

// ─── Core Logic ───────────────────────────────────────────────────────────────

let cachedDataUrl: string | null = null;
let cachedPath: string = "";

async function applyBackground() {
    const path = settings.store.imagePath?.trim();

    if (!path) {
        removeStyle();
        cachedDataUrl = null;
        cachedPath = "";
        logger.info("Tidak ada gambar — background dihapus.");
        return;
    }

    // Hanya re-fetch kalau path berubah
    if (path !== cachedPath || !cachedDataUrl) {
        logger.info(`Membaca gambar dari: ${path}`);
        const dataUrl = await Native.readImageAsDataUrl(path);
        if (!dataUrl) {
            logger.error(`Gagal membaca file: ${path}`);
            removeStyle();
            return;
        }
        cachedDataUrl = dataUrl;
        cachedPath = path;
        logger.info("Gambar berhasil dimuat!");
    }

    const css = buildCSS(
        cachedDataUrl,
        settings.store.opacity ?? 30,
        settings.store.coverMode ?? "chat",
        settings.store.glowColor ?? "#000000",
        settings.store.glowSize ?? 60,
        settings.store.glowOpacity ?? 70,
        settings.store.backgroundSize ?? "cover",
        settings.store.backgroundPosition ?? "center",
    );

    const style = getOrCreateStyle();
    style.textContent = css;

    logger.info("Background CSS diterapkan.");
}

// ─── Plugin Definition ────────────────────────────────────────────────────────

export default definePlugin({
    name: "chatBackground",
    description:
        "Pasang gambar sebagai background chat (atau seluruh Discord) dari file lokal di komputermu. " +
        "Support PNG, JPG, WEBP, GIF. Bisa atur opacity, ukuran, posisi, dan efek inner glow di tepi.",
    tags: ["Appearance", "Customisation", "Theme"],
    authors: [{ name: "kintil555", id: 0n }],

    settings,

    startAt: StartAt.DOMContentLoaded,

    start() {
        logger.info("ChatBackground plugin aktif!");
        applyBackground();
    },

    stop() {
        logger.info("ChatBackground plugin dinonaktifkan — background dihapus.");
        removeStyle();
        cachedDataUrl = null;
        cachedPath = "";
    },
});
