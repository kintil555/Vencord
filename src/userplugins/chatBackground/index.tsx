/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative, StartAt } from "@utils/types";

// ─── Native bridge ────────────────────────────────────────────────────────────

const Native = VencordNative.pluginHelpers.chatBackground as PluginNative<typeof import("./native")>;
const logger = new Logger("ChatBackground", "#a78bfa");

// ─── Style injection ──────────────────────────────────────────────────────────

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

// ─── CSS builder ──────────────────────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] {
    const clean = hex.replace("#", "").padEnd(6, "0");
    return [
        parseInt(clean.substring(0, 2), 16) || 0,
        parseInt(clean.substring(2, 4), 16) || 0,
        parseInt(clean.substring(4, 6), 16) || 0,
    ];
}

function buildCSS(
    dataUrl: string,
    opacity: number,
    mode: "chat" | "full",
    bgSize: string,
    bgPos: string,
    glowEnabled: boolean,
    glowColor: string,
    glowSize: number,
    glowOpacity: number,
): string {
    const bgOpacity = (opacity / 100).toFixed(3);
    const [r, g, b] = hexToRgb(glowColor);
    const glowAlpha = (glowOpacity / 100).toFixed(3);
    const glow = glowEnabled
        ? `0 0 ${glowSize}px rgba(${r},${g},${b},${glowAlpha})`
        : "none";

    // Background gambar dipasang langsung ke elemen container Discord.
    // TIDAK pakai position:fixed atau z-index — biar tidak ada overlay.
    // Pakai CSS custom property supaya bisa dipakai di mana saja.
    const chatBg = `
/* ── ChatBackground: background area ──────────────────── */
:root {
    --cbg-image: url("${dataUrl}");
    --cbg-size: ${bgSize};
    --cbg-pos: ${bgPos};
    --cbg-opacity: ${bgOpacity};
}`;

    // Mode chat: hanya area scroll pesan
    const chatTarget = `
/* background di area chat */
[class*="messagesWrapper_"],
[class*="chatContent_"] {
    background-image: var(--cbg-image) !important;
    background-size: var(--cbg-size) !important;
    background-position: var(--cbg-pos) !important;
    background-repeat: no-repeat !important;
    background-attachment: local !important;
    background-color: transparent !important;
}

/* Kurangi opacity teks container di atasnya agar gambar tembus */
[class*="messagesWrapper_"]::before,
[class*="chatContent_"]::before {
    content: none !important;
}`;

    // Mode full: seluruh app Discord
    const fullTarget = `
/* background di seluruh app */
#app-mount {
    background-image: var(--cbg-image) !important;
    background-size: var(--cbg-size) !important;
    background-position: var(--cbg-pos) !important;
    background-repeat: no-repeat !important;
    background-attachment: fixed !important;
}

/* Buat panel-panel Discord semi-transparan agar background keliatan */
[class*="sidebar_"],
[class*="panels_"],
[class*="content_"],
[class*="chat_"],
[class*="base_"],
[class*="container_"] {
    background-color: transparent !important;
}

/* Kembalikan opacity untuk elemen yang harusnya solid */
[class*="attachment_"],
[class*="embed_"],
[class*="popout_"],
[class*="modal_"],
[class*="menu_"],
[class*="tooltip_"] {
    background-color: var(--background-secondary) !important;
}`;

    const bgSection = mode === "chat" ? chatTarget : fullTarget;

    // Opacity overlay tipis di atas background — pakai pseudo di #app-mount
    // pointer-events: none jadi TIDAK blocking klik sama sekali
    const overlaySection = `
/* Overlay transparan untuk kontrol opacity gambar — pointer-events: none! */
#app-mount::before {
    content: "";
    position: fixed;
    inset: 0;
    z-index: -1;
    pointer-events: none !important;
    background-image: var(--cbg-image);
    background-size: var(--cbg-size);
    background-position: var(--cbg-pos);
    background-repeat: no-repeat;
    background-attachment: fixed;
    opacity: var(--cbg-opacity);
}

/* Reset background dari elemen utama kalau mode full */
${mode === "full" ? `#app-mount {
    background-image: none !important;
    background-color: transparent !important;
}

[class*="bg_"],
[class*="background_"] {
    background: transparent !important;
}` : ""}`;

    // Inner glow di elemen UI: tombol, panel, sidebar, input, dll.
    // box-shadow INWARD — tidak ada pseudo-element, tidak blocking klik
    const glowSection = glowEnabled ? `
/* ── ChatBackground: inner glow di elemen UI ──────────── */

/* Tombol-tombol */
[class*="button_"]:not([class*="buttonColor_"]),
button[class*="lookFilled_"],
button[class*="lookOutlined_"],
button[class*="lookLink_"],
[role="button"] {
    box-shadow: inset 0 0 ${glowSize}px rgba(${r},${g},${b},${glowAlpha}) !important;
}

/* Panel sidebar kiri (list channel) */
[class*="sidebar_"] {
    box-shadow: inset 0 0 ${Math.round(glowSize * 1.5)}px rgba(${r},${g},${b},${(parseFloat(glowAlpha) * 0.6).toFixed(3)}) !important;
}

/* Panel member list kanan */
[class*="members_"],
[class*="membersWrap_"] {
    box-shadow: inset 0 0 ${Math.round(glowSize * 1.2)}px rgba(${r},${g},${b},${(parseFloat(glowAlpha) * 0.5).toFixed(3)}) !important;
}

/* Area input pesan di bawah */
[class*="channelTextArea_"],
[class*="textArea_"] {
    box-shadow: inset 0 0 ${glowSize}px rgba(${r},${g},${b},${(parseFloat(glowAlpha) * 0.7).toFixed(3)}) !important;
}

/* Header channel atas */
[class*="header_"][class*="chat_"],
[class*="toolbar_"] {
    box-shadow: inset 0 0 ${glowSize}px rgba(${r},${g},${b},${(parseFloat(glowAlpha) * 0.5).toFixed(3)}) !important;
}

/* Icon tombol kecil di toolbar */
[class*="iconWrapper_"],
[class*="icon_"] button {
    box-shadow: inset 0 0 ${Math.round(glowSize * 0.5)}px rgba(${r},${g},${b},${(parseFloat(glowAlpha) * 0.8).toFixed(3)}) !important;
}

/* Voice/video control panel */
[class*="connection_"],
[class*="voiceDetails_"] {
    box-shadow: inset 0 0 ${glowSize}px rgba(${r},${g},${b},${glowAlpha}) !important;
}` : "";

    return [chatBg, bgSection, overlaySection, glowSection, "/* ─────────────────────────────── */"].join("\n");
}

