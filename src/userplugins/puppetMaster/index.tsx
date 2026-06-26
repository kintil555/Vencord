/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import { sendMessage } from "@utils/discord";
import definePlugin, { OptionType } from "@utils/types";
import {
    ChannelStore,
    FluxDispatcher,
    GuildChannelStore,
    GuildStore,
    MessageActions,
    MessageStore,
    React,
    SearchableSelect,
    Toasts,
    UserStore,
    useState,
} from "@webpack/common";

const logger = new Logger("PuppetMaster", "#e879f9");

// ─── State ────────────────────────────────────────────────────────────────────

let muteUntil: number | null = null;
let muteTimer: ReturnType<typeof setTimeout> | null = null;
let lastCommandAt = 0;
let pendingTimeout: ReturnType<typeof setTimeout> | null = null;

// ─── Forward memory ───────────────────────────────────────────────────────────
// Discord kirim forward dan teks sebagai 2 pesan TERPISAH.
// Simpan forward terakhir per userId, lalu match dengan !reply berikutnya.

interface ForwardEntry {
    msgId: string;
    channelId: string;
    at: number;
}

const pendingForwards = new Map<string, ForwardEntry>();
const FORWARD_EXPIRE_MS = 60_000; // expire setelah 60 detik

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isMuted(): boolean {
    if (muteUntil === null) return false;
    if (Date.now() >= muteUntil) { muteUntil = null; return false; }
    return true;
}

function getRemainingMute(): number {
    if (!isMuted() || muteUntil === null) return 0;
    return Math.ceil((muteUntil - Date.now()) / 1000);
}

function containsBannedWord(text: string): string | null {
    const banned = (settings.store.bannedWords ?? "")
        .split(",")
        .map((w: string) => w.trim().toLowerCase())
        .filter(Boolean);
    const lower = text.toLowerCase();
    return banned.find((w: string) => lower.includes(w)) ?? null;
}

function toast(msg: string, type: number = Toasts.Type.MESSAGE) {
    Toasts.show({ id: Toasts.genId(), message: msg, type });
}

function isInDM(channelId: string): boolean {
    return ChannelStore.getChannel(channelId)?.type === 1;
}

// ─── Core actions ─────────────────────────────────────────────────────────────

async function doSay(content: string, requester: string) {
    const { targetChannelId, targetGuildId } = settings.store;
    if (!targetChannelId || !targetGuildId) {
        logger.warn("Target channel/guild belum diatur.");
        return;
    }
    try {
        await sendMessage(targetChannelId, { content }, true);
        logger.info(`[SAY] "${content}" oleh ${requester}`);
        toast(`Pesan dikirim atas perintah ${requester}`, Toasts.Type.SUCCESS);
    } catch (e: any) {
        logger.error("Gagal kirim:", e?.message);
        toast(`Gagal kirim: ${e?.message ?? "Unknown"}`, Toasts.Type.FAILURE);
    }
}

async function doReply(targetMsgId: string, targetMsgChannelId: string, replyContent: string, requester: string) {
    const { targetChannelId } = settings.store;
    if (!targetChannelId) { logger.warn("Target channel belum diatur."); return; }

    if (targetMsgChannelId !== targetChannelId) {
        toast("Pesan yang di-forward bukan dari channel target.", Toasts.Type.FAILURE);
        return;
    }

    const channel = ChannelStore.getChannel(targetChannelId);
    const message = MessageStore.getMessage(targetChannelId, targetMsgId);

    if (!channel || !message) {
        toast("Pesan target tidak ada di cache. Coba buka channel-nya dulu.", Toasts.Type.FAILURE);
        return;
    }

    try {
        const options = MessageActions.getSendMessageOptionsForReply({
            channel,
            message,
            shouldMention: true,
            showMentionToggle: false,
        });

        await MessageActions.sendMessage(
            targetChannelId,
            { content: replyContent, tts: false, invalidEmojis: [], validNonShortcutEmojis: [] },
            true,
            options
        );

        logger.info(`[REPLY] "${replyContent}" ke ${targetMsgId} oleh ${requester}`);
        toast(`Reply dikirim atas perintah ${requester}`, Toasts.Type.SUCCESS);
    } catch (e: any) {
        logger.error("Gagal reply:", e?.message);
        toast(`Gagal reply: ${e?.message ?? "Unknown"}`, Toasts.Type.FAILURE);
    }
}

