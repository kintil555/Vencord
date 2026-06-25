/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Flex } from "@components/Flex";
import { Paragraph } from "@components/Paragraph";
import { Span } from "@components/Span";
import { OptionType } from "@utils/types";
import { React, TextArea, TextInput } from "@webpack/common";

// ───────────────────────────── Default values ─────────────────────────────

const DEFAULT_TRIGGERS = "hai, halo, hello, yo, apa kabar";
const DEFAULT_REPLIES = [
    "Hai juga! 👋",
    "Halo! Ada yang bisa dibantu? 😊",
    "Yo! Apa kabar?",
    "Hei! 👋 Apa kabar nih?",
    "Halo halo~ 🙌",
].join("\n");

// ───────────────────────────── Settings UI ─────────────────────────────

function AutoGreetSettingsUI() {
    const {
        enabled,
        triggerWords,
        replyVariants,
        delaySeconds,
        cooldownSeconds,
    } = settings.use(["enabled", "triggerWords", "replyVariants", "delaySeconds", "cooldownSeconds"]);

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>

            {/* Toggle aktif/nonaktif */}
            <div>
                <Flex alignItems="center" gap="0.5em">
                    <input
                        id="agr-enabled"
                        type="checkbox"
                        checked={!!enabled}
                        onChange={e => { settings.store.enabled = e.target.checked; }}
                        style={{ cursor: "pointer" }}
                    />
                    <label htmlFor="agr-enabled" style={{ cursor: "pointer" }}>
                        <Span weight="medium">Aktifkan Auto Reply Sapaan</Span>
                    </label>
                </Flex>
                <Paragraph size="sm" style={{ color: "var(--text-muted)", marginTop: "4px" }}>
                    Kalau dimatikan, plugin tidak akan membalas pesan apapun.
                </Paragraph>
            </div>

            {/* Trigger words */}
            <div>
                <Span weight="medium">Kata Pemicu (pisahkan dengan koma)</Span>
                <Paragraph size="sm" style={{ color: "var(--text-muted)", margin: "4px 0" }}>
                    Plugin akan merespons jika pesan orang <em>mengandung</em> salah satu kata ini.
                    Misalnya "halo guys" akan terdeteksi karena ada kata "halo".
                </Paragraph>
                <TextInput
                    value={triggerWords ?? DEFAULT_TRIGGERS}
                    onChange={(v: string) => { settings.store.triggerWords = v; }}
                    placeholder={DEFAULT_TRIGGERS}
                />
            </div>

            {/* Reply variants */}
            <div>
                <Span weight="medium">Variasi Balasan (1 baris = 1 balasan)</Span>
                <Paragraph size="sm" style={{ color: "var(--text-muted)", margin: "4px 0" }}>
                    Plugin akan memilih satu balasan secara acak dari daftar ini setiap kali ada sapaan masuk.
                    Kamu bisa tambah sebanyak mungkin baris.
                </Paragraph>
                <TextArea
                    value={replyVariants ?? DEFAULT_REPLIES}
                    onChange={(v: string) => { settings.store.replyVariants = v; }}
                    placeholder={DEFAULT_REPLIES}
                    rows={6}
                />
            </div>

            {/* Delay & Cooldown */}
            <Flex gap="1.5em" flexDirection="row" flexWrap="wrap">
                <div style={{ flex: "1", minWidth: "150px" }}>
                    <Span weight="medium">Delay sebelum balas (detik)</Span>
                    <Paragraph size="sm" style={{ color: "var(--text-muted)", margin: "4px 0" }}>
                        Jeda antara sapaan masuk dan balasan terkirim. Default: 10 detik.
                    </Paragraph>
                    <TextInput
                        type="number"
                        value={String(delaySeconds ?? 10)}
                        onChange={(v: string) => {
                            const n = parseInt(v, 10);
                            settings.store.delaySeconds = Number.isFinite(n) && n >= 0 ? n : 10;
                        }}
                    />
                </div>
                <div style={{ flex: "1", minWidth: "150px" }}>
                    <Span weight="medium">Cooldown per channel (detik)</Span>
                    <Paragraph size="sm" style={{ color: "var(--text-muted)", margin: "4px 0" }}>
                        Setelah membalas, plugin diam selama ini di channel yang sama. Default: 15 detik.
                    </Paragraph>
                    <TextInput
                        type="number"
                        value={String(cooldownSeconds ?? 15)}
                        onChange={(v: string) => {
                            const n = parseInt(v, 10);
                            settings.store.cooldownSeconds = Number.isFinite(n) && n >= 0 ? n : 15;
                        }}
                    />
                </div>
            </Flex>

            {/* Info */}
            <Paragraph size="sm" style={{ color: "var(--text-muted)", borderTop: "1px solid var(--background-modifier-accent)", paddingTop: "8px" }}>
                ℹ️ Plugin hanya membalas pesan dari <strong>pengguna lain</strong> (bukan pesan diri sendiri).
                Markdown didukung di variasi balasan: <code>**bold**</code>, <code>*italic*</code>, emoji, dll.
            </Paragraph>
        </div>
    );
}

// ───────────────────────────── definePluginSettings ─────────────────────────────

export const settings = definePluginSettings({
    ui: {
        type: OptionType.COMPONENT,
        component: AutoGreetSettingsUI,
    },
    enabled: {
        type: OptionType.CUSTOM,
        default: true,
    },
    triggerWords: {
        type: OptionType.CUSTOM,
        default: DEFAULT_TRIGGERS,
    },
    replyVariants: {
        type: OptionType.CUSTOM,
        default: DEFAULT_REPLIES,
    },
    delaySeconds: {
        type: OptionType.CUSTOM,
        default: 10,
    },
    cooldownSeconds: {
        type: OptionType.CUSTOM,
        default: 15,
    },
});