// ─── Settings ─────────────────────────────────────────────────────────────────

const settings = definePluginSettings({
    imagePath: {
        type: OptionType.STRING,
        description: "Path file gambar di komputer (contoh: C:\\Users\\kamu\\Pictures\\bg.png). Support: PNG, JPG, WEBP, GIF",
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
        description: "Opacity gambar background (0 = tidak terlihat, 100 = penuh)",
        default: 25,
        markers: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
        stickToMarkers: false,
        onChange: () => applyBackground(),
    },

    backgroundSize: {
        type: OptionType.SELECT,
        description: "Ukuran gambar background",
        options: [
            { label: "Cover (memenuhi area)", value: "cover", default: true },
            { label: "Contain (gambar penuh terlihat)", value: "contain" },
            { label: "Asli (ukuran file)", value: "auto" },
            { label: "Stretch (memenuhi persis)", value: "100% 100%" },
        ] as const,
        onChange: () => applyBackground(),
    },

    backgroundPosition: {
        type: OptionType.SELECT,
        description: "Posisi gambar background",
        options: [
            { label: "Tengah", value: "center", default: true },
            { label: "Atas tengah", value: "top center" },
            { label: "Bawah tengah", value: "bottom center" },
            { label: "Kiri tengah", value: "center left" },
            { label: "Kanan tengah", value: "center right" },
        ] as const,
        onChange: () => applyBackground(),
    },

    glowEnabled: {
        type: OptionType.BOOLEAN,
        description: "Aktifkan inner glow di elemen UI (tombol, sidebar, input box, dll.)",
        default: true,
        onChange: () => applyBackground(),
    },

    glowColor: {
        type: OptionType.STRING,
        description: "Warna inner glow — format HEX (contoh: #7c3aed untuk ungu, #1e40af untuk biru)",
        default: "#5865f2",
        placeholder: "#5865f2",
        onChange: () => applyBackground(),
    },

    glowSize: {
        type: OptionType.SLIDER,
        description: "Ukuran spread inner glow (px) di setiap elemen UI",
        default: 12,
        markers: [0, 4, 8, 12, 16, 20, 30, 40],
        stickToMarkers: false,
        onChange: () => applyBackground(),
    },

    glowOpacity: {
        type: OptionType.SLIDER,
        description: "Opacity inner glow di elemen UI (0-100)",
        default: 40,
        markers: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
        stickToMarkers: false,
        onChange: () => applyBackground(),
    },
});

// ─── Core logic ───────────────────────────────────────────────────────────────

let cachedDataUrl: string | null = null;
let cachedPath = "";

async function applyBackground() {
    const path = settings.store.imagePath?.trim();

    if (!path) {
        removeStyle();
        cachedDataUrl = null;
        cachedPath = "";
        return;
    }

    if (path !== cachedPath || !cachedDataUrl) {
        logger.info(`Membaca: ${path}`);
        const dataUrl = await Native.readImageAsDataUrl(path);
        if (!dataUrl) {
            logger.error(`Gagal baca file: ${path}`);
            removeStyle();
            return;
        }
        cachedDataUrl = dataUrl;
        cachedPath = path;
    }

    const css = buildCSS(
        cachedDataUrl,
        settings.store.opacity ?? 25,
        settings.store.coverMode ?? "chat",
        settings.store.backgroundSize ?? "cover",
        settings.store.backgroundPosition ?? "center",
        settings.store.glowEnabled ?? true,
        settings.store.glowColor ?? "#5865f2",
        settings.store.glowSize ?? 12,
        settings.store.glowOpacity ?? 40,
    );

    getOrCreateStyle().textContent = css;
    logger.info("CSS diterapkan.");
}

// ─── Plugin definition ────────────────────────────────────────────────────────

export default definePlugin({
    name: "chatBackground",
    description:
        "Pasang gambar sebagai background dari file lokal. " +
        "Support PNG/JPG/WEBP/GIF. Atur opacity, ukuran, posisi. " +
        "Inner glow di tombol & panel UI agar mudah dibedakan.",
    tags: ["Appearance", "Customisation", "Theme"],
    authors: [{ name: "kintil555", id: 0n }],

    settings,
    startAt: StartAt.DOMContentLoaded,

    start() {
        applyBackground();
    },

    stop() {
        removeStyle();
        cachedDataUrl = null;
        cachedPath = "";
    },
});