function doMute(durationSec: number, requester: string) {
    const maxSec = settings.store.maxMuteDuration ?? 30;
    const actualSec = Math.min(durationSec, maxSec);

    if (muteTimer) clearTimeout(muteTimer);
    muteUntil = Date.now() + actualSec * 1000;
    muteTimer = setTimeout(() => {
        muteUntil = null;
        muteTimer = null;
        toast("Kamu sudah tidak di-mute.", Toasts.Type.SUCCESS);
    }, actualSec * 1000);

    logger.info(`[MUTE] ${actualSec}s oleh ${requester}`);
    toast(`${requester} mute kamu selama ${actualSec} detik!`, Toasts.Type.FAILURE);
}

// ─── Message handler ──────────────────────────────────────────────────────────

function handleMessageCreate({ message }: { message: any; }) {
    const myId = UserStore.getCurrentUser()?.id;

    if (!isInDM(message.channel_id)) return;
    if (message.author?.id === myId) return;
    if (message.author?.bot) return;

    const requester: string = message.author?.username ?? "Unknown";
    const userId: string = message.author?.id ?? "";
    const content: string = (message.content ?? "").trim();

    const sayPrefix = (settings.store.sayPrefix ?? "!say").trim();
    const replyPrefix = (settings.store.replyPrefix ?? "!reply").trim();
    const mutePrefix = (settings.store.mutePrefix ?? "!mute").trim();

    // ── !mute (bypass mute & cooldown) ──
    if (content.startsWith(mutePrefix)) {
        const afterMute = content.slice(mutePrefix.length).trim();
        const dur = parseInt(afterMute, 10);
        doMute(isNaN(dur) || dur <= 0 ? (settings.store.maxMuteDuration ?? 30) : dur, requester);
        return;
    }

    // ── Deteksi forward masuk (pesan tanpa command, tapi ada snapshot/reference) ──
    // Discord kirim forward sebagai pesan terpisah dari command-nya.
    // Kita simpan ke pendingForwards dan tunggu !reply dari user yang sama.
    const ref = message.message_reference;
    const snapshots = message.message_snapshots;
    const hasForward = snapshots?.length > 0 || ref?.type === 1;
    const isCommandMsg = content.startsWith(sayPrefix) || content.startsWith(replyPrefix) || content.startsWith(mutePrefix);

    if (hasForward && !isCommandMsg) {
        let fwdMsgId: string | null = null;
        let fwdChannelId: string | null = null;

        if (snapshots?.[0]?.message?.id) {
            fwdMsgId = snapshots[0].message.id;
            fwdChannelId = snapshots[0].message.channel_id ?? null;
        } else if (ref?.message_id) {
            fwdMsgId = ref.message_id;
            fwdChannelId = ref.channel_id ?? null;
        }

        if (fwdMsgId && fwdChannelId) {
            pendingForwards.set(userId, { msgId: fwdMsgId, channelId: fwdChannelId, at: Date.now() });
            logger.info(`Forward disimpan dari ${requester}: msgId=${fwdMsgId}`);
            toast(`Forward dari ${requester} diterima ✓ — sekarang ketik !reply <teks>`, Toasts.Type.MESSAGE);
        }
        return;
    }

    // Cek mute sebelum proses !say / !reply
    if (isMuted()) {
        logger.info(`Command dari ${requester} diabaikan — mute aktif (${getRemainingMute()}s)`);
        return;
    }

    // Cek cooldown
    const now = Date.now();
    const cooldownMs = (settings.store.cooldownSeconds ?? 20) * 1000;
    if (now - lastCommandAt < cooldownMs) {
        const sisa = Math.ceil((cooldownMs - (now - lastCommandAt)) / 1000);
        toast(`Cooldown aktif — tunggu ${sisa}s lagi.`, Toasts.Type.MESSAGE);
        return;
    }

    // Batalkan pending yang ada
    if (pendingTimeout) { clearTimeout(pendingTimeout); pendingTimeout = null; }

    const delayMs = (settings.store.delaySeconds ?? 5) * 1000;

    // ── !say ──
    if (content.startsWith(sayPrefix)) {
        const afterSay = content.slice(sayPrefix.length).trim();
        if (!afterSay) return;

        const banned = containsBannedWord(afterSay);
        if (banned) { toast(`Kata terlarang: "${banned}"`, Toasts.Type.FAILURE); return; }

        lastCommandAt = now;
        toast(`${requester}: !say — terkirim dalam ${settings.store.delaySeconds ?? 5}s...`, Toasts.Type.MESSAGE);
        pendingTimeout = setTimeout(() => { pendingTimeout = null; doSay(afterSay, requester); }, delayMs);
        return;
    }

    // ── !reply ──
    // Ambil dari pendingForwards yang tersimpan saat forward masuk sebelumnya
    if (content.startsWith(replyPrefix)) {
        const replyContent = content.slice(replyPrefix.length).trim();
        if (!replyContent) return;

        const banned = containsBannedWord(replyContent);
        if (banned) { toast(`Kata terlarang: "${banned}"`, Toasts.Type.FAILURE); return; }

        // Cek apakah ada forward tersimpan dari user ini
        const fwd = pendingForwards.get(userId);
        if (!fwd || (Date.now() - fwd.at > FORWARD_EXPIRE_MS)) {
            pendingForwards.delete(userId);
            toast("Tidak ada forward tersimpan. Forward dulu pesan dari channel target ke DM ini, lalu ketik !reply <teks>.", Toasts.Type.FAILURE);
            return;
        }

        const { msgId: targetMsgId, channelId: targetMsgChannelId } = fwd;
        pendingForwards.delete(userId); // hapus setelah dipakai

        lastCommandAt = now;
        toast(`${requester}: !reply — terkirim dalam ${settings.store.delaySeconds ?? 5}s...`, Toasts.Type.MESSAGE);
        pendingTimeout = setTimeout(() => {
            pendingTimeout = null;
            doReply(targetMsgId, targetMsgChannelId, replyContent, requester);
        }, delayMs);
        return;
    }
}

