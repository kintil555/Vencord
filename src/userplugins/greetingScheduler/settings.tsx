/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { ExpandableSection } from "@components/ExpandableCard";
import { Flex } from "@components/Flex";
import { HeadingSecondary } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { Span } from "@components/Span";
import { OptionType } from "@utils/types";
import {
    GuildChannelStore,
    GuildStore,
    React,
    SearchableSelect,
    TextArea,
    TextInput,
    Toasts,
    useRef,
    useState,
} from "@webpack/common";

import { FormatToolbar } from "./FormatToolbar";
import { sendGreetingNow } from "./sender";
import { DEFAULT_SLOTS, GreetingSlot } from "./types";

const cl = (name: string) => `vc-greeting-${name}`;

// ───────────────────────────── Target Server/Channel Picker ─────────────────────────────

function getGuildOptions() {
    return GuildStore.getGuildsArray()
        .map((g: any) => ({ label: g.name, value: g.id }))
        .sort((a: any, b: any) => a.label.localeCompare(b.label));
}

function getChannelOptions(guildId: string | undefined) {
    if (!guildId) return [];
    const channels = GuildChannelStore.getChannels(guildId)?.SELECTABLE ?? [];
    return channels
        .map((c: any) => ({ label: `#${c.channel.name}`, value: c.channel.id }))
        .sort((a: any, b: any) => a.label.localeCompare(b.label));
}

function TargetPicker() {
    const { targetGuildId, targetChannelId } = settings.use(["targetGuildId", "targetChannelId"]);
    const guildOptions = getGuildOptions();
    const channelOptions = getChannelOptions(targetGuildId);

    return (
        <div style={{ marginBottom: "12px" }}>
            <HeadingSecondary>Server &amp; Channel Tujuan</HeadingSecondary>
            <Paragraph style={{ marginBottom: "6px", color: "var(--text-muted)" }}>
                Pesan hanya akan dikirim ke channel ini. Pastikan kamu punya izin kirim pesan di channel tersebut.
            </Paragraph>
            <Flex flexDirection="column" gap="0.5em">
                <SearchableSelect
                    placeholder="Pilih server"
                    options={guildOptions}
                    value={guildOptions.find((o: any) => o.value === targetGuildId)?.value}
                    onChange={(v: string) => {
                        settings.store.targetGuildId = v;
                        settings.store.targetChannelId = "";
                    }}
                    maxVisibleItems={6}
                    closeOnSelect
                />
                <SearchableSelect
                    placeholder={targetGuildId ? "Pilih channel" : "Pilih server dulu"}
                    options={channelOptions}
                    value={channelOptions.find((o: any) => o.value === targetChannelId)?.value}
                    onChange={(v: string) => { settings.store.targetChannelId = v; }}
                    maxVisibleItems={6}
                    closeOnSelect
                    isDisabled={!targetGuildId}
                />
            </Flex>
        </div>
    );
}

// ───────────────────────────── Slot Editor (Pagi/Siang/Sore/Malam) ─────────────────────────────

function TimeRangeInputs({ slot, onChange }: { slot: GreetingSlot; onChange(patch: Partial<GreetingSlot>): void; }) {
    return (
        <Flex gap="0.5em" alignItems="center">
            <Span size="sm">Dari</Span>
            <input
                type="time"
                value={slot.startTime}
                onChange={e => onChange({ startTime: e.target.value })}
                className={cl("time-input")}
            />
            <Span size="sm">sampai</Span>
            <input
                type="time"
                value={slot.endTime}
                onChange={e => onChange({ endTime: e.target.value })}
                className={cl("time-input")}
            />
        </Flex>
    );
}

function MessageEditor({ slot, onChange }: { slot: GreetingSlot; onChange(patch: Partial<GreetingSlot>): void; }) {
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);

    return (
        <div>
            <FormatToolbar
                getTextareaEl={() => textareaRef.current}
                value={slot.message}
                onChange={text => onChange({ message: text })}
            />
            <TextArea
                inputRef={textareaRef}
                value={slot.message}
                onChange={(v: string) => onChange({ message: v })}
                placeholder="Tulis pesan ucapan, contoh: **Selamat Pagi!**"
                rows={3}
            />
            <Paragraph size="sm" style={{ marginTop: "4px", color: "var(--text-muted)" }}>
                Markdown didukung: **bold**, *italic*, __underline__, ~~strike~~, `code`, # heading, -# kecil
            </Paragraph>
        </div>
    );
}

