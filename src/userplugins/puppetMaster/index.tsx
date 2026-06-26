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

// mute state: null = tidak mute, number = timestamp berakhirnya mute
let muteUntil: number | null = null;
let muteTimer: ReturnType<typeof setTimeout> | null = null;

// cooldown global (semua command share satu cooldown)
let lastCommandAt = 0;

// pending delay timeout
let pendingTimeout: ReturnType<typeof setTimeout> | null = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isMuted(): boolean {
    if (muteUntil === null) return false;
    if (Date.now() >= muteUntil) {
        muteUntil = null;
        return false;
    }
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

function toast(message: string, type: number = Toasts.Type.MESSAGE) {
    Toasts.show({ id: Toasts.genId(), message, type });
}

function isInTargetDM(channelId: string): boolean {
    // Hanya proses pesan di DM (bukan guild channel)
    const channel = ChannelStore.getChannel(channelId);
    return channel?.type === 1; // 1 = DM
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
        logger.info(`[SAY] "${content}" (diminta oleh ${requester})`);
        toast(`Pesan dikirim atas perintah ${requester}`, Toasts.Type.SUCCESS);
    } catch (e: any) {
        logger.error("Gagal kirim pesan:", e?.message);
        toast(`Gagal kirim pesan: ${e?.message ?? "Unknown error"}`, Toasts.Type.FAILURE);
    }
}

async function doReply(targetMessageId: string, targetMessageChannelId: string, replyContent: string, requester: string) {
    const { targetChannelId } = settings.store;
    if (!targetChannelId) {
        logger.warn("Target channel belum diatur.");
        return;
    }

    // Harus reply ke pesan di channel target
    if (targetMessageChannelId !== targetChannelId) {
        toast("Pesan yang di-forward bukan dari channel target.", Toasts.Type.FAILURE);
        return;
    }

    const channel = ChannelStore.getChannel(targetChannelId);
    const message = MessageStore.getMessage(targetChannelId, targetMessageId);

    if (!channel || !message) {
        toast("Pesan target tidak ditemukan di cache.", Toasts.Type.FAILURE);
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
            {
                content: replyContent,
                tts: false,
                invalidEmojis: [],
                validNonShortcutEmojis: [],
            },
            true,
            options
        );

        logger.info(`[REPLY] "${replyContent}" ke message ${targetMessageId} (diminta oleh ${requester})`);
        toast(`Reply dikirim atas perintah ${requester}`, Toasts.Type.SUCCESS);
    } catch (e: any) {
        logger.error("Gagal reply:", e?.message);
        toast(`Gagal reply: ${e?.message ?? "Unknown error"}`, Toasts.Type.FAILURE);
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
        logger.info("Mute selesai.");
    }, actualSec * 1000);

    logger.info(`[MUTE] ${actualSec}s oleh ${requester}`);
    toast(`${requester} mute kamu selama ${actualSec} detik!`, Toasts.Type.FAILURE);
}

// ─── Message handler ──────────────────────────────────────────────────────────