// ─── Settings UI ──────────────────────────────────────────────────────────────

function getGuildOptions() {
    return GuildStore.getGuildsArray()
        .map((g: any) => ({ label: g.name, value: g.id }))
        .sort((a: any, b: any) => a.label.localeCompare(b.label));
}

function getChannelOptions(guildId: string | undefined) {
    if (!guildId) return [];
    const channels = GuildChannelStore.getChannels(guildId)?.SELECTABLE ?? [];
    return channels
        .filter((c: any) => c.channel?.type === 0)
        .map((c: any) => ({ label: `#${c.channel.name}`, value: c.channel.id }))
        .sort((a: any, b: any) => a.label.localeCompare(b.label));
}

function TargetPicker() {
    const { targetGuildId, targetChannelId } = settings.use(["targetGuildId", "targetChannelId"]);
    const [localGuild, setLocalGuild] = useState<string>(targetGuildId ?? "");
    const guildOptions = getGuildOptions();
    const channelOptions = getChannelOptions(localGuild || targetGuildId);

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "8px" }}>
            <div style={{ color: "var(--header-primary)", fontWeight: 600, fontSize: "14px" }}>🎯 Target Server &amp; Channel</div>
            <div style={{ color: "var(--text-muted)", fontSize: "12px", marginBottom: "4px" }}>
                Command !say dan !reply hanya berlaku di channel ini.
            </div>
            <SearchableSelect
                placeholder="Pilih server..."
                options={guildOptions}
                value={guildOptions.find((o: any) => o.value === (localGuild || targetGuildId))?.value}
                onChange={(v: string) => { setLocalGuild(v); settings.store.targetGuildId = v; settings.store.targetChannelId = ""; }}
                maxVisibleItems={6}
                closeOnSelect
            />
            <SearchableSelect
                placeholder={localGuild || targetGuildId ? "Pilih channel..." : "Pilih server dulu"}
                options={channelOptions}
                value={channelOptions.find((o: any) => o.value === targetChannelId)?.value}
                onChange={(v: string) => { settings.store.targetChannelId = v; }}
                maxVisibleItems={6}
                closeOnSelect
                isDisabled={!localGuild && !targetGuildId}
            />
            {targetGuildId && targetChannelId && (
                <div style={{ color: "var(--text-positive)", fontSize: "12px" }}>
                    ✅ <b>{GuildStore.getGuild(targetGuildId)?.name}</b> → <b>#{ChannelStore.getChannel(targetChannelId)?.name}</b>
                </div>
            )}
        </div>
    );
}

