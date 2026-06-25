/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType, ApplicationCommandOptionType, findOption, sendBotMessage } from "@api/Commands";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import { ModalCloseButton, ModalContent, ModalFooter, ModalHeader, ModalRoot, openModal } from "@utils/modal";
import definePlugin from "@utils/types";
import { GuildStore, RestAPI, Toasts, UserStore, useState } from "@webpack/common";

const logger = new Logger("NickSync");

// ========================
// Core: set nickname di satu guild
// ========================

async function setNickInGuild(guildId: string, nick: string): Promise<{ guildId: string; success: boolean; error?: string; }> {
    try {
        await RestAPI.patch({
            url: `/guilds/${guildId}/members/@me`,
            body: { nick: nick.trim() || null },
        });
        return { guildId, success: true };
    } catch (e: any) {
        const reason = e?.body?.message ?? e?.message ?? "Unknown error";
        logger.error(`Failed to set nick in guild ${guildId}:`, reason);
        return { guildId, success: false, error: reason };
    }
}

// ========================
// Core: sync nickname ke semua/sebagian guild
// ========================

async function syncNickToGuilds(nick: string, guildIds?: string[]): Promise<{ ok: string[]; fail: Array<{ name: string; reason: string; }>; }> {
    const guilds = GuildStore.getGuilds();
    const targets = guildIds ?? Object.keys(guilds);

    // Batch dengan delay 300ms antar request biar tidak rate-limit
    const results: Awaited<ReturnType<typeof setNickInGuild>>[] = [];
    for (const guildId of targets) {
        const result = await setNickInGuild(guildId, nick);
        results.push(result);
        if (targets.length > 1) await new Promise(r => setTimeout(r, 300));
    }

    const ok = results.filter(r => r.success).map(r => r.guildId);
    const fail = results
        .filter(r => !r.success)
        .map(r => ({
            name: guilds[r.guildId]?.name ?? r.guildId,
            reason: r.error ?? "Unknown"
        }));

    return { ok, fail };
}

// ========================
// Modal: pilih server + isi nickname
// ========================