function SlotCard({ slot, onChange }: { slot: GreetingSlot; onChange(patch: Partial<GreetingSlot>): void; }) {
    return (
        <ExpandableSection
            key={slot.key}
            renderContent={() => (
                <Flex flexDirection="column" gap="0.75em" style={{ padding: "8px 4px" }}>
                    <TimeRangeInputs slot={slot} onChange={onChange} />
                    <MessageEditor slot={slot} onChange={onChange} />
                </Flex>
            )}
        >
            <Flex alignItems="center" gap="0.5em" justifyContent="space-between" style={{ width: "100%" }}>
                <Span weight="medium">
                    {slot.label} {!slot.enabled && "(nonaktif)"}
                </Span>
                <input
                    type="checkbox"
                    checked={slot.enabled}
                    onClick={e => e.stopPropagation()}
                    onChange={e => onChange({ enabled: e.target.checked })}
                />
            </Flex>
        </ExpandableSection>
    );
}

function SlotEditorList() {
    const { slots } = settings.use(["slots"]);

    function patchSlot(index: number, patch: Partial<GreetingSlot>) {
        Object.assign(slots[index], patch);
    }

    return (
        <Flex flexDirection="column" gap="0.5em">
            {slots.map((slot, index) => (
                <SlotCard key={slot.key} slot={slot} onChange={patch => patchSlot(index, patch)} />
            ))}
        </Flex>
    );
}

// ───────────────────────────── Mode & Tombol Manual ─────────────────────────────

function ModeAndManualSection() {
    const { mode, countdownSeconds } = settings.use(["mode", "countdownSeconds"]);
    const [sending, setSending] = useState(false);

    return (
        <div style={{ marginTop: "16px" }}>
            <HeadingSecondary>Mode Pengiriman</HeadingSecondary>
            <Flex gap="0.5em" style={{ marginBottom: "8px" }}>
                <Button
                    variant={mode === "auto" ? "primary" : "secondary"}
                    size="small"
                    onClick={() => { settings.store.mode = "auto"; }}
                >
                    Otomatis
                </Button>
                <Button
                    variant={mode === "manual" ? "primary" : "secondary"}
                    size="small"
                    onClick={() => { settings.store.mode = "manual"; }}
                >
                    Manual
                </Button>
            </Flex>

            {mode === "auto" && (
                <Paragraph size="sm" style={{ color: "var(--text-muted)" }}>
                    Begitu Discord aktif & kamu online di channel tujuan, dan jam saat ini masuk salah satu slot,
                    pesan akan dikirim otomatis setelah countdown {countdownSeconds} detik. Tiap slot maksimal 1x per hari.
                </Paragraph>
            )}

            {mode === "manual" && (
                <>
                    <Paragraph size="sm" style={{ marginBottom: "8px", color: "var(--text-muted)" }}>
                        Tidak ada pengiriman otomatis. Klik tombol di bawah untuk mengirim pesan sesuai slot waktu saat ini.
                    </Paragraph>
                    <Button
                        variant="primary"
                        disabled={sending}
                        onClick={async () => {
                            setSending(true);
                            try {
                                const result = await sendGreetingNow();
                                Toasts.show({
                                    message: result.message,
                                    type: result.ok ? Toasts.Type.SUCCESS : Toasts.Type.FAILURE,
                                    id: Toasts.genId(),
                                });
                            } finally {
                                setSending(false);
                            }
                        }}
                    >
                        {sending ? "Mengirim..." : "Kirim Sekarang"}
                    </Button>
                </>
            )}
        </div>
    );
}

function CountdownSetting() {
    const { countdownSeconds } = settings.use(["countdownSeconds"]);
    return (
        <div style={{ marginTop: "12px", maxWidth: "200px" }}>
            <Span size="sm" weight="medium">Countdown sebelum kirim (detik)</Span>
            <TextInput
                type="number"
                value={String(countdownSeconds)}
                onChange={(v: string) => {
                    const n = parseInt(v, 10);
                    settings.store.countdownSeconds = Number.isFinite(n) && n >= 0 ? n : 10;
                }}
            />
        </div>
    );
}

// ───────────────────────────── Root Settings Component ─────────────────────────────

function GreetingSettingsRoot() {
    return (
        <div>
            <TargetPicker />
            <HeadingSecondary>Pesan per Waktu</HeadingSecondary>
            <Paragraph style={{ marginBottom: "8px", color: "var(--text-muted)" }}>
                Atur jam mulai/selesai dan pesan untuk masing-masing waktu. Klik judul untuk membuka/menutup.
            </Paragraph>
            <SlotEditorList />
            <ModeAndManualSection />
            <CountdownSetting />
        </div>
    );
}

export const settings = definePluginSettings({
    ui: {
        type: OptionType.COMPONENT,
        component: GreetingSettingsRoot,
    },
    slots: {
        type: OptionType.CUSTOM,
        default: DEFAULT_SLOTS,
    },
    targetGuildId: {
        type: OptionType.CUSTOM,
        default: "",
    },
    targetChannelId: {
        type: OptionType.CUSTOM,
        default: "",
    },
    mode: {
        type: OptionType.CUSTOM,
        default: "manual" as "auto" | "manual",
    },
    countdownSeconds: {
        type: OptionType.CUSTOM,
        default: 10,
    },
});