const settings = definePluginSettings({
    targetGuildId: { type: OptionType.STRING, description: "Guild ID (dari dropdown)", default: "", hidden: true },
    targetChannelId: { type: OptionType.STRING, description: "Channel ID (dari dropdown)", default: "", hidden: true },
    _picker: { type: OptionType.COMPONENT, description: "", component: TargetPicker },
    sayPrefix: { type: OptionType.STRING, description: "Prefix kirim pesan", default: "!say", placeholder: "!say" },
    replyPrefix: { type: OptionType.STRING, description: "Prefix reply pesan", default: "!reply", placeholder: "!reply" },
    mutePrefix: { type: OptionType.STRING, description: "Prefix mute", default: "!mute", placeholder: "!mute" },
    delaySeconds: {
        type: OptionType.SLIDER,
        description: "Delay sebelum pesan dikirim (detik)",
        default: 5,
        markers: [0, 1, 2, 3, 5, 7, 10, 15, 20, 30],
        stickToMarkers: false,
    },
    cooldownSeconds: {
        type: OptionType.SLIDER,
        description: "Cooldown antar command (detik)",
        default: 20,
        markers: [5, 10, 15, 20, 30, 45, 60],
        stickToMarkers: false,
    },
    maxMuteDuration: {
        type: OptionType.SLIDER,
        description: "Durasi maksimum mute (detik)",
        default: 30,
        markers: [10, 20, 30, 45, 60, 120, 180, 300],
        stickToMarkers: false,
    },
    bannedWords: {
        type: OptionType.STRING,
        description: "Kata terlarang, pisah koma",
        default: "",
        placeholder: "anjing, kontol, bangsat",
    },
});

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default definePlugin({
    name: "puppetMaster",
    description:
        "Fun plugin: teman bisa kontrol pesanmu via DM. " +
        "!say <teks> → kamu kirim pesan. Forward + !reply <teks> → kamu reply. " +
        "!mute [detik] → command diblokir sementara. Hanya 1 server & 1 channel.",
    tags: ["Fun", "Social", "Puppet", "Command"],
    authors: [{ name: "kintil555", id: 0n }],
    settings,

    start() {
        FluxDispatcher.subscribe("MESSAGE_CREATE", handleMessageCreate as any);
        logger.info("PuppetMaster aktif.");
    },

    stop() {
        FluxDispatcher.unsubscribe("MESSAGE_CREATE", handleMessageCreate as any);
        if (pendingTimeout) { clearTimeout(pendingTimeout); pendingTimeout = null; }
        if (muteTimer) { clearTimeout(muteTimer); muteTimer = null; }
        muteUntil = null;
        lastCommandAt = 0;
        pendingForwards.clear();
        logger.info("PuppetMaster dimatikan.");
    },
});