function NickSyncModal({ modalProps, initialNick = "" }: { modalProps: any; initialNick?: string; }) {
    const [nick, setNick] = useState(initialNick);
    const [loading, setLoading] = useState(false);
    const [selectedGuilds, setSelectedGuilds] = useState<Set<string>>(new Set());
    const [selectAll, setSelectAll] = useState(true);
    const [done, setDone] = useState<{ ok: number; fail: Array<{ name: string; reason: string; }>; } | null>(null);

    const allGuilds = GuildStore.getGuildsArray();

    function toggleGuild(id: string) {
        setSelectedGuilds((prev: Set<string>) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
        setSelectAll(false);
    }

    function toggleAll() {
        setSelectAll((v: boolean) => !v);
        setSelectedGuilds(new Set());
    }

    async function handleApply() {
        setLoading(true);
        try {
            const targets = selectAll ? undefined : [...selectedGuilds];
            const { ok, fail } = await syncNickToGuilds(nick, targets);
            setDone({ ok: ok.length, fail });
        } finally {
            setLoading(false);
        }
    }

    const canApply = !loading && (nick.trim().length > 0 || nick === "") && (selectAll || selectedGuilds.size > 0);

    const inputStyle: React.CSSProperties = {
        width: "100%",
        padding: "8px 12px",
        background: "var(--input-background)",
        border: "1px solid var(--input-border)",
        borderRadius: "4px",
        color: "var(--text-normal)",
        fontSize: "14px",
        outline: "none",
        boxSizing: "border-box",
    };

    const checkboxRowStyle: React.CSSProperties = {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "4px 0",
        cursor: "pointer",
        color: "var(--text-normal)",
        fontSize: "13px",
    };

    const guildListStyle: React.CSSProperties = {
        maxHeight: "200px",
        overflowY: "auto",
        border: "1px solid var(--background-modifier-accent)",
        borderRadius: "4px",
        padding: "4px 8px",
        background: "var(--background-secondary)",
    };

    if (done) {
        return (
            <ModalRoot {...modalProps}>
                <ModalHeader>
                    <div style={{ fontWeight: 700, fontSize: "16px", color: "var(--header-primary)" }}>
                        NickSync — Selesai!
                    </div>
                    <ModalCloseButton onClick={modalProps.onClose} />
                </ModalHeader>
                <ModalContent>
                    <div style={{ padding: "16px 0", display: "flex", flexDirection: "column", gap: "12px" }}>
                        <div style={{ color: "var(--status-positive)", fontSize: "14px" }}>
                            ✅ Berhasil di <strong>{done.ok}</strong> server
                            {nick.trim() ? ` dengan nickname "${nick.trim()}"` : " (nickname dihapus)"}
                        </div>
                        {done.fail.length > 0 && (
                            <div style={{ color: "var(--status-danger)", fontSize: "13px" }}>
                                <div style={{ fontWeight: 600, marginBottom: "4px" }}>❌ Gagal di {done.fail.length} server:</div>
                                {done.fail.map(f => (
                                    <div key={f.name} style={{ paddingLeft: "8px", color: "var(--text-muted)" }}>
                                        • <strong>{f.name}</strong>: {f.reason}
                                    </div>
                                ))}
                                <div style={{ marginTop: "8px", fontSize: "12px", color: "var(--text-muted)" }}>
                                    Kemungkinan kamu tidak punya izin ganti nickname di server tersebut.
                                </div>
                            </div>
                        )}
                    </div>
                </ModalContent>
                <ModalFooter>
                    <button
                        onClick={modalProps.onClose}
                        style={{
                            padding: "8px 16px",
                            background: "var(--brand-experiment)",
                            color: "white",
                            border: "none",
                            borderRadius: "4px",
                            cursor: "pointer",
                            fontWeight: 600,
                        }}
                    >
                        Tutup
                    </button>
                </ModalFooter>
            </ModalRoot>
        );
    }

    return (
        <ModalRoot {...modalProps}>
            <ModalHeader>
                <div style={{ fontWeight: 700, fontSize: "16px", color: "var(--header-primary)" }}>
                    NickSync — Ganti Nickname di Semua Server
                </div>
                <ModalCloseButton onClick={modalProps.onClose} />
            </ModalHeader>
            <ModalContent>
                <div style={{ padding: "12px 0", display: "flex", flexDirection: "column", gap: "14px" }}>

                    {/* Input nickname */}
                    <div>
                        <div style={{ fontSize: "12px", fontWeight: 700, color: "var(--text-muted)", marginBottom: "6px", textTransform: "uppercase" }}>
                            Nickname Baru
                        </div>
                        <input
                            style={inputStyle}
                            value={nick}
                            onChange={e => setNick((e.target as HTMLInputElement).value)}
                            placeholder="Kosongkan untuk menghapus nickname"
                            maxLength={32}
                            disabled={loading}
                        />
                        <div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "4px" }}>
                            {nick.length}/32 karakter • Kosongkan = hapus nickname
                        </div>
                    </div>

                    {/* Pilih server */}
                    <div>
                        <div style={{ fontSize: "12px", fontWeight: 700, color: "var(--text-muted)", marginBottom: "6px", textTransform: "uppercase" }}>
                            Target Server ({allGuilds.length} server)
                        </div>

                        {/* Select all toggle */}
                        <label style={checkboxRowStyle}>
                            <input
                                type="checkbox"
                                checked={selectAll}
                                onChange={toggleAll}
                                disabled={loading}
                            />
                            <span style={{ fontWeight: 600 }}>Semua server</span>
                        </label>

                        {/* Per-guild list (hanya tampil kalau selectAll = false) */}
                        {!selectAll && (
                            <div style={guildListStyle}>
                                {allGuilds.map(guild => (
                                    <label key={guild.id} style={checkboxRowStyle}>
                                        <input
                                            type="checkbox"
                                            checked={selectedGuilds.has(guild.id)}
                                            onChange={() => toggleGuild(guild.id)}
                                            disabled={loading}
                                        />
                                        <span>{guild.name}</span>
                                    </label>
                                ))}
                            </div>
                        )}
                    </div>

                    {loading && (
                        <div style={{ color: "var(--text-muted)", fontSize: "13px" }}>
                            ⏳ Sedang mengirim ke server... (ada delay kecil antar request agar tidak rate-limit)
                        </div>
                    )}
                </div>
            </ModalContent>
            <ModalFooter>
                <button
                    onClick={modalProps.onClose}
                    disabled={loading}
                    style={{
                        padding: "8px 16px",
                        background: "var(--background-modifier-accent)",
                        color: "var(--text-normal)",
                        border: "none",
                        borderRadius: "4px",
                        cursor: loading ? "not-allowed" : "pointer",
                        marginRight: "8px",
                    }}
                >
                    Batal
                </button>
                <button
                    onClick={handleApply}
                    disabled={!canApply}
                    style={{
                        padding: "8px 16px",
                        background: canApply ? "var(--brand-experiment)" : "var(--background-modifier-accent)",
                        color: canApply ? "white" : "var(--text-muted)",
                        border: "none",
                        borderRadius: "4px",
                        cursor: canApply ? "pointer" : "not-allowed",
                        fontWeight: 600,
                    }}
                >
                    {loading ? "Memproses..." : `Terapkan ke ${selectAll ? "Semua" : selectedGuilds.size} Server`}
                </button>
            </ModalFooter>
        </ModalRoot>
    );
}