function handleMessageCreate({ message }: { message: any; }) {
    const myId = UserStore.getCurrentUser()?.id;

    // Hanya proses DM
    if (!isInTargetDM(message.channel_id)) return;

    // Abaikan pesan dari diri sendiri
    if (message.author?.id === myId) return;

    // Abaikan bot
    if (message.author?.bot) return;

    const requester: string = message.author?.username ?? "Unknown";
    const content: string = (message.content ?? "").trim();

    const sayPrefix = (settings.store.sayPrefix ?? "!say").trim();
    const replyPrefix = (settings.store.replyPrefix ?? "!reply").trim();
    const mutePrefix = (settings.store.mutePrefix ?? "!mute").trim();

    // ── !mute ──
    if (content.startsWith(mutePrefix)) {
        const afterMute = content.slice(mutePrefix.length).trim();
        const durationSec = parseInt(afterMute, 10);
        const dur = isNaN(durationSec) || durationSec <= 0
            ? (settings.store.maxMuteDuration ?? 30)
            : durationSec;
        doMute(dur, requester);
        return;
    }

    // Cek mute sebelum proses !say / !reply
    if (isMuted()) {
        logger.info(`Command dari ${requester} diabaikan (mute aktif, sisa ${getRemainingMute()}s)`);
        return;
    }

    // Cek cooldown
    const now = Date.now();
    const cooldownMs = (settings.store.cooldownSeconds ?? 20) * 1000;
    if (now - lastCommandAt < cooldownMs) {
        const sisa = Math.ceil((cooldownMs - (now - lastCommandAt)) / 1000);
        logger.info(`Cooldown aktif, sisa ${sisa}s`);
        toast(`Cooldown aktif, tunggu ${sisa}s lagi.`, Toasts.Type.MESSAGE);
        return;
    }

    // Batalkan pending yang ada
    if (pendingTimeout) {
        clearTimeout(pendingTimeout);
        pendingTimeout = null;
    }

    const delayMs = (settings.store.delaySeconds ?? 5) * 1000;

    // ── !say ──
    if (content.startsWith(sayPrefix)) {
        const afterSay = content.slice(sayPrefix.length).trim();
        if (!afterSay) return;

        const banned = containsBannedWord(afterSay);
        if (banned) {
            toast(`Pesan mengandung kata terlarang: "${banned}"`, Toasts.Type.FAILURE);
            return;
        }

        lastCommandAt = now;
        toast(`${requester}: !say — dikirim dalam ${settings.store.delaySeconds ?? 5}s...`, Toasts.Type.MESSAGE);

        pendingTimeout = setTimeout(() => {
            pendingTimeout = null;
            doSay(afterSay, requester);
        }, delayMs);
        return;
    }

    // ── !reply (dengan forward) ──
    // Discord forward: pesan berisi message_reference + message_snapshots
    // Isinya: content = "!reply <teks balasan", plus message_snapshots dari pesan yang di-forward
    if (content.startsWith(replyPrefix)) {
        const replyContent = content.slice(replyPrefix.length).trim();
        if (!replyContent) return;

        const banned = containsBannedWord(replyContent);
        if (banned) {
            toast(`Reply mengandung kata terlarang: "${banned}"`, Toasts.Type.FAILURE);
            return;
        }

        // Cari pesan yang di-forward: ada di message_reference atau message_snapshots
        const ref = message.message_reference;
        const snapshots = message.message_snapshots;

        let targetMsgId: string | null = null;
        let targetChannelId: string | null = null;

        if (ref?.message_id) {
            targetMsgId = ref.message_id;
            targetChannelId = ref.channel_id ?? null;
        } else if (snapshots?.[0]?.message?.id) {
            // Forward tanpa explicit reference — ambil dari snapshot
            targetMsgId = snapshots[0].message.id;
            targetChannelId = snapshots[0].message.channel_id ?? null;
        }

        if (!targetMsgId || !targetChannelId) {
            toast("Tidak ada pesan yang di-forward. Forward pesan dari channel target + ketik !reply <teks>.", Toasts.Type.FAILURE);
            return;
        }

        lastCommandAt = now;
        toast(`${requester}: !reply — dikirim dalam ${settings.store.delaySeconds ?? 5}s...`, Toasts.Type.MESSAGE);

        pendingTimeout = setTimeout(() => {
            pendingTimeout = null;
            doReply(targetMsgId!, targetChannelId!, replyContent, requester);
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
        .filter((c: any) => c.channel?.type === 0) // text channels only
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
            <div style={{ color: "var(--header-primary)", fontWeight: 600, fontSize: "14px" }}>
                🎯 Target Server &amp; Channel
            </div>
            <div style={{ color: "var(--text-muted)", fontSize: "12px", marginBottom: "4px" }}>
                Command !say dan !reply hanya berlaku di channel ini. Pilih server dulu, lalu channel.
            </div>
            <SearchableSelect
                placeholder="Pilih server..."
                options={guildOptions}
                value={guildOptions.find((o: any) => o.value === (localGuild || targetGuildId))?.value}
                onChange={(v: string) => {
                    setLocalGuild(v);
                    settings.store.targetGuildId = v;
                    settings.store.targetChannelId = "";
                }}
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
                    ✅ Target: <b>{GuildStore.getGuild(targetGuildId)?.name}</b> → <b>#{ChannelStore.getChannel(targetChannelId)?.name}</b>
                </div>
            )}
        </div>
    );
}