// ========================
// Plugin
// ========================

export default definePlugin({
    name: "NickSync",
    description: "Ganti nickname kamu di semua (atau beberapa) server Discord sekaligus dengan satu klik.",
    authors: [Devs.kintil555],
    tags: ["nickname", "nick", "sync", "qol"],

    commands: [
        {
            name: "nicksync",
            description: "Ganti nickname kamu di semua server sekaligus",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "nickname",
                    description: "Nickname baru (kosongkan untuk hapus nickname di semua server)",
                    type: ApplicationCommandOptionType.STRING,
                    required: false,
                },
            ],
            async execute(opts, ctx) {
                const nick = findOption<string>(opts, "nickname", "");
                const me = UserStore.getCurrentUser();
                if (!me) return sendBotMessage(ctx.channel.id, { content: "❌ Gagal mendapatkan data user." });

                sendBotMessage(ctx.channel.id, { content: `⏳ NickSync: Mengirim nickname "${nick || "(hapus)"}" ke semua server...` });

                const { ok, fail } = await syncNickToGuilds(nick);

                const msg = [
                    `✅ NickSync selesai!`,
                    `• Berhasil: **${ok.length}** server`,
                    fail.length > 0
                        ? `• Gagal: **${fail.length}** server (${fail.map(f => f.name).join(", ")})`
                        : null,
                ].filter(Boolean).join("\n");

                sendBotMessage(ctx.channel.id, { content: msg });
            }
        }
    ],

    openModal() {
        openModal(props => <NickSyncModal modalProps={props} />);
    },

    toolboxActions: {
        "Ganti Nickname di Semua Server"() {
            openModal(props => <NickSyncModal modalProps={props} />);
        }
    },

    start() {
        logger.info("NickSync aktif — pakai /nicksync atau buka via Vencord Toolbox");
        Toasts.show({
            message: "NickSync aktif! Gunakan /nicksync atau Vencord Toolbox",
            type: Toasts.Type.SUCCESS,
            id: Toasts.genId(),
            options: { duration: 3000 },
        });
    },

    stop() {
        logger.info("NickSync nonaktif");
    },
});