const settings = definePluginSettings({
    targetGuildId: {
        type: OptionType.STRING,
        description: "ID server target (diisi otomatis dari dropdown)",
        default: "",
        hidden: true,
    },
    targetChannelId: {
        type: OptionType.STRING,
        description: "ID channel target (diisi otomatis dari dropdown)",
        default: "",
        hidden: true,
    },

    // Picker component
    _picker: {
        type: OptionType.COMPONENT,
        description: "",
        component: TargetPicker,
    },

    sayPrefix: {
        type: OptionType.STRING,
        description: "Prefix command kirim pesan",
        default: "!say",
        placeholder: "!say",
    },
    replyPrefix: {
        type: OptionType.STRING,
        description: "Prefix command reply pesan (+ forward pesan target ke DM)",
        default: "!reply",
        placeholder: "!reply",
    },
    mutePrefix: {
        type: OptionType.STRING,
        description: "Prefix command mute (contoh: !mute 30)",
        default: "!mute",
        placeholder: "!mute",
    },

    delaySeconds: {
        type: OptionType.SLIDER,
        description: "Delay sebelum pesan dikirim (detik)",
        default: 5,
        markers: [0, 1, 2, 3, 5, 7, 10, 15, 20, 30],
        stickToMarkers: false,
    },
    cooldownSeconds: {
        type: OptionType.SLIDER,
        description: "Cooldown antar command (detik) — mencegah spam",
        default: 20,
        markers: [5, 10, 15, 20, 30, 45, 60],
        stickToMarkers: false,
    },
    maxMuteDuration: {
        type: OptionType.SLIDER,
        description: "Durasi maksimum mute (detik) — meskipun orang ketik lebih besar",
        default: 30,
        markers: [10, 20, 30, 45, 60, 120, 180, 300],
        stickToMarkers: false,
    },

    bannedWords: {
        type: OptionType.STRING,
        description: "Kata-kata terlarang (pisahkan dengan koma) — pesan yang mengandung ini akan diabaikan",
        default: "",
        placeholder: "anjing, kontol, bangsat",
    },
});

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default definePlugin({
    name: "puppetMaster",
    description:
        "Fun plugin: biarkan teman mengontrol pesanmu via DM! " +
        "!say <teks> → kamu kirim pesan di channel target. " +
        "Forward pesan + !reply <teks> → kamu reply pesan itu. " +
        "!mute [detik] → command !say & !reply diblokir sementara. " +
        "Semua berlaku hanya di 1 server & 1 channel yang dipilih.",
    tags: ["Fun", "Social", "Puppet", "Command"],
    authors: [{ name: "kintil555", id: 0n }],
    settings,

    start() {
        FluxDispatcher.subscribe("MESSAGE_CREATE", handleMessageCreate as any);
        logger.info("PuppetMaster aktif. Mendengarkan DM...");
    },

    stop() {
        FluxDispatcher.unsubscribe("MESSAGE_CREATE", handleMessageCreate as any);
        if (pendingTimeout) { clearTimeout(pendingTimeout); pendingTimeout = null; }
        if (muteTimer) { clearTimeout(muteTimer); muteTimer = null; }
        muteUntil = null;
        lastCommandAt = 0;
        logger.info("PuppetMaster dimatikan.");
    },
});
